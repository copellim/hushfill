// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import keyring from "../electron/keyring.cjs";

const { choosePasswordStore, parseBusNames } = keyring;

test("legge i nomi dall'output di dbus-send", () => {
  const output = `method return time=1 sender=org.freedesktop.DBus -> destination=:1.5 serial=3 reply_serial=2
   array [
      string "org.freedesktop.DBus"
      string "org.freedesktop.secrets"
      string ":1.2"
   ]`;
  assert.deepEqual([...parseBusNames(output)], ["org.freedesktop.DBus", "org.freedesktop.secrets", ":1.2"]);
});

test("un servizio in esecuzione vince su uno solo attivabile", () => {
  // Caso reale su Hyprland: gnome-keyring attivo, KWallet installato ma spento.
  const found = choosePasswordStore(new Set(["org.freedesktop.secrets"]), new Set(["org.kde.kwalletd6"]));
  assert.equal(found?.store, "gnome-libsecret");
  const kwalletRunning = choosePasswordStore(new Set(["org.kde.kwalletd6"]), new Set(["org.freedesktop.secrets"]));
  assert.equal(kwalletRunning?.store, "kwallet6");
});

test("senza servizi in esecuzione si usa uno attivabile, altrimenti nessuno", () => {
  assert.equal(choosePasswordStore(new Set(), new Set(["org.kde.kwalletd5"]))?.store, "kwallet5");
  assert.equal(choosePasswordStore(new Set(["org.gnome.Shell"]), new Set()), null);
});
