#!/usr/bin/env bash
# Generate self-signed certificates for LOCAL DEVELOPMENT ONLY.
# Never use these in production; terminate TLS with a real certificate there.
set -euo pipefail

OUT_DIR="${1:-.local/certs}"
mkdir -p "$OUT_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but not installed." >&2
  exit 1
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/server.key" \
  -out "$OUT_DIR/server.crt" \
  -days 825 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:gateway,IP:127.0.0.1" \
  2>/dev/null

chmod 600 "$OUT_DIR/server.key"
chmod 644 "$OUT_DIR/server.crt"

echo "Wrote $OUT_DIR/server.key and $OUT_DIR/server.crt"
echo "Enable with: TLS_ENABLED=true (see .env.example)"
