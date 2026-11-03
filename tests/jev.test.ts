// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJevRequests,
  buildPartRequests,
  collectPartAnswers,
  orderParts,
  parseJevResponse,
  resolveCombined,
  COMBINED_CHOICE,
  NONE_CHOICE,
  SIGNATURE_CHOICE,
  type FieldDecision,
  type FormFieldInfo,
  type Heading,
} from "../src/jev.ts";

const headings: Heading[] = [
  { id: "h-nome", label: "Nome", description: "" },
  { id: "h-cf", label: "Codice fiscale", description: "16 caratteri" },
];

function field(fieldName: string, label = ""): FormFieldInfo {
  return { source: "acroform", fieldName, ids: ["1R"], kind: "text", tooltip: "", label, maxLen: null, pageIndex: 0, rect: [0, 0, 10, 10], fontSize: null, currentValue: "" };
}

test("la richiesta contiene solo intestazioni e descrizioni dei campi, mai valori", () => {
  const [prepared] = buildJevRequests([field("Text1", "Il sottoscritto")], headings);
  const serialized = JSON.stringify(prepared.request);
  assert.match(serialized, /Codice fiscale: 16 caratteri/);
  assert.match(serialized, /Il sottoscritto/);
  const criteria = prepared.request.questions.campo_1.criteria;
  assert.deepEqual(Object.keys(criteria), ["info_1", "info_2", COMBINED_CHOICE, SIGNATURE_CHOICE, NONE_CHOICE]);
});

test("oltre 40 campi la richiesta si spezza e la numerazione prosegue", () => {
  const fields = Array.from({ length: 45 }, (_, i) => field(`Text${i}`));
  const prepared = buildJevRequests(fields, headings);
  assert.equal(prepared.length, 2);
  assert.deepEqual(Object.keys(prepared[1].request.questions), ["campo_41", "campo_42", "campo_43", "campo_44", "campo_45"]);
});

test("la risposta viene tradotta negli id delle intestazioni", () => {
  const [prepared] = buildJevRequests([field("cf"), field("firma"), field("note")], headings);
  const decisions = parseJevResponse(prepared, {
    model: "jev-1.14.0",
    answers: {
      campo_1: { type: "choice", choice: "info_2", confidence: 0.9, probabilities: { info_2: 0.95 } },
      campo_2: { type: "choice", choice: SIGNATURE_CHOICE, confidence: 0.8, probabilities: { [SIGNATURE_CHOICE]: 0.9 } },
      campo_3: { type: "choice", choice: NONE_CHOICE, confidence: 0.7, probabilities: { [NONE_CHOICE]: 0.8 } },
    },
  });
  assert.deepEqual(
    decisions.map((d) => [d.field.fieldName, d.target, d.probability]),
    [
      ["cf", "h-cf", 0.95],
      ["firma", SIGNATURE_CHOICE, 0.9],
      ["note", null, 0.8],
    ],
  );
});

test("risposta mancante per un campo: nessun abbinamento", () => {
  const [prepared] = buildJevRequests([field("x")], headings);
  const [decision] = parseJevResponse(prepared, { model: "jev-1.14.0", answers: {} });
  assert.equal(decision.target, null);
});

const personHeadings: Heading[] = [
  { id: "h-nome", label: "Nome", description: "" },
  { id: "h-cognome", label: "Cognome", description: "" },
  { id: "h-luogo", label: "Luogo", description: "" },
  { id: "h-oggi", label: "Data di oggi", description: "Data della compilazione", automatic: "today" },
];

function combined(label: string): FieldDecision {
  return { field: field("Text1", label), target: COMBINED_CHOICE, parts: [], probability: 0.9, confidence: 0.9 };
}

test("campo combinato: una domanda sì/no per intestazione, solo per i campi combinati", () => {
  const plain: FieldDecision = { ...combined("Telefono"), target: "h-nome" };
  const [prepared] = buildPartRequests([plain, combined("Il sottoscritto")], personHeadings);
  const questions = Object.values(prepared.request.questions);
  assert.equal(questions.length, personHeadings.length);
  assert.ok(questions.every((q) => q.type === "noul" && q.instructions.includes("Il sottoscritto")));
  assert.match(questions[3].instructions, /«Data di oggi \(Data della compilazione\)»/);
  assert.deepEqual(buildPartRequests([plain], personHeadings), []);
});

test("le risposte sì/no tengono le intestazioni da 0,5 in su", () => {
  const decision = combined("Il sottoscritto");
  const [prepared] = buildPartRequests([decision], personHeadings);
  const parts = new Map<FieldDecision, string[]>();
  collectPartAnswers(prepared, {
    model: "jev-1.14.0",
    answers: {
      parte_1: { type: "noul", noul: 0.97 },
      parte_2: { type: "noul", noul: 0.5 },
      parte_3: { type: "noul", noul: 0.2 },
    },
  }, parts);
  assert.deepEqual(parts.get(decision), ["h-nome", "h-cognome"]);
});

test("ordine delle parti: come le nomina il modulo se le nomina tutte, altrimenti quello del profilo", () => {
  const withCity: Heading[] = [{ id: "h-comune", label: "Comune di residenza", description: "" }, ...personHeadings];
  assert.deepEqual(orderParts(field("x", "a sinistra: Luogo e data"), ["h-oggi", "h-comune"], withCity), ["h-comune", "h-oggi"]);
  assert.deepEqual(orderParts(field("x", "a sinistra: Data e luogo"), ["h-oggi", "h-luogo"], personHeadings), ["h-oggi", "h-luogo"]);
  assert.deepEqual(orderParts(field("x", "a sinistra: Cognome e nome"), ["h-nome", "h-cognome"], personHeadings), ["h-cognome", "h-nome"]);
  assert.deepEqual(orderParts(field("x", "a sinistra: Luogo e data"), ["h-oggi", "h-luogo"], personHeadings), ["h-luogo", "h-oggi"]);
  assert.deepEqual(orderParts(field("x", "a sinistra: Il sottoscritto"), ["h-cognome", "h-nome"], personHeadings), ["h-nome", "h-cognome"]);
});

test("un campo combinato con una sola parte diventa un campo semplice, senza parti nessuna informazione", () => {
  assert.deepEqual(resolveCombined(combined("x"), ["h-nome"], personHeadings).target, "h-nome");
  assert.equal(resolveCombined(combined("x"), [], personHeadings).target, null);
  const both = resolveCombined(combined("Il sottoscritto"), ["h-cognome", "h-nome"], personHeadings);
  assert.deepEqual([both.target, both.parts], [COMBINED_CHOICE, ["h-nome", "h-cognome"]]);
});
