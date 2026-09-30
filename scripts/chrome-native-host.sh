#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
for n in "$CANBAN_NODE" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do
  [ -n "$n" ] && [ -x "$n" ] && ok "$n" && exec "$n" --no-warnings "$DIR/scripts/chrome-native-host.mjs"
done
echo "[canban chrome] Node.js >= 22.13 が見つかりません" >&2
exit 1
