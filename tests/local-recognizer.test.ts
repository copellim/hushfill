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

test("la normalizzazione scioglie sigle, abbreviazioni e forme di genere", () => {
  assert.deepEqual(tokenize("C.F."), ["codice", "fiscale"]);
  assert.deepEqual(tokenize("Nato/a a"), ["nato", "a"]);
  assert.deepEqual(tokenize("La sottoscritta"), ["il", "sottoscritto"]);
  assert.deepEqual(tokenize("Prov. (PR)"), ["provincia", "pr"]);
  assert.deepEqual(tokenize("E-mail"), ["email"]);
  assert.deepEqual(tokenize("Città"), ["citta"]);
});

test("le etichette tipiche dei moduli italiani vanno all'intestazione giusta", () => {
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

test("l'indizio più vicino al campo vince su quelli più lontani", () => {
  // Testo a sinistra di un AcroForm che raccoglie anche l'etichetta del campo precedente.
  assert.equal(targetOf("a sinistra: Cognome Nome", { source: "acroform" }), "nome");
});

test("i campi combinati escono con le parti nell'ordine del modulo", () => {
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

test("la scomposizione generica regge le intestazioni create dall'utente", () => {
  const decision = recognize("a sinistra: Nome e numero tessera");
  assert.equal(decision.target, COMBINED_CHOICE);
  assert.deepEqual(decision.parts, ["nome", "tessera"]);
});

test("le intestazioni create dall'utente si abbinano per parole, senza confondere quelle simili", () => {
  assert.equal(targetOf("a sinistra: Patente n."), "patente");
  assert.equal(targetOf("a sinistra: Numero di telefono"), "telefono");
  assert.equal(targetOf("a sinistra: Numero tessera sanitaria"), "tessera");
});

test("firma da testo e da campo firma", () => {
  assert.equal(targetOf("sotto: Firma del dichiarante"), SIGNATURE_CHOICE);
  assert.equal(targetOf("", { source: "acroform", kind: "signature", fieldName: "Signature1" }), SIGNATURE_CHOICE);
});

test("campi non personali o senza indizi restano senza proposta", () => {
  for (const label of ["a sinistra: PEC", "sopra: Spazio riservato all'ufficio", "a sinistra: Protocollo n.", "a sinistra: Motivo della richiesta", ""]) {
    assert.equal(targetOf(label), null, label);
  }
});

test("i dati di terzi negli esempi restano senza proposta, e somiglianti generalizzano", () => {
  assert.equal(targetOf("a sinistra: Cognome del minore"), null);
  assert.equal(targetOf("a sinistra: Cognome della minore"), null);
  assert.equal(targetOf("a sinistra: Cognome"), "cognome");
});

test("un esempio più lungo e specifico vince su uno corto", () => {
  // "il" da solo è la data di nascita, "rilasciato il" no.
  assert.equal(targetOf("a sinistra: rilasciato il"), null);
});

test("il nome tecnico e la lunghezza massima di un AcroForm aiutano", () => {
  assert.equal(targetOf("", { source: "acroform", fieldName: "txtCodiceFiscale" }), "cf");
  assert.equal(targetOf("", { source: "acroform", fieldName: "dataNascita" }), "nascita-data");
  // Un campo da 2 caratteri non può contenere il codice fiscale.
  assert.notEqual(targetOf("a sinistra: Codice fiscale", { source: "acroform", maxLen: 2 }), "cf");
  assert.equal(targetOf("a sinistra: Codice fiscale", { source: "acroform", maxLen: 16 }), "cf");
});

test("senza l'intestazione nel profilo la parte di un combinato si toglie", () => {
  const withoutName = headings.filter((heading) => heading.id !== "nome");
  const [decision] = recognizeFieldsLocally([field("a sinistra: Nome e cognome")], withoutName);
  assert.equal(decision.target, "cognome");
  assert.deepEqual(decision.parts, []);
});
