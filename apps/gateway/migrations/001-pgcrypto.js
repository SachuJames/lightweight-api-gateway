/* Migration: enable pgcrypto for gen_random_uuid(). */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
