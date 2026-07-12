#!/usr/bin/env bash
# Build a load-unpacked / Chrome Web Store zip of the Wick extension.
# manifest.json sits at the zip root so "Load unpacked" works directly.
# Output: ../wick-v<version>.zip  (one directory above extension/)
set -euo pipefail

cd "$(dirname "$0")"

VERSION="$(node -p "require('./manifest.json').version")"
OUT="../wick-v${VERSION}.zip"

rm -f "$OUT"

# Ship only what the extension needs; exclude repo/dev/OS cruft.
zip -r "$OUT" . \
  -x "build.sh" \
  -x "*.DS_Store" \
  -x ".git/*" \
  -x ".gitignore" \
  -x "PROGRESS.md" \
  -x "TESTING.md" \
  -x "README.md" \
  > /dev/null

echo "✓ Built $OUT"
unzip -l "$OUT" | tail -n 1
