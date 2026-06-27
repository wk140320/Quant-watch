#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODEX_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
elif [ -x "$CODEX_NODE" ]; then
  NODE_BIN="$CODEX_NODE"
else
  echo "Node.js was not found. Install Node.js 20+ or start this project from Codex." >&2
  exit 1
fi

cd "$ROOT"
exec "$NODE_BIN" server.mjs
