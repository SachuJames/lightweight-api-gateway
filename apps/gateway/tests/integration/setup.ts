import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const ADMIN_URL = 'postgres://gateway:gateway@localhost:5432/postgres';

/**
 * Creates a fresh, migrated database for an integration test file.
 * Each file gets its own database so files can run in parallel.
 */
export async function setupTestDb(name: string): Promise<Pool> {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }
  const url = `postgres://gateway:gateway@localhost:5432/${name}`;
  const fresh = new Pool({ connectionString: url });
  try {
    await fresh.query('DROP SCHEMA public CASCADE');
    await fresh.query('CREATE SCHEMA public');
  } finally {
    await fresh.end();
  }
  await runner({ databaseUrl: url, dir: migrationsDir, direction: 'up', migrationsTable: 'pgmigrations' });
  return new Pool({ connectionString: url });
}
