// Shared types between the gateway service and the admin UI.
// Validation schemas (zod) live here when both sides need the same contract.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export interface RateLimitPolicy {
  id: string;
  name: string;
  capacity: number;
  refillRatePerSec: number;
  keyStrategy: 'ip' | 'user' | 'route_ip' | 'route_user';
  failOpen: boolean;
}

export interface CircuitBreakerPolicy {
  id: string;
  name: string;
  failureThreshold: number;
  rollingWindowMs: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
  failureStatuses: number[];
  countTimeouts: boolean;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface Route {
  id: string;
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
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
