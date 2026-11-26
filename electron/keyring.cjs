// Chooses the keyring for safeStorage on Linux by looking at what is really
// on the session bus, instead of guessing it from the desktop: Chromium decides
// from XDG_CURRENT_DESKTOP and on environments it does not know (Hyprland, Sway,
// i3…) falls back to "basic_text", that is a fixed key, with no protection.
const { spawnSync } = require("node:child_process");

const SECRET_SERVICE = "org.freedesktop.secrets";
const KWALLET6 = "org.kde.kwalletd6";
const KWALLET5 = "org.kde.kwalletd5";
const DBUS_TIMEOUT_MS = 2000;

// Chromium's --password-store values for each service, in order of
// preference. Secret Service first: gnome-keyring, KeePassXC and recent
// KWallet all offer it, and libsecret talks to all of them.
const STORES = [
  { busName: SECRET_SERVICE, store: "gnome-libsecret" },
  { busName: KWALLET6, store: "kwallet6" },
  { busName: KWALLET5, store: "kwallet5" },
];

// Names from the output of dbus-send --print-reply: lines `string "name"`.
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

// A service already running wins over one that can only be activated: it is the
// one the user really uses (here gnome-keyring can coexist with an installed KWallet).
function choosePasswordStore(running, activatable) {
  for (const names of [running, activatable]) {
    const found = STORES.find(({ busName }) => names.has(busName));
    if (found) {
      return found;
    }
  }
  return null;
}

// Returns { store, busName, how } with how "in esecuzione" (running) or
// "attivabile" (activatable), or { store: null, reason } if there is no keyring
// or it cannot be told.
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
