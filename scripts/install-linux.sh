#!/bin/sh
# Installa PDF Firma per l'utente corrente (nessun privilegio richiesto):
# copia la build in ~/.local/opt, crea il comando pdf-firma e la voce del
# menu applicazioni registrata per i PDF, così compare in "Apri con".
# Prima: npm run install:linux (che lancia la build e poi questo script).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/release/linux-unpacked"
TARGET="$HOME/.local/opt/pdf-firma"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"

if [ ! -x "$SOURCE/pdf-firma" ]; then
  echo "Build non trovata in $SOURCE: lancia prima 'npm run install:linux'." >&2
  exit 1
fi

mkdir -p "$TARGET" "$BIN" "$APPS" "$ICONS"
rm -rf "$TARGET"
cp -r "$SOURCE" "$TARGET"
ln -sf "$TARGET/pdf-firma" "$BIN/pdf-firma"
cp "$ROOT/build/icon.png" "$ICONS/pdf-firma.png"

cat > "$APPS/pdf-firma.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PDF Firma
Comment=Visualizza, compila e firma documenti PDF
Exec=$TARGET/pdf-firma %F
Icon=pdf-firma
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;
StartupWMClass=PDF Firma
EOF

update-desktop-database "$APPS" 2>/dev/null || true

echo "Installato in $TARGET"
echo "Per aprire i PDF con PDF Firma di default:"
echo "  xdg-mime default pdf-firma.desktop application/pdf"
