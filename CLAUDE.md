# Hushfill

Visualizzatore PDF desktop (Electron + pdf.js + pdf-lib, TypeScript con Vite): compila moduli, scrive sulle righe vuote, firma, compila da profili, riconoscendo i campi sul computer (predefinito) o con Jev. Panoramica utente e struttura dei file in `README.md`. Prima di lavorare su estrazione delle etichette, riconoscimento o profili leggi `DOMINIO.md`: campo, etichetta, intestazione, decisione e dove sbaglia ciascun passo.

## Comandi

- `npm run setup` al primo clone: `~/.npmrc` ha `ignore-scripts=true`, il binario di Electron va scaricato a parte.
- Verifica dopo ogni modifica: `npx tsc --noEmit`, `npm test` (node `--experimental-strip-types`, solo `tests/*.test.ts`), `npx vite build`.
- `npm run dev` per provare a mano; `npm run install:linux` ricompila e installa in `~/.local/opt/hushfill` (prima controlla che l'app installata non sia aperta).

## Invarianti

- A Jev vanno solo descrizioni dei campi e intestazioni del profilo, mai valori né firme: l'abbinamento intestazione → valore avviene in locale (`src/autofill-dialog.ts`). Ogni modifica a `src/jev.ts` mantiene i test che lo verificano.
- La chiave di Jev vive solo nel processo principale (`electron/main.cjs`), cifrata con `safeStorage` in `jev.enc`; il renderer sa solo se esiste. Niente segreti in chiaro: niente `.env`, niente fallback `basic_text`.
- Il salvataggio propone sempre `nome-firmato.pdf` e non tocca l'originale.
- La chiave di `safeStorage` è legata al nome dell'app: cambiare `productName` rende illeggibili profili e chiave di Jev. L'import dal vecchio nome è in `electron/main.cjs` (migrazione da PDF Firma).
- Le firme sono sempre PNG: `src/export.ts` incorpora solo PNG.
- Il riconoscimento sul computer (`src/local-recognizer.ts`) non fa chiamate di rete e produce le stesse `FieldDecision` di Jev: la revisione non sa quale motore ha lavorato. La conoscenza sta tutta in `data/recognizer.json` (esempi, alias, abbreviazioni, soglie): un caso riconosciuto male si corregge con un esempio, non con codice; il codice resta generico (normalizzazione, somiglianza a trigrammi, scelta). Un caso nuovo va prima in `tests/local-recognizer.test.ts`.
- I test girano con `--experimental-strip-types`, che non risolve import senza estensione: un modulo di `src/` che importa *valori* da un altro modulo testato lo importa con `.ts` (`allowImportingTsExtensions`); gli `import type` vanno bene senza.

## Trappole di pdf.js e pdf-lib

- `PDFViewer` vuole `globalThis.pdfjsLib` impostato prima dell'import dinamico di `pdf_viewer.mjs`, e un `div` come contenitore.
- `PDFPageView.reset()` toglie i nodi estranei dalla pagina: lo strato di firme e testi si ricrea a ogni `pagerendered`.
- In v6 non esistono `convertToViewportRectangle` né `increaseScale({maxScale})`; i tracciati arrivano come `constructPath` con buffer `DrawOPS` già trasformato dall'ottimizzatore (vedi `src/drawn-lines.ts`).
- `saveDocument()` solo se `annotationStorage.size > 0`, altrimenti `getData()`.
- Prima di `form.removeField` di pdf-lib vanno tolti i widget da `/Annots` di tutte le pagine (`detachWidgets`), o la pagina punta a un oggetto cancellato.

## Prove a runtime

- Playwright `_electron` dall'installazione globale di `@playwright/cli`; screenshot con `webContents.capturePage()`, quelli di Playwright si bloccano su Wayland.
- Jev si prova con un server finto locale (`TYPESAFE_BASE_URL=http://127.0.0.1:...`, http ammesso solo verso localhost) e un `--user-data-dir` dedicato, mai le cartelle dati reali `~/.config/Hushfill` e `~/.config/PDF Firma`.
- Riconoscimento sbagliato con il vero Jev: `HUSHFILL_DEBUG_JEV=1` stampa domande e risposte dal processo principale. Le descrizioni delle intestazioni predefinite finiscono nei criteri: non devono suggerire una scelta per un campo specifico.
- `asar extract-file` scrive nella cartella corrente: mai lanciarlo dalla radice del progetto, sovrascrive `index.html`.
