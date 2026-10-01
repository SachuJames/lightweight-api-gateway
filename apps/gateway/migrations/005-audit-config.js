/* Migration: append-only audit log and configuration version counter. */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('audit_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    actor: { type: 'text', notNull: true },
    action: { type: 'text', notNull: true },
    resource_type: { type: 'text', notNull: true },
    resource_id: { type: 'text' },
    before: { type: 'jsonb' },
    after: { type: 'jsonb' },
    request_id: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: '{}' },
  });
  pgm.createIndex('audit_logs', 'created_at');
  pgm.createIndex('audit_logs', 'actor');
  pgm.createIndex('audit_logs', ['resource_type', 'resource_id']);

  pgm.createTable('config_versions', {
    id: { type: 'serial', primaryKey: true },
    version: { type: 'integer', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'text' },
    note: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('config_versions');
  pgm.dropTable('audit_logs');
};
