// Riconoscimento dei campi con Jev (TypeSafe, modello decisionale).
// Jev riceve SOLO la descrizione dei campi del modulo e le intestazioni dei
// campi del profilo; risponde quale intestazione serve a ciascun campo. I
// valori del profilo non entrano mai in questo modulo: l'associazione
// intestazione -> valore avviene in locale, dopo.
// Formato: https://docs.typesafe.ai/introduction/quickstart

export interface FormFieldInfo {
  // acroform: campo compilabile del PDF; blank: riga vuota stampata sul
  // foglio, come caratteri ("____", "....") o come linea disegnata.
  source: "acroform" | "blank";
  fieldName: string;
  ids: string[];
  kind: "text" | "signature";
  tooltip: string;
  label: string;
  maxLen: number | null;
  pageIndex: number;
  // Rettangolo in coordinate PDF della pagina [x1, y1, x2, y2].
  rect: [number, number, number, number];
  // Corpo del testo attorno a una riga vuota, per scriverci sopra in proporzione.
  fontSize: number | null;
  currentValue: string;
}

export interface Heading {
  id: string;
  label: string;
  description: string;
  // Valore calcolato al momento della compilazione invece che salvato nel
  // profilo. A Jev arrivano comunque solo etichetta e descrizione.
  automatic?: "today";
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

// Domanda sì/no: Jev risponde con la probabilità del sì.
export interface JevYesNoQuestion {
  type: "noul";
  instructions: string;
}

export interface JevRequest<Question extends JevChoiceQuestion | JevYesNoQuestion = JevChoiceQuestion | JevYesNoQuestion> {
  state: string;
  questions: Record<string, Question>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevYesNoAnswer {
  type: "noul";
  noul: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer | JevYesNoAnswer | { type: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export const SIGNATURE_CHOICE = "firma";
export const NONE_CHOICE = "nessuna";
// Il campo vuole più informazioni del profilo scritte una dopo l'altra
// ("Il sottoscritto" = nome e cognome, "Luogo e data"): quali, lo dice una
// seconda richiesta con una domanda sì/no per intestazione.
export const COMBINED_CHOICE = "insieme";

export interface FieldDecision {
  field: FormFieldInfo;
  // Id dell'intestazione del profilo, SIGNATURE_CHOICE, COMBINED_CHOICE o
  // null se nessuna.
  target: string | null;
  // Con COMBINED_CHOICE: id delle intestazioni, nell'ordine di scrittura.
  parts: string[];
  probability: number;
  confidence: number;
}

// Oltre questa soglia di domande per richiesta si spezza: ogni domanda
// ripete l'elenco delle intestazioni e il limite è 64k token per richiesta.
const QUESTIONS_PER_REQUEST = 40;
// Le domande sì/no non ripetono l'elenco: ne stanno molte di più.
const PART_QUESTIONS_PER_REQUEST = 150;
// Un'intestazione fa parte del campo combinato da questa probabilità in su.
const PART_MIN_PROBABILITY = 0.5;
const MAX_TEXT_LENGTH = 160;

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TEXT_LENGTH ? `…${clean.slice(-MAX_TEXT_LENGTH)}` : clean;
}

function describeField(field: FormFieldInfo): string {
  const parts = field.source === "blank" ? ["riga vuota stampata sul foglio, da compilare a mano"] : [`nome tecnico «${clip(field.fieldName)}»`];
  if (field.tooltip.trim()) {
    parts.push(`descrizione «${clip(field.tooltip)}»`);
  }
  if (field.label.trim()) {
    parts.push(`testo stampato vicino «${clip(field.label)}»`);
  }
  if (field.maxLen) {
    parts.push(`massimo ${field.maxLen} caratteri`);
  }
  if (field.kind === "signature") {
    parts.push("campo firma");
  }
  return parts.join("; ");
}

// Le chiavi delle risposte sono neutre (info_1, info_2…) e tradotte in id
// delle intestazioni in locale: Jev vede l'etichetta, non i nostri id interni.
export function buildCriteria(headings: Heading[]): { criteria: Record<string, string>; keyToHeading: Map<string, string> } {
  const criteria: Record<string, string> = {};
  const keyToHeading = new Map<string, string>();
  headings.forEach((heading, index) => {
    const key = `info_${index + 1}`;
    criteria[key] = heading.description.trim() ? `${heading.label}: ${heading.description}` : heading.label;
    keyToHeading.set(key, heading.id);
  });
  criteria[COMBINED_CHOICE] = "Più informazioni dell'elenco scritte insieme nello stesso campo, ad esempio nome e cognome, oppure luogo e data";
  criteria[SIGNATURE_CHOICE] = "Spazio per la firma autografa della persona che compila";
  criteria[NONE_CHOICE] = "Nessuna delle informazioni elencate: campo non personale o da compilare a mano";
  return { criteria, keyToHeading };
}

export interface PreparedRequest {
  request: JevRequest<JevChoiceQuestion>;
  questionToField: Map<string, FormFieldInfo>;
  keyToHeading: Map<string, string>;
}

export function buildJevRequests(fields: FormFieldInfo[], headings: Heading[]): PreparedRequest[] {
  const { criteria, keyToHeading } = buildCriteria(headings);
  const prepared: PreparedRequest[] = [];
  for (let start = 0; start < fields.length; start += QUESTIONS_PER_REQUEST) {
    const chunk = fields.slice(start, start + QUESTIONS_PER_REQUEST);
    const questionToField = new Map<string, FormFieldInfo>();
    const questions: Record<string, JevChoiceQuestion> = {};
    const stateLines = ["Modulo PDF da compilare. Elenco dei campi:"];
    chunk.forEach((field, index) => {
      const questionId = `campo_${start + index + 1}`;
      questionToField.set(questionId, field);
      stateLines.push(`- ${questionId} (pagina ${field.pageIndex + 1}): ${describeField(field)}`);
      questions[questionId] = {
        type: "choice",
        instructions: `Quale informazione personale va scritta nel campo ${questionId} del modulo (${describeField(field)})?`,
        criteria,
      };
    });
    prepared.push({ request: { state: stateLines.join("\n"), questions }, questionToField, keyToHeading });
  }
  return prepared;
}

function isChoiceAnswer(answer: JevResponse["answers"][string] | undefined): answer is JevChoiceAnswer {
  return answer?.type === "choice" && typeof (answer as JevChoiceAnswer).choice === "string";
}

function isYesNoAnswer(answer: JevResponse["answers"][string] | undefined): answer is JevYesNoAnswer {
  return answer?.type === "noul" && typeof (answer as JevYesNoAnswer).noul === "number";
}

function choiceTarget(choice: string, keyToHeading: Map<string, string>): string | null {
  if (choice === SIGNATURE_CHOICE || choice === COMBINED_CHOICE) {
    return choice;
  }
  return keyToHeading.get(choice) ?? null;
}

// Le decisioni COMBINED_CHOICE escono senza parti: le riempie la seconda
// richiesta (buildPartRequests / applyPartAnswers).
export function parseJevResponse(prepared: PreparedRequest, response: JevResponse): FieldDecision[] {
  const decisions: FieldDecision[] = [];
  for (const [questionId, field] of prepared.questionToField) {
    const answer = response.answers[questionId];
    if (!isChoiceAnswer(answer)) {
      decisions.push({ field, target: null, parts: [], probability: 0, confidence: 0 });
      continue;
    }
    decisions.push({
      field,
      target: choiceTarget(answer.choice, prepared.keyToHeading),
      parts: [],
      probability: answer.probabilities[answer.choice] ?? 0,
      confidence: answer.confidence,
    });
  }
  return decisions;
}

// --- Campi combinati: quali intestazioni, in che ordine ----------------------

export interface PreparedPartRequest {
  request: JevRequest<JevYesNoQuestion>;
  questionToPart: Map<string, { decision: FieldDecision; headingId: string }>;
}

function headingText(heading: Heading): string {
  return heading.description.trim() ? `${heading.label} (${heading.description})` : heading.label;
}

// Una domanda sì/no per ogni coppia campo combinato × intestazione. Anche qui
// a Jev vanno solo descrizioni del campo ed etichette, mai valori.
export function buildPartRequests(decisions: FieldDecision[], headings: Heading[]): PreparedPartRequest[] {
  const pairs = decisions
    .filter((decision) => decision.target === COMBINED_CHOICE)
    .flatMap((decision, fieldIndex) => headings.map((heading) => ({ decision, heading, fieldIndex })));
  const prepared: PreparedPartRequest[] = [];
  for (let start = 0; start < pairs.length; start += PART_QUESTIONS_PER_REQUEST) {
    const questions: Record<string, JevYesNoQuestion> = {};
    const questionToPart = new Map<string, { decision: FieldDecision; headingId: string }>();
    const stateLines = ["Modulo PDF da compilare. Ogni campo qui sotto contiene più informazioni personali scritte una dopo l'altra."];
    const describedFields = new Set<number>();
    for (const [index, { decision, heading, fieldIndex }] of pairs.slice(start, start + PART_QUESTIONS_PER_REQUEST).entries()) {
      const questionId = `parte_${start + index + 1}`;
      const fieldText = `campo_combinato_${fieldIndex + 1} (${describeField(decision.field)})`;
      if (!describedFields.has(fieldIndex)) {
        describedFields.add(fieldIndex);
        stateLines.push(`- ${fieldText}`);
      }
      questions[questionId] = {
        type: "noul",
        instructions: `Nel campo ${fieldText} va scritta, insieme alle altre, l'informazione «${headingText(heading)}»?`,
      };
      questionToPart.set(questionId, { decision, headingId: heading.id });
    }
    prepared.push({ request: { state: stateLines.join("\n"), questions }, questionToPart });
  }
  return prepared;
}

// Raccoglie le intestazioni con probabilità sufficiente, per decisione.
export function collectPartAnswers(prepared: PreparedPartRequest, response: JevResponse, into: Map<FieldDecision, string[]>): void {
  for (const [questionId, { decision, headingId }] of prepared.questionToPart) {
    const answer = response.answers[questionId];
    if (isYesNoAnswer(answer) && answer.noul >= PART_MIN_PROBABILITY) {
      into.set(decision, [...(into.get(decision) ?? []), headingId]);
    }
  }
}

// Posizione di una parola intera nel testo, senza distinzione di maiuscole:
// "nome" non deve trovarsi dentro "cognome".
function wordPosition(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, "iu").exec(text);
  return match ? match.index + match[1].length : Number.POSITIVE_INFINITY;
}

// Ordine di scrittura: quello in cui il modulo nomina le informazioni
// ("Cognome e nome"), cercando la prima parola dell'etichetta ("Data di oggi"
// → data). Vale solo se le nomina tutte: in "Luogo e data" con "Comune di
// residenza" il comune non compare, e mescolare i due ordini metterebbe la
// data davanti. Altrimenti si segue l'ordine del profilo.
export function orderParts(field: FormFieldInfo, headingIds: string[], headings: Heading[]): string[] {
  const text = `${field.label} ${field.tooltip}`;
  const parts = headings
    .filter((heading) => headingIds.includes(heading.id))
    .map((heading) => ({ id: heading.id, position: wordPosition(text, heading.label.trim().split(/\s+/)[0] ?? "") }));
  if (parts.every(({ position }) => Number.isFinite(position))) {
    parts.sort((a, b) => a.position - b.position);
  }
  return parts.map(({ id }) => id);
}

// Decisione finale di un campo combinato: nessuna parte → nessuna
// informazione, una sola → quella intestazione, due o più → combinato.
export function resolveCombined(decision: FieldDecision, headingIds: string[], headings: Heading[]): FieldDecision {
  if (headingIds.length === 0) {
    return { ...decision, target: null, parts: [] };
  }
  if (headingIds.length === 1) {
    return { ...decision, target: headingIds[0], parts: [] };
  }
  return { ...decision, parts: orderParts(decision.field, headingIds, headings) };
}
