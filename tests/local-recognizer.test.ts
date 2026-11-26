// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeFieldsLocally, tokenize } from "../src/local-recognizer.ts";
import { COMBINED_CHOICE, SIGNATURE_CHOICE, type FormFieldInfo, type Heading } from "../src/jev.ts";

const headings: Heading[] = [
  ["nome", "Nome"],
  ["cognome", "Cognome"],
  ["nascita-data", "Data di nascita"],
  ["nascita-luogo", "Luogo di nascita"],
  ["cf", "Codice fiscale"],
  ["indirizzo", "Indirizzo di residenza"],
  ["cap", "CAP"],
  ["comune", "Comune di residenza"],
  ["provincia", "Provincia di residenza"],
  ["telefono", "Telefono"],
  ["email", "Email"],
  ["oggi", "Data di oggi"],
  ["patente", "Numero patente"],
  ["tessera", "Numero tessera"],
].map(([id, label]) => ({ id, label, description: "" }));

function field(label: string, overrides: Partial<FormFieldInfo> = {}): FormFieldInfo {
  return {
    source: "blank",
    fieldName: "",
    ids: [],
    kind: "text",
    tooltip: "",
    label,
    maxLen: null,
    pageIndex: 0,
    rect: [0, 0, 10, 10],
    fontSize: 10,
    currentValue: "",
    ...overrides,
  };
}

function recognize(label: string, overrides: Partial<FormFieldInfo> = {}) {
  const [decision] = recognizeFieldsLocally([field(label, overrides)], headings);
  return decision;
}

function targetOf(label: string, overrides: Partial<FormFieldInfo> = {}): string | null {
  return recognize(label, overrides).target;
}

test("normalisation expands acronyms, abbreviations and gendered forms", () => {
  assert.deepEqual(tokenize("C.F."), ["codice", "fiscale"]);
  assert.deepEqual(tokenize("Nato/a a"), ["nato", "a"]);
  assert.deepEqual(tokenize("La sottoscritta"), ["il", "sottoscritto"]);
  assert.deepEqual(tokenize("Prov. (PR)"), ["provincia", "pr"]);
  assert.deepEqual(tokenize("E-mail"), ["email"]);
  assert.deepEqual(tokenize("Città"), ["citta"]);
});

test("typical labels of Italian forms go to the right heading", () => {
  const cases: [string, string][] = [
    ["a sinistra: Cognome", "cognome"],
    ["a sinistra: Nome", "nome"],
    ["a sinistra: Il sottoscritto nato a", "nascita-luogo"],
    ["a sinistra: il", "nascita-data"],
    ["a sinistra: Data di nascita", "nascita-data"],
    ["a sinistra: C.F.", "cf"],
    ["a sinistra: residente a", "comune"],
    ["a sinistra: in via", "indirizzo"],
    ["a sinistra: CAP", "cap"],
    ["a sinistra: Prov.", "provincia"],
    ["a sinistra: Tel.", "telefono"],
    ["a sinistra: Cellulare", "telefono"],
    ["a sinistra: indirizzo e-mail", "email"],
    ["sotto: Data", "oggi"],
    ["a sinistra: Date of birth", "nascita-data"],
    ["a sinistra: Surname", "cognome"],
  ];
  for (const [label, expected] of cases) {
    assert.equal(targetOf(label), expected, label);
  }
});

test("the clue closest to the field wins over those further away", () => {
  // Text to the left of an AcroForm that also picks up the previous field's label.
  assert.equal(targetOf("a sinistra: Cognome Nome", { source: "acroform" }), "nome");
});

test("combined fields come out with the parts in the form's order", () => {
  const cases: [string, string[]][] = [
    ["a sinistra: Il/La sottoscritto/a", ["nome", "cognome"]],
    ["a sinistra: Cognome e nome", ["cognome", "nome"]],
    ["sotto: Luogo e data", ["comune", "oggi"]],
    ["a sinistra: Luogo e data di nascita", ["nascita-luogo", "nascita-data"]],
  ];
  for (const [label, parts] of [...cases, ["a sinistra: Cognome/Nome", ["cognome", "nome"]] as [string, string[]]]) {
    const decision = recognize(label);
    assert.equal(decision.target, COMBINED_CHOICE, label);
    assert.deepEqual(decision.parts, parts, label);
  }
});

test("generic splitting copes with user-created headings", () => {
  const decision = recognize("a sinistra: Nome e numero tessera");
  assert.equal(decision.target, COMBINED_CHOICE);
  assert.deepEqual(decision.parts, ["nome", "tessera"]);
});

test("user-created headings are matched by words, without confusing similar ones", () => {
  assert.equal(targetOf("a sinistra: Patente n."), "patente");
  assert.equal(targetOf("a sinistra: Numero di telefono"), "telefono");
  assert.equal(targetOf("a sinistra: Numero tessera sanitaria"), "tessera");
});

test("signature from text and from a signature field", () => {
  assert.equal(targetOf("sotto: Firma del dichiarante"), SIGNATURE_CHOICE);
  assert.equal(targetOf("", { source: "acroform", kind: "signature", fieldName: "Signature1" }), SIGNATURE_CHOICE);
});

test("non-personal fields or fields without clues are left without a proposal", () => {
  for (const label of ["a sinistra: PEC", "sopra: Spazio riservato all'ufficio", "a sinistra: Protocollo n.", "a sinistra: Motivo della richiesta", ""]) {
    assert.equal(targetOf(label), null, label);
  }
});

test("third-party data in the examples is left without a proposal, and similar labels generalise", () => {
  assert.equal(targetOf("a sinistra: Cognome del minore"), null);
  assert.equal(targetOf("a sinistra: Cognome della minore"), null);
  assert.equal(targetOf("a sinistra: Cognome"), "cognome");
});

test("a longer, more specific example beats a short one", () => {
  // "il" alone is the date of birth, "rilasciato il" (issued on) is not.
  assert.equal(targetOf("a sinistra: rilasciato il"), null);
});

test("the technical name and maximum length of an AcroForm help", () => {
  assert.equal(targetOf("", { source: "acroform", fieldName: "txtCodiceFiscale" }), "cf");
  assert.equal(targetOf("", { source: "acroform", fieldName: "dataNascita" }), "nascita-data");
  // A 2-character field cannot hold the tax code.
  assert.notEqual(targetOf("a sinistra: Codice fiscale", { source: "acroform", maxLen: 2 }), "cf");
  assert.equal(targetOf("a sinistra: Codice fiscale", { source: "acroform", maxLen: 16 }), "cf");
});

test("without the heading in the profile the part of a combined field is removed", () => {
  const withoutName = headings.filter((heading) => heading.id !== "nome");
  const [decision] = recognizeFieldsLocally([field("a sinistra: Nome e cognome")], withoutName);
  assert.equal(decision.target, "cognome");
  assert.deepEqual(decision.parts, []);
});
