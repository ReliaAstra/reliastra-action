#!/usr/bin/env bash
# Regenerate .github/social-preview.png from assets/social-preview.html.
#
# GitHub has no API for a repository's social preview image; it is uploaded in
# Settings -> General -> Social preview. That makes the source the only durable
# copy, so the HTML is committed and this script is the documented way to
# reproduce the PNG. If you change the design, change the HTML, re-run this,
# and re-upload.
#
# Requires: Google Chrome or Chromium on PATH. Edit CHROME below if needed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
OUT="$ROOT/.github/social-preview.png"

if [ ! -f "$CHROME" ]; then
  echo "Chrome not found at $CHROME" >&2
  echo "Set CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi

# GitHub's preview is rendered around 1280x640. A device scale factor of 1 keeps
# the PNG at exactly that size; anything higher uploads a file GitHub will
# downscale, losing the crispness of the small type.
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size=1280,640 \
  --screenshot="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")" \
  "file://$(cygpath -m "$ROOT/assets/social-preview.html" 2>/dev/null || echo "$ROOT/assets/social-preview.html")" \
  2>/dev/null

test -f "$OUT" || { echo "render failed: $OUT was not written" >&2; exit 1; }
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
echo
echo "Now upload it: repository Settings -> General -> Social preview -> Upload an image."