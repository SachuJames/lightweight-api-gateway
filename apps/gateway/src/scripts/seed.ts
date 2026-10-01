import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { closePool, getPool, withTransaction } from '../db.js';
import { getCurrentVersion } from '../db/config-versions.js';
import { createUser } from '../db/users.js';

/**
 * Seed script: admin user, default policies, sample routes, initial config
 * version. Idempotent (safe to run multiple times). Local/dev only — refuses
 * to run in production since it installs a known admin password.
 */
async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed in production: it installs a known admin password.');
  }
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const adminEmail = process.env['ADMIN_EMAIL'] ?? 'admin@example.local';
  const adminPassword = process.env['ADMIN_PASSWORD'] ?? 'admin123';
  if (adminPassword.length < 12) {
    throw new Error('Refusing to seed: ADMIN_PASSWORD must be at least 12 characters.');
  }

  const pool = getPool({ databaseUrl });
  try {
    await withTransaction(pool, async (client) => {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await createUser(client, { email: adminEmail, passwordHash, role: 'admin' });

      await client.query(
        `INSERT INTO rate_limit_policies (id, name, capacity, refill_rate_per_sec, key_strategy, fail_open)
         VALUES
           ('00000000-0000-0000-0000-0000000000a1', 'default-route', 100, 10, 'route_ip', true),
           ('00000000-0000-0000-0000-0000000000a2', 'strict-auth', 20, 2, 'ip', false)
         ON CONFLICT (id) DO NOTHING`,
      );
      await client.query(
        `INSERT INTO circuit_breaker_policies
           (id, name, failure_threshold, rolling_window_ms, open_duration_ms,
            half_open_max_probes, failure_statuses, count_timeouts)
         VALUES
           ('00000000-0000-0000-0000-0000000000b1', 'default-upstream', 5, 60000, 30000, 2,
            ARRAY[500,502,503,504], true)
         ON CONFLICT (id) DO NOTHING`,
      );

      await client.query(
        `INSERT INTO routes
           (id, name, path_pattern, methods, upstream_url, enabled, priority,
            auth_required, rate_limit_policy_id, circuit_breaker_policy_id, timeout_ms)
         VALUES
           ('00000000-0000-0000-0000-0000000000c1', 'users', '/api/users/*',
            ARRAY['GET','POST','PUT','PATCH','DELETE'], 'http://users-service:3001',
            true, 100, false, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 30000),
           ('00000000-0000-0000-0000-0000000000c2', 'orders', '/api/orders/*',
            ARRAY['GET','POST','PUT','PATCH','DELETE'], 'http://orders-service:3002',
            true, 100, true, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 30000),
           ('00000000-0000-0000-0000-0000000000c3', 'slow', '/api/slow/*',
            ARRAY['GET'], 'http://slow-service:3003',
            true, 100, false, null, null, 5000),
           ('00000000-0000-0000-0000-0000000000c4', 'failing', '/api/failing/*',
            ARRAY['GET'], 'http://failing-service:3004',
            true, 100, false, null, '00000000-0000-0000-0000-0000000000b1', 30000)
         ON CONFLICT (id) DO NOTHING`,
      );

      const version = await getCurrentVersion(client);
      if (version === 0) {
        await client.query(
          "INSERT INTO config_versions (version, created_by, note) VALUES (1, 'seed', 'initial seeded configuration')",
        );
      }
    });
    // eslint-disable-next-line no-console
    console.log('seed complete');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
