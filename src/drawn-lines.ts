// Trova le righe orizzontali disegnate come grafica (non come caratteri "_"
// o "."): molti moduli tracciano la riga su cui scrivere con un segmento o
// con un rettangolo sottilissimo. Lavora sulla lista di operatori di pdf.js
// ed è indipendente dal DOM, così si prova con dati finti.

// Codici degli operatori di pdf.js che servono qui, passati da chi chiama
// (sono OPS di pdfjs-dist) per non importare pdf.js nei test.
export interface PathOps {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  setLineWidth: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

// Codici dei comandi dentro il buffer di constructPath (DrawOPS di pdf.js).
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

// Misure in punti PDF.
const AXIS_TOLERANCE = 0.5; // scarto ammesso per dire "orizzontale" o "verticale"
const MAX_RULE_THICKNESS = 3; // oltre è una barra o un riquadro, non una riga
const MIN_RULE_LENGTH = 30; // più corta è un trattino, un segno grafico
const MIN_VERTICAL_LENGTH = 4;
const MERGE_GAP = 3; // righe tratteggiate o a puntini disegnate a pezzi
const SAME_LINE_TOLERANCE = 1;
const TABLE_CORNER_TOLERANCE = 2;

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];

export interface HorizontalRule {
  x1: number;
  x2: number;
  y: number;
}

interface VerticalRule {
  x: number;
  y1: number;
  y2: number;
}

