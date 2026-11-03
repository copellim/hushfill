// Finestra di creazione della firma: disegnata a mano, scritta in corsivo o
// importata da un'immagine. Restituisce sempre un PNG (l'unico formato con
// trasparenza che l'export incorpora) ritagliato sull'ingombro reale.
import "@fontsource/dancing-script/600.css";

export interface SignatureImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface SignatureResult {
  signature: SignatureImage;
  saveToProfile: boolean;
}

const STROKE_WIDTH = 5;
const TYPED_FONT = '600 140px "Dancing Script"';
const TYPED_CANVAS_HEIGHT = 260;
const TYPED_MARGIN = 40;
const TRIM_PADDING = 8;
const INK_MIN_ALPHA = 64; // su 255
const INK_MIN_PIXELS = 3; // per riga o colonna
// Immagini importate: lato massimo dopo il ridimensionamento (una foto da
// 4000 px renderebbe pesanti profilo e PDF senza guadagno visibile).
const IMPORT_MAX_WIDTH = 1600;
const IMPORT_MAX_HEIGHT = 800;
// SVG senza dimensioni proprie.
const IMPORT_FALLBACK_SIZE = { width: 1200, height: 400 };
// Sfondo chiaro reso trasparente: sopra la soglia alta il pixel sparisce,
// sotto quella bassa resta pieno, in mezzo sfuma (bordi del tratto, rumore JPEG).
const BACKGROUND_FULL = 235;
const BACKGROUND_START = 180;

type Tab = "draw" | "type" | "import";

const dialog = document.querySelector<HTMLDialogElement>("#sign-dialog")!;
const canvas = document.querySelector<HTMLCanvasElement>("#sign-canvas")!;
const colorSelect = document.querySelector<HTMLSelectElement>("#sign-color")!;
const textInput = document.querySelector<HTMLInputElement>("#sign-text")!;
const textPreview = document.querySelector<HTMLDivElement>("#sign-text-preview")!;
const saveToProfileBox = document.querySelector<HTMLInputElement>("#sign-save-profile")!;
const saveToProfileLabel = document.querySelector<HTMLSpanElement>("#sign-save-profile-label")!;
const okButton = document.querySelector<HTMLButtonElement>("#sign-ok")!;
const colorLabel = document.querySelector<HTMLLabelElement>("#sign-color-label")!;
const importDrop = document.querySelector<HTMLDivElement>("#sign-import-drop")!;
const importPreview = document.querySelector<HTMLImageElement>("#sign-import-preview")!;
const importEmpty = document.querySelector<HTMLParagraphElement>("#sign-import-empty")!;
const importFile = document.querySelector<HTMLInputElement>("#sign-import-file")!;
const importTransparent = document.querySelector<HTMLInputElement>("#sign-import-transparent")!;
const importError = document.querySelector<HTMLParagraphElement>("#sign-import-error")!;
const context = canvas.getContext("2d")!;

let activeTab: Tab = "draw";
let hasStrokes = false;
// Immagine importata già decodificata e ridimensionata, sfondo originale.
let importedCanvas: HTMLCanvasElement | null = null;
let resolveDialog: ((value: SignatureResult | null) => void) | null = null;

function switchTab(tab: Tab): void {
  activeTab = tab;
  for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  for (const panel of dialog.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== tab;
  }
  if (tab === "type") {
    textInput.focus();
  }
  // L'immagine importata tiene i suoi colori.
  colorLabel.hidden = tab === "import";
  refreshOkButton();
}

function refreshOkButton(): void {
  const ready = { draw: hasStrokes, type: textInput.value.trim() !== "", import: importedCanvas !== null };
  okButton.disabled = !ready[activeTab];
}

function clearCanvas(): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  hasStrokes = false;
  refreshOkButton();
}

function clearImport(): void {
  importedCanvas = null;
  importFile.value = "";
  importPreview.hidden = true;
  importPreview.removeAttribute("src");
  importEmpty.hidden = false;
  importError.textContent = "";
  refreshOkButton();
}

// "Cancella" svuota solo la scheda in uso.
function clearActiveTab(): void {
  if (activeTab === "draw") {
    clearCanvas();
  } else if (activeTab === "type") {
    textInput.value = "";
    textPreview.textContent = "";
    refreshOkButton();
  } else {
    clearImport();
  }
}

