#!/usr/bin/env bash
# Laya Minesweeper — macOS / Linux 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8080}"

echo "============================================================"
echo "   Laya Minesweeper"
echo "============================================================"
echo
echo "   代码负责数学约束, Laya 负责判断"
echo
echo "   首次运行会下载模型权重, 约 650 MB"
echo
echo "============================================================"
echo

PY="python3"
[ -x ".venv/bin/python" ] && PY=".venv/bin/python"

if ! "$PY" -c "import laya" >/dev/null 2>&1; then
  echo "[提示] 未检测到 laya, 正在安装 ..."
  "$PY" -m pip install --quiet laya
fi

echo "   启动中, 浏览器会自动打开 ..."
echo

# 后台延迟打开浏览器
(
  sleep 20
  URL="http://127.0.0.1:${PORT}/"
  if command -v open >/dev/null 2>&1;      then open "$URL"        # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"   # Linux
  fi
) &

exec "$PY" server.py --port "$PORT"
