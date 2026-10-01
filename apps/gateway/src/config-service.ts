import type { CircuitBreakerPolicy, RateLimitPolicy } from '@gateway/shared-types';
import type { DbClient } from './db.js';
import { getCurrentVersion } from './db/config-versions.js';
import { listCircuitBreakerPolicies, listRateLimitPolicies, listRoutes } from './db/routes.js';
import { compileRoute, type CompiledRoute } from './routing.js';

/**
 * Configuration snapshots.
 *
 * The gateway never queries Postgres on the hot path. Instead it holds an
 * immutable, atomically-swapped snapshot of everything the request pipeline
 * needs: compiled routes plus the rate-limit and circuit-breaker policies
 * referenced by those routes.
 *
 * Swapping the reference is atomic in Node's single thread, so requests
 * always see one complete version of the configuration — never a mix of
 * old and new rows. Zero-downtime refresh is built on top of this
 * (see the reload mechanism in a later phase).
 */

export interface ConfigSnapshot {
  version: number;
  routes: CompiledRoute[];
  rateLimitPolicies: Map<string, RateLimitPolicy>;
  circuitBreakerPolicies: Map<string, CircuitBreakerPolicy>;
  loadedAt: string;
}

export async function loadSnapshot(client: DbClient): Promise<ConfigSnapshot> {
  const [version, routes, rateLimits, circuitBreakers] = await Promise.all([
    getCurrentVersion(client),
    listRoutes(client),
    listRateLimitPolicies(client),
    listCircuitBreakerPolicies(client),
  ]);
  return {
    version,
    routes: routes.map(compileRoute),
    rateLimitPolicies: new Map(rateLimits.map((p) => [p.id, p])),
    circuitBreakerPolicies: new Map(circuitBreakers.map((p) => [p.id, p])),
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Holds the active snapshot. `refresh()` loads a fresh snapshot and swaps it
 * in one assignment; `current()` always returns a complete snapshot.
 */
export class ConfigStore {
  private snapshot: ConfigSnapshot;

  constructor(initial: ConfigSnapshot) {
    this.snapshot = initial;
  }

  current(): ConfigSnapshot {
    return this.snapshot;
  }

  version(): number {
    return this.snapshot.version;
  }

  async refresh(client: DbClient): Promise<{ from: number; to: number }> {
    const next = await loadSnapshot(client);
    const from = this.snapshot.version;
    this.snapshot = next; // atomic swap
    return { from, to: next.version };
  }

  static empty(): ConfigStore {
    return new ConfigStore({
      version: 0,
      routes: [],
      rateLimitPolicies: new Map(),
      circuitBreakerPolicies: new Map(),
      loadedAt: new Date().toISOString(),
    });
  }
}
