// Field recognition with Jev (TypeSafe, decision model).
// Jev receives ONLY the description of the form's fields and the headings of
// the profile fields; it answers which heading each field needs. Profile
// values never enter this module: the heading -> value matching happens
// locally, afterwards.
// Formato: https://docs.typesafe.ai/introduction/quickstart

export interface FormFieldInfo {
  // acroform: fillable field of the PDF; blank: blank line printed on the
  // sheet, as characters ("____", "....") or as a drawn line.
  source: "acroform" | "blank";
  fieldName: string;
  ids: string[];
  kind: "text" | "signature";
  tooltip: string;
  label: string;
  maxLen: number | null;
  pageIndex: number;
  // Rectangle in the page's PDF coordinates [x1, y1, x2, y2].
  rect: [number, number, number, number];
  // Text size around a blank line, to write over it in proportion.
  fontSize: number | null;
  currentValue: string;
}

export interface Heading {
  id: string;
  label: string;
  description: string;
  // Value computed at fill time instead of saved in the profile.
  // Jev still receives only the label and the description.
  automatic?: "today";
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

// Yes/no question: Jev answers with the probability of yes.
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
// The field wants several pieces of profile information written one after
// the other ("Il sottoscritto" = first name and surname, "Luogo e data"):
// which ones is said by a second request with one yes/no question per heading.
export const COMBINED_CHOICE = "insieme";

export interface FieldDecision {
  field: FormFieldInfo;
  // Id of the profile heading, SIGNATURE_CHOICE, COMBINED_CHOICE or
  // null if none.
  target: string | null;
  // With COMBINED_CHOICE: ids of the headings, in writing order.
  parts: string[];
  probability: number;
  confidence: number;
}

// Beyond this number of questions per request it is split: every question
// repeats the list of headings and the limit is 64k tokens per request.
const QUESTIONS_PER_REQUEST = 40;
// Yes/no questions do not repeat the list: many more of them fit.
const PART_QUESTIONS_PER_REQUEST = 150;
// A heading belongs to the combined field from this probability up.
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

// The answer keys are neutral (info_1, info_2…) and translated into heading
// ids locally: Jev sees the label, not our internal ids.
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

// COMBINED_CHOICE decisions come out without parts: the second request
// fills them in (buildPartRequests / applyPartAnswers).
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

// --- Combined fields: which headings, in what order --------------------------

export interface PreparedPartRequest {
  request: JevRequest<JevYesNoQuestion>;
  questionToPart: Map<string, { decision: FieldDecision; headingId: string }>;
}

function headingText(heading: Heading): string {
  return heading.description.trim() ? `${heading.label} (${heading.description})` : heading.label;
}

// One yes/no question for every combined field × heading pair. Here too
// only field descriptions and labels go to Jev, never values.
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

// Collects the headings with sufficient probability, per decision.
export function collectPartAnswers(prepared: PreparedPartRequest, response: JevResponse, into: Map<FieldDecision, string[]>): void {
  for (const [questionId, { decision, headingId }] of prepared.questionToPart) {
    const answer = response.answers[questionId];
    if (isYesNoAnswer(answer) && answer.noul >= PART_MIN_PROBABILITY) {
      into.set(decision, [...(into.get(decision) ?? []), headingId]);
    }
  }
}

// Position of a whole word in the text, case-insensitive:
// "nome" must not be found inside "cognome".
function wordPosition(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, "iu").exec(text);
  return match ? match.index + match[1].length : Number.POSITIVE_INFINITY;
}

// Writing order: the one in which the form names the pieces of information
// ("Cognome e nome"), looking for the first word of the label ("Data di oggi"
// → data). It applies only if it names all of them: in "Luogo e data" with
// "Comune di residenza" the town does not appear, and mixing the two orders
// would put the date first. Otherwise the profile's order is followed.
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

// Final decision for a combined field: no part → no information,
// only one → that heading, two or more → combined.
export function resolveCombined(decision: FieldDecision, headingIds: string[], headings: Heading[]): FieldDecision {
  if (headingIds.length === 0) {
    return { ...decision, target: null, parts: [] };
  }
  if (headingIds.length === 1) {
    return { ...decision, target: headingIds[0], parts: [] };
  }
  return { ...decision, parts: orderParts(decision.field, headingIds, headings) };
}
