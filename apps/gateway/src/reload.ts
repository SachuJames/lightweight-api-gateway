import type { Redis } from 'ioredis';
import { ConfigStore } from './config-service.js';
import type { DbClient } from './db.js';
import { getCurrentVersion } from './db/config-versions.js';

/**
 * Zero-downtime configuration reload.
 *
 * Writers (the admin API) bump the config version in Postgres and publish the
 * new version on a Redis channel. Every gateway instance subscribes; on
 * notification it refreshes its snapshot and atomically swaps it in, so
 * in-flight requests finish on the old config and new requests use the new
 * one. A periodic poll is a backstop for missed messages.
 */

export const CONFIG_RELOAD_CHANNEL = 'gateway:config:reload';

export interface ReloadMessage {
  version: number;
  at: string;
}

export async function notifyConfigChange(publisher: Redis, version: number): Promise<void> {
  const message: ReloadMessage = { version, at: new Date().toISOString() };
  await publisher.publish(CONFIG_RELOAD_CHANNEL, JSON.stringify(message));
}

export interface ReloaderOptions {
  channel?: string;
  /** Backstop poll; 0 disables. Defaults to 15s. */
  pollIntervalMs?: number;
  onReload?: (from: number, to: number) => void;
  onError?: (err: Error) => void;
}

export class ConfigReloader {
  private store: ConfigStore;
  private db: DbClient;
  private subscriber: Redis;
  private channel: string;
  private pollIntervalMs: number;
  private onReload: ((from: number, to: number) => void) | undefined;
  private onError: ((err: Error) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(store: ConfigStore, db: DbClient, subscriber: Redis, opts: ReloaderOptions = {}) {
    this.store = store;
    this.db = db;
    this.subscriber = subscriber;
    this.channel = opts.channel ?? CONFIG_RELOAD_CHANNEL;
    this.pollIntervalMs = opts.pollIntervalMs ?? 15_000;
    this.onReload = opts.onReload;
    this.onError = opts.onError;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.subscriber.on('message', (channel, raw) => {
      if (channel !== this.channel) return;
      this.handleMessage(raw).catch((err) => this.onError?.(err as Error));
    });
    await this.subscriber.subscribe(this.channel);
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.checkForUpdates().catch((err) => this.onError?.(err as Error));
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscriber.removeAllListeners('message');
    await this.subscriber.unsubscribe(this.channel).catch(() => undefined);
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: ReloadMessage;
    try {
      message = JSON.parse(raw) as ReloadMessage;
    } catch {
      return; // ignore malformed messages
    }
    if (typeof message.version !== 'number') return;
    await this.reloadIfBehind(message.version);
  }

  private async checkForUpdates(): Promise<void> {
    // Backstop for missed pub/sub messages: compare the database version and
    // refresh only when behind.
    const latest = await getCurrentVersion(this.db);
    await this.reloadIfBehind(latest);
  }

  private async reloadIfBehind(version: number): Promise<void> {
    if (version <= this.store.version()) return;
    const { from, to } = await this.store.refresh(this.db);
    if (to > from) this.onReload?.(from, to);
  }
}
