import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import type { DbClient } from './db.js';
import { getUserByEmail, type UserRecord } from './db/users.js';
import { ErrorCodes, GatewayError } from './errors.js';

export const PUBLIC_PATHS = ['/health', '/ready', '/api/auth/login'];

export interface TokenClaims {
  sub: string;
  email: string;
  role: string;
}

export interface AuthConfig {
  jwtSecret: string;
  /** Access token lifetime in seconds. */
  tokenTtlSec: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signToken(
  user: Pick<UserRecord, 'id' | 'email' | 'role'>,
  auth: AuthConfig,
): Promise<string> {
  return new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${auth.tokenTtlSec}s`)
    .sign(new TextEncoder().encode(auth.jwtSecret));
}

export async function verifyToken(token: string, secret: string): Promise<TokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    }));
  } catch {
    throw new GatewayError(ErrorCodes.AUTHENTICATION_ERROR, 401, 'Invalid or expired token.');
  }
  const sub = payload['sub'];
  const email = payload['email'];
  const role = payload['role'];
  if (typeof sub !== 'string' || typeof email !== 'string' || typeof role !== 'string') {
    throw new GatewayError(
      ErrorCodes.AUTHENTICATION_ERROR,
      401,
      'Token is missing required claims.',
    );
  }
  return { sub, email, role };
}

/** Verify email+password against the users table. Throws 401 on any mismatch. */
export async function authenticateUser(
  client: DbClient,
  email: string,
  password: string,
): Promise<Pick<UserRecord, 'id' | 'email' | 'role'>> {
  const user = await getUserByEmail(client, email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new GatewayError(ErrorCodes.AUTHENTICATION_ERROR, 401, 'Invalid email or password.');
  }
  return { id: user.id, email: user.email, role: user.role };
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match?.[1] ? match[1].trim() : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: TokenClaims;
  }
}

/**
 * Attaches `request.authUser` when a valid Bearer token is present.
 * Public paths skip auth entirely; other paths get `authUser` only if the
 * token verifies (proxied routes check `route.authRequired` themselves, and
 * the admin API enforces roles per route).
 */
export function registerAuthPlugin(app: FastifyInstance, auth: AuthConfig): void {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (PUBLIC_PATHS.includes(req.raw.url?.split('?')[0] ?? '')) return;
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return;
    req.authUser = await verifyToken(token, auth.jwtSecret);
  });
}

/** Pre-handler: require any authenticated user. */
export function requireAuth(req: FastifyRequest, _reply: FastifyReply): void {
  if (!req.authUser) {
    throw new GatewayError(ErrorCodes.AUTHENTICATION_ERROR, 401, 'Authentication required.');
  }
}

/**
 * Pre-handler factory: require at least the lowest-ranked of the given roles.
 * Roles are hierarchical: viewer < operator < admin, so `requireRole('operator')`
 * admits operators and admins. Unknown roles never satisfy a requirement.
 */
export function requireRole(...roles: string[]) {
  const required = Math.min(...roles.map(roleRank));
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.authUser) {
      throw new GatewayError(ErrorCodes.AUTHENTICATION_ERROR, 401, 'Authentication required.');
    }
    if (roleRank(req.authUser.role) < required) {
      throw new GatewayError(ErrorCodes.AUTHORIZATION_ERROR, 403, 'Insufficient permissions.');
    }
  };
}

/** Numeric rank for the role hierarchy; unknown roles rank below everything. */
export function roleRank(role: string): number {
  switch (role) {
    case 'viewer':
      return 0;
    case 'operator':
      return 1;
    case 'admin':
      return 2;
    default:
      return -1;
  }
}
