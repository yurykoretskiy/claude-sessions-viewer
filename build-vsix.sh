#!/bin/bash
# Packages the extension with the OFFICIAL packager (@vscode/vsce) so the
# .vsix carries the full manifest (icon, version, README/CHANGELOG assets,
# properties) that VS Code's extension-details page reads. The previous
# hand-rolled zip had a minimal manifest — the details page showed no version
# and rendered the README without its declared assets.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
OUT="${NAME}-${VERSION}.vsix"

VSCE="./node_modules/.bin/vsce"
if [ ! -x "$VSCE" ]; then
  echo "vsce not found locally — installing (--no-save, dev-only)"
  npm install --no-save @vscode/vsce >/dev/null 2>&1
fi

# --baseImagesUrl: VS Code's extension-details page cannot resolve relative
# image paths for sideloaded (vsix) extensions, so the packaged README must
# carry absolute URLs. The repo is public, so raw.githubusercontent resolves.
"$VSCE" package -o "$OUT" --no-git-tag-version --no-update-package-json \
  --baseImagesUrl "https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master"

echo "Built $OUT"
if [ "${1:-}" = "--install" ]; then
  code --install-extension "$OUT" --force
fi
