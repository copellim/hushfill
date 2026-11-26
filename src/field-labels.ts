// Etichetta di un campo: il testo stampato vicino, letto dalle posizioni del
// testo sulla pagina. Senza pdf.js né canvas, così si prova da Node.

// Distanze in punti PDF entro cui un testo è considerato etichetta del campo.
const LEFT_REACH = 220;
const ABOVE_REACH = 26;
const BELOW_REACH = 16;
export const VERTICAL_TOLERANCE = 3;
export const MAX_LABEL_CHARS = 120;
// Oltre questo spazio, in proporzione al corpo del testo, due pezzi della
// stessa riga sono colonne o celle diverse, non parole della stessa frase.
const CONTINUOUS_GAP_FACTOR = 1.5;
// Distanza entro cui un campo o una riga sono "al margine" del testo della pagina.
const MARGIN_SLACK = 20;
// Una riga vuota è una sequenza di trattini bassi o di puntini abbastanza
// lunga da non essere punteggiatura.
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

// Testo uguale entro questo scarto è la stessa scritta stampata due volte,
// il finto grassetto di alcuni programmi: senza toglierla l'etichetta
// diventa "i i documenti documenti".
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

// Un campo compilabile messo sopra i trattini di "Tel. ________": il testo
// parte a sinistra del campo e gli passa sotto. Conta la parte prima della
// riga vuota coperta dal campo; un testo senza righe vuote sotto il campo è
// un paragrafo, non un'etichetta. Le posizioni dei caratteri sono stimate in
// proporzione alla lunghezza: basta per dire quale riga vuota è coperta.
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

// Un testo che passa sotto il campo conta solo se sta sulla riga su cui il
// campo poggia: quella del testo vicino con la base più vicina al bordo
// inferiore del campo. Un campo alto copre in parte anche la riga sotto o
// sopra, che può avere i suoi trattini sotto il campo ("Mutuo Fondiario
// ____" sotto "del sig. ____", dove i puntini del campo cominciano proprio
// dove comincia il campo e quindi non gli passano sotto).
function crossingOnTheFieldLine(crossing: PlacedText[], nearby: PlacedText[], y1: number): PlacedText[] {
  const closest = Math.min(...nearby.map((t) => Math.abs(t.bottom - y1)));
  return crossing.filter((t) => Math.abs(t.bottom - y1) - closest < VERTICAL_TOLERANCE);
}

// Testo sulla stessa riga a sinistra, preso dal più vicino al campo
// all'indietro: "Il sottoscritto ____ nato a ____" dà "...nato a".
function textOnTheLeft(texts: PlacedText[], [x1, y1, x2, y2]: Rect): string {
  const band = texts.filter((t) => t.top > y1 - VERTICAL_TOLERANCE && t.bottom < y2 + VERTICAL_TOLERANCE && x1 - t.right < LEFT_REACH);
  const before = band.filter((t) => t.right <= x1 + VERTICAL_TOLERANCE).map((t) => ({ right: t.right, text: withoutBlanks(t.text) }));
  // Vicini sono anche i testi che cominciano sopra il campo, come i
  // puntini di una riga vuota: dicono su quale riga il campo poggia.
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
  const line = candidates
    .filter((c) => c.distance - nearest < VERTICAL_TOLERANCE)
    .map((c) => c.t)
    .sort((a, b) => a.left - b.left);
  const text = (where === "above" ? continueToTheRight(line, texts, x1) : line)
    .map((t) => withoutBlanks(t.text))
    .join(" ")
    .trim();
  // Sopra, la parte più vicina al campo nel filo del testo è la fine della
  // riga; sotto, l'inizio.
  const kept = where === "above" ? text.slice(-MAX_LABEL_CHARS) : text.slice(0, MAX_LABEL_CHARS);
  return text ? { text: kept, distance: nearest } : null;
}

// Un campo a capo, sotto una frase che continua oltre la sua fine ("…a mezzo
// posta elettronica certificata"): la parte che dice cosa scrivere è la fine
// della riga sopra. Vale solo se il campo comincia al margine sinistro del
// testo, la riga sopra arriva al margine destro ed è testo continuo, senza
// righe vuote. Le griglie non passano: le intestazioni stanno a metà pagina
// o finiscono presto, e lo spazio fra due celle vicine può essere stretto
// come quello fra due parole. Una riga sopra con righe vuote ha altri campi,
// e la sua fine è l'etichetta di un altro campo.
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

// Un solo indizio, il più vicino: aggiungere la riga sopra quando c'è già
// un'etichetta a sinistra confonde (la riga sopra appartiene a un altro campo).
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
