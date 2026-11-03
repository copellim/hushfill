# PDF Firma

Visualizzatore PDF desktop, semplice: compila i moduli, scrive sulle righe vuote dei moduli "da stampare", aggiunge testo libero e firma. Con i profili salvati riconosce i campi da compilare tramite Jev e li riempie con i tuoi dati. Linux, Windows e macOS (Electron).

## Cosa fa

- Apre i PDF da doppio clic, "Apri con", riga di comando o trascinandoli nella finestra; un secondo PDF apre una nuova finestra.
- Compila i campi dei moduli PDF veri (AcroForm).
- Sui moduli senza campi (righe `_____` o `.....` stampate nel testo) scrive sopra la riga.
- Testo libero: "Testo", clic sulla pagina, scrivi; doppio clic per modificare, trascina per spostare, quadratino blu per il corpo, Canc per eliminare.
- Firma disegnata, scritta in corsivo o importata da immagine (PNG, JPG, WebP, GIF, BMP, SVG, anche trascinandola nella finestra), posizionabile e ridimensionabile; ogni profilo può avere la sua. Di una firma scansionata o fotografata lo sfondo chiaro diventa trasparente (si può disattivare) e i margini vuoti vengono ritagliati.
- Salva sempre una copia `nome-firmato.pdf`: l'originale non viene toccato. Firme e testi vengono incisi nella pagina.

## Profili e compilazione automatica

"Profili" apre l'elenco dei profili. I campi del profilo (intestazioni come "Codice fiscale", con una descrizione facoltativa) sono comuni a tutti i profili e si aggiungono o tolgono liberamente; ogni profilo ha i suoi valori e la sua firma. "Data di oggi" è automatico: non si salva, vale sempre la data del giorno in cui compili (gg/mm/aaaa); si può rinominare o eliminare. Non serve un campo "Nome e cognome": si compone da Nome e Cognome (vedi sotto); i profili salvati con la versione precedente lo perdono all'apertura.

"Compila":

1. legge i campi del PDF e le righe vuote, con il testo stampato accanto;
2. manda a Jev **solo** queste descrizioni e le **intestazioni** dei campi del profilo; Jev risponde quale intestazione serve a ciascun campo (o "firma", "nessuna", oppure "più informazioni insieme");
3. per i campi con più informazioni insieme ("Il sottoscritto", "Luogo e data") una seconda richiesta chiede, intestazione per intestazione, se fa parte del campo (sì da 0,5 in su); le parti si scrivono nell'ordine in cui il modulo le nomina ("Cognome e nome") se le nomina tutte, altrimenti in quello del profilo, separate da uno spazio, con una virgola prima di una data ("Parma, 03/11/2026"). Se una parte manca nel profilo il valore resta vuoto e la revisione dice quale;
4. l'associazione intestazione → valore avviene in locale: i valori del profilo non lasciano mai il computer;
5. una finestra mostra le proposte: puoi correggere l'informazione, il valore, o escludere un campo prima di scrivere.

Nella revisione puoi far crescere il profilo mentre compili. Se un campo riconosciuto non ha valore nel profilo attivo e ne scrivi uno, "salva nel profilo" (spuntato di default) lo memorizza. Se scrivi un valore in un campo che Jev non ha associato a niente, la riga diventa "nuovo campo del profilo", con un nome proposto dal testo stampato accanto, che puoi correggere: confermando, il campo si aggiunge alle intestazioni (per tutti i profili) e il valore al profilo attivo. Un campo nuovo con il nome di uno esistente non si duplica, e un valore già presente nel profilo non viene mai sovrascritto da qui.

I profili sono salvati cifrati con il portachiavi di sistema (`safeStorage` di Electron: Secret Service o KWallet su Linux, DPAPI su Windows, Portachiavi su macOS) in `profiles.enc` nella cartella dati dell'app (`~/.config/PDF Firma` su Linux).

Su Linux il portachiavi si sceglie all'avvio guardando il bus di sessione D-Bus, non il nome del desktop: un servizio Secret Service in esecuzione (gnome-keyring, KeePassXC, KWallet recente) vince su KWallet, uno in esecuzione vince su uno solo attivabile. Serve perché Chromium decide dal desktop e su quelli che non conosce (Hyprland, Sway…) ripiega su una chiave fissa. Se non trova nessun portachiavi l'app non salva in chiaro, e l'errore dice cosa ha cercato. `--password-store=...` da riga di comando ha la precedenza.

