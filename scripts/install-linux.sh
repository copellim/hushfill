#!/bin/sh
# Installa Hushfill per l'utente corrente (nessun privilegio richiesto):
# copia la build in ~/.local/opt, crea il comando hushfill e la voce del
# menu applicazioni registrata per i PDF, così compare in "Apri con".
# Prima: npm run install:linux (che lancia la build e poi questo script).
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

# L'app si chiamava "PDF Firma": si toglie la vecchia installazione (solo i
# programmi, non la cartella dati ~/.config/PDF Firma, che Hushfill importa al
# primo avvio) e, se era il lettore PDF predefinito, lo diventa Hushfill.
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
