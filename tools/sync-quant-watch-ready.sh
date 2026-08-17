#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="${QUANT_WATCH_READY_DEST:-/Users/wukai/Documents/Codex/Quant-watch-ready}"

if [[ ! -d "$DEST" ]]; then
  echo "Destination does not exist: $DEST" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quant-watch-ready.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT

rsync -a \
  --exclude .git \
  --exclude .cache \
  --exclude catboost_info \
  --exclude .pnpm-store \
  --exclude .share \
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
  --exclude reports \
  --exclude 'record*' \
  --exclude Quant-watch-open-source.tar.gz \
  --exclude Quant-watch-ready-update.tar.gz \
  ./ "$STAGING_DIR/"

# Mirror the sanitized staging tree while preserving the destination repository.
# This removes private or generated files left behind by older sync runs.
rsync -a --delete --filter='P /.git/***' "$STAGING_DIR/" "$DEST/"

echo "Synced safe project files to $DEST"
