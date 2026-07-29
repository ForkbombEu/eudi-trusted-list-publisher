#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# The optional root .env is loaded with Node's native environment-file support.
# Variables already exported in the shell take precedence over the file, so the
# LAN binding, port handling and publication directory keep their behaviour.
ENV_FILE_FLAG="--env-file-if-exists=.env"

IFS=$'\t' read -r HOST PORT PUB_DIR < <(node "$ENV_FILE_FLAG" -e '
const env = process.env;
process.stdout.write([
  env.TLP_HOST || "0.0.0.0",
  env.PORT || env.TLP_PORT || "8080",
  env.TLP_PUBLICATION_DIR || "./publications",
].join("\t") + "\n");
')

echo "Building..."
npx tsc -p tsconfig.json

echo "Starting server on ${HOST}:${PORT}..."
exec node "$ENV_FILE_FLAG" dist/src/cli/main.js serve \
  --publication-dir "$PUB_DIR" \
  --host "$HOST" \
  --port "$PORT"
