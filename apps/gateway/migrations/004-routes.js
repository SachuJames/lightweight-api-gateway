/* Migration: routes table — the source of truth for gateway routing. */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('routes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    path_pattern: { type: 'text', notNull: true },
    methods: { type: 'text[]', notNull: true },
    upstream_url: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
    priority: { type: 'integer', notNull: true, default: 100 },
    auth_required: { type: 'boolean', notNull: true, default: false },
    rate_limit_policy_id: {
      type: 'uuid',
      references: 'rate_limit_policies',
      onDelete: 'SET NULL',
    },
    circuit_breaker_policy_id: {
      type: 'uuid',
      references: 'circuit_breaker_policies',
      onDelete: 'SET NULL',
    },
    timeout_ms: { type: 'integer', notNull: true, default: 30000 },
    plugin_config: { type: 'jsonb', notNull: true, default: '{}' },
    version: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('routes', ['enabled', 'priority']);
  pgm.createIndex('routes', 'path_pattern');
};

exports.down = (pgm) => {
  pgm.dropTable('routes');
};
