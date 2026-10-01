import { beforeEach, describe, expect, it } from 'vitest';
import type { CircuitBreakerPolicy } from '@gateway/shared-types';
import { CircuitBreakerRegistry } from '../../src/circuit-breaker.js';

function policy(overrides: Partial<CircuitBreakerPolicy> = {}): CircuitBreakerPolicy {
  return {
    id: 'cb-1',
    name: 'test',
    failureThreshold: 3,
    rollingWindowMs: 10_000,
    openDurationMs: 5_000,
    halfOpenMaxProbes: 1,
    failureStatuses: [500, 502, 503, 504],
    countTimeouts: true,
    ...overrides,
  };
}

describe('CircuitBreakerRegistry', () => {
  let now: number;
  let breakers: CircuitBreakerRegistry;
  const p = policy();

  beforeEach(() => {
    now = 1_000_000;
    breakers = new CircuitBreakerRegistry(() => now);
  });

  it('starts closed and allows requests', () => {
    expect(breakers.canRequest('r1', p)).toEqual({ allowed: true, state: 'closed' });
  });

  it('opens after threshold failures inside the window', () => {
    for (let i = 0; i < 2; i++) {
      breakers.canRequest('r1', p);
      breakers.record('r1', p, { kind: 'status', status: 500 });
    }
    expect(breakers.canRequest('r1', p).allowed).toBe(true);
    breakers.record('r1', p, { kind: 'status', status: 503 });
    expect(breakers.stateOf('r1')).toBe('open');
    expect(breakers.canRequest('r1', p)).toEqual({ allowed: false, state: 'open' });
  });

  it('ignores failures outside the rolling window', () => {
    breakers.canRequest('r1', p);
    breakers.record('r1', p, { kind: 'status', status: 500 });
    now += 11_000; // past the window
    breakers.canRequest('r1', p);
    breakers.record('r1', p, { kind: 'status', status: 500 });
    expect(breakers.stateOf('r1')).toBe('closed');
  });

  it('does not count successes or non-listed statuses', () => {
    for (const outcome of [
      { kind: 'success' },
      { kind: 'status', status: 400 },
      { kind: 'status', status: 200 },
    ] as const) {
      breakers.canRequest('r1', p);
      breakers.record('r1', p, outcome);
    }
    expect(breakers.stateOf('r1')).toBe('closed');
  });

  it('counts timeouts only when configured', () => {
    const noTimeout = policy({ countTimeouts: false, failureThreshold: 1 });
    breakers.canRequest('r1', noTimeout);
    breakers.record('r1', noTimeout, { kind: 'timeout' });
    expect(breakers.stateOf('r1')).toBe('closed');

    const yesTimeout = policy({ countTimeouts: true, failureThreshold: 1 });
    breakers.canRequest('r2', yesTimeout);
    breakers.record('r2', yesTimeout, { kind: 'timeout' });
    expect(breakers.stateOf('r2')).toBe('open');
  });

  it('half-opens after the open duration and closes on probe success', () => {
    const trip = policy({ failureThreshold: 1, halfOpenMaxProbes: 1 });
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    expect(breakers.canRequest('r1', trip).allowed).toBe(false);

    now += 5_000;
    expect(breakers.canRequest('r1', trip)).toEqual({ allowed: true, state: 'half-open' });
    breakers.record('r1', trip, { kind: 'success' });
    expect(breakers.stateOf('r1')).toBe('closed');
    expect(breakers.canRequest('r1', trip).allowed).toBe(true);
  });

  it('re-opens when a half-open probe fails', () => {
    const trip = policy({ failureThreshold: 1 });
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    now += 5_000;
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    expect(breakers.stateOf('r1')).toBe('open');
  });

  it('limits concurrent half-open probes', () => {
    const trip = policy({ failureThreshold: 1, halfOpenMaxProbes: 1 });
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    now += 5_000;
    expect(breakers.canRequest('r1', trip).allowed).toBe(true); // probe 1
    expect(breakers.canRequest('r1', trip)).toEqual({ allowed: false, state: 'half-open' });
  });

  it('isolates breakers per route', () => {
    const trip = policy({ failureThreshold: 1 });
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    expect(breakers.canRequest('r2', trip).allowed).toBe(true);
  });

  it('recreates the breaker when the policy changes', () => {
    const trip = policy({ failureThreshold: 1 });
    breakers.canRequest('r1', trip);
    breakers.record('r1', trip, { kind: 'status', status: 500 });
    expect(breakers.stateOf('r1')).toBe('open');
    breakers.canRequest('r1', { ...trip, id: 'cb-2' });
    expect(breakers.stateOf('r1')).toBe('closed');
  });
});
