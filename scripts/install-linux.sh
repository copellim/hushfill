#!/bin/sh
# Installs Hushfill for the current user (no privileges required):
# copies the build to ~/.local/opt, creates the hushfill command and the
# application menu entry registered for PDFs, so it shows up in "Open with".
# Before: npm run install:linux (which runs the build and then this script).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/release/linux-unpacked"
TARGET="$HOME/.local/opt/hushfill"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"

if [ ! -x "$SOURCE/hushfill" ]; then
  echo "Build non trovata in $SOURCE: lancia prima 'npm run install:linux'." >&2
  exit 1
fi

mkdir -p "$TARGET" "$BIN" "$APPS" "$ICONS"
rm -rf "$TARGET"
cp -r "$SOURCE" "$TARGET"
ln -sf "$TARGET/hushfill" "$BIN/hushfill"
cp "$ROOT/build/icon.png" "$ICONS/hushfill.png"

cat > "$APPS/hushfill.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hushfill
Comment=Visualizza, compila e firma documenti PDF
Exec=$TARGET/hushfill %F
Icon=hushfill
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;
StartupWMClass=Hushfill
EOF

# The app used to be called "PDF Firma": the old installation is removed (only
# the programs, not the data folder ~/.config/PDF Firma, which Hushfill imports
# on first launch) and, if it was the default PDF reader, Hushfill becomes it.
LEGACY_DESKTOP="pdf-firma.desktop"
if [ "$(xdg-mime query default application/pdf 2>/dev/null)" = "$LEGACY_DESKTOP" ]; then
  xdg-mime default hushfill.desktop application/pdf
  echo "Lettore PDF predefinito: da PDF Firma a Hushfill"
fi
if [ -e "$HOME/.local/opt/pdf-firma" ] || [ -e "$APPS/$LEGACY_DESKTOP" ]; then
  rm -rf "$HOME/.local/opt/pdf-firma"
  rm -f "$BIN/pdf-firma" "$APPS/$LEGACY_DESKTOP" "$ICONS/pdf-firma.png"
  echo "Tolta la vecchia installazione di PDF Firma"
fi

update-desktop-database "$APPS" 2>/dev/null || true

echo "Installato in $TARGET"
echo "Per aprire i PDF con Hushfill di default:"
echo "  xdg-mime default hushfill.desktop application/pdf"
