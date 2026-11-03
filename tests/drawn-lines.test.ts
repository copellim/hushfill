// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHorizontalRules, type PathOps } from "../src/drawn-lines.ts";

// Numeri arbitrari ma distinti: il modulo usa solo quelli che riceve.
const ops: PathOps = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  setLineWidth: 6,
  constructPath: 7,
  stroke: 8,
  closeStroke: 9,
  fill: 10,
  eoFill: 11,
  fillStroke: 12,
  eoFillStroke: 13,
  closeFillStroke: 14,
  closeEOFillStroke: 15,
};
const endPath = 99;
const [MOVE, LINE, CURVE, CLOSE] = [0, 1, 2, 4];

type Op = [number, unknown];

function path(paintOp: number, ...commands: number[]): Op {
  return [ops.constructPath, [paintOp, [new Float32Array(commands)], [0, 0, 0, 0]]];
}

function rules(...operators: Op[]) {
  return findHorizontalRules(
    operators.map(([fn]) => fn),
    operators.map(([, args]) => args),
    ops,
  );
}

test("segmento orizzontale tracciato: è una riga", () => {
  assert.deepEqual(rules(path(ops.stroke, MOVE, 100, 200, LINE, 300, 200)), [{ x1: 100, x2: 300, y: 200 }]);
});

test("rettangolo pieno sottile: è una riga, alla sua metà", () => {
  const found = rules(path(ops.fill, MOVE, 50, 400, LINE, 250, 400, LINE, 250, 401, LINE, 50, 401, CLOSE));
  assert.deepEqual(found, [{ x1: 50, x2: 250, y: 400.5 }]);
});

test("la matrice corrente e quella dei form XObject spostano e scalano la riga", () => {
  const found = rules(
    [ops.save, null],
    [ops.transform, [2, 0, 0, 2, 10, 20]],
    [ops.paintFormXObjectBegin, [[1, 0, 0, 1, 5, 5], null]],
    path(ops.stroke, MOVE, 0, 0, LINE, 50, 0),
    [ops.paintFormXObjectEnd, null],
    [ops.restore, null],
    path(ops.stroke, MOVE, 0, 100, LINE, 40, 100),
  );
  assert.deepEqual(found, [
    { x1: 20, x2: 120, y: 30 },
    { x1: 0, x2: 40, y: 100 },
  ]);
});

test("righe a puntini disegnate a pezzi si uniscono", () => {
  const dots = [];
  for (let x = 100; x < 200; x += 4) {
    dots.push(path(ops.stroke, MOVE, x, 300, LINE, x + 1.5, 300));
  }
  // L'ultimo puntino parte da 196 (100 + 24 × 4) e finisce a 197,5.
  assert.deepEqual(rules(...dots), [{ x1: 100, x2: 197.5, y: 300 }]);
});

test("scartati: trattini corti, tracciati di ritaglio, curve, righe spesse, verticali", () => {
  const found = rules(
    path(ops.stroke, MOVE, 0, 10, LINE, 20, 10),
    path(endPath, MOVE, 0, 50, LINE, 300, 50),
    path(ops.stroke, MOVE, 0, 90, CURVE, 50, 90, 100, 90, 150, 90),
    [ops.setLineWidth, [6]],
    path(ops.stroke, MOVE, 0, 130, LINE, 300, 130),
    [ops.setLineWidth, [1]],
    path(ops.stroke, MOVE, 400, 0, LINE, 400, 300),
  );
  assert.deepEqual(found, []);
});

test("lati di tabelle e riquadri non sono righe da compilare", () => {
  const found = rules(path(ops.stroke, MOVE, 100, 100, LINE, 300, 100, LINE, 300, 130, LINE, 100, 130, CLOSE));
  assert.deepEqual(found, []);
});

test("righe lunghe quasi quanto la pagina sono escluse dal limite di lunghezza", () => {
  const found = findHorizontalRules([ops.constructPath], [[ops.stroke, [new Float32Array([MOVE, 20, 50, LINE, 580, 50])], null]], ops, 535);
  assert.deepEqual(found, []);
});