### Configurare Jev

"Impostazioni" nella barra: si incolla la chiave da console.typesafe.ai, "Prova connessione" la verifica con una domanda banale senza dati personali, "Salva" la cifra col portachiavi in `jev.enc` nella cartella dati dell'app. La chiave salvata non viene più mostrata né rimandata all'interfaccia; "Rimuovi chiave" la cancella.

Nella stessa finestra si cambiano il modello (default `jev-1.14.0`, fissato perché l'alias `jev-latest` cambia a ogni rilascio) e il server (default `https://api.typesafe.ai`; per un server compatibile come jevos in locale). Il server deve usare https, http solo verso localhost, perché la chiave viaggia nell'header.

In sviluppo le variabili d'ambiente `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` e `TYPESAFE_BASE_URL`, se impostate, hanno la precedenza sui valori salvati; la finestra lo segnala.

Per capire perché un campo è stato riconosciuto male, lancia l'app dal terminale con `PDF_FIRMA_DEBUG_JEV=1` (per esempio `PDF_FIRMA_DEBUG_JEV=1 ~/.local/opt/pdf-firma/pdf-firma modulo.pdf`): ogni domanda a Jev viene stampata con la sua risposta. Ci sono solo testo del modulo e intestazioni, mai valori del profilo né la chiave.

## Sviluppo

```sh
npm run setup     # npm install + download del binario Electron
npm run dev       # Vite con hot reload + Electron (npm run dev -- ~/doc.pdf)
npm start         # build e avvio
npm test          # test unitari (richiesta Jev, righe disegnate, scelta del portachiavi)
npm run typecheck
```

`setup` scarica Electron a parte perché con `ignore-scripts=true` in `~/.npmrc` lo script di installazione del pacchetto non parte.

## Installazione

Linux, per l'utente corrente (nessun sudo):

```sh
npm run install:linux
xdg-mime default pdf-firma.desktop application/pdf   # facoltativo: lettore PDF predefinito
```

Copia l'app in `~/.local/opt/pdf-firma`, crea `~/.local/bin/pdf-firma` e la voce di menu registrata per `application/pdf`.

Pacchetti: `npm run dist:linux` (AppImage, deb, pacman), `npm run dist:win` (installer NSIS), `npm run dist:mac` (dmg, va eseguito su macOS). Escono in `release/`.

## Limiti noti

- La firma è un'immagine (firma grafica), non una firma digitale con certificato (PAdES).
- Le righe vuote si riconoscono sia come caratteri (`____`, `.....`) sia come linee disegnate (segmenti, rettangoli sottili, puntini). Si scartano i lati di tabelle e riquadri, il testo sottolineato e i separatori lunghi quasi quanto la pagina; le caselle disegnate (riquadri da riempire) non vengono proposte. Le scansioni senza testo non vengono riconosciute: si compilano con "Testo".
- Caselle di spunta, pulsanti di scelta e menu a tendina non vengono compilati automaticamente.
- PDF cifrati: si aprono e si compilano i campi, ma firme e testi aggiunti non possono essere incisi.

## Struttura

- `electron/main.cjs`: finestre, apertura file da sistema, salvataggio, profili cifrati, chiamate a Jev.
- `electron/preload.cjs`: ponte minimo verso l'interfaccia.
- `src/viewer.ts`: pdf.js (visualizzazione, zoom, moduli).
- `electron/keyring.cjs`: scelta del portachiavi su Linux dal bus D-Bus.
- `src/form-fields.ts`: estrazione di campi AcroForm e righe vuote con il loro contesto.
- `src/drawn-lines.ts`: righe disegnate come grafica, dalla lista di operatori di pdf.js.
- `src/settings-dialog.ts`: finestra Impostazioni di Jev.
- `src/jev.ts`: costruzione della richiesta a Jev e lettura della risposta.
- `src/autofill-dialog.ts`: revisione delle proposte e associazione locale ai valori.
- `src/placements.ts`, `src/export.ts`: firme e testi sulla pagina e loro incisione nel PDF.
- `src/profiles.ts`, `src/profile-dialog.ts`, `src/signature-dialog.ts`: profili e firme.
- `docs/validazione-riconoscimento.md`: piano, non ancora fatto, per misurare il riconoscimento con il vero Jev su moduli con risposta attesa.
