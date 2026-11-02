#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 24 或更高版本，再双击本文件。"
  read -r -p "按回车退出…" _answer
  exit 1
fi
node scripts/start.mjs
