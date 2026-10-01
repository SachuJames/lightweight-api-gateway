#!/bin/sh
# Container entrypoint: migrate, optionally seed, then start the gateway.
# Migrations and the seed script are idempotent, so restarts are safe.
set -e

echo "Running database migrations..."
node dist/scripts/migrate.js up

if [ "${SEED_ON_START:-false}" = "true" ]; then
  echo "Seeding initial data..."
  node dist/scripts/seed.js
fi

echo "Starting gateway..."
exec node dist/index.js
