#!/usr/bin/env bash
# Renders every slide-*.html in this folder to PNG, twice:
#   ../4x5/   1080×1350  (Instagram / Facebook feed carousel)
#   ../9x16/  1080×1920  (TikTok photo mode / Stories / Reels cover)
# Rendered at 2× device scale, then downsampled with sips for crisp text.
#
# Needs a headless Chrome. Uses Puppeteer's cached chrome-headless-shell by
# default; override with CHROME_BIN=/path/to/chrome.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"
BIN="${CHROME_BIN:-$(find "$HOME/.cache/puppeteer" -maxdepth 6 -type f -name chrome-headless-shell 2>/dev/null | head -1)}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "No headless Chrome found. Set CHROME_BIN=/path/to/chrome-headless-shell (or Google Chrome)." >&2
  exit 1
fi

render() { # <html> <variant> <width> <height>
  local f="$1" variant="$2" w="$3" h="$4"
  local base; base="$(basename "$f" .html)"
  local dir="$OUT/$variant"; mkdir -p "$dir"
  local tmp="$dir/$base@2x.png"
  "$BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
         --allow-file-access-from-files --force-device-scale-factor=2 \
         --window-size="$w,$h" --virtual-time-budget=4000 \
         --screenshot="$tmp" "file://$f" >/dev/null 2>&1
  sips --resampleWidth "$w" "$tmp" --out "$dir/$base.png" >/dev/null
  rm -f "$tmp"
  echo "  $variant/$base.png"
}

echo "Rendering with: $BIN"
for f in "$HERE"/slide-*.html; do
  render "$f" 4x5  1080 1350
  render "$f" 9x16 1080 1920
done
echo "Done → $OUT/4x5 and $OUT/9x16"
