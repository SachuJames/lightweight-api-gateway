import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://gateway:gateway@localhost:5432/gateway_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-very-long-test-secret-that-is-safe',
};

describe('loadConfig', () => {
  it('loads defaults for a development environment', () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: 'development' });
    expect(c.port).toBe(8080);
    expect(c.nodeEnv).toBe('development');
    expect(c.rateLimitFailOpen).toBe(true);
    expect(c.maxBodyBytes).toBe(1_048_576);
  });

  it('parses comma-separated lists', () => {
    const c = loadConfig({ ...baseEnv, CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test ' });
    expect(c.corsAllowedOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '99999' })).toThrow(/Invalid configuration/);
  });

  it('rejects missing required values', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('refuses production with the development JWT secret', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'dev-only-change-me-in-any-shared-environment',
      }),
    ).toThrow(/development default/);
  });

  it('refuses production with a short JWT secret', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'short-secret-value!!',
        ADMIN_PASSWORD: 'a-strong-dev-password',
      }),
    ).toThrow(/at least 32 characters/);
  });

  it('describeConfig never exposes secrets', () => {
    const c = loadConfig(baseEnv);
    const d = JSON.stringify(describeConfig(c));
    expect(d).not.toContain('a-very-long-test-secret');
    expect(d).not.toContain('gateway_dev');
  });
});
