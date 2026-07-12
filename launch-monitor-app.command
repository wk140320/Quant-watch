#!/bin/zsh
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

LOG_DIR="$SCRIPT_DIR/.cache/backend-monitor"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/desktop-app-launch.log"
exec >> "$LOG_FILE" 2>&1

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] launching Global Quant Monitor"

PYTHON_BIN=""
for candidate in "$SCRIPT_DIR/.venv/bin/python" /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [[ -x "$candidate" ]]; then
    PYTHON_BIN="$candidate"
    break
  fi
done

if [[ -z "$PYTHON_BIN" ]]; then
  /usr/bin/osascript -e 'display dialog "未找到 Python 3，无法启动 Global Quant Monitor。" buttons {"OK"} with icon stop' >/dev/null 2>&1
  exit 1
fi

echo "python=$PYTHON_BIN"
exec "$PYTHON_BIN" desktop_monitor_app.py
