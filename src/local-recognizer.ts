// Riconoscimento dei campi in locale: confronta il testo vicino al campo con
// gli esempi di data/recognizer.json e con le etichette delle intestazioni
// del profilo, e sceglie la risposta più somigliante. Tutta la conoscenza
// (esempi, alias, abbreviazioni, soglie) sta nel file di dati: il codice fa
// solo normalizzazione, somiglianza e scelta, e non va toccato per un caso
// nuovo. Produce le stesse decisioni di Jev, così la revisione non cambia.
import recognizerData from "../data/recognizer.json" with { type: "json" };
import { COMBINED_CHOICE, SIGNATURE_CHOICE, type FieldDecision, type FormFieldInfo, type Heading } from "./jev.ts";

type Example = string | { text: string; weight: number };

interface RecognizerData {
  parameters: {
    // Sotto questo punteggio il campo resta senza proposta.
    noneThreshold: number;
    // Ogni parte di un'etichetta scomposta ("Nome e numero tessera") deve
    // essere riconosciuta almeno così.
    combinedPartThreshold: number;
    // Quota tolta a una coda dell'etichetta che ne copre solo una parte: a
    // parità di somiglianza vince l'esempio più lungo e specifico.
    shortTailPenalty: number;
    maxTailWords: number;
    // Il nome tecnico di un AcroForm ("txtCognome") vale meno del testo stampato.
    fieldNameWeight: number;
    signatureFieldScore: number;
  };
  abbreviations: Record<string, string>;
  targets: { id: string; headings?: string[]; examples: Example[]; minLength?: number; special?: "signature" | "none" }[];
  combined: { parts: string[]; examples: Example[] }[];
}

const DATA = recognizerData as RecognizerData;
const PARAMETERS = DATA.parameters;
const SEPARATOR = ",";
const CONJUNCTIONS = new Set(["e", "ed", "and"]);
const LABEL_PREFIX = /^(a sinistra|sopra|sotto):\s*/i;
const FIELD_NAME_NOISE = new Set(["txt", "text", "campo", "field", "fld", "tf", "testo"]);

// --- Normalizzazione -----------------------------------------------------------------

// Varianti grafiche dell'italiano ridotte a una, prima di togliere la
// punteggiatura che le distingue: generiche, non legate a un campo.
const REWRITES: [RegExp, string][] = [
  [/\be\s*-\s*mail\b/g, "email"],
  [/\bla sottoscritta\b/g, "il sottoscritto"],
  [/\b(il|lo)\s*\/\s*la\b/g, "$1"],
  [/(\p{L}{2,})\s*\/\s*[ae]\b/gu, "$1"],
  [/(\p{L}{2,})\s*\(\s*[ae]\s*\)/gu, "$1"],
];
// Sigle puntate: "c.f." → "cf".
const DOTTED_ACRONYM = /\b(?:\p{L}\.\s?){2,}/gu;

// Parole normalizzate; virgola, punto e virgola e barra restano come
// separatore per la scomposizione dei campi combinati.
export function tokenize(text: string): string[] {
  let plain = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  for (const [pattern, replacement] of REWRITES) {
    plain = plain.replace(pattern, replacement);
  }
  plain = plain.replace(DOTTED_ACRONYM, (acronym) => `${acronym.replace(/[.\s]/g, "")} `).replace(/[,;/]/g, ` ${SEPARATOR} `);
  return plain
    .split(/[^\p{L}\p{N},]+/u)
    .filter(Boolean)
    .flatMap((token) => (DATA.abbreviations[token] ?? token).split(" "));
}

function normalize(text: string): string {
  return tokenize(text)
    .filter((token) => token !== SEPARATOR)
    .join(" ");
}

function fieldNameTokens(fieldName: string): string[] {
  const spaced = fieldName.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/[_.\-[\]]+/g, " ");
  return tokenize(spaced).filter((token) => !FIELD_NAME_NOISE.has(token) && !/^\d+$/.test(token));
}

// --- Somiglianza ------------------------------------------------------------------------

