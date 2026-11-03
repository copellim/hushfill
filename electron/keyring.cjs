// Sceglie il portachiavi per safeStorage su Linux guardando cosa c'è davvero
// sul bus di sessione, invece di indovinarlo dal desktop: Chromium decide
// da XDG_CURRENT_DESKTOP e sugli ambienti che non conosce (Hyprland, Sway,
// i3…) ripiega su "basic_text", cioè una chiave fissa, senza protezione.
const { spawnSync } = require("node:child_process");

const SECRET_SERVICE = "org.freedesktop.secrets";
const KWALLET6 = "org.kde.kwalletd6";
const KWALLET5 = "org.kde.kwalletd5";
const DBUS_TIMEOUT_MS = 2000;

// Valori di --password-store di Chromium per ciascun servizio, in ordine di
// preferenza. Secret Service prima: lo offrono gnome-keyring, KeePassXC e
// anche KWallet recente, e libsecret parla con tutti.
const STORES = [
  { busName: SECRET_SERVICE, store: "gnome-libsecret" },
  { busName: KWALLET6, store: "kwallet6" },
  { busName: KWALLET5, store: "kwallet5" },
];

// Nomi dall'output di dbus-send --print-reply: righe `string "nome"`.
function parseBusNames(output) {
  return new Set([...output.matchAll(/^\s*string "([^"]+)"$/gm)].map((match) => match[1]));
}

function listBusNames(method) {
  const result = spawnSync(
    "dbus-send",
    ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", `org.freedesktop.DBus.${method}`],
    { encoding: "utf8", timeout: DBUS_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseBusNames(result.stdout);
}

// Un servizio già in esecuzione vince su uno solo attivabile: è quello che
// l'utente usa davvero (qui gnome-keyring può convivere con KWallet installato).
function choosePasswordStore(running, activatable) {
  for (const names of [running, activatable]) {
    const found = STORES.find(({ busName }) => names.has(busName));
    if (found) {
      return found;
    }
  }
  return null;
}

// Restituisce { store, busName, how } con how "in esecuzione"/"attivabile",
// oppure { store: null, reason } se non c'è un portachiavi o non si sa.
function detectPasswordStore() {
  const running = listBusNames("ListNames");
  if (!running) {
    return { store: null, reason: "bus di sessione D-Bus non raggiungibile (dbus-send assente o nessuna sessione)" };
  }
  const activatable = listBusNames("ListActivatableNames") ?? new Set();
  const found = choosePasswordStore(running, activatable);
  if (!found) {
    return { store: null, reason: `nessun servizio tra ${STORES.map((s) => s.busName).join(", ")} sul bus di sessione` };
  }
  return { ...found, how: running.has(found.busName) ? "in esecuzione" : "attivabile" };
}

module.exports = { detectPasswordStore, choosePasswordStore, parseBusNames };
