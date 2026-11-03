// Estrae dal PDF ciò che va compilato, con il contesto che serve a Jev:
// - i campi AcroForm (testo e firma), quando il PDF è un modulo vero;
// - le righe vuote stampate nel testo ("Il sottoscritto ________",
//   "CAP ......") o disegnate come linee, quando il modulo è solo da stampare
//   e compilare a mano. Diventano campi "blank" compilati scrivendo sopra.
import { AnnotationMode, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { findHorizontalRules, type HorizontalRule } from "./drawn-lines";
import type { FormFieldInfo } from "./jev";

// Distanze in punti PDF entro cui un testo è considerato etichetta del campo.
const LEFT_REACH = 220;
const ABOVE_REACH = 26;
const BELOW_REACH = 16;
const VERTICAL_TOLERANCE = 3;
const MAX_LABEL_CHARS = 120;
// Una riga vuota è una sequenza di trattini bassi o di puntini abbastanza
// lunga da non essere punteggiatura.
const BLANK_PATTERN = /_{3,}|\.{5,}|…{2,}/g;
// Font usato per stimare dove cade la riga vuota dentro una stringa: i
// moduli usano quasi sempre Helvetica/Arial, e serve solo la proporzione.
const MEASURE_FONT = "Helvetica, Arial, sans-serif";
// Righe disegnate: corpo di scrittura stimato e limiti di plausibilità.
const DEFAULT_FONT_SIZE = 10;
const MIN_DRAWN_FONT_SIZE = 8;
const MAX_DRAWN_FONT_SIZE = 12;
// Testo che copre almeno tanti punti di una riga ci sta appoggiato sopra.
const UNDERLINE_MIN_OVERLAP = 10;
// Una riga lunga quasi quanto la pagina è un separatore, non uno spazio.
const MAX_RULE_PAGE_FRACTION = 0.9;

interface WidgetAnnotation {
  subtype: string;
  id: string;
  fieldName: string;
  fieldType: string;
  fieldValue: unknown;
  alternativeText?: string;
  readOnly?: boolean;
  maxLen?: number;
  rect: number[];
}

interface PlacedText {
  text: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

type Rect = [number, number, number, number];

function toPlacedText(item: TextItem): PlacedText {
  const [, , , , x, y] = item.transform;
  return { text: item.str, left: x, right: x + item.width, bottom: y, top: y + item.height };
}

function normalizeRect(rect: number[]): Rect {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

function overlapsHorizontally(text: PlacedText, x1: number, x2: number): boolean {
  return text.right > x1 && text.left < x2;
}

function withoutBlanks(text: string): string {
  return text.replace(BLANK_PATTERN, " ").replace(/\s+/g, " ").trim();
}

// Testo sulla stessa riga a sinistra, preso dal più vicino al campo
// all'indietro: "Il sottoscritto ____ nato a ____" dà "...nato a".
function textOnTheLeft(texts: PlacedText[], [x1, y1, , y2]: Rect): string {
  const sameLine = texts
    .filter((t) => t.right <= x1 + VERTICAL_TOLERANCE && x1 - t.right < LEFT_REACH)
    .filter((t) => t.top > y1 - VERTICAL_TOLERANCE && t.bottom < y2 + VERTICAL_TOLERANCE)
    .sort((a, b) => b.right - a.right);
  let label = "";
  for (const text of sameLine) {
    label = `${withoutBlanks(text.text)} ${label}`.trim();
    if (label.length >= MAX_LABEL_CHARS) {
      break;
    }
  }
  return label.slice(-MAX_LABEL_CHARS);
}

// Riga di testo più vicina sopra o sotto il campo, che lo sovrapponga
// in orizzontale. Restituisce anche la distanza per scegliere la più vicina.
function lineNear(texts: PlacedText[], [x1, y1, x2, y2]: Rect, where: "above" | "below"): { text: string; distance: number } | null {
  const candidates = texts
    .filter((t) => overlapsHorizontally(t, x1, x2))
    .map((t) => ({ t, distance: where === "above" ? t.bottom - y2 : y1 - t.top }))
    .filter(({ distance }) => distance >= -VERTICAL_TOLERANCE && distance < (where === "above" ? ABOVE_REACH : BELOW_REACH))
    .sort((a, b) => a.distance - b.distance);
  if (candidates.length === 0) {
    return null;
  }
  const nearest = candidates[0].distance;
  const text = candidates
    .filter((c) => c.distance - nearest < VERTICAL_TOLERANCE)
    .sort((a, b) => a.t.left - b.t.left)
    .map((c) => withoutBlanks(c.t.text))
    .join(" ")
    .trim();
  return text ? { text: text.slice(0, MAX_LABEL_CHARS), distance: nearest } : null;
}

// Un solo indizio, il più vicino: aggiungere la riga sopra quando c'è già
// un'etichetta a sinistra confonde (la riga sopra appartiene a un altro campo).
function describeSurroundings(texts: PlacedText[], rect: Rect): string {
  const left = textOnTheLeft(texts, rect);
  if (left) {
    return `a sinistra: ${left}`;
  }
  const above = lineNear(texts, rect, "above");
  const below = lineNear(texts, rect, "below");
  const nearest = [above && { ...above, where: "sopra" }, below && { ...below, where: "sotto" }]
    .filter((c): c is { text: string; distance: number; where: string } => Boolean(c))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest ? `${nearest.where}: ${nearest.text}` : "";
}

async function readTexts(page: PDFPageProxy): Promise<{ items: TextItem[]; placed: PlacedText[] }> {
  const content = await page.getTextContent();
  const items = content.items.filter((item): item is TextItem => "str" in item && item.str.trim() !== "");
  return { items, placed: items.map(toPlacedText) };
}

function acroFormFields(widgets: WidgetAnnotation[], texts: PlacedText[], pageIndex: number): FormFieldInfo[] {
  return widgets.map((widget) => {
    const rect = normalizeRect(widget.rect);
    return {
      source: "acroform",
      fieldName: widget.fieldName,
      ids: [widget.id],
      kind: widget.fieldType === "Sig" ? "signature" : "text",
      tooltip: widget.alternativeText ?? "",
      label: describeSurroundings(texts, rect),
      maxLen: widget.maxLen && widget.maxLen > 0 ? widget.maxLen : null,
      pageIndex,
      rect,
      fontSize: null,
      currentValue: typeof widget.fieldValue === "string" ? widget.fieldValue : "",
    };
  });
}

const measureContext = new OffscreenCanvas(1, 1).getContext("2d")!;

function measure(text: string): number {
  measureContext.font = `100px ${MEASURE_FONT}`;
  return measureContext.measureText(text).width;
}

// Etichetta di una riga vuota: il testo che la precede nella stessa stringa
// (fino alla riga vuota precedente); se la stringa inizia con la riga vuota,
// il testo vicino sulla pagina.
function blankLabel(item: TextItem, start: number, previousEnd: number, texts: PlacedText[], rect: Rect): string {
  const before = withoutBlanks(item.str.slice(previousEnd, start));
  if (before) {
    return `a sinistra: ${before.slice(-MAX_LABEL_CHARS)}`;
  }
  return describeSurroundings(texts, rect);
}

function blanksOfItem(item: TextItem, texts: PlacedText[], pageIndex: number): FormFieldInfo[] {
  const [, , , , x, y] = item.transform;
  const totalWidth = measure(item.str);
  const fields: FormFieldInfo[] = [];
  let previousEnd = 0;
  for (const match of item.str.matchAll(BLANK_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    const x1 = x + (item.width * measure(item.str.slice(0, start))) / totalWidth;
    const x2 = x + (item.width * measure(item.str.slice(0, end))) / totalWidth;
    const rect: Rect = [x1, y - 2, x2, y + item.height];
    fields.push({
      source: "blank",
      fieldName: "",
      ids: [],
      kind: "text",
      tooltip: "",
      label: blankLabel(item, start, previousEnd, texts, rect),
      maxLen: null,
      pageIndex,
      rect,
      fontSize: item.height,
      currentValue: "",
    });
    previousEnd = end;
  }
  return fields;
}

function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

// Corpo del testo tipico della pagina (mediana delle altezze), per dare alle
// righe disegnate, che non hanno un font, uno spazio di scrittura plausibile.
function typicalFontSize(texts: PlacedText[]): number {
  const heights = texts.map((t) => t.top - t.bottom).filter((h) => h > 0).sort((a, b) => a - b);
  const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : DEFAULT_FONT_SIZE;
  return Math.min(MAX_DRAWN_FONT_SIZE, Math.max(MIN_DRAWN_FONT_SIZE, median));
}

// Una riga con del testo appoggiato sopra è una sottolineatura o una riga
// già compilata nel documento: non va proposta.
function hasTextOnTop(rule: HorizontalRule, texts: PlacedText[], fontSize: number): boolean {
  const minOverlap = Math.min(UNDERLINE_MIN_OVERLAP, (rule.x2 - rule.x1) / 2);
  return texts.some((t) => {
    const overlap = Math.min(t.right, rule.x2) - Math.max(t.left, rule.x1);
    return overlap >= minOverlap && t.bottom >= rule.y - VERTICAL_TOLERANCE && t.bottom <= rule.y + fontSize;
  });
}

async function drawnBlanks(page: PDFPageProxy, texts: PlacedText[], pageIndex: number): Promise<FormFieldInfo[]> {
  // Senza annotazioni: i bordi dei widget AcroForm non sono righe stampate.
  const operators = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const [, , pageRight] = page.view;
  const rules = findHorizontalRules(operators.fnArray, operators.argsArray, OPS, pageRight * MAX_RULE_PAGE_FRACTION);
  const fontSize = typicalFontSize(texts);
  return rules
    .filter((rule) => !hasTextOnTop(rule, texts, fontSize))
    .map((rule) => {
      const rect: Rect = [rule.x1, rule.y - 2, rule.x2, rule.y + fontSize];
      return {
        source: "blank",
        fieldName: "",
        ids: [],
        kind: "text",
        tooltip: "",
        label: describeSurroundings(texts, rect),
        maxLen: null,
        pageIndex,
        rect,
        fontSize,
        currentValue: "",
      };
    });
}

async function fieldsOfPage(page: PDFPageProxy, pageIndex: number): Promise<FormFieldInfo[]> {
  const annotations = (await page.getAnnotations({ intent: "display" })) as WidgetAnnotation[];
  const widgets = annotations.filter(
    (a) => a.subtype === "Widget" && !a.readOnly && (a.fieldType === "Tx" || a.fieldType === "Sig"),
  );
  const { items, placed } = await readTexts(page);
  const formFields = acroFormFields(widgets, placed, pageIndex);
  // Una riga stampata sotto un campo AcroForm è già coperta dal campo.
  const textBlanks = items
    .flatMap((item) => blanksOfItem(item, placed, pageIndex))
    .filter((blank) => !formFields.some((field) => intersects(field.rect, blank.rect)));
  // Una riga disegnata sotto "_____" o sotto un campo AcroForm è la stessa riga.
  const covered = [...formFields, ...textBlanks];
  const drawn = (await drawnBlanks(page, placed, pageIndex)).filter(
    (blank) => !covered.some((field) => intersects(field.rect, blank.rect)),
  );
  return [...formFields, ...sortByReadingOrder([...textBlanks, ...drawn])];
}

// Dall'alto in basso, poi da sinistra: le righe disegnate arrivano in un
// ordine diverso da quelle nel testo, e la revisione va letta come il foglio.
function sortByReadingOrder(fields: FormFieldInfo[]): FormFieldInfo[] {
  return [...fields].sort((a, b) => b.rect[1] - a.rect[1] || a.rect[0] - b.rect[0]);
}

// Più widget con lo stesso nome sono lo stesso campo logico (es. il nome
// ripetuto in testa a ogni pagina): una sola domanda, tutti gli id compilati.
function mergeByName(fields: FormFieldInfo[]): FormFieldInfo[] {
  const merged: FormFieldInfo[] = [];
  const byName = new Map<string, FormFieldInfo>();
  for (const field of fields) {
    const existing = field.source === "acroform" ? byName.get(field.fieldName) : undefined;
    if (existing) {
      existing.ids.push(...field.ids);
      continue;
    }
    const copy = { ...field, ids: [...field.ids] };
    if (field.source === "acroform") {
      byName.set(field.fieldName, copy);
    }
    merged.push(copy);
  }
  return merged;
}

export async function collectFormFields(pdfDocument: PDFDocumentProxy): Promise<FormFieldInfo[]> {
  const all: FormFieldInfo[] = [];
  for (let pageIndex = 0; pageIndex < pdfDocument.numPages; pageIndex++) {
    const page = await pdfDocument.getPage(pageIndex + 1);
    all.push(...(await fieldsOfPage(page, pageIndex)));
  }
  return mergeByName(all);
}
