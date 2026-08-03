#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22 或更高版本，然后重新双击此文件。"
  echo "https://nodejs.org/"
  read "?按回车键关闭…"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "当前 Node.js 版本过低。请安装 Node.js 22 或更高版本，然后重新双击此文件。"
  echo "https://nodejs.org/"
  read "?按回车键关闭…"
  exit 1
fi

echo "正在准备 ReMind 本地服务…"
npm --prefix server ci
npm --prefix gateway ci
node scripts/remind-local-setup.mjs
