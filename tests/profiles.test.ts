// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { combinedValue, headingValue, migrateStore, suggestHeadingLabel, todayText, withProfileUpdates, type Profile, type ProfileStore } from "../src/profiles.ts";

const profile: Profile = { id: "p", name: "Prova", values: { "h-nome": "Mario", "h-oggi": "valore vecchio" }, signature: null };

test("la data di oggi è nel formato gg/mm/aaaa", () => {
  assert.equal(todayText(new Date(2026, 0, 5)), "05/01/2026");
});

test("l'intestazione automatica ignora il valore salvato e dà la data di oggi", () => {
  assert.equal(headingValue({ id: "h-oggi", label: "Data di oggi", description: "", automatic: "today" }, profile), todayText());
  assert.equal(headingValue({ id: "h-nome", label: "Nome", description: "" }, profile), "Mario");
  assert.equal(headingValue({ id: "h-assente", label: "CAP", description: "" }, profile), "");
});

test("i profili della versione 1 ricevono la data automatica una volta sola", () => {
  const v1 = { version: 1, headings: [{ id: "h-nome", label: "Nome", description: "" }], profiles: [profile], activeProfileId: "p" };
  const migrated = migrateStore(v1);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.headings.map((h) => h.automatic ?? null), [null, "today"]);
  // Una versione 2 senza data (l'utente l'ha eliminata) resta com'è.
  const deleted = { ...migrated, version: 2, headings: migrated.headings.filter((h) => !h.automatic) };
  assert.equal(migrateStore(deleted).headings.length, 1);
});

test("la versione 3 toglie «Nome e cognome» e i suoi valori; dopo non si tocca più", () => {
  const v2 = {
    version: 2,
    headings: [
      { id: "h-nome", label: "Nome", description: "" },
      { id: "h-completo", label: "Nome e cognome", description: "" },
    ],
    profiles: [{ id: "p", name: "Prova", values: { "h-nome": "Mario", "h-completo": "Mario Rossi" }, signature: null }],
    activeProfileId: "p",
  };
  const migrated = migrateStore(v2);
  assert.deepEqual(migrated.headings.map((h) => h.id), ["h-nome"]);
  assert.deepEqual(migrated.profiles[0].values, { "h-nome": "Mario" });
  // Riaggiunto a mano dall'utente nella versione 3: resta.
  assert.equal(migrateStore({ ...v2, version: 3 }).headings.length, 2);
});

test("la versione 4 aggiorna le descrizioni predefinite solo se non toccate", () => {
  const v3 = {
    version: 3,
    headings: [
      { id: "h-oggi", label: "Data di oggi", description: "Data della compilazione, ad esempio in «Luogo e data» o accanto alla firma", automatic: "today" as const },
      { id: "h-comune", label: "Comune di residenza", description: "" },
      { id: "h-cap", label: "CAP", description: "" },
    ],
    profiles: [],
    activeProfileId: null,
  };
  const descriptions = migrateStore(v3).headings.map((h) => h.description);
  assert.ok(!descriptions[0].includes("Luogo e data"), descriptions[0]);
  assert.match(descriptions[1], /luogo in cui si firma/);
  assert.equal(descriptions[2], "");
  const edited = { ...v3, headings: [{ ...v3.headings[1], description: "Mia descrizione" }] };
  assert.equal(migrateStore(edited).headings[0].description, "Mia descrizione");
});

test("campo combinato: spazio tra le parti, virgola prima della data, vuoto se manca una parte", () => {
  const nome = { id: "h-nome", label: "Nome", description: "" };
  const cognome = { id: "h-cognome", label: "Cognome", description: "" };
  const luogo = { id: "h-luogo", label: "Luogo", description: "" };
  const oggi = { id: "h-oggi", label: "Data di oggi", description: "", automatic: "today" as const };
  const person: Profile = { id: "p", name: "Prova", values: { "h-nome": "Mario", "h-cognome": "Rossi", "h-luogo": "Parma" }, signature: null };
  assert.deepEqual(combinedValue([nome, cognome], person), { value: "Mario Rossi", missing: [] });
  assert.equal(combinedValue([luogo, oggi], person).value, `Parma, ${todayText()}`);
  assert.deepEqual(combinedValue([nome, cognome], { ...person, values: { "h-nome": "Mario" } }), { value: "", missing: ["Cognome"] });
});

test("nome proposto per un campo nuovo dal testo stampato accanto", () => {
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "a sinistra: numero di tessera:", fieldName: "" }), "Numero di tessera");
  assert.equal(suggestHeadingLabel({ tooltip: "Targa del veicolo", label: "a sinistra: x", fieldName: "Text3" }), "Targa del veicolo");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "", fieldName: "Text3" }), "");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "", fieldName: "matricola" }), "Matricola");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "a sinistra: iscritto all'albo n.", fieldName: "" }), "Iscritto all'albo");
  // Lungo: restano le ultime parole, le più vicine al campo, entro 40 caratteri.
  const long = suggestHeadingLabel({ tooltip: "", label: "sopra: A tal fine indica il seguente indirizzo e-mail:", fieldName: "" });
  assert.ok(long.length <= 40 && long.endsWith("indirizzo e-mail"), long);
});

function store(): ProfileStore {
  return {
    version: 4,
    headings: [
      { id: "h-nome", label: "Nome", description: "" },
      { id: "h-tel", label: "Telefono", description: "" },
      { id: "h-oggi", label: "Data di oggi", description: "", automatic: "today" },
    ],
    profiles: [{ id: "p", name: "Prova", values: { "h-nome": "Mario" }, signature: null }],
    activeProfileId: "p",
  };
}

test("campi nuovi e valori mancanti finiscono nel profilo, senza toccare l'originale", () => {
  const original = store();
  const next = withProfileUpdates(original, "p", {
    newHeadings: [{ label: " Numero di tessera ", description: "a sinistra: Tessera n.", value: "A123" }],
    values: [{ headingId: "h-tel", value: "333111222" }],
  });
  const added = next.headings.find((h) => h.label === "Numero di tessera");
  assert.ok(added);
  assert.equal(added.description, "a sinistra: Tessera n.");
  assert.deepEqual(next.profiles[0].values, { "h-nome": "Mario", "h-tel": "333111222", [added.id]: "A123" });
  assert.equal(original.headings.length, 3);
  assert.deepEqual(original.profiles[0].values, { "h-nome": "Mario" });
});

test("un campo nuovo con il nome di uno esistente non si duplica e non sovrascrive", () => {
  const next = withProfileUpdates(store(), "p", {
    newHeadings: [
      { label: "nome", description: "", value: "Luigi" },
      { label: "TELEFONO", description: "", value: "06123" },
      { label: "Data di oggi", description: "", value: "01/01/2020" },
    ],
    values: [],
  });
  assert.equal(next.headings.length, 3);
  assert.deepEqual(next.profiles[0].values, { "h-nome": "Mario", "h-tel": "06123" });
});
