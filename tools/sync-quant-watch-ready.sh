#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="/Users/wukai/Documents/Codex/Quant-watch-ready"

if [[ ! -d "$DEST" ]]; then
  echo "Destination does not exist: $DEST" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
rsync -a \
  --exclude .git \
  --exclude .cache \
  --exclude catboost_info \
  --exclude .pnpm-store \
  --exclude .venv \
  --include .env.example \
  --exclude '.env*' \
  --exclude __pycache__ \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude GlobalQuantMonitorLocal.app \
  --exclude GlobalQuantMonitor.app \
  --exclude Quant-watch \
  --exclude node_modules \
  --exclude 'record*' \
  --exclude Quant-watch-open-source.tar.gz \
  ./ "$DEST/"

echo "Synced safe project files to $DEST"
