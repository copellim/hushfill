// Processo principale: finestre, apertura dei file passati dal sistema
// (riga di comando, "Apri con", doppio clic), accesso al disco, profili
// cifrati col portachiavi di sistema e chiamate a Jev con la chiave API.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { detectPasswordStore } = require("./keyring.cjs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Jev: la chiave si imposta dalla finestra Impostazioni ed è salvata cifrata
// col portachiavi; resta nel processo principale, il renderer non la rilegge
// mai. Le variabili TYPESAFE_* dell'ambiente, se presenti, hanno la
// precedenza (utile in sviluppo). Modello fissato perché l'alias jev-latest
// cambia a ogni rilascio.
const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const JEV_DEFAULT_MODEL = "jev-1.14.0";
const JEV_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const PROFILES_FILE_NAME = "profiles.enc";
const JEV_SETTINGS_FILE_NAME = "jev.enc";

// Il portachiavi va scelto prima che l'app sia pronta: dopo, Chromium ha già
// deciso. Un --password-store passato a mano ha la precedenza.
const keyring = choosePasswordStoreAtStartup();

function choosePasswordStoreAtStartup() {
  if (process.platform !== "linux") {
    return null; // Windows e macOS hanno un solo portachiavi, sempre presente
  }
  if (app.commandLine.hasSwitch("password-store")) {
    return { store: app.commandLine.getSwitchValue("password-store"), how: "scelto da riga di comando" };
  }
  const detected = detectPasswordStore();
  if (detected.store) {
    app.commandLine.appendSwitch("password-store", detected.store);
    console.info(`Portachiavi: ${detected.busName} (${detected.how}) → --password-store=${detected.store}`);
  } else {
    console.warn(`Portachiavi non trovato: ${detected.reason}. Decide Chromium dal desktop.`);
  }
  return detected;
}

// Stato per finestra: file iniziale e modifiche non salvate.
const windows = new Map(); // webContents.id -> { win, initialPath, dirty }

// Il primo argomento utile dipende da come è lanciato Electron:
// in sviluppo argv è [electron, ".", ...], impacchettato è [app, ...].
function pdfFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith("-")) {
      continue;
    }
    const candidate = arg.startsWith("file://") ? decodeURIComponent(new URL(arg).pathname) : arg;
    if (/\.pdf$/i.test(candidate) && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function readPdf(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(bytes) };
}

// Scrittura su file temporaneo e rename: un errore a metà non tronca il file esistente.
function writeAtomically(filePath, bytes) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, filePath);
}

function createWindow(initialPath = null) {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#2b2d31",
    title: "PDF Firma",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const id = win.webContents.id;
  windows.set(id, { win, initialPath, dirty: false });

  // Link esterni del PDF nel browser di sistema, mai dentro l'app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openIfExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      openIfExternal(url);
    }
  });

  win.on("close", (event) => {
    if (windows.get(id)?.dirty && !confirmDiscard(win)) {
      event.preventDefault();
    }
  });
  win.on("closed", () => windows.delete(id));

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  return win;
}

function openIfExternal(url) {
  if (/^(https?|mailto):/.test(url)) {
    shell.openExternal(url);
  }
}

function confirmDiscard(win) {
  const choice = dialog.showMessageBoxSync(win, {
    type: "warning",
    buttons: ["Annulla", "Chiudi senza salvare"],
    defaultId: 0,
    cancelId: 0,
    message: "Ci sono modifiche non salvate.",
    detail: "Se chiudi ora, i campi compilati e le firme aggiunte andranno persi.",
  });
  return choice === 1;
}

function stateOf(event) {
  return windows.get(event.sender.id);
}

// --- File PDF ---------------------------------------------------------------

ipcMain.handle("get-initial-file", (event) => {
  const state = stateOf(event);
  if (!state?.initialPath) {
    return null;
  }
  const filePath = state.initialPath;
  state.initialPath = null;
  return readPdf(filePath);
});

ipcMain.handle("read-file", (_event, filePath) => readPdf(filePath));

ipcMain.handle("open-dialog", async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(stateOf(event).win, {
    title: "Apri PDF",
    properties: ["openFile"],
    filters: [{ name: "Documenti PDF", extensions: ["pdf"] }],
  });
  return canceled || !filePaths[0] ? null : readPdf(filePaths[0]);
});

