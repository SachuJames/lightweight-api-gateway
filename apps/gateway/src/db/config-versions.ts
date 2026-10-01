import type { DbClient } from '../db.js';

/**
 * Monotonic configuration version. Every route/policy mutation bumps it;
 * gateway instances compare their active snapshot version against this.
 */

export async function getCurrentVersion(client: DbClient): Promise<number> {
  const res = await client.query('SELECT COALESCE(MAX(version), 0)::int AS v FROM config_versions');
  return (res.rows[0] as { v: number }).v;
}

export async function bumpVersion(
  client: DbClient,
  createdBy: string | null,
  note: string | null,
): Promise<number> {
  const current = await getCurrentVersion(client);
  const next = current + 1;
  await client.query(
    'INSERT INTO config_versions (version, created_by, note) VALUES ($1, $2, $3)',
    [next, createdBy, note],
  );
  return next;
}
