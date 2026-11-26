// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import keyring from "../electron/keyring.cjs";

const { choosePasswordStore, parseBusNames } = keyring;

test("reads the names from the dbus-send output", () => {
  const output = `method return time=1 sender=org.freedesktop.DBus -> destination=:1.5 serial=3 reply_serial=2
   array [
      string "org.freedesktop.DBus"
      string "org.freedesktop.secrets"
      string ":1.2"
   ]`;
  assert.deepEqual([...parseBusNames(output)], ["org.freedesktop.DBus", "org.freedesktop.secrets", ":1.2"]);
});

test("a running service wins over one that can only be activated", () => {
  // Real case on Hyprland: gnome-keyring running, KWallet installed but stopped.
  const found = choosePasswordStore(new Set(["org.freedesktop.secrets"]), new Set(["org.kde.kwalletd6"]));
  assert.equal(found?.store, "gnome-libsecret");
  const kwalletRunning = choosePasswordStore(new Set(["org.kde.kwalletd6"]), new Set(["org.freedesktop.secrets"]));
  assert.equal(kwalletRunning?.store, "kwallet6");
});

test("with no running services an activatable one is used, otherwise none", () => {
  assert.equal(choosePasswordStore(new Set(), new Set(["org.kde.kwalletd5"]))?.store, "kwallet5");
  assert.equal(choosePasswordStore(new Set(["org.gnome.Shell"]), new Set()), null);
});
