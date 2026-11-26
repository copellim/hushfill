# Hushfill

Desktop PDF viewer (Electron + pdf.js + pdf-lib, TypeScript with Vite): fills in forms, writes on blank lines, signs, fills from profiles, recognising the fields on the computer (default) or with Jev. User overview and file structure in `README.md`. Before working on label extraction, recognition or profiles read `DOMAIN.md`: field, label, heading, decision and where each step goes wrong.

## Commands

- `npm run setup` on first clone: `~/.npmrc` has `ignore-scripts=true`, the Electron binary must be downloaded separately.
- Verify after every change: `npx tsc --noEmit`, `npm test` (node `--experimental-strip-types`, only `tests/*.test.ts`), `npx vite build`.
- `npm run dev` to try things by hand; `npm run install:linux` rebuilds and installs into `~/.local/opt/hushfill` (first check that the installed app is not open).

## Invariants

- Only field descriptions and profile headings go to Jev, never values or signatures: the heading → value matching happens locally (`src/autofill-dialog.ts`). Every change to `src/jev.ts` keeps the tests that verify this.
- The Jev key lives only in the main process (`electron/main.cjs`), encrypted with `safeStorage` in `jev.enc`; the renderer only knows whether it exists. No secrets in plain text: no `.env`, no `basic_text` fallback.
- Saving always proposes `name-firmato.pdf` and does not touch the original.
- The `safeStorage` key is tied to the app's name: changing `productName` makes the profiles and the Jev key unreadable. The import from the old name is in `electron/main.cjs` (migration from PDF Firma).
- Signatures are always PNG: `src/export.ts` embeds only PNG.
- Recognition on the computer (`src/local-recognizer.ts`) makes no network calls and produces the same `FieldDecision`s as Jev: the review does not know which engine did the work. All the knowledge lives in `data/recognizer.json` (examples, aliases, abbreviations, thresholds): a case recognised wrongly is fixed with an example, not with code; the code stays generic (normalisation, trigram similarity, choice). A new case goes into `tests/local-recognizer.test.ts` first.
- Tests run with `--experimental-strip-types`, which does not resolve imports without an extension: a module in `src/` that imports *values* from another tested module imports it with `.ts` (`allowImportingTsExtensions`); `import type` is fine without.

## pdf.js and pdf-lib pitfalls

- `PDFViewer` wants `globalThis.pdfjsLib` set before the dynamic import of `pdf_viewer.mjs`, and a `div` as container.
- `PDFPageView.reset()` removes foreign nodes from the page: the layer of signatures and text is recreated on every `pagerendered`.
- In v6 neither `convertToViewportRectangle` nor `increaseScale({maxScale})` exists; paths arrive as `constructPath` with a `DrawOPS` buffer already transformed by the optimiser (see `src/drawn-lines.ts`).
- `saveDocument()` only if `annotationStorage.size > 0`, otherwise `getData()`.
- Before pdf-lib's `form.removeField` the widgets must be removed from `/Annots` of every page (`detachWidgets`), or the page points to a deleted object.

## Runtime tests

- Playwright `_electron` from the global installation of `@playwright/cli`; screenshots with `webContents.capturePage()`, Playwright's own hang on Wayland.
- Jev is tested with a fake local server (`TYPESAFE_BASE_URL=http://127.0.0.1:...`, http allowed only towards localhost) and a dedicated `--user-data-dir`, never the real data folders `~/.config/Hushfill` and `~/.config/PDF Firma`.
- Wrong recognition with the real Jev: `HUSHFILL_DEBUG_JEV=1` prints questions and answers from the main process. The descriptions of the default headings end up in the criteria: they must not suggest a choice for a specific field.
- `asar extract-file` writes into the current folder: never run it from the project root, it overwrites `index.html`.
