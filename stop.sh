#!/usr/bin/env bash
# Laya Minesweeper — 停止服务 (macOS / Linux)
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8080}"
FOUND=0

echo "============================================================"
echo "   停止 Laya Minesweeper"
echo "============================================================"
echo

# 1) 按端口找（最可靠）
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $PIDS; do
    echo "   发现端口 ${PORT} 上的进程 PID ${pid}, 正在结束 ..."
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
    FOUND=1
  done
fi

# 2) 按命令行特征兜底（端口被改过时也能停）
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f "server\.py" 2>/dev/null || true); do
    # 只杀属于本项目的进程
    if ps -p "$pid" -o args= 2>/dev/null | grep -q "laya-minesweeper"; then
      echo "   发现本项目的进程 PID ${pid}, 正在结束 ..."
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
      FOUND=1
    fi
  done
fi

echo
if [ "$FOUND" = "1" ]; then
  echo "   已停止。"
else
  echo "   没有发现正在运行的服务。"
  echo
  echo "   提示: 若服务是在别的端口启动的, 请手动结束,"
  echo "         例如:  pkill -f server.py"
fi
echo
echo "============================================================"
