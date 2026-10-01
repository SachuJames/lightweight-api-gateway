import { loadEnvFile } from './env.js';
import { z } from 'zod';

loadEnvFile();

const DEV_JWT_SECRET = 'dev-only-change-me-in-any-shared-environment';

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a boolean env var. `z.coerce.boolean()` is wrong here: it turns the
 * string "false" into `true` because any non-empty string is truthy.
 */
function bool(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no', ''].includes(normalized)) return false;
      ctx.addIssue({
        code: 'custom',
        message: `Expected a boolean (true/false), got "${value}"`,
      });
      return z.NEVER;
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  TLS_ENABLED: bool(false),
  TLS_CERT_PATH: z.string().default('.local/certs/server.crt'),
  TLS_KEY_PATH: z.string().default('.local/certs/server.key'),
  HTTPS_REDIRECT: bool(false),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('15m'),
  ADMIN_EMAIL: z.email().default('admin@example.local'),
  ADMIN_PASSWORD: z.string().min(8).default('admin123'),
  TRUSTED_PROXIES: z.string().default(''),
  RATE_LIMIT_FAIL_OPEN: bool(true),
  ADMIN_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  ADMIN_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  SSRF_DEV_ALLOWLIST: z.string().default(''),
  UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  UPSTREAM_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MAX_HEADER_BYTES: z.coerce.number().int().positive().default(8_192),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: bool(false),
  METRICS_PATH: z.string().startsWith('/').default('/internal/metrics'),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
});

export type GatewayConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  httpsPort: number;
  tlsEnabled: boolean;
  tlsCertPath: string;
  tlsKeyPath: string;
  httpsRedirect: boolean;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  adminEmail: string;
  adminPassword: string;
  trustedProxies: string[];
  rateLimitFailOpen: boolean;
  adminLoginMaxAttempts: number;
  adminLoginWindowMs: number;
  ssrfDevAllowlist: string[];
  upstreamConnectTimeoutMs: number;
  upstreamResponseTimeoutMs: number;
  maxBodyBytes: number;
  maxHeaderBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logPretty: boolean;
  metricsPath: string;
  corsAllowedOrigins: string[];
  isDevSecret: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${issues.join('\n  ')}`);
  }
  const e = parsed.data;

  const isDevSecret = e.JWT_SECRET === DEV_JWT_SECRET;
  if (e.NODE_ENV === 'production') {
    if (isDevSecret) {
      throw new Error('Refusing to start: JWT_SECRET is the development default.');
    }
    if (e.JWT_SECRET.length < 32) {
      throw new Error(
        'Refusing to start: JWT_SECRET must be at least 32 characters in production.',
      );
    }
    if (e.ADMIN_PASSWORD === 'admin123') {
      throw new Error('Refusing to start: ADMIN_PASSWORD is the development default.');
    }
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    httpsPort: e.HTTPS_PORT,
    tlsEnabled: e.TLS_ENABLED,
    tlsCertPath: e.TLS_CERT_PATH,
    tlsKeyPath: e.TLS_KEY_PATH,
    httpsRedirect: e.HTTPS_REDIRECT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    jwtExpiresIn: e.JWT_EXPIRES_IN,
    adminEmail: e.ADMIN_EMAIL,
    adminPassword: e.ADMIN_PASSWORD,
    trustedProxies: csv(e.TRUSTED_PROXIES),
    rateLimitFailOpen: e.RATE_LIMIT_FAIL_OPEN,
    adminLoginMaxAttempts: e.ADMIN_LOGIN_MAX_ATTEMPTS,
    adminLoginWindowMs: e.ADMIN_LOGIN_WINDOW_MS,
    ssrfDevAllowlist: csv(e.SSRF_DEV_ALLOWLIST),
    upstreamConnectTimeoutMs: e.UPSTREAM_CONNECT_TIMEOUT_MS,
    upstreamResponseTimeoutMs: e.UPSTREAM_RESPONSE_TIMEOUT_MS,
    maxBodyBytes: e.MAX_BODY_BYTES,
    maxHeaderBytes: e.MAX_HEADER_BYTES,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
    metricsPath: e.METRICS_PATH,
    corsAllowedOrigins: csv(e.CORS_ALLOWED_ORIGINS),
    isDevSecret,
  };
}

/** Non-secret startup diagnostics, safe to log. */
export function describeConfig(c: GatewayConfig): Record<string, unknown> {
  return {
    nodeEnv: c.nodeEnv,
    port: c.port,
    tlsEnabled: c.tlsEnabled,
    httpsRedirect: c.httpsRedirect,
    trustedProxies: c.trustedProxies.length,
    rateLimitFailOpen: c.rateLimitFailOpen,
    upstreamConnectTimeoutMs: c.upstreamConnectTimeoutMs,
    upstreamResponseTimeoutMs: c.upstreamResponseTimeoutMs,
    maxBodyBytes: c.maxBodyBytes,
    corsAllowedOrigins: c.corsAllowedOrigins,
    devCredentials: c.isDevSecret,
  };
}
