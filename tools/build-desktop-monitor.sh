#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/GlobalQuantMonitor.app"
CACHE="${TMPDIR:-/private/tmp}/global-quant-swift-cache"

mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/tools/GlobalQuantMonitor-Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

/usr/bin/swiftc \
  -O \
  -module-cache-path "$CACHE" \
  -framework AppKit \
  -framework WebKit \
  "$ROOT/tools/GlobalQuantMonitorMain.swift" \
  -o "$APP/Contents/MacOS/GlobalQuantMonitor"

/usr/bin/xattr -cr "$APP"
/usr/bin/codesign --force --deep --sign - --timestamp=none "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"

printf 'Built %s\n' "$APP"
