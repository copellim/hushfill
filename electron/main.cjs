// Main process: windows, opening the files passed by the system
// (command line, "Open with", double click), disk access, profiles
// encrypted with the system keyring and calls to Jev with the API key.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { detectPasswordStore } = require("./keyring.cjs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Jev: the key is set from the Settings window and saved encrypted with the
// keyring; it stays in the main process, the renderer never reads it back.
// The TYPESAFE_* environment variables, when present, take precedence
// (useful in development). Model pinned because the jev-latest alias
// changes with every release.
const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const JEV_DEFAULT_MODEL = "jev-1.14.0";
const JEV_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const PROFILES_FILE_NAME = "profiles.enc";
const JEV_SETTINGS_FILE_NAME = "jev.enc";

// The app used to be called "PDF Firma". safeStorage ties the key to the app's
// name (on Linux the "<name> Safe Storage" keyring entry, on macOS the
// Keychain one), so Hushfill cannot decrypt the old files. On first launch
// it relaunches itself with the switch below and the old name: that process
// reads the files of the old data folder and passes them in plain text over
// a pipe (fd 3), never to disk; this one re-encrypts them with the new key.
const LEGACY_APP_NAME = "PDF Firma";
const LEGACY_EXPORT_SWITCH = "export-legacy-data";
const LEGACY_MIGRATED_MARKER = "migrato-da-pdf-firma";
const LEGACY_EXPORT_TIMEOUT_MS = 120_000; // the keyring may ask to be unlocked
const LEGACY_FILES = [PROFILES_FILE_NAME, JEV_SETTINGS_FILE_NAME];
const legacyUserDataDir = path.join(app.getPath("appData"), LEGACY_APP_NAME);
const exportingLegacyData = app.commandLine.hasSwitch(LEGACY_EXPORT_SWITCH);
if (exportingLegacyData) {
  // Before "ready": afterwards, Chromium has already chosen the key.
  app.setName(LEGACY_APP_NAME);
  app.setPath("userData", legacyUserDataDir);
}

// The keyring must be chosen before the app is ready: afterwards, Chromium has
// already decided. A --password-store passed by hand takes precedence.
const keyring = choosePasswordStoreAtStartup();

