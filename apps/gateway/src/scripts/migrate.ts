import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../migrations');

function dbUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const databaseUrl = dbUrl();

  if (command === 'reset') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('Refusing to reset the database in production.');
    }
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
    } finally {
      await pool.end();
    }
  }

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: command === 'down' ? 'down' : 'up',
    migrationsTable: 'pgmigrations',
    ...(command === 'down' ? { count: 1 } : {}),
    verbose: true,
  });
  // eslint-disable-next-line no-console
  console.log(`migrations ${command} complete`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