// Coefficiente di Dice sui trigrammi di caratteri: regge refusi, sigle e
// parole in ordine diverso ("Patente n." / "Numero patente").
function trigrams(text: string): Map<string, number> {
  const padded = ` ${text} `;
  const counts = new Map<string, number>();
  for (let index = 0; index + 3 <= padded.length; index++) {
    const gram = padded.slice(index, index + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

interface PreparedExample {
  text: string;
  grams: Map<string, number>;
  size: number;
  weight: number;
}

function prepare(example: Example): PreparedExample {
  const { text, weight } = typeof example === "string" ? { text: example, weight: 1 } : example;
  const normalized = normalize(text);
  const grams = trigrams(normalized);
  return { text: normalized, grams, size: [...grams.values()].reduce((a, b) => a + b, 0), weight };
}

function similarity(a: PreparedExample, b: PreparedExample): number {
  if (a.text === b.text) {
    return 1;
  }
  let shared = 0;
  for (const [gram, count] of a.grams) {
    shared += Math.min(count, b.grams.get(gram) ?? 0);
  }
  return (2 * shared) / (a.size + b.size);
}

// --- Risposte possibili -------------------------------------------------------------------

interface Choice {
  target: string | null;
  parts: string[];
  examples: PreparedExample[];
  minLength: number;
}

// Un'intestazione eredita gli esempi del target che ha la sua etichetta fra
// gli alias; quelle create dall'utente hanno come esempio solo l'etichetta.
function buildChoices(headings: Heading[]): Choice[] {
  const headingOfTarget = new Map<string, string>();
  const choices: Choice[] = headings.map((heading) => {
    const label = normalize(heading.label);
    const target = DATA.targets.find((entry) => entry.headings?.map(normalize).includes(label));
    if (target && !headingOfTarget.has(target.id)) {
      headingOfTarget.set(target.id, heading.id);
    }
    const examples = [heading.label, ...(target?.examples ?? [])].map(prepare);
    return { target: heading.id, parts: [], examples, minLength: target?.minLength ?? 0 };
  });
  for (const entry of DATA.targets.filter((target) => target.special)) {
    choices.push({ target: entry.special === "signature" ? SIGNATURE_CHOICE : null, parts: [], examples: entry.examples.map(prepare), minLength: 0 });
  }
  for (const entry of DATA.combined) {
    const parts = entry.parts.map((part) => headingOfTarget.get(part)).filter((id): id is string => id !== undefined);
    choices.push({ ...combinedTarget(parts), examples: entry.examples.map(prepare), minLength: 0 });
  }
  return choices;
}

// Le parti che il profilo non ha si tolgono: con una sola rimasta il campo
// diventa quell'intestazione, con nessuna non c'è proposta.
function combinedTarget(parts: string[]): { target: string | null; parts: string[] } {
  if (parts.length < 2) {
    return { target: parts[0] ?? null, parts: [] };
  }
  return { target: COMBINED_CHOICE, parts };
}

// --- Punteggio di un testo ----------------------------------------------------------------

interface Scored {
  choice: Choice;
  score: number;
}

// Si confrontano le code dell'etichetta (ultima parola, ultime due…): la
// parte più vicina al campo è la fine, e "Il sottoscritto ____ nato a" va
// letto da "nato a".
function scoreWords(words: string[], choices: Choice[], maxLen: number | null): Scored[] {
  const tails = Array.from({ length: Math.min(words.length, PARAMETERS.maxTailWords) }, (_, index) => {
    const length = index + 1;
    const coverage = length / words.length;
    return { text: prepare(words.slice(-length).join(" ")), factor: 1 - PARAMETERS.shortTailPenalty * (1 - coverage) };
  });
  return choices
    .filter((choice) => maxLen === null || choice.minLength <= maxLen)
    .map((choice) => ({
      choice,
      score: Math.max(0, ...tails.flatMap((tail) => choice.examples.map((example) => similarity(tail.text, example) * example.weight * tail.factor))),
    }));
}

function best(scored: Scored[]): Scored | null {
  return scored.reduce<Scored | null>((top, item) => (item.score > (top?.score ?? 0) ? item : top), null);
}

function segmentsOf(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === SEPARATOR || CONJUNCTIONS.has(token)) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(token);
    }
  }
  return segments.filter((segment) => segment.length > 0);
}

// "Nome e numero tessera", "Cognome/Nome": ogni parte riconosciuta da sola
// come un'intestazione diversa. Vale anche per quelle create dall'utente.
function splitCombined(tokens: string[], choices: Choice[], maxLen: number | null): Scored | null {
  const headingChoices = choices.filter((choice) => choice.target !== null && choice.target !== SIGNATURE_CHOICE && choice.parts.length === 0);
  const parts = segmentsOf(tokens).map((segment) => best(scoreWords(segment, headingChoices, maxLen)));
  if (parts.length < 2 || parts.some((part) => !part || part.score < PARAMETERS.combinedPartThreshold)) {
    return null;
  }
  const ids = parts.map((part) => part!.choice.target!);
  if (new Set(ids).size !== ids.length) {
    return null;
  }
  return { choice: { target: COMBINED_CHOICE, parts: ids, examples: [], minLength: 0 }, score: Math.min(...parts.map((part) => part!.score)) };
}

// Se l'etichetta si scompone in parti, la risposta migliore presa da sola è
// di solito una di quelle parti, la più vicina al campo: il campo le vuole tutte.
function scoreText(tokens: string[], choices: Choice[], maxLen: number | null): Scored | null {
  const top = best(scoreWords(tokens.filter((token) => token !== SEPARATOR), choices, maxLen));
  const split = splitCombined(tokens, choices, maxLen);
  if (split && top && (top.choice.target === null || split.choice.parts.includes(top.choice.target))) {
    return top.choice.target === null ? top : { ...split, score: Math.max(split.score, top.score) };
  }
  return top;
}

// --- Decisione per campo ------------------------------------------------------------------

function fieldTexts(field: FormFieldInfo): { tokens: string[]; weight: number }[] {
  return [
    { tokens: tokenize(field.label.replace(LABEL_PREFIX, "")), weight: 1 },
    { tokens: tokenize(field.tooltip), weight: 1 },
    { tokens: fieldNameTokens(field.fieldName), weight: PARAMETERS.fieldNameWeight },
  ].filter(({ tokens }) => tokens.some((token) => token !== SEPARATOR));
}

function decide(field: FormFieldInfo, choices: Choice[]): FieldDecision {
  const none: FieldDecision = { field, target: null, parts: [], probability: 0, confidence: 0 };
  if (field.kind === "signature") {
    return { field, target: SIGNATURE_CHOICE, parts: [], probability: PARAMETERS.signatureFieldScore, confidence: PARAMETERS.signatureFieldScore };
  }
  const top = best(
    fieldTexts(field).flatMap(({ tokens, weight }) => {
      const scored = scoreText(tokens, choices, field.maxLen);
      return scored ? [{ ...scored, score: scored.score * weight }] : [];
    }),
  );
  if (!top || top.choice.target === null || top.score < PARAMETERS.noneThreshold) {
    return none;
  }
  const probability = Math.min(1, top.score);
  return { field, target: top.choice.target, parts: top.choice.parts, probability, confidence: probability };
}

export function recognizeFieldsLocally(fields: FormFieldInfo[], headings: Heading[]): FieldDecision[] {
  const choices = buildChoices(headings);
  return fields.map((field) => decide(field, choices));
}
