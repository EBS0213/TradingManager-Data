#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  read -r -p "설치된 TradingManager 폴더 경로를 입력하세요: " TARGET
fi
TARGET="${TARGET/#\~/$HOME}"
node --max-old-space-size=4096 restore.mjs "$TARGET"
read -r -p "완료. Enter를 누르면 닫습니다." _