interface Subpath {
  points: Point[];
  closed: boolean;
  curved: boolean;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// Matrice che applica prima `inner` e poi `outer` (come l'operatore cm).
function concat(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

function apply(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

function readSubpaths(buffer: ArrayLike<number>, ctm: Matrix): Subpath[] {
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  for (let k = 0; k < buffer.length; ) {
    const command = buffer[k++];
    if (command === DRAW_MOVE_TO) {
      current = { points: [apply(ctm, buffer[k], buffer[k + 1])], closed: false, curved: false };
      subpaths.push(current);
      k += 2;
    } else if (command === DRAW_LINE_TO) {
      current?.points.push(apply(ctm, buffer[k], buffer[k + 1]));
      k += 2;
    } else if (command === DRAW_CURVE_TO || command === DRAW_QUADRATIC_CURVE_TO) {
      if (current) {
        current.curved = true;
      }
      k += command === DRAW_CURVE_TO ? 6 : 4;
    } else if (command === DRAW_CLOSE_PATH) {
      if (current) {
        current.closed = true;
      }
    } else {
      break; // comando sconosciuto: meglio fermarsi che leggere coordinate sbagliate
    }
  }
  return subpaths.filter((subpath) => !subpath.curved);
}

interface Collected {
  horizontals: HorizontalRule[];
  verticals: VerticalRule[];
}

function collectStroked(subpath: Subpath, lineWidth: number, into: Collected): void {
  const points = subpath.closed ? [...subpath.points, subpath.points[0]] : subpath.points;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    if (Math.abs(ay - by) <= AXIS_TOLERANCE && lineWidth <= MAX_RULE_THICKNESS) {
      into.horizontals.push({ x1: Math.min(ax, bx), x2: Math.max(ax, bx), y: (ay + by) / 2 });
    } else if (Math.abs(ax - bx) <= AXIS_TOLERANCE && Math.abs(ay - by) >= MIN_VERTICAL_LENGTH) {
      into.verticals.push({ x: (ax + bx) / 2, y1: Math.min(ay, by), y2: Math.max(ay, by) });
    }
  }
}

// Un riempimento conta solo se è un rettangolo allineato agli assi:
// sottile in altezza è una riga, sottile in larghezza un bordo verticale.
function collectFilled(subpath: Subpath, into: Collected): void {
  const xs = subpath.points.map(([x]) => x);
  const ys = subpath.points.map(([, y]) => y);
  const [left, right, bottom, top] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const onCorners = subpath.points.every(
    ([x, y]) =>
      (Math.abs(x - left) <= AXIS_TOLERANCE || Math.abs(x - right) <= AXIS_TOLERANCE) &&
      (Math.abs(y - bottom) <= AXIS_TOLERANCE || Math.abs(y - top) <= AXIS_TOLERANCE),
  );
  if (!onCorners || subpath.points.length < 2) {
    return;
  }
  if (top - bottom <= MAX_RULE_THICKNESS && right - left > top - bottom) {
    into.horizontals.push({ x1: left, x2: right, y: (top + bottom) / 2 });
  } else if (right - left <= MAX_RULE_THICKNESS && top - bottom >= MIN_VERTICAL_LENGTH) {
    into.verticals.push({ x: (left + right) / 2, y1: bottom, y2: top });
  }
}

function collectSegments(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: PathOps): Collected {
  const stroking = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const filling = new Set([ops.fill, ops.eoFill]);
  const collected: Collected = { horizontals: [], verticals: [] };
  const stack: { ctm: Matrix; lineWidth: number }[] = [];
  let ctm = IDENTITY;
  let lineWidth = 1;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === ops.save) {
      stack.push({ ctm, lineWidth });
    } else if (fn === ops.restore) {
      ({ ctm, lineWidth } = stack.pop() ?? { ctm, lineWidth });
    } else if (fn === ops.transform) {
      ctm = concat(ctm, args as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push({ ctm, lineWidth });
      const matrix = args?.[0] as Matrix | null;
      ctm = matrix ? concat(ctm, matrix) : ctm;
    } else if (fn === ops.paintFormXObjectEnd) {
      ({ ctm, lineWidth } = stack.pop() ?? { ctm, lineWidth });
    } else if (fn === ops.setLineWidth) {
      lineWidth = args?.[0] as number;
    } else if (fn === ops.constructPath) {
      const [paintOp, [buffer]] = args as [number, [ArrayLike<number> | null]];
      if (!buffer || !(stroking.has(paintOp) || filling.has(paintOp))) {
        continue; // tracciati di ritaglio o vuoti: non si vedono
      }
      for (const subpath of readSubpaths(buffer, ctm)) {
        if (stroking.has(paintOp)) {
          // Spessore zero significa "il più sottile possibile", ma è visibile.
          collectStroked(subpath, Math.max(lineWidth, 0) * scaleOf(ctm), collected);
        } else {
          collectFilled(subpath, collected);
        }
      }
    }
  }
  return collected;
}

// Unisce i pezzi sulla stessa altezza che si toccano o quasi: una riga a
// puntini o tratteggiata disegnata a segmenti diventa una riga sola.
function mergeHorizontals(rules: HorizontalRule[]): HorizontalRule[] {
  const sorted = [...rules].sort((a, b) => a.y - b.y || a.x1 - b.x1);
  const merged: HorizontalRule[] = [];
  for (const rule of sorted) {
    const last = merged.findLast((m) => Math.abs(m.y - rule.y) <= SAME_LINE_TOLERANCE && rule.x1 <= m.x2 + MERGE_GAP);
    if (last) {
      last.x2 = Math.max(last.x2, rule.x2);
    } else {
      merged.push({ ...rule });
    }
  }
  return merged;
}

function touchesVertical(x: number, y: number, verticals: VerticalRule[]): boolean {
  return verticals.some(
    (v) =>
      Math.abs(v.x - x) <= TABLE_CORNER_TOLERANCE &&
      v.y1 - TABLE_CORNER_TOLERANCE <= y &&
      y <= v.y2 + TABLE_CORNER_TOLERANCE,
  );
}

// Lato di una tabella o di un riquadro: chiuso da bordi verticali a entrambi
// gli estremi. Non è una riga su cui scrivere.
function isBoxEdge(rule: HorizontalRule, verticals: VerticalRule[]): boolean {
  return touchesVertical(rule.x1, rule.y, verticals) && touchesVertical(rule.x2, rule.y, verticals);
}

export function findHorizontalRules(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: PathOps,
  maxLength = Number.POSITIVE_INFINITY,
): HorizontalRule[] {
  const { horizontals, verticals } = collectSegments(fnArray, argsArray, ops);
  return mergeHorizontals(horizontals).filter((rule) => {
    const length = rule.x2 - rule.x1;
    return length >= MIN_RULE_LENGTH && length <= maxLength && !isBoxEdge(rule, verticals);
  });
}