// Decodifica con <img>, che a differenza di createImageBitmap legge anche gli SVG.
async function decodeImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new Error(`«${file.name}» non è un'immagine leggibile.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitWithin(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, IMPORT_MAX_WIDTH / width, IMPORT_MAX_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function rasterize(image: HTMLImageElement): HTMLCanvasElement {
  const natural = image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : IMPORT_FALLBACK_SIZE;
  const size = fitWithin(natural.width, natural.height);
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  out.getContext("2d")!.drawImage(image, 0, 0, size.width, size.height);
  return out;
}

// Una firma scansionata o fotografata su carta bianca: lo sfondo chiaro
// diventa trasparente in proporzione alla luminosità, così il tratto resta
// morbido e il foglio sotto si vede.
function withTransparentBackground(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    const opacity = Math.min(1, Math.max(0, (BACKGROUND_FULL - luminance) / (BACKGROUND_FULL - BACKGROUND_START)));
    pixels[i + 3] = Math.round(pixels[i + 3] * opacity);
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

function importedSignature(): SignatureImage | null {
  if (!importedCanvas) {
    return null;
  }
  return trimToInk(importTransparent.checked ? withTransparentBackground(importedCanvas) : importedCanvas);
}

function refreshImportPreview(): void {
  const signature = importedSignature();
  importPreview.hidden = !signature;
  importEmpty.hidden = Boolean(signature);
  if (signature) {
    importPreview.src = signature.dataUrl;
  }
}

async function importFromFile(file: File): Promise<void> {
  importError.textContent = "";
  try {
    if (!file.type.startsWith("image/")) {
      throw new Error(`«${file.name}» non è un'immagine.`);
    }
    importedCanvas = rasterize(await decodeImage(file));
    if (!importedSignature()) {
      importedCanvas = null;
      throw new Error("L'immagine è vuota o tutta chiara: prova a togliere «Rendi trasparente lo sfondo chiaro».");
    }
    refreshImportPreview();
  } catch (error) {
    importError.textContent = error instanceof Error ? error.message : String(error);
  }
  refreshOkButton();
}

function setupImport(): void {
  document.querySelector("#sign-import-choose")!.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    if (file) {
      void importFromFile(file);
    }
  });
  importTransparent.addEventListener("change", () => {
    refreshImportPreview();
    refreshOkButton();
  });
  importDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    importDrop.classList.add("over");
  });
  importDrop.addEventListener("dragleave", () => importDrop.classList.remove("over"));
  importDrop.addEventListener("drop", (event) => {
    // Non deve arrivare al gestore della finestra, che aprirebbe i PDF.
    event.preventDefault();
    event.stopPropagation();
    importDrop.classList.remove("over");
    const file = event.dataTransfer?.files[0];
    if (file) {
      void importFromFile(file);
    }
  });
}

function canvasPoint(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function drawSegment(from: { x: number; y: number }, sample: PointerEvent): { x: number; y: number } {
  const point = canvasPoint(sample);
  const pressure = sample.pointerType === "pen" ? 0.5 + sample.pressure : 1;
  context.strokeStyle = colorSelect.value;
  context.lineWidth = STROKE_WIDTH * pressure;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(point.x, point.y);
  context.stroke();
  return point;
}

function setupDrawing(): void {
  let last: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    last = canvasPoint(event);
    context.fillStyle = colorSelect.value;
    context.beginPath();
    context.arc(last.x, last.y, STROKE_WIDTH / 2, 0, Math.PI * 2);
    context.fill();
    hasStrokes = true;
    refreshOkButton();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!last) {
      return;
    }
    // Gli eventi coalescenti danno una linea fluida anche con mouse veloci.
    for (const sample of event.getCoalescedEvents?.() ?? [event]) {
      last = drawSegment(last, sample);
    }
  });
  const stop = () => {
    last = null;
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

// Righe e colonne contano come inchiostro solo con abbastanza pixel ben
// visibili: il rumore di una scansione (puntini isolati, quasi trasparenti
// dopo aver tolto lo sfondo) non deve allargare il ritaglio.
function findInkBounds(source: HTMLCanvasElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { width, height } = source;
  const pixels = source.getContext("2d")!.getImageData(0, 0, width, height).data;
  const rowInk = new Uint32Array(height);
  const columnInk = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > INK_MIN_ALPHA) {
        rowInk[y]++;
        columnInk[x]++;
      }
    }
  }
  const rows = [...rowInk.keys()].filter((y) => rowInk[y] >= INK_MIN_PIXELS);
  const columns = [...columnInk.keys()].filter((x) => columnInk[x] >= INK_MIN_PIXELS);
  if (rows.length === 0 || columns.length === 0) {
    return null;
  }
  return { minX: columns[0], minY: rows[0], maxX: columns.at(-1)!, maxY: rows.at(-1)! };
}

