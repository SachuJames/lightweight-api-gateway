import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { AuditService } from './audit-service.js';
import { CircuitBreakerRegistry } from './circuit-breaker.js';
import { loadConfig } from './config.js';
import { ConfigStore, loadSnapshot } from './config-service.js';
import { MetricsRegistry } from './metrics.js';
import { PluginManager } from './plugins.js';
import { createRedis } from './redis.js';
import { ConfigReloader } from './reload.js';
import { buildServer } from './server.js';

/** Parse "15m"/"1h"/"30s"/"2d" (or bare seconds) into seconds. */
function parseTtlSec(value: string): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid JWT_EXPIRES_IN: ${value}`);
  const n = Number(m[1]);
  switch (m[2] ?? 's') {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86_400;
    default:
      return n;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
  pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err);
  });

  const redis = createRedis(config.redisUrl);
  const publisher = createRedis(config.redisUrl);
  const subscriber = createRedis(config.redisUrl);
  await redis.ping();

  const snapshot = await loadSnapshot(pool);
  const store = new ConfigStore(snapshot);

  const metrics = new MetricsRegistry();

  const reloader = new ConfigReloader(store, pool, subscriber, {
    pollIntervalMs: 15_000,
    onReload: () => {
      metrics.inc('gateway.config_reloads', { result: 'ok' });
    },
    onError: (err: unknown) => {
      metrics.inc('gateway.config_reloads', { result: 'error' });
      console.error('Config reload error:', err);
    },
  });
  await reloader.start();

  const plugins = new PluginManager();
  const pluginDir = process.env['PLUGIN_DIR'];
  if (pluginDir) {
    const result = await plugins.loadFromDirectory(pluginDir);
    for (const name of result.loaded) {
      console.log(`Loaded plugin: ${name}`);
    }
    for (const failure of result.failed) {
      console.error(`Failed to load plugin ${failure.file}: ${failure.error}`);
    }
  }

  const tls =
    config.tlsEnabled
      ? {
          key: await readFile(config.tlsKeyPath),
          cert: await readFile(config.tlsCertPath),
        }
      : undefined;

  const app = await buildServer({
    config,
    pool,
    redis,
    publisher,
    store,
    plugins,
    metrics,
    breakers: new CircuitBreakerRegistry(),
    auth: { jwtSecret: config.jwtSecret, tokenTtlSec: parseTtlSec(config.jwtExpiresIn) },
    audit: new AuditService(pool),
    ...(tls ? { tls } : {}),
  });

  // Optional plain-HTTP listener that redirects everything to HTTPS.
  // Declared up here so the shutdown handler below can close it.
  let redirectApp: FastifyInstance | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await app.close();
    } catch (err) {
      console.error('Error closing server:', err);
    }
    if (redirectApp !== undefined) {
      await redirectApp.close().catch((err: unknown) => {
        console.error('Error closing redirect server:', err);
      });
    }
    reloader.stop().catch((err: unknown) => {
      console.error('Error stopping reloader:', err);
    });
    redis.disconnect();
    publisher.disconnect();
    subscriber.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(
    `${config.tlsEnabled ? 'HTTPS' : 'HTTP'} gateway listening on :${config.port} ` +
      `(config v${store.current().version}, ${store.current().routes.length} routes).`,
  );

  if (config.tlsEnabled && config.httpsRedirect) {
    const { default: Fastify } = await import('fastify');
    redirectApp = Fastify({ logger: false });
    redirectApp.all('*', async (req, reply) => {
      const host = (req.headers.host ?? 'localhost').split(':')[0];
      return reply.redirect(`https://${host}:${config.httpsPort}${req.url}`, 301);
    });
    await redirectApp.listen({ port: 8080, host: '0.0.0.0' });
    console.log(`HTTP->HTTPS redirect listening on :8080, targeting :${config.httpsPort}.`);
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});
