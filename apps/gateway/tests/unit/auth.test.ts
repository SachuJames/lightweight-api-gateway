import { describe, expect, it } from 'vitest';
import {
  authenticateUser,
  extractBearerToken,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
} from '../../src/auth.js';
import { GatewayError } from '../../src/errors.js';

const AUTH = { jwtSecret: 'test-secret-at-least-32-chars-long!!', tokenTtlSec: 3600 };

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct-horse-123');
    expect(await verifyPassword('correct-horse-123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('tokens', () => {
  const user = { id: 'u1', email: 'a@b.c', role: 'admin' };

  it('round-trips claims', async () => {
    const token = await signToken(user, AUTH);
    const claims = await verifyToken(token, AUTH.jwtSecret);
    expect(claims).toMatchObject({ sub: 'u1', email: 'a@b.c', role: 'admin' });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signToken(user, AUTH);
    await expect(verifyToken(token, 'different-secret-that-is-long-enough!')).rejects.toThrow(GatewayError);
  });

  it('rejects expired tokens', async () => {
    const token = await signToken(user, { ...AUTH, tokenTtlSec: -10 });
    await expect(verifyToken(token, AUTH.jwtSecret)).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
  });

  it('rejects garbage', async () => {
    await expect(verifyToken('not.a.token', AUTH.jwtSecret)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['Bearer   abc123  ', 'abc123'],
    [undefined, null],
    ['Basic abc123', null],
    ['Bearer ', null],
  ])('parses %j', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});

describe('authenticateUser', () => {
  const stubClient = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM users')) {
        if (params[0] === 'a@b.c') {
          const hash = await hashPassword('s3cret-password');
          return {
            rows: [
              { id: 'u1', email: 'a@b.c', password_hash: hash, role: 'operator', created_at: new Date() },
            ],
          };
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as never;

  it('returns the user on correct credentials', async () => {
    const user = await authenticateUser(stubClient, 'a@b.c', 's3cret-password');
    expect(user).toMatchObject({ id: 'u1', role: 'operator' });
  });

  it('throws 401 for unknown email or wrong password', async () => {
    await expect(authenticateUser(stubClient, 'nobody@x.y', 's3cret-password')).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTHENTICATION_ERROR',
    });
    await expect(authenticateUser(stubClient, 'a@b.c', 'wrong')).rejects.toMatchObject({ statusCode: 401 });
  });
});
