// Finds the horizontal lines drawn as graphics (not as "_" or "."
// characters): many forms draw the line to write on with a segment or
// with a very thin rectangle. It works on pdf.js's operator list
// and is independent of the DOM, so it can be tested with fake data.

// Codes of the pdf.js operators needed here, passed by the caller
// (they are pdfjs-dist's OPS) so as not to import pdf.js in the tests.
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

// Codes of the commands inside the constructPath buffer (pdf.js's DrawOPS).
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

// Measures in PDF points.
const AXIS_TOLERANCE = 0.5; // deviation allowed to call it "horizontal" or "vertical"
const MAX_RULE_THICKNESS = 3; // beyond this it is a bar or a box, not a line
const MIN_RULE_LENGTH = 30; // shorter than this it is a dash, a graphic mark
const MIN_VERTICAL_LENGTH = 4;
const MERGE_GAP = 3; // dashed or dotted lines drawn in pieces
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

// Matrix that applies `inner` first and then `outer` (like the cm operator).
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
      break; // unknown command: better to stop than to read wrong coordinates
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

// A fill counts only if it is an axis-aligned rectangle:
// thin in height it is a line, thin in width a vertical border.
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
        continue; // clipping or empty paths: they are not visible
      }
      for (const subpath of readSubpaths(buffer, ctm)) {
        if (stroking.has(paintOp)) {
          // Zero width means "as thin as possible", but it is visible.
          collectStroked(subpath, Math.max(lineWidth, 0) * scaleOf(ctm), collected);
        } else {
          collectFilled(subpath, collected);
        }
      }
    }
  }
  return collected;
}

// Joins the pieces at the same height that touch or nearly touch: a dotted
// or dashed line drawn in segments becomes a single line.
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

// Side of a table or a box: closed by vertical borders at both ends.
// It is not a line to write on.
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
