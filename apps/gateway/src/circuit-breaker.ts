import type { CircuitBreakerPolicy } from '@gateway/shared-types';

/**
 * Per-instance in-memory circuit breaker.
 *
 * One breaker per route. States:
 *   closed    — requests flow; failures inside the rolling window are counted
 *   open      — requests are rejected fast for `openDurationMs`
 *   half-open — up to `halfOpenMaxProbes` trial requests pass through; the
 *               first success closes the circuit, any failure re-opens it
 *
 * Breakers are per gateway instance by design (documented trade-off): state
 * does not need cross-instance consensus to protect an upstream, and local
 * state avoids a Redis round trip on every proxied request.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export type UpstreamOutcome =
  | { kind: 'success' }
  | { kind: 'status'; status: number }
  | { kind: 'timeout' };

interface Breaker {
  policy: CircuitBreakerPolicy;
  state: CircuitState;
  failureTimes: number[];
  openedAt: number;
  activeProbes: number;
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, Breaker>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private getOrCreate(routeId: string, policy: CircuitBreakerPolicy): Breaker {
    let breaker = this.breakers.get(routeId);
    if (!breaker || breaker.policy.id !== policy.id) {
      breaker = { policy, state: 'closed', failureTimes: [], openedAt: 0, activeProbes: 0 };
      this.breakers.set(routeId, breaker);
    }
    return breaker;
  }

  /** Whether a request may proceed; performs time-based state transitions. */
  canRequest(routeId: string, policy: CircuitBreakerPolicy): { allowed: boolean; state: CircuitState } {
    const breaker = this.getOrCreate(routeId, policy);
    const now = this.now();

    if (breaker.state === 'open' && now - breaker.openedAt >= policy.openDurationMs) {
      breaker.state = 'half-open';
      breaker.activeProbes = 0;
    }

    if (breaker.state === 'open') {
      return { allowed: false, state: 'open' };
    }
    if (breaker.state === 'half-open') {
      if (breaker.activeProbes >= policy.halfOpenMaxProbes) {
        return { allowed: false, state: 'half-open' };
      }
      breaker.activeProbes += 1;
      return { allowed: true, state: 'half-open' };
    }
    return { allowed: true, state: 'closed' };
  }

  /** Record a completed probe or request. Must pair with a prior canRequest. */
  record(routeId: string, policy: CircuitBreakerPolicy, outcome: UpstreamOutcome): CircuitState {
    const breaker = this.getOrCreate(routeId, policy);
    const now = this.now();

    if (breaker.state === 'half-open') {
      breaker.activeProbes = Math.max(0, breaker.activeProbes - 1);
      if (this.isFailure(policy, outcome)) {
        this.trip(breaker, now);
      } else {
        breaker.state = 'closed';
        breaker.failureTimes = [];
      }
      return breaker.state;
    }

    if (!this.isFailure(policy, outcome)) return breaker.state;

    breaker.failureTimes.push(now);
    const windowStart = now - policy.rollingWindowMs;
    breaker.failureTimes = breaker.failureTimes.filter((t) => t >= windowStart);
    if (breaker.state === 'closed' && breaker.failureTimes.length >= policy.failureThreshold) {
      this.trip(breaker, now);
    }
    return breaker.state;
  }

  stateOf(routeId: string): CircuitState | null {
    return this.breakers.get(routeId)?.state ?? null;
  }

  /** Forget a route's breaker (route deleted or policy unassigned). */
  remove(routeId: string): void {
    this.breakers.delete(routeId);
  }

  private trip(breaker: Breaker, now: number): void {
    breaker.state = 'open';
    breaker.openedAt = now;
    breaker.activeProbes = 0;
  }

  private isFailure(policy: CircuitBreakerPolicy, outcome: UpstreamOutcome): boolean {
    switch (outcome.kind) {
      case 'success':
        return false;
      case 'timeout':
        return policy.countTimeouts;
      case 'status':
        return policy.failureStatuses.includes(outcome.status);
    }
  }
}
