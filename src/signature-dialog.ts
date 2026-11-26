// Signature creation window: drawn by hand, typed in cursive or imported
// from an image. It always returns a PNG (the only format with transparency
// that the export embeds) cropped to its real bounding box.
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
const INK_MIN_ALPHA = 64; // out of 255
const INK_MIN_PIXELS = 3; // per row or column
// Imported images: maximum side after resizing (a 4000 px photo would make
// the profile and the PDF heavy with no visible gain).
const IMPORT_MAX_WIDTH = 1600;
const IMPORT_MAX_HEIGHT = 800;
// SVG without its own dimensions.
const IMPORT_FALLBACK_SIZE = { width: 1200, height: 400 };
// Light background made transparent: above the high threshold the pixel vanishes,
// below the low one it stays solid, in between it fades (stroke edges, JPEG noise).
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
// Imported image already decoded and resized, original background.
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
  // The imported image keeps its colours.
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

// "Cancella" (clear) empties only the tab in use.
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

// Decodes with <img>, which unlike createImageBitmap also reads SVGs.
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

// A signature scanned or photographed on white paper: the light background
// becomes transparent in proportion to its brightness, so the stroke stays
// smooth and the sheet underneath shows through.
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
    // It must not reach the window's handler, which would open the PDFs.
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
    // Coalesced events give a smooth line even with fast mouse movements.
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

// Rows and columns count as ink only with enough clearly visible pixels:
// the noise of a scan (isolated dots, almost transparent after removing the
// background) must not widen the crop.
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

// Crops the transparent margins, so the signature is placed and resized
// on its real bounding box.
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
  // Changing the canvas size resets the context: set it up again.
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

// profileName: profile to offer saving the signature to; null hides the option.
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
