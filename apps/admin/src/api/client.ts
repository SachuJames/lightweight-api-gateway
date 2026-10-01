// Typed HTTP client for the gateway admin API.
// Single place where fetch() is used; pages never call fetch directly.
//
// Auth: JWT in the Authorization header (no cookies, so no CSRF surface).
// The token lives in sessionStorage (tab-scoped) via the auth context.

import type {
  AdminUser,
  AnalyticsSnapshot,
  AuditRecord,
  CircuitBreakerPolicy,
  ConfigVersionInfo,
  ErrorBody,
  HttpMethod,
  LoginResponse,
  MetricsSnapshot,
  RateLimitPolicy,
  Route,
  RouteMutationResult,
} from '@gateway/shared-types';

/** Base URL of the gateway API. Empty string = same origin (dev proxy handles it). */
export const API_BASE: string = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, code: string, message: string, requestId: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface RouteInput {
  name: string;
  pathPattern: string;
  methods: HttpMethod[];
  upstreamUrl: string;
  enabled: boolean;
  priority: number;
  authRequired: boolean;
  rateLimitPolicyId: string | null;
  circuitBreakerPolicyId: string | null;
  timeoutMs: number;
  pluginConfig: Record<string, unknown>;
}

export interface RateLimitPolicyInput {
  name: string;
  capacity: number;
  refillRatePerSec: number;
  keyStrategy: RateLimitPolicy['keyStrategy'];
  failOpen: boolean;
}

export interface CircuitBreakerPolicyInput {
  name: string;
  failureThreshold: number;
  rollingWindowMs: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
  failureStatuses: number[];
  countTimeouts: boolean;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const fallback = `Request failed with status ${status}`;
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as ErrorBody).error;
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    const message = typeof err.message === 'string' ? err.message : fallback;
    const requestId = typeof err.requestId === 'string' ? err.requestId : '';
    return new ApiError(status, code, message, requestId);
  }
  return new ApiError(status, 'UNKNOWN', fallback, '');
}

export class ApiClient {
  private token: string | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(`${API_BASE}${path}`, init);
    } catch (err) {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        err instanceof Error ? err.message : 'Network request failed',
        '',
      );
    }
    const parsed = await parseBody(res);
    if (!res.ok) throw toApiError(res.status, parsed);
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // --- auth ---
  login(email: string, password: string): Promise<LoginResponse> {
    return this.post<LoginResponse>('/api/auth/login', { email, password });
  }

  // --- routes ---
  listRoutes(): Promise<{ routes: Route[] }> {
    return this.get('/api/routes');
  }
  getRoute(id: string): Promise<{ route: Route }> {
    return this.get(`/api/routes/${encodeURIComponent(id)}`);
  }
  createRoute(input: RouteInput): Promise<RouteMutationResult> {
    return this.post('/api/routes', input);
  }
  updateRoute(id: string, patch: Partial<RouteInput>): Promise<RouteMutationResult> {
    return this.put(`/api/routes/${encodeURIComponent(id)}`, patch);
  }
  deleteRoute(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/routes/${encodeURIComponent(id)}`);
  }

  // --- policies ---
  listRateLimitPolicies(): Promise<{ policies: RateLimitPolicy[] }> {
    return this.get('/api/rate-limit-policies');
  }
  createRateLimitPolicy(input: RateLimitPolicyInput): Promise<{ policy: RateLimitPolicy }> {
    return this.post('/api/rate-limit-policies', input);
  }
  updateRateLimitPolicy(
    id: string,
    patch: Partial<RateLimitPolicyInput>,
  ): Promise<{ policy: RateLimitPolicy }> {
    return this.put(`/api/rate-limit-policies/${encodeURIComponent(id)}`, patch);
  }
  deleteRateLimitPolicy(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/rate-limit-policies/${encodeURIComponent(id)}`);
  }
  listCircuitBreakerPolicies(): Promise<{ policies: CircuitBreakerPolicy[] }> {
    return this.get('/api/circuit-breaker-policies');
  }
  createCircuitBreakerPolicy(
    input: CircuitBreakerPolicyInput,
  ): Promise<{ policy: CircuitBreakerPolicy }> {
    return this.post('/api/circuit-breaker-policies', input);
  }
  updateCircuitBreakerPolicy(
    id: string,
    patch: Partial<CircuitBreakerPolicyInput>,
  ): Promise<{ policy: CircuitBreakerPolicy }> {
    return this.put(`/api/circuit-breaker-policies/${encodeURIComponent(id)}`, patch);
  }
  deleteCircuitBreakerPolicy(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/circuit-breaker-policies/${encodeURIComponent(id)}`);
  }

  // --- audit / config / metrics ---
  listAudit(q: AuditQuery = {}): Promise<{ records: AuditRecord[]; total?: number }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== '') params.set(k, String(v));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.get(`/api/audit${suffix}`);
  }
  getConfigVersion(): Promise<ConfigVersionInfo> {
    return this.get('/api/config/version');
  }
  reloadConfig(): Promise<{ reloaded: boolean; version: number }> {
    return this.post('/api/config/reload');
  }
  getMetrics(): Promise<MetricsSnapshot> {
    return this.get('/api/metrics');
  }

  // --- system ---
  getHealth(): Promise<Record<string, unknown>> {
    return this.get('/health');
  }
  getReadiness(): Promise<Record<string, unknown>> {
    return this.get('/ready');
  }

  // --- users (admin only) ---
  listUsers(): Promise<{ users: AdminUser[] }> {
    return this.get('/api/users');
  }
  createUser(email: string, password: string, role: string): Promise<{ user: AdminUser }> {
    return this.post('/api/users', { email, password, role });
  }
  deleteUser(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/users/${encodeURIComponent(id)}`);
  }
}

export const api = new ApiClient();

/** Shape of one SSE analytics event (matches the gateway's /api/analytics/stream). */
export type { AnalyticsSnapshot };
