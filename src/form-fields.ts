// Extracts from the PDF what needs filling, with the context Jev needs:
// - the AcroForm fields (text and signature), when the PDF is a real form;
// - the blank lines printed in the text ("Il sottoscritto ________",
//   "CAP ......") or drawn as lines, when the form is only meant to be printed
//   and filled in by hand. They become "blank" fields filled by writing over them.
import { AnnotationMode, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { findHorizontalRules, type HorizontalRule } from "./drawn-lines";
import {
  BLANK_PATTERN,
  MAX_LABEL_CHARS,
  VERTICAL_TOLERANCE,
  describeSurroundings,
  withoutBlanks,
  withoutDuplicates,
  type PlacedText,
  type Rect,
} from "./field-labels";
import type { FormFieldInfo } from "./jev";

// Font used to estimate where the blank line falls inside a string:
// forms almost always use Helvetica/Arial, and only the proportion matters.
const MEASURE_FONT = "Helvetica, Arial, sans-serif";
// Drawn lines: estimated writing size and plausibility limits.
const DEFAULT_FONT_SIZE = 10;
const MIN_DRAWN_FONT_SIZE = 8;
const MAX_DRAWN_FONT_SIZE = 12;
// Text covering at least this many points of a line is sitting on it.
const UNDERLINE_MIN_OVERLAP = 10;
// A line almost as long as the page is a separator, not a space.
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

function toPlacedText(item: TextItem): PlacedText {
  const [, , , , x, y] = item.transform;
  return { text: item.str, left: x, right: x + item.width, bottom: y, top: y + item.height };
}

function normalizeRect(rect: number[]): Rect {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

async function readTexts(page: PDFPageProxy): Promise<{ items: TextItem[]; placed: PlacedText[] }> {
  const content = await page.getTextContent();
  const items = content.items.filter((item): item is TextItem => "str" in item && item.str.trim() !== "");
  return { items, placed: withoutDuplicates(items.map(toPlacedText)) };
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

// Label of a blank line: the text preceding it in the same string
// (up to the previous blank line); if the string starts with the blank line,
// the nearby text on the page.
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

// Typical text size of the page (median of the heights), to give the drawn
// lines, which have no font, a plausible writing space.
function typicalFontSize(texts: PlacedText[]): number {
  const heights = texts.map((t) => t.top - t.bottom).filter((h) => h > 0).sort((a, b) => a - b);
  const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : DEFAULT_FONT_SIZE;
  return Math.min(MAX_DRAWN_FONT_SIZE, Math.max(MIN_DRAWN_FONT_SIZE, median));
}

// A line with text sitting on it is an underline or a line already filled
// in the document: it must not be proposed.
function hasTextOnTop(rule: HorizontalRule, texts: PlacedText[], fontSize: number): boolean {
  const minOverlap = Math.min(UNDERLINE_MIN_OVERLAP, (rule.x2 - rule.x1) / 2);
  return texts.some((t) => {
    const overlap = Math.min(t.right, rule.x2) - Math.max(t.left, rule.x1);
    return overlap >= minOverlap && t.bottom >= rule.y - VERTICAL_TOLERANCE && t.bottom <= rule.y + fontSize;
  });
}

async function drawnBlanks(page: PDFPageProxy, texts: PlacedText[], pageIndex: number): Promise<FormFieldInfo[]> {
  // Without annotations: the borders of AcroForm widgets are not printed lines.
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
  // A line printed under an AcroForm field is already covered by the field.
  const textBlanks = items
    .flatMap((item) => blanksOfItem(item, placed, pageIndex))
    .filter((blank) => !formFields.some((field) => intersects(field.rect, blank.rect)));
  // A line drawn under "_____" or under an AcroForm field is the same line.
  const covered = [...formFields, ...textBlanks];
  const drawn = (await drawnBlanks(page, placed, pageIndex)).filter(
    (blank) => !covered.some((field) => intersects(field.rect, blank.rect)),
  );
  return [...formFields, ...sortByReadingOrder([...textBlanks, ...drawn])];
}

// Top to bottom, then from the left: drawn lines arrive in a different
// order from those in the text, and the review must read like the sheet.
function sortByReadingOrder(fields: FormFieldInfo[]): FormFieldInfo[] {
  return [...fields].sort((a, b) => b.rect[1] - a.rect[1] || a.rect[0] - b.rect[0]);
}

// Several widgets with the same name are the same logical field (e.g. the name
// repeated at the top of every page): a single question, all ids filled.
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
