// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSurroundings, withoutDuplicates, type PlacedText } from "../src/field-labels.ts";

const LINE_HEIGHT = 11;

function placed(text: string, left: number, right: number, bottom: number): PlacedText {
  return { text, left, right, bottom, top: bottom + LINE_HEIGHT };
}

// Words of a line, each 5 points wide per character and separated by 9 points,
// as pdf.js returns them for justified text.
function words(sentence: string, left: number, bottom: number): PlacedText[] {
  const result: PlacedText[] = [];
  let x = left;
  for (const word of sentence.split(" ")) {
    result.push(placed(word, x, x + word.length * 5, bottom));
    x += word.length * 5 + 9;
  }
  return result;
}

test("label to the left: basic behaviour", () => {
  const texts = [placed("Codice fiscale", 57, 130, 543)];
  assert.equal(describeSurroundings(texts, [140, 541, 300, 556]), "a sinistra: Codice fiscale");
});

test("field placed over the dashes of a text that starts to the left", () => {
  // Real coordinates from a University of Bologna form: "Tel." and the
  // dashes are a single text, and the fillable field covers the dashes.
  const texts = [
    placed("C.A.P. ___________ Via _________________________________________________ N. _________", 57, 540, 569),
    placed("Tel. ____________________", 57, 197, 543),
  ];
  assert.equal(describeSurroundings(texts, [77, 542, 197, 562]), "a sinistra: Tel.");
});

test("with several blank lines in the same text the one covered by the field counts", () => {
  const line = "C.A.P. __________ Via ____________________";
  const texts = [placed(line, 0, line.length * 5, 100)];
  const viaBlank = line.lastIndexOf(" ") + 1;
  assert.equal(describeSurroundings(texts, [viaBlank * 5, 98, line.length * 5, 113]), "a sinistra: C.A.P. Via");
});

test("a paragraph under the field, without blank lines, is not a label", () => {
  const texts = [placed("Il trattamento dei dati è necessario per l'esecuzione dei compiti", 30, 500, 300)];
  assert.equal(describeSurroundings(texts, [200, 298, 400, 313]), "");
});

test("the line above is read to its end, beyond the field's width", () => {
  // Form of the Soprintendenza of Chieti: the PEC field wraps onto a new line,
  // under a line that continues well past its end.
  const texts = words("specificando di voler ricevere i documenti a mezzo posta elettronica certificata al seguente indirizzo", 36, 374.4);
  assert.equal(
    describeSurroundings(texts, [36, 359, 294.6, 372.2]),
    "sopra: specificando di voler ricevere i documenti a mezzo posta elettronica certificata al seguente indirizzo",
  );
});

test("a text from the neighbouring line running under a tall field does not count", () => {
  // Real coordinates from an inheritance declaration: the line of dots
  // starts where the field starts, and the only text running under the field
  // is that of the line below, at 9.6 points instead of the 2 of the "sig." line.
  const texts = [
    ...(
      [
        ["a", 56.6, 62.2],
        ["seguito", 68.3, 100.4],
        ["del", 106.5, 119.9],
        ["decesso", 125.9, 163.1],
        ["del", 169.2, 182.6],
        ["sig.", 188.6, 204.1],
      ] as const
    ).map(([text, left, right]) => ({ text, left, right, bottom: 634.1, top: 644.1 })),
    { text: "…………………………………………………….,", left: 210.3, right: 415.8, bottom: 634.1, top: 644.1 },
    { text: "Mutuo Fondiario ………………………………………………………….. …………………………………………….", left: 56.6, right: 532.5, bottom: 622.5, top: 632.5 },
  ];
  assert.equal(describeSurroundings(texts, [210.3, 632.1, 410.3, 644]), "a sinistra: a seguito del decesso del sig.");
});

test("in a grid the heading of the neighbouring cell is left out", () => {
  const texts = [placed("Family Name (Last Name)", 60, 175, 420), placed("Given Name (First Name)", 350, 465, 420)];
  assert.equal(describeSurroundings(texts, [58, 400, 330, 415]), "sopra: Family Name (Last Name)");
  // Real coordinates: very close headings in a grid (form AA4/8)…
  const headers = [
    placed("Dati anagrafici", 27.6, 72.8, 534.7),
    { text: "PROVINCIA", left: 418.3, right: 443.9, bottom: 523.9, top: 528.9 },
    { text: "DATA DI NASCITA", left: 449.2, right: 488.7, bottom: 523.9, top: 528.9 },
    placed("CODICE FISCALE", 27.6, 560, 600),
  ];
  assert.equal(describeSurroundings(headers, [416.5, 505.5, 445.6, 521.4]), "sopra: PROVINCIA");
  // …and a short heading line at the left margin (form EX160).
  const short = [placed("Form number", 56.7, 128.1, 781), placed("Name of form", 143.5, 216.5, 781), placed("bottom of the first page of a", 428.3, 565.4, 777.3)];
  assert.equal(describeSurroundings(short, [56.6, 753.4, 108.4, 775.9]), "sopra: Form number");
});

test("a line above with other fields is not followed beyond the field", () => {
  // The field continues the blank line of "Il/la sottoscritto/a" on a new line:
  // "nato/a" is the label of the next field on that line.
  const texts = [placed("Il/la sottoscritto/a ______________________", 71, 300, 615), placed("nato/a ________________", 315, 560, 615)];
  assert.equal(describeSurroundings(texts, [71.3, 596.4, 308.7, 611.8]), "sopra: Il/la sottoscritto/a");
});

test("text printed twice with a small offset counts once", () => {
  const once = words("a mezzo posta", 36, 374.4);
  const twice = [...once, ...once.map((text) => ({ ...text, left: text.left + 0.1, right: text.right + 0.1 }))];
  assert.deepEqual(withoutDuplicates(twice), once);
  // Two identical words at different points of the line both remain.
  const repeated = [placed("i", 10, 15, 100), placed("i", 80, 85, 100)];
  assert.deepEqual(withoutDuplicates(repeated), repeated);
});
