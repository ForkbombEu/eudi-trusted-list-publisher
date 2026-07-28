#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"
HOST="${TLP_HOST:-0.0.0.0}"
PUB_DIR="${TLP_PUBLICATION_DIR:-./publications}"

cd "$(dirname "$0")"

echo "Building..."
npx tsc -p tsconfig.json

echo "Starting server on ${HOST}:${PORT}..."
exec node dist/src/cli/main.js serve \
  --publication-dir "$PUB_DIR" \
  --host "$HOST" \
  --port "$PORT"
