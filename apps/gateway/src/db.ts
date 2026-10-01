import { Pool, type PoolClient } from 'pg';

/**
 * PostgreSQL access: one shared pool, parameterized queries only,
 * explicit transaction helper. No query builder, no string-built SQL.
 */

let pool: Pool | null = null;

export function getPool(config: { databaseUrl: string }, onError?: (err: Error) => void): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    pool.on('error', (err) => {
      if (onError) onError(err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export type DbClient = Pool | PoolClient;