function choosePasswordStoreAtStartup() {
  if (process.platform !== "linux") {
    return null; // Windows and macOS have a single keyring, always present
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

// Per-window state: initial file and unsaved changes.
const windows = new Map(); // webContents.id -> { win, initialPath, dirty }

// The first useful argument depends on how Electron is launched:
// in development argv is [electron, ".", ...], packaged it is [app, ...].
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

// Write to a temporary file and rename: an error halfway does not truncate the existing file.
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
    title: "Hushfill",
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

  // External links of the PDF in the system browser, never inside the app.
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

// --- PDF files --------------------------------------------------------------

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

// --- Files encrypted with the keyring (profiles and Jev settings) ------------

function userDataFile(name) {
  return path.join(app.getPath("userData"), name);
}

// On Linux, without a keyring, Electron falls back to a fixed key
// ("basic_text"): it would be plain text in disguise. It refuses only after
// looking for a keyring at startup, and says what it found.
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

// null if the file does not exist yet.
async function readEncrypted(name) {
  const file = userDataFile(name);
  if (!fs.existsSync(file)) {
    return null;
  }
  await assertEncryptionAvailable();
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
  // The keyring key has been rotated: rewrite with the new one.
  if (shouldReEncrypt) {
    await writeEncrypted(name, result);
  }
  return result;
}

ipcMain.handle("profiles-load", () => readEncrypted(PROFILES_FILE_NAME));
ipcMain.handle("profiles-save", (_event, json) => writeEncrypted(PROFILES_FILE_NAME, json));

// --- Jev ------------------------------------------------------------------------

// Saved settings: { apiKey?, model?, baseUrl? }, encrypted as a whole.
async function readJevSettings() {
  const json = await readEncrypted(JEV_SETTINGS_FILE_NAME);
  return json ? JSON.parse(json) : {};
}

// Environment, then saved settings, then defaults.
async function resolveJevConfig() {
  const saved = await readJevSettings();
  const env = process.env;
  return {
    apiKey: env.TYPESAFE_API_KEY || saved.apiKey || "",
    model: env.TYPESAFE_MODEL || saved.model || JEV_DEFAULT_MODEL,
    baseUrl: env.TYPESAFE_BASE_URL || saved.baseUrl || JEV_DEFAULT_BASE_URL,
  };
}

// The key travels in the header: in plain text (http) only towards this
// computer, for a compatible local server.
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

// For the Settings window: never the key, only whether it exists and where it comes from.
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

// Window values not yet saved, completed with those in use: "Prova" (test)
// checks what is about to be saved. Empty key field = current key.
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

// Trivial question, with no user data, to check key and server.
const JEV_PING = {
  state: "Prova di connessione dall'app Hushfill.",
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

// HUSHFILL_DEBUG_JEV=1 prints every question with its answer on the terminal,
// to understand why a field was recognised wrongly. Questions and answers
// contain no profile values (only the form's text and the headings);
// the key is never printed.
function logJevExchange(request, response) {
  for (const [id, question] of Object.entries(request.questions)) {
    console.info(`[jev] ${id}: ${question.instructions}`);
    console.info(`[jev]   → ${JSON.stringify(response.answers?.[id] ?? null)}`);
  }
}

ipcMain.handle("jev-decide", async (_event, request) => {
  const response = await callJev(await resolveJevConfig(), request);
  if (process.env.HUSHFILL_DEBUG_JEV === "1") {
    logJevExchange(request, response);
  }
  return response;
});

// --- Migration of the "PDF Firma" data -----------------------------------------

// Child process, started with the old name: reads and decrypts the files of
// the old data folder and writes them to fd 3. It opens no windows.
async function exportLegacyData() {
  let payload;
  try {
    const files = {};
    for (const name of LEGACY_FILES) {
      files[name] = await readEncrypted(name);
    }
    payload = { files };
  } catch (error) {
    payload = { error: error.message };
  }
  writeAllToFd(3, Buffer.from(JSON.stringify(payload), "utf8"));
  app.exit(0);
}

// writeSync on a pipe may write only part, or answer EAGAIN if it is full.
function writeAllToFd(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += fs.writeSync(fd, bytes, offset);
    } catch (error) {
      if (error.code !== "EAGAIN") {
        throw error;
      }
    }
  }
}

// Only with the default data folder: with --user-data-dir (tests, development
// profiles) the user's real folder is not read.
function legacyMigrationNeeded() {
  const userData = app.getPath("userData");
  if (userData !== path.join(app.getPath("appData"), app.getName())) {
    return false;
  }
  if (fs.existsSync(path.join(userData, LEGACY_MIGRATED_MARKER))) {
    return false;
  }
  const exists = (dir) => LEGACY_FILES.some((name) => fs.existsSync(path.join(dir, name)));
  return exists(legacyUserDataDir) && !exists(userData);
}

function runLegacyExport() {
  // In development execPath is the Electron binary and the app folder must be passed.
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), `--${LEGACY_EXPORT_SWITCH}`];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit", "pipe"] });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("il portachiavi non ha risposto in tempo"));
    }, LEGACY_EXPORT_TIMEOUT_MS);
    child.stdio[3].on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        payload.error ? reject(new Error(payload.error)) : resolve(payload.files);
      } catch {
        reject(new Error("il processo di lettura dei dati vecchi non ha risposto"));
      }
    });
  });
}

// The old folder stays as it is: the marker prevents redoing the migration
// (for example after "Rimuovi chiave", remove key, which deletes jev.enc).
async function migrateLegacyData() {
  if (!legacyMigrationNeeded()) {
    return;
  }
  try {
    const files = await runLegacyExport();
    for (const [name, text] of Object.entries(files)) {
      if (text !== null) {
        await writeEncrypted(name, text);
      }
    }
    fs.writeFileSync(
      path.join(app.getPath("userData"), LEGACY_MIGRATED_MARKER),
      `Profili e impostazioni di Jev importati da ${legacyUserDataDir} il ${new Date().toISOString()}.\n`,
    );
    console.info(`Dati di ${LEGACY_APP_NAME} importati da ${legacyUserDataDir}`);
  } catch (error) {
    dialog.showErrorBox(
      "Dati di PDF Firma non importati",
      `Profili e chiave di Jev della versione precedente non sono stati importati: ${error.message}.\n\nSono ancora in ${legacyUserDataDir}: riapri l'app per riprovare.`,
    );
  }
}

// --- Lifecycle ----------------------------------------------------------------

// A single instance: a second launch ("Open with" on another PDF)
// opens a new window in the process already running.
if (exportingLegacyData) {
  app.whenReady().then(exportLegacyData);
} else if (!app.requestSingleInstanceLock()) {
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

  // macOS delivers files opened from the Finder with an event, not in argv.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      createWindow(filePath);
    } else {
      pendingMacFile = filePath;
    }
  });

  app.whenReady().then(async () => {
    if (process.platform !== "darwin") {
      Menu.setApplicationMenu(null);
    }
    await migrateLegacyData();
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
