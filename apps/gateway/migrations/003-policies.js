/* Migration: rate-limit and circuit-breaker policy tables. */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('rate_limit_policies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    capacity: { type: 'integer', notNull: true },
    refill_rate_per_sec: { type: 'numeric', notNull: true },
    key_strategy: { type: 'text', notNull: true },
    fail_open: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('circuit_breaker_policies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    failure_threshold: { type: 'integer', notNull: true },
    rolling_window_ms: { type: 'integer', notNull: true },
    open_duration_ms: { type: 'integer', notNull: true },
    half_open_max_probes: { type: 'integer', notNull: true },
    failure_statuses: { type: 'integer[]', notNull: true },
    count_timeouts: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('circuit_breaker_policies');
  pgm.dropTable('rate_limit_policies');
};
