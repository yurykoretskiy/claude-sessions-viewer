#!/bin/bash
# Packages the extension as a .vsix (a zip with a manifest) without vsce,
# then installs it via the `code` CLI.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
PUBLISHER=$(node -p "require('./package.json').publisher")
OUT="${NAME}-${VERSION}.vsix"
STAGE=$(mktemp -d)

mkdir -p "$STAGE/extension/assets/screenshots"
cp package.json *.js README.md CHANGELOG.md LICENSE "$STAGE/extension/"
cp assets/*.svg assets/icon.png "$STAGE/extension/assets/"
cp assets/screenshots/*.png "$STAGE/extension/assets/screenshots/"

cat > "$STAGE/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}"/>
    <DisplayName>Claude Sessions Viewer</DisplayName>
    <Description xml:space="preserve">Browse Claude Code sessions grouped by project folder.</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
EOF

cat > "$STAGE/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>
EOF

rm -f "$OUT"
(cd "$STAGE" && zip -qr vsix.zip .) && mv "$STAGE/vsix.zip" "$OUT"
rm -rf "$STAGE"

echo "Built $OUT"
if [ "${1:-}" = "--install" ]; then
  code --install-extension "$OUT" --force
fi
