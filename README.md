# Hushfill

A simple desktop PDF viewer that fills in forms, writes on the blank lines of print-and-fill forms, adds free text and signs. With saved profiles it recognises which fields to fill, either on the computer or through Jev, and fills them with your data. Linux, Windows and macOS (Electron).

The interface is in Italian and so are the forms it is tuned for (Italian tax code, "nato/a a", "Luogo e data"). Interface labels are quoted below in Italian, with their meaning.

## What it does

- Opens PDFs by double click, "Open with", the command line or by dropping them on the window; a second PDF opens a new window.
- Fills the fields of real PDF forms (AcroForm).
- On forms without fields (`_____` or `.....` lines printed in the text) it writes over the line.
- Free text: "Testo" (Text), click on the page, type; double click to edit, drag to move, the blue square to resize, Delete to remove.
- Signature drawn, typed in cursive or imported from an image (PNG, JPG, WebP, GIF, BMP, SVG, also by dropping it on the window), which can be placed and resized; each profile can have its own. For a scanned or photographed signature the light background becomes transparent (this can be turned off) and the empty margins are cropped.
- Always saves a copy, `name-firmato.pdf`: the original is never touched. Signatures and text are burnt into the page.

## Profiles and automatic filling

"Profili" (Profiles) opens the list of profiles. The profile fields (headings such as "Codice fiscale", the Italian tax code, with an optional description) are shared by all profiles and can be added or removed freely; each profile has its own values and its own signature. "Data di oggi" (today's date) is automatic: it is not saved and always holds the date of the day you fill the form (dd/mm/yyyy); it can be renamed or deleted. No "full name" field is needed: it is composed from first name and surname (see below); profiles saved with the previous version lose it when opened.

"Compila" (Fill):

1. reads the PDF's fields and blank lines, with the text printed next to them;
2. recognises which heading each field needs, with the engine chosen in "Impostazioni" (Settings, see below). The default is **on the computer**: nothing leaves the computer, not even the form's text. The rest of this list describes Jev; the local engine reaches the same result on its own, combined fields included;
3. with Jev: it sends **only** these descriptions and the **headings** of the profile fields; Jev answers which heading each field needs (or "signature", "none", or "several pieces of information together");
4. for fields with several pieces of information together ("Il sottoscritto", the undersigned; "Luogo e data", place and date) a second request asks, heading by heading, whether it belongs to the field (yes from 0.5 up); the parts are written in the order the form names them ("Cognome e nome", surname and name) if it names all of them, otherwise in the profile's order, separated by a space, with a comma before a date ("Parma, 03/11/2026"). If a part is missing from the profile the value stays empty and the review says which one;
5. the heading → value matching happens locally: profile values never leave the computer;
6. a window shows the proposals: you can correct the information, the value, or exclude a field before writing.

In the review you can grow the profile while you fill. If a recognised field has no value in the active profile and you type one, "salva nel profilo" (save to profile, checked by default) stores it. If you type a value in a field that recognition did not match to anything, the row becomes "nuovo campo del profilo" (new profile field), with a name suggested from the printed text next to it, which you can correct: on confirmation the field is added to the headings (for all profiles) and the value to the active profile. A new field with the name of an existing one is not duplicated, and a value already in the profile is never overwritten from here.

Profiles are stored encrypted with the system keyring (Electron's `safeStorage`: Secret Service or KWallet on Linux, DPAPI on Windows, Keychain on macOS) in `profiles.enc` in the app's data folder (`~/.config/Hushfill` on Linux).

The app used to be called PDF Firma. On first launch Hushfill imports the profiles and the Jev key from the old folder (`~/.config/PDF Firma`): the encryption key is tied to the app's name, so it has them read by a process started under the old name and re-encrypts them with its own, without writing them to disk in plain text. The old folder stays as it is; after checking the profiles you can delete it and the "PDF Firma Safe Storage" keyring entry.

On Linux the keyring is chosen at startup by looking at the D-Bus session bus, not at the desktop's name: a running Secret Service (gnome-keyring, KeePassXC, recent KWallet) wins over KWallet, and a running one wins over one that can only be activated. This is needed because Chromium decides from the desktop, and on desktops it does not know (Hyprland, Sway…) it falls back to a fixed key. If no keyring is found the app does not save in plain text, and the error says what it looked for. `--password-store=...` on the command line takes precedence.

### Recognition on the computer

It is the default engine and needs no configuration. It compares the text printed near the field with examples ("C.F." → tax code, "nato/a a" → place of birth, "Luogo e data" → town and today's date, "PEC" → none) and with the labels of the profile headings, and proposes the most similar answer. Similarity works on groups of three characters, so it copes with abbreviations, typos and words in a different order ("Patente n." → "Numero patente"); abbreviations and gendered forms are expanded before comparing. The final parts of the label, those closest to the field, are compared: in "Il sottoscritto ____ nato a ____" the second line is the place of birth. Headings you create work without examples, from their label alone, and a label with several parts joined by "e" (and), a comma or a slash becomes a combined field. An AcroForm field shorter than a piece of information's minimum length excludes it: a 2-character field is not a tax code.

All the knowledge lives in `data/recognizer.json`: examples, heading labels that inherit them, abbreviations, thresholds. A case recognised wrongly is fixed by adding an example, not code; a longer, more specific example beats a short one ("rilasciato il", issued on → none, against "il" → date of birth). The percentages in the review are similarities, not probabilities calibrated on real forms (see `docs/recognition-validation.md`).

### Setting up Jev

To use it, choose it in "Impostazioni" (Settings), under "Riconoscimento" (Recognition). In the same window: paste the key from console.typesafe.ai, "Prova connessione" (test connection) checks it with a trivial question carrying no personal data, and "Salva" (Save) encrypts it with the keyring in `jev.enc` in the app's data folder. The saved key is never shown again nor sent back to the interface; "Rimuovi chiave" (remove key) deletes it.

The same window changes the model (default `jev-1.14.0`, pinned because the `jev-latest` alias changes with every release) and the server (default `https://api.typesafe.ai`; set it for a compatible server such as a local jevos). The server must use https, or http only towards localhost, because the key travels in a header.

In development the environment variables `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` and `TYPESAFE_BASE_URL`, when set, take precedence over the saved values; the window says so.

To understand why a field was recognised wrongly, start the app from a terminal with `HUSHFILL_DEBUG_JEV=1` (for example `HUSHFILL_DEBUG_JEV=1 ~/.local/opt/hushfill/hushfill form.pdf`): every question to Jev is printed with its answer. They hold only the form's text and the headings, never profile values or the key.

## Development

```sh
npm run setup     # npm install + download of the Electron binary
npm run dev       # Vite with hot reload + Electron (npm run dev -- ~/doc.pdf)
npm start         # build and start
npm test          # unit tests (Jev request, on-computer recognition, drawn lines, keyring choice)
npm run typecheck
```

`setup` downloads Electron separately because with `ignore-scripts=true` in `~/.npmrc` the package's install script does not run.

## Installation

Linux, for the current user (no sudo):

```sh
npm run install:linux
xdg-mime default hushfill.desktop application/pdf   # optional: default PDF reader
```

It copies the app to `~/.local/opt/hushfill`, creates `~/.local/bin/hushfill` and the menu entry registered for `application/pdf`. It removes the old PDF Firma installation, if present, and if that was the default PDF reader it hands the role to Hushfill.

Packages: `npm run dist:linux` (AppImage, deb, pacman), `npm run dist:win` (NSIS installer), `npm run dist:mac` (dmg, must run on macOS). They land in `release/`.

## Known limits

- The signature is an image (a graphic signature), not a digital signature with a certificate (PAdES).
- Blank lines are recognised both as characters (`____`, `.....`) and as drawn lines (segments, thin rectangles, dots). The sides of tables and boxes, underlined text and separators almost as long as the page are discarded; drawn boxes (squares to fill in) are not proposed. Scans without text are not recognised: fill them with "Testo".
- Checkboxes, radio buttons and drop-down menus are not filled automatically.
- Encrypted PDFs: they open and their fields can be filled, but added signatures and text cannot be burnt in.

## Structure

- `electron/main.cjs`: windows, opening files from the system, saving, encrypted profiles, calls to Jev.
- `electron/preload.cjs`: minimal bridge to the interface.
- `src/viewer.ts`: pdf.js (display, zoom, forms).
- `electron/keyring.cjs`: choice of the keyring on Linux from the D-Bus bus.
- `src/form-fields.ts`: extraction of AcroForm fields and blank lines with their context.
- `src/field-labels.ts`: a field's label from the text printed near it (to the left, also under a field placed above the dashes; above, up to the end of the line if the field wraps; below).
- `src/drawn-lines.ts`: lines drawn as graphics, from pdf.js's operator list.
- `src/settings-dialog.ts`: Settings window: recognition engine and Jev.
- `src/recognition-engine.ts`: chosen engine (on the computer or Jev), saved in `localStorage`.
- `src/local-recognizer.ts`: recognition on the computer: normalisation, similarity with the examples, combined fields.
- `data/recognizer.json`: examples, aliases, abbreviations and thresholds of the on-computer recognition.
- `src/jev.ts`: building the request to Jev and reading the answer.
- `src/autofill-dialog.ts`: review of the proposals and local matching to the values.
- `src/placements.ts`, `src/export.ts`: signatures and text on the page and burning them into the PDF.
- `src/profiles.ts`, `src/profile-dialog.ts`, `src/signature-dialog.ts`: profiles and signatures.
- `docs/recognition-validation.md`: a plan, not yet carried out, to measure recognition with the real Jev on forms with an expected answer.