// Ritaglia i margini trasparenti, così la firma si posiziona e si
// ridimensiona sul suo ingombro reale.
function trimToInk(source: HTMLCanvasElement): SignatureImage | null {
  const bounds = findInkBounds(source);
  if (!bounds) {
    return null;
  }
  const minX = Math.max(0, bounds.minX - TRIM_PADDING);
  const minY = Math.max(0, bounds.minY - TRIM_PADDING);
  const maxX = Math.min(source.width - 1, bounds.maxX + TRIM_PADDING);
  const maxY = Math.min(source.height - 1, bounds.maxY + TRIM_PADDING);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL("image/png"), width: out.width, height: out.height };
}

async function renderTypedSignature(text: string): Promise<SignatureImage | null> {
  await document.fonts.load(TYPED_FONT, text);
  const scratch = document.createElement("canvas");
  const ctx = scratch.getContext("2d")!;
  ctx.font = TYPED_FONT;
  scratch.width = Math.ceil(ctx.measureText(text).width) + TYPED_MARGIN * 2;
  scratch.height = TYPED_CANVAS_HEIGHT;
  // Cambiare le dimensioni del canvas azzera il contesto: si reimposta.
  ctx.font = TYPED_FONT;
  ctx.fillStyle = colorSelect.value;
  ctx.textBaseline = "middle";
  ctx.fillText(text, TYPED_MARGIN, scratch.height / 2);
  return trimToInk(scratch);
}

async function currentSignature(): Promise<SignatureImage | null> {
  if (activeTab === "draw") {
    return trimToInk(canvas);
  }
  if (activeTab === "type") {
    return renderTypedSignature(textInput.value.trim());
  }
  return importedSignature();
}

async function finish(): Promise<void> {
  const signature = await currentSignature();
  if (signature) {
    close({ signature, saveToProfile: saveToProfileBox.checked && !saveToProfileBox.disabled });
  }
}

function close(value: SignatureResult | null): void {
  dialog.close();
  resolveDialog?.(value);
  resolveDialog = null;
}

export function initSignatureDialog(): void {
  setupDrawing();
  setupImport();
  for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab as Tab));
  }
  document.querySelector("#sign-clear")!.addEventListener("click", clearActiveTab);
  document.querySelector("#sign-cancel")!.addEventListener("click", () => close(null));
  okButton.addEventListener("click", () => void finish());
  textInput.addEventListener("input", () => {
    textPreview.textContent = textInput.value;
    refreshOkButton();
  });
  colorSelect.addEventListener("change", () => {
    textPreview.style.color = colorSelect.value;
  });
  textPreview.style.color = colorSelect.value;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(null);
  });
}

// profileName: profilo a cui proporre di salvare la firma; null nasconde l'opzione.
export function askForSignature(options: { profileName: string | null; okLabel: string }): Promise<SignatureResult | null> {
  clearCanvas();
  clearImport();
  textInput.value = "";
  textPreview.textContent = "";
  okButton.textContent = options.okLabel;
  const row = saveToProfileBox.closest("label")!;
  row.hidden = options.profileName === null;
  saveToProfileBox.disabled = options.profileName === null;
  saveToProfileBox.checked = true;
  saveToProfileLabel.textContent = options.profileName ?? "";
  switchTab("draw");
  dialog.showModal();
  return new Promise((resolve) => {
    resolveDialog = resolve;
  });
}
