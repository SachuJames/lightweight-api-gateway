import { z } from 'zod';
import type { Route } from '@gateway/shared-types';

/**
 * Routing engine.
 *
 * Path patterns support static segments, `:param` segments, and a trailing
 * `/*` wildcard. Matching is deterministic:
 *
 *   1. higher `priority` first,
 *   2. then higher specificity (static > param > wildcard),
 *   3. then longer pattern,
 *   4. then route id (stable tiebreak).
 *
 * Path forwarding strips the static prefix of the pattern (everything before
 * the first `*` or `:param`). Example: pattern `/api/users/*`, request
 * `/api/users/123` -> upstream receives `/123`.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATIC_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=@%-]+$/;

export function isValidPattern(pattern: string): boolean {
  if (!pattern.startsWith('/') || pattern.length > 200) return false;
  if (pattern.includes('?') || pattern.includes('#') || /\s/.test(pattern)) return false;
  const segments = pattern.split('/').slice(1);
  if (segments.some((s) => s.length === 0)) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === '*') {
      if (i !== segments.length - 1) return false; // wildcard only as last segment
      continue;
    }
    if (seg.startsWith(':')) {
      if (!PARAM_NAME.test(seg.slice(1))) return false;
      continue;
    }
    if (seg.includes('*') || seg.includes(':')) return false;
    try {
      if (!STATIC_SEGMENT.test(decodeURIComponent(seg))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export const routeInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  pathPattern: z
    .string()
    .min(1)
    .max(200)
    .refine(isValidPattern, { message: 'Invalid path pattern' }),
  methods: z.array(z.enum(HTTP_METHODS)).min(1),
  upstreamUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(
      (u) => {
        try {
          const parsed = new URL(u);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'upstreamUrl must be a valid http(s) URL' },
    ),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000).default(100),
  authRequired: z.boolean().default(false),
  rateLimitPolicyId: z.uuid().nullable().default(null),
  circuitBreakerPolicyId: z.uuid().nullable().default(null),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  pluginConfig: z.record(z.string(), z.unknown()).default({}),
});

export type RouteInput = z.infer<typeof routeInputSchema>;

export function normalizeUpstreamUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface CompiledRoute {
  route: Route;
  regex: RegExp;
  paramNames: string[];
  staticPrefix: string;
  specificity: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRoute(route: Route): CompiledRoute {
  const segments = route.pathPattern.split('/').slice(1);
  const paramNames: string[] = [];
  const staticParts: string[] = [];
  let regexSrc = '^';
  let specificity = 0;
  let inStaticPrefix = true;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === '*') {
      // Trailing wildcard: also matches the prefix itself ("/api/users" matches "/api/users/*").
      regexSrc += '(?:/.*)?';
      specificity += 1;
      inStaticPrefix = false;
      continue;
    }
    regexSrc += '/';
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      paramNames.push(name);
      regexSrc += `(?<${name}>[^/]+)`;
      specificity += 2;
      inStaticPrefix = false;
    } else {
      regexSrc += escapeRegex(seg);
      specificity += 3;
      if (inStaticPrefix) staticParts.push(seg);
    }
  }
  regexSrc += '/?$'; // tolerate a trailing slash

  return {
    route,
    regex: new RegExp(regexSrc),
    paramNames,
    staticPrefix: '/' + staticParts.join('/'),
    specificity,
  };
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
  /** Path (with query string) to request from the upstream. */
  upstreamPath: string;
}

function stripQuery(url: string): { path: string; query: string } {
  const q = url.indexOf('?');
  if (q === -1) return { path: url, query: '' };
  return { path: url.slice(0, q), query: url.slice(q) };
}

export function matchCompiled(
  compiled: CompiledRoute[],
  method: string,
  url: string,
): RouteMatch | null {
  const { path, query } = stripQuery(url);
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;

  const candidates = compiled
    .filter((c) => c.route.enabled && (c.route.methods as string[]).includes(method))
    .map((c) => ({ c, m: c.regex.exec(normalized) }))
    .filter((x): x is { c: CompiledRoute; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => {
      if (b.c.route.priority !== a.c.route.priority) return b.c.route.priority - a.c.route.priority;
      if (b.c.specificity !== a.c.specificity) return b.c.specificity - a.c.specificity;
      if (b.c.route.pathPattern.length !== a.c.route.pathPattern.length)
        return b.c.route.pathPattern.length - a.c.route.pathPattern.length;
      return a.c.route.id < b.c.route.id ? -1 : 1;
    });

  const winner = candidates[0];
  if (!winner) return null;

  const params: Record<string, string> = {};
  for (const name of winner.c.paramNames) {
    const value = winner.m.groups?.[name];
    if (value !== undefined) params[name] = decodeURIComponent(value);
  }

  let stripped = normalized.slice(winner.c.staticPrefix.length);
  if (!stripped.startsWith('/')) stripped = '/' + stripped;
  if (stripped === '') stripped = '/';

  return { route: winner.c.route, params, upstreamPath: stripped + query };
}

/** Match against raw route records (compiles on the fly; snapshots pre-compile). */
export function matchRoutes(routes: Route[], method: string, url: string): RouteMatch | null {
  return matchCompiled(routes.map(compileRoute), method, url);
}
