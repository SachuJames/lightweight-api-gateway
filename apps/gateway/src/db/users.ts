import type { DbClient } from '../db.js';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: string;
}

export async function getUserByEmail(client: DbClient, email: string): Promise<UserRecord | null> {
  const res = await client.query(
    'SELECT id, email, password_hash, role, created_at FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  const row = res.rows[0] as
    | { id: string; email: string; password_hash: string; role: string; created_at: Date }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createUser(
  client: DbClient,
  input: { email: string; passwordHash: string; role: string },
): Promise<UserRecord> {
  const res = await client.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, password_hash, role, created_at`,
    [input.email.toLowerCase(), input.passwordHash, input.role],
  );
  const row = res.rows[0] as
    | { id: string; email: string; password_hash: string; role: string; created_at: Date }
    | undefined;
  if (!row) {
    const existing = await getUserByEmail(client, input.email);
    if (!existing) throw new Error('createUser conflict could not be resolved');
    return existing;
  }
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}
