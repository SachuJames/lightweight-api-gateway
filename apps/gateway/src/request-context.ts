import type { CircuitState, Route } from '@gateway/shared-types';

/** Authenticated identity attached by the JWT middleware. */
export interface AuthIdentity {
  userId: string;
  email: string;
  role: string;
  permissions: string[];
}

/** Per-request state carried through the gateway pipeline. */
export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startTimeMs: number;
  clientIp: string;
  route: Route | null;
  auth: AuthIdentity | null;
  rateLimit: { allowed: boolean; remaining: number; limit: number } | null;
  circuitState: CircuitState | null;
  upstream: string | null;
  upstreamStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
}

export function newRequestContext(partial: Pick<RequestContext, 'requestId' | 'method' | 'path' | 'clientIp'>): RequestContext {
  return {
    ...partial,
    startTimeMs: Date.now(),
    route: null,
    auth: null,
    rateLimit: null,
    circuitState: null,
    upstream: null,
    upstreamStatus: null,
    latencyMs: null,
    errorCode: null,
  };
}