ipcMain.handle("save-dialog", async (event, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog(stateOf(event).win, {
    title: "Salva PDF firmato",
    defaultPath,
    filters: [{ name: "Documenti PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) {
    return null;
  }
  return /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
});

ipcMain.handle("write-file", (_event, filePath, bytes) => {
  writeAtomically(filePath, Buffer.from(bytes));
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle("confirm", async (event, message, detail, okLabel) => {
  const { response } = await dialog.showMessageBox(stateOf(event).win, {
    type: "question",
    buttons: ["Annulla", okLabel],
    defaultId: 1,
    cancelId: 0,
    message,
    detail,
  });
  return response === 1;
});

ipcMain.on("set-dirty", (event, dirty) => {
  const state = stateOf(event);
  if (state) {
    state.dirty = Boolean(dirty);
  }
});

ipcMain.on("set-title", (event, title) => {
  stateOf(event)?.win.setTitle(title);
});

// --- File cifrati col portachiavi (profili e impostazioni di Jev) -------------

function userDataFile(name) {
  return path.join(app.getPath("userData"), name);
}

// Su Linux, senza portachiavi, Electron ripiega su una chiave fissa
// ("basic_text"): sarebbe testo in chiaro travestito. Si rifiuta solo dopo
// aver cercato un portachiavi all'avvio, e si dice cosa si è trovato.
async function assertEncryptionAvailable() {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  const backend = process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : "di sistema";
  if (available && backend !== "basic_text") {
    return;
  }
  const searched = keyring?.store
    ? `trovato ${keyring.busName ?? keyring.store} (${keyring.how}), ma non ha risposto (backend: ${backend})`
    : `ricerca all'avvio: ${keyring?.reason ?? "non eseguita"}`;
  throw new Error(
    `Portachiavi di sistema non utilizzabile, ${searched}. Avvia gnome-keyring, KeePassXC (con Secret Service) o KWallet e riapri l'app: profili e chiave di Jev non vengono salvati in chiaro.`,
  );
}

async function writeEncrypted(name, text) {
  await assertEncryptionAvailable();
  writeAtomically(userDataFile(name), await safeStorage.encryptStringAsync(text));
}

// null se il file non esiste ancora.
async function readEncrypted(name) {
  const file = userDataFile(name);
  if (!fs.existsSync(file)) {
    return null;
  }
  await assertEncryptionAvailable();
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
  // La chiave del portachiavi è stata ruotata: si riscrive con quella nuova.
  if (shouldReEncrypt) {
    await writeEncrypted(name, result);
  }
  return result;
}

ipcMain.handle("profiles-load", () => readEncrypted(PROFILES_FILE_NAME));
ipcMain.handle("profiles-save", (_event, json) => writeEncrypted(PROFILES_FILE_NAME, json));

// --- Jev ------------------------------------------------------------------------

// Impostazioni salvate: { apiKey?, model?, baseUrl? }, cifrate per intero.
async function readJevSettings() {
  const json = await readEncrypted(JEV_SETTINGS_FILE_NAME);
  return json ? JSON.parse(json) : {};
}

// Ambiente, poi impostazioni salvate, poi default.
async function resolveJevConfig() {
  const saved = await readJevSettings();
  const env = process.env;
  return {
    apiKey: env.TYPESAFE_API_KEY || saved.apiKey || "",
    model: env.TYPESAFE_MODEL || saved.model || JEV_DEFAULT_MODEL,
    baseUrl: env.TYPESAFE_BASE_URL || saved.baseUrl || JEV_DEFAULT_BASE_URL,
  };
}

// La chiave viaggia nell'header: in chiaro (http) solo verso questo computer,
// per un server compatibile in locale.
function validateBaseUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Indirizzo del server non valido: «${text}».`);
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    throw new Error("L'indirizzo del server deve usare https (http è ammesso solo per localhost): la chiave viaggerebbe in chiaro.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function validateApiKey(text) {
  const key = text.trim();
  if (!key || /\s/.test(key)) {
    throw new Error("La chiave API non può essere vuota né contenere spazi.");
  }
  return key;
}

async function callJev({ apiKey, model, baseUrl }, request) {
  if (!apiKey) {
    throw new Error("Chiave API di Jev non impostata: inseriscila in Impostazioni.");
  }
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, model }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jev ha risposto ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json();
}

ipcMain.handle("jev-status", async () => {
  const config = await resolveJevConfig();
  return { configured: Boolean(config.apiKey), model: config.model, baseUrl: config.baseUrl };
});

// Per la finestra Impostazioni: mai la chiave, solo se c'è e da dove viene.
ipcMain.handle("jev-settings-get", async () => {
  const saved = await readJevSettings();
  const env = process.env;
  return {
    hasSavedKey: Boolean(saved.apiKey),
    model: saved.model ?? "",
    baseUrl: saved.baseUrl ?? "",
    defaults: { model: JEV_DEFAULT_MODEL, baseUrl: JEV_DEFAULT_BASE_URL },
    fromEnvironment: { apiKey: Boolean(env.TYPESAFE_API_KEY), model: Boolean(env.TYPESAFE_MODEL), baseUrl: Boolean(env.TYPESAFE_BASE_URL) },
    storageFile: userDataFile(JEV_SETTINGS_FILE_NAME),
  };
});

// Valori della finestra non ancora salvati, completati da quelli in uso:
// "Prova" verifica ciò che si sta per salvare. Campo chiave vuoto = chiave attuale.
async function candidateJevConfig(form) {
  const current = await resolveJevConfig();
  return {
    apiKey: form.removeKey ? "" : form.apiKey ? validateApiKey(form.apiKey) : current.apiKey,
    model: form.model.trim() || current.model,
    baseUrl: form.baseUrl.trim() ? validateBaseUrl(form.baseUrl.trim()) : current.baseUrl,
  };
}

ipcMain.handle("jev-settings-save", async (_event, form) => {
  const saved = await readJevSettings();
  const next = {
    apiKey: form.removeKey ? undefined : form.apiKey ? validateApiKey(form.apiKey) : saved.apiKey,
    model: form.model.trim() || undefined,
    baseUrl: form.baseUrl.trim() ? validateBaseUrl(form.baseUrl.trim()) : undefined,
  };
  if (!next.apiKey && !next.model && !next.baseUrl) {
    fs.rmSync(userDataFile(JEV_SETTINGS_FILE_NAME), { force: true });
    return;
  }
  await writeEncrypted(JEV_SETTINGS_FILE_NAME, JSON.stringify(next));
});

// Domanda banale, senza dati dell'utente, per verificare chiave e server.
const JEV_PING = {
  state: "Prova di connessione dall'app PDF Firma.",
  questions: { prova: { type: "choice", instructions: "Questa è una prova di connessione: rispondi sì.", criteria: { si: "sì", no: "no" } } },
};

ipcMain.handle("jev-test", async (_event, form) => {
  const config = await candidateJevConfig(form);
  const started = Date.now();
  const response = await callJev(config, JEV_PING);
  if (!response?.answers?.prova) {
    throw new Error("Jev ha risposto, ma senza la risposta attesa: controlla modello e indirizzo del server.");
  }
  return { model: response.model ?? config.model, milliseconds: Date.now() - started };
});

// PDF_FIRMA_DEBUG_JEV=1 stampa sul terminale ogni domanda con la risposta,
// per capire perché un campo è stato riconosciuto male. Domande e risposte
// non contengono valori del profilo (solo testo del modulo e intestazioni);
// la chiave non viene mai stampata.
function logJevExchange(request, response) {
  for (const [id, question] of Object.entries(request.questions)) {
    console.info(`[jev] ${id}: ${question.instructions}`);
    console.info(`[jev]   → ${JSON.stringify(response.answers?.[id] ?? null)}`);
  }
}

ipcMain.handle("jev-decide", async (_event, request) => {
  const response = await callJev(await resolveJevConfig(), request);
  if (process.env.PDF_FIRMA_DEBUG_JEV === "1") {
    logJevExchange(request, response);
  }
  return response;
});

// --- Ciclo di vita ------------------------------------------------------------

// Una sola istanza: un secondo lancio ("Apri con" su un altro PDF)
// apre una nuova finestra nel processo già attivo.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let pendingMacFile = null;

  app.on("second-instance", (_event, argv) => {
    const filePath = pdfFromArgv(argv);
    if (filePath) {
      createWindow(filePath);
    } else {
      BrowserWindow.getAllWindows()[0]?.focus();
    }
  });

  // macOS consegna i file aperti dal Finder con un evento, non in argv.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      createWindow(filePath);
    } else {
      pendingMacFile = filePath;
    }
  });

  app.whenReady().then(() => {
    if (process.platform !== "darwin") {
      Menu.setApplicationMenu(null);
    }
    createWindow(pendingMacFile ?? pdfFromArgv(process.argv));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
