import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Route } from '@gateway/shared-types';

/**
 * Plugin system.
 *
 * Plugins observe and modify traffic at three hook points: before proxying
 * (`onRequest`), after the upstream responds (`onResponse`), and when the
 * pipeline fails (`onError`). They are plain objects — no framework coupling —
 * registered programmatically or loaded from a directory of `.js` files.
 *
 * Per-route control lives in the route's `pluginConfig`:
 * `{ "<plugin-name>": { "enabled": false, ...options } }`.
 * A plugin runs for a route unless explicitly disabled there.
 */

export interface PluginAuthUser {
  sub: string;
  email: string;
  role: string;
}

export interface PluginRequest {
  method: string;
  /** Path + query string, e.g. "/api/users/1?active=true". */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  route: Route;
  requestId: string;
  ip: string;
  authUser?: PluginAuthUser | undefined;
}

export interface PluginResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

export interface PluginShortCircuit {
  statusCode: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}

export interface PluginContext {
  /** Per-request scratch space shared across hooks of all plugins. */
  state: Map<string, unknown>;
  /** This route's options for the running plugin. */
  options: Record<string, unknown>;
}

export interface GatewayPlugin {
  name: string;
  version?: string;
  onRequest?: (req: PluginRequest, ctx: PluginContext) => Promise<PluginShortCircuit | undefined>;
  onResponse?: (res: PluginResponse, ctx: PluginContext) => Promise<void>;
  onError?: (err: unknown, ctx: PluginContext) => Promise<void>;
}

export interface PluginLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

export function isGatewayPlugin(value: unknown): value is GatewayPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p['name'] !== 'string' || p['name'].length === 0) return false;
  for (const hook of ['onRequest', 'onResponse', 'onError'] as const) {
    if (p[hook] !== undefined && typeof p[hook] !== 'function') return false;
  }
  return true;
}

export class PluginManager {
  private plugins: GatewayPlugin[] = [];
  private onPluginError: (pluginName: string, hook: string, err: unknown) => void;

  constructor(onPluginError?: (pluginName: string, hook: string, err: unknown) => void) {
    this.onPluginError = onPluginError ?? (() => undefined);
  }

  register(plugin: GatewayPlugin): void {
    if (!isGatewayPlugin(plugin)) throw new Error('Invalid plugin: missing name or bad hooks.');
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    this.plugins.push(plugin);
  }

  names(): string[] {
    return this.plugins.map((p) => p.name);
  }

  /** Import every `.js` file in a directory as a plugin (default export). */
  async loadFromDirectory(dir: string): Promise<PluginLoadResult> {
    const result: PluginLoadResult = { loaded: [], failed: [] };
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort();
    } catch (err) {
      throw new Error(`Cannot read plugin directory ${dir}: ${(err as Error).message}`);
    }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const mod = (await import(pathToFileURL(full).href)) as { default?: unknown };
        const plugin = mod.default;
        if (!isGatewayPlugin(plugin)) {
          throw new Error('default export is not a valid plugin');
        }
        this.register(plugin);
        result.loaded.push(plugin.name);
      } catch (err) {
        result.failed.push({ file, error: (err as Error).message });
      }
    }
    return result;
  }

  pluginsForRoute(route: Route): GatewayPlugin[] {
    return this.plugins.filter((p) => {
      const cfg = route.pluginConfig[p.name];
      if (
        cfg !== null &&
        typeof cfg === 'object' &&
        (cfg as Record<string, unknown>)['enabled'] === false
      ) {
        return false;
      }
      return true;
    });
  }

  private contextFor(
    route: Route,
    plugin: GatewayPlugin,
    state: Map<string, unknown>,
  ): PluginContext {
    const cfg = route.pluginConfig[plugin.name];
    const options = cfg !== null && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
    return { state, options };
  }

  /** Runs onRequest hooks in order; returns a short-circuit response if any. */
  async runOnRequest(req: PluginRequest, route: Route): Promise<PluginShortCircuit | null> {
    const state = new Map<string, unknown>();
    for (const plugin of this.pluginsForRoute(route)) {
      if (!plugin.onRequest) continue;
      try {
        const shortCircuit = await plugin.onRequest(req, this.contextFor(route, plugin, state));
        if (shortCircuit) return shortCircuit;
      } catch (err) {
        this.onPluginError(plugin.name, 'onRequest', err);
      }
    }
    return null;
  }

  async runOnResponse(res: PluginResponse, route: Route): Promise<void> {
    const state = new Map<string, unknown>();
    for (const plugin of this.pluginsForRoute(route)) {
      if (!plugin.onResponse) continue;
      try {
        await plugin.onResponse(res, this.contextFor(route, plugin, state));
      } catch (err) {
        this.onPluginError(plugin.name, 'onResponse', err);
      }
    }
  }

  async runOnError(err: unknown, route: Route): Promise<void> {
    const state = new Map<string, unknown>();
    for (const plugin of this.pluginsForRoute(route)) {
      if (!plugin.onError) continue;
      try {
        await plugin.onError(err, this.contextFor(route, plugin, state));
      } catch (hookErr) {
        this.onPluginError(plugin.name, 'onError', hookErr);
      }
    }
  }
}

/** Example plugin: injects a static header into every proxied request. */
export function createAddHeaderPlugin(header: string, value: string): GatewayPlugin {
  return {
    name: 'add-header',
    version: '1.0.0',
    onRequest: (req) => {
      req.headers[header.toLowerCase()] = value;
      return Promise.resolve(undefined);
    },
  };
}
