#!/usr/bin/env bash
# Renders every artboard of this reel to a PNG in ./png/, numbered in reel
# order (01 = the hook, 10 = the CTA), 1080×1920 for TikTok photo mode /
# Reels / Stories.
#
# Each .dc.html is a Design Component: the frame markup lives inside <x-dc>
# and the fonts inside <helmet>. Neither tag means anything to a browser, so
# the frame is unwrapped into a plain HTML file next to the assets first
# (./k-mark.png and ./kwill-wordmark.png resolve relatively), rendered, and
# the temp file removed.
#
# Rendered at 2× device scale then downsampled with sips, for crisp text.
# Needs a headless Chrome. Uses Puppeteer's cached chrome-headless-shell by
# default; override with CHROME_BIN=/path/to/chrome.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/png"
BIN="${CHROME_BIN:-$(find "$HOME/.cache/puppeteer" -maxdepth 6 -type f -name chrome-headless-shell 2>/dev/null | head -1)}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "No headless Chrome found. Set CHROME_BIN=/path/to/chrome-headless-shell (or Google Chrome)." >&2
  exit 1
fi

# Reel order, right to left on the canvas.
ORDER=(Main Fikra Anawin Yaarafhom Safha Rabet Qadim Logha Aawed Nihaya)
# The slug each frame is about, so a filename says what it shows.
SLUG=(hook not-paragraphs from-headings infers own-page links old-toc language rebuild cta)

mkdir -p "$OUT"
echo "Rendering with: $BIN"

for i in "${!ORDER[@]}"; do
  name="${ORDER[$i]}"
  n=$(printf "%02d" $((i + 1)))
  base="$n-${SLUG[$i]}"
  tmp="$HERE/.render-$name.html"

  python3 - "$HERE/$name.dc.html" "$tmp" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
body = re.search(r"(?s)<x-dc>(.*?)</x-dc>", s).group(1)
body = body.replace("<helmet>", "").replace("</helmet>", "")
open(dst, "w", encoding="utf-8").write(
    '<!doctype html><html><head><meta charset="utf-8">'
    "<style>html,body{margin:0;padding:0;}</style></head><body>" + body + "</body></html>")
PY

  "$BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
         --allow-file-access-from-files --force-device-scale-factor=2 \
         --window-size=1080,1920 --virtual-time-budget=4000 \
         --screenshot="$OUT/$base@2x.png" "file://$tmp" >/dev/null 2>&1
  sips --resampleWidth 1080 "$OUT/$base@2x.png" --out "$OUT/$base.png" >/dev/null
  rm -f "$OUT/$base@2x.png" "$tmp"
  echo "  png/$base.png"
done

echo "Done → $OUT"
