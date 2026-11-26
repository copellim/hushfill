// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { combinedValue, headingValue, migrateStore, suggestHeadingLabel, todayText, withProfileUpdates, type Profile, type ProfileStore } from "../src/profiles.ts";

const profile: Profile = { id: "p", name: "Prova", values: { "h-nome": "Mario", "h-oggi": "valore vecchio" }, signature: null };

test("today's date is in dd/mm/yyyy format", () => {
  assert.equal(todayText(new Date(2026, 0, 5)), "05/01/2026");
});

test("the automatic heading ignores the saved value and gives today's date", () => {
  assert.equal(headingValue({ id: "h-oggi", label: "Data di oggi", description: "", automatic: "today" }, profile), todayText());
  assert.equal(headingValue({ id: "h-nome", label: "Nome", description: "" }, profile), "Mario");
  assert.equal(headingValue({ id: "h-assente", label: "CAP", description: "" }, profile), "");
});

test("version 1 profiles receive the automatic date only once", () => {
  const v1 = { version: 1, headings: [{ id: "h-nome", label: "Nome", description: "" }], profiles: [profile], activeProfileId: "p" };
  const migrated = migrateStore(v1);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.headings.map((h) => h.automatic ?? null), [null, "today"]);
  // A version 2 without the date (the user deleted it) stays as it is.
  const deleted = { ...migrated, version: 2, headings: migrated.headings.filter((h) => !h.automatic) };
  assert.equal(migrateStore(deleted).headings.length, 1);
});

test("version 3 removes «Nome e cognome» and its values; afterwards it is never touched again", () => {
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
  // Added back by hand by the user in version 3: it stays.
  assert.equal(migrateStore({ ...v2, version: 3 }).headings.length, 2);
});

test("version 4 updates the default descriptions only if untouched", () => {
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

test("combined field: space between the parts, comma before the date, empty if a part is missing", () => {
  const nome = { id: "h-nome", label: "Nome", description: "" };
  const cognome = { id: "h-cognome", label: "Cognome", description: "" };
  const luogo = { id: "h-luogo", label: "Luogo", description: "" };
  const oggi = { id: "h-oggi", label: "Data di oggi", description: "", automatic: "today" as const };
  const person: Profile = { id: "p", name: "Prova", values: { "h-nome": "Mario", "h-cognome": "Rossi", "h-luogo": "Parma" }, signature: null };
  assert.deepEqual(combinedValue([nome, cognome], person), { value: "Mario Rossi", missing: [] });
  assert.equal(combinedValue([luogo, oggi], person).value, `Parma, ${todayText()}`);
  assert.deepEqual(combinedValue([nome, cognome], { ...person, values: { "h-nome": "Mario" } }), { value: "", missing: ["Cognome"] });
});

test("name proposed for a new field from the text printed next to it", () => {
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "a sinistra: numero di tessera:", fieldName: "" }), "Numero di tessera");
  assert.equal(suggestHeadingLabel({ tooltip: "Targa del veicolo", label: "a sinistra: x", fieldName: "Text3" }), "Targa del veicolo");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "", fieldName: "Text3" }), "");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "", fieldName: "matricola" }), "Matricola");
  assert.equal(suggestHeadingLabel({ tooltip: "", label: "a sinistra: iscritto all'albo n.", fieldName: "" }), "Iscritto all'albo");
  // Long: the last words, closest to the field, remain, within 40 characters.
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

test("new fields and missing values end up in the profile, without touching the original", () => {
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

test("a new field with the name of an existing one is not duplicated and does not overwrite", () => {
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
