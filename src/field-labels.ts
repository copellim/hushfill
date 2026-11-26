// Label of a field: the text printed nearby, read from the positions of the
// text on the page. Without pdf.js or canvas, so it can be tested from Node.

// Distances in PDF points within which a text is considered the field's label.
const LEFT_REACH = 220;
const ABOVE_REACH = 26;
const BELOW_REACH = 16;
export const VERTICAL_TOLERANCE = 3;
export const MAX_LABEL_CHARS = 120;
// Beyond this gap, in proportion to the text size, two pieces of the same
// line are different columns or cells, not words of the same sentence.
const CONTINUOUS_GAP_FACTOR = 1.5;
// Distance within which a field or a line is "at the margin" of the page's text.
const MARGIN_SLACK = 20;
// A blank line is a sequence of underscores or dots long enough not to be
// punctuation.
export const BLANK_PATTERN = /_{3,}|\.{5,}|…{2,}/g;

export interface PlacedText {
  text: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export type Rect = [number, number, number, number];

function overlapsHorizontally(text: PlacedText, x1: number, x2: number): boolean {
  return text.right > x1 && text.left < x2;
}

// Identical text within this offset is the same writing printed twice,
// the fake bold of some programs: without removing it the label
// becomes "i i documenti documenti".
const DUPLICATE_OFFSET = 1;

export function withoutDuplicates(texts: PlacedText[]): PlacedText[] {
  const kept: PlacedText[] = [];
  for (const text of texts) {
    const isCopy = kept.some(
      (other) => other.text === text.text && Math.abs(other.left - text.left) < DUPLICATE_OFFSET && Math.abs(other.bottom - text.bottom) < DUPLICATE_OFFSET,
    );
    if (!isCopy) {
      kept.push(text);
    }
  }
  return kept;
}

export function withoutBlanks(text: string): string {
  return text.replace(BLANK_PATTERN, " ").replace(/\s+/g, " ").trim();
}

// A fillable field placed over the dashes of "Tel. ________": the text
// starts to the left of the field and runs under it. What counts is the part
// before the blank line covered by the field; a text with no blank lines under
// the field is a paragraph, not a label. Character positions are estimated in
// proportion to the length: enough to tell which blank line is covered.
function textBeforeCoveredBlank(text: PlacedText, x1: number, x2: number): string {
  const charWidth = (text.right - text.left) / text.text.length;
  let covered = { overlap: 0, index: -1 };
  for (const match of text.text.matchAll(BLANK_PATTERN)) {
    const start = text.left + match.index * charWidth;
    const end = start + match[0].length * charWidth;
    const overlap = Math.min(end, x2) - Math.max(start, x1);
    if (overlap > covered.overlap) {
      covered = { overlap, index: match.index };
    }
  }
  return covered.index < 0 ? "" : withoutBlanks(text.text.slice(0, covered.index));
}

// A text running under the field counts only if it is on the line the
// field rests on: that of the nearby text whose baseline is closest to the
// field's bottom edge. A tall field also partly covers the line below or
// above, which may have its own dashes under the field ("Mutuo Fondiario
// ____" under "del sig. ____", where the field's dots start exactly
// where the field starts and so do not run under it).
function crossingOnTheFieldLine(crossing: PlacedText[], nearby: PlacedText[], y1: number): PlacedText[] {
  const closest = Math.min(...nearby.map((t) => Math.abs(t.bottom - y1)));
  return crossing.filter((t) => Math.abs(t.bottom - y1) - closest < VERTICAL_TOLERANCE);
}

// Text on the same line to the left, taken backwards from the one closest
// to the field: "Il sottoscritto ____ nato a ____" gives "...nato a".
function textOnTheLeft(texts: PlacedText[], [x1, y1, x2, y2]: Rect): string {
  const band = texts.filter((t) => t.top > y1 - VERTICAL_TOLERANCE && t.bottom < y2 + VERTICAL_TOLERANCE && x1 - t.right < LEFT_REACH);
  const before = band.filter((t) => t.right <= x1 + VERTICAL_TOLERANCE).map((t) => ({ right: t.right, text: withoutBlanks(t.text) }));
  // Texts that start over the field also count as nearby, like the
  // dots of a blank line: they tell which line the field rests on.
  const nearby = texts.filter((t) => t.top > y1 - VERTICAL_TOLERANCE && t.bottom < y2 + VERTICAL_TOLERANCE && t.right > x1 - LEFT_REACH && t.left < x2);
  const crossing = crossingOnTheFieldLine(
    band.filter((t) => t.right > x1 + VERTICAL_TOLERANCE && t.left < x1),
    nearby,
    y1,
  ).map((t) => ({ right: x1, text: textBeforeCoveredBlank(t, x1, x2) }));
  const sameLine = [...before, ...crossing].sort((a, b) => b.right - a.right);
  let label = "";
  for (const text of sameLine) {
    label = `${text.text} ${label}`.trim();
    if (label.length >= MAX_LABEL_CHARS) {
      break;
    }
  }
  return label.slice(-MAX_LABEL_CHARS);
}

// Nearest line of text above or below the field that overlaps it
// horizontally. Also returns the distance, to choose the nearest one.
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
  const line = candidates
    .filter((c) => c.distance - nearest < VERTICAL_TOLERANCE)
    .map((c) => c.t)
    .sort((a, b) => a.left - b.left);
  const text = (where === "above" ? continueToTheRight(line, texts, x1) : line)
    .map((t) => withoutBlanks(t.text))
    .join(" ")
    .trim();
  // Above, the part closest to the field in the flow of the text is the end of
  // the line; below, the beginning.
  const kept = where === "above" ? text.slice(-MAX_LABEL_CHARS) : text.slice(0, MAX_LABEL_CHARS);
  return text ? { text: kept, distance: nearest } : null;
}

// A field that wraps, under a sentence continuing past its end ("…a mezzo
// posta elettronica certificata"): the part that says what to write is the
// end of the line above. It applies only if the field starts at the left
// margin of the text, the line above reaches the right margin and is
// continuous text, without blank lines. Grids do not pass: their headings sit
// mid-page or end early, and the gap between two neighbouring cells can be as
// narrow as the one between two words. A line above with blank lines has
// other fields, and its end is the label of another field.
function continueToTheRight(line: PlacedText[], texts: PlacedText[], x1: number): PlacedText[] {
  const marginLeft = Math.min(...texts.map((t) => t.left));
  const marginRight = Math.max(...texts.map((t) => t.right));
  if (x1 - marginLeft > MARGIN_SLACK) {
    return line;
  }
  const continued = [...line];
  let last = line[line.length - 1];
  const rest = texts.filter((t) => Math.abs(t.bottom - last.bottom) < VERTICAL_TOLERANCE && t.left > last.left).sort((a, b) => a.left - b.left);
  for (const text of rest) {
    const gap = text.left - last.right;
    if (gap > CONTINUOUS_GAP_FACTOR * (last.top - last.bottom)) {
      break;
    }
    if (gap >= -VERTICAL_TOLERANCE) {
      continued.push(text);
      last = text;
    }
  }
  const reachesRightMargin = marginRight - last.right <= MARGIN_SLACK;
  const isRunningText = continued.every((t) => !t.text.match(BLANK_PATTERN));
  return reachesRightMargin && isRunningText ? continued : line;
}

// A single clue, the nearest: adding the line above when there is already a
// label to the left confuses things (the line above belongs to another field).
export function describeSurroundings(texts: PlacedText[], rect: Rect): string {
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
