// Additions on the pages: signatures (images) and text. Position and size
// are fractions of the displayed page, so they stay correct at every zoom.
// On saving they are burnt into the page content (export.ts).
// pdf.js empties a page's foreign nodes when it redraws it: the layer is
// therefore recreated on every "pagerendered".
import type { SignatureImage } from "./signature-dialog";

interface PlacementBase {
  id: string;
  pageIndex: number;
  // Top-left corner, in fractions of the page.
  x: number;
  y: number;
}

export interface ImagePlacement extends PlacementBase {
  kind: "image";
  image: SignatureImage;
  width: number;
  height: number;
  // Form field the signature replaces: widgets are drawn over the page
  // content and would cover it, so on saving the field is removed.
  replacesFieldName?: string;
}

export interface TextPlacement extends PlacementBase {
  kind: "text";
  text: string;
  // Font size in PDF points.
  fontSize: number;
}

export type Placement = ImagePlacement | TextPlacement;
type NewPlacement = Omit<ImagePlacement, "id"> | Omit<TextPlacement, "id">;

// Text is drawn in Helvetica in the PDF: on screen the metric equivalent is
// used, so what you see is what will be saved.
export const TEXT_FONT_FAMILY = 'Helvetica, Arial, "Liberation Sans", sans-serif';
// Distance of the baseline from the top edge, in fractions of the font size
// (line-height 1, Helvetica/Arial ascender).
export const TEXT_BASELINE_RATIO = 0.8;
const MIN_WIDTH_FRACTION = 0.03;
const MIN_FONT_SIZE = 5;
const MAX_FONT_SIZE = 72;

const placements: Placement[] = [];
let selectedId: string | null = null;
let notifyChange: () => void = () => {};
let pageDivOf: (pageIndex: number) => HTMLElement | null = () => null;
let pageHeightOf: (pageIndex: number) => number = () => 842;

export function initPlacements(options: {
  onChange: () => void;
  pageDiv: (pageIndex: number) => HTMLElement | null;
  pageHeight: (pageIndex: number) => number;
}): void {
  notifyChange = options.onChange;
  pageDivOf = options.pageDiv;
  pageHeightOf = options.pageHeight;
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target as HTMLElement).closest(".place-item")) {
      select(null);
    }
  });
}

export function getPlacements(): readonly Placement[] {
  return placements;
}

export function clearPlacements(): void {
  placements.length = 0;
  selectedId = null;
}

export function addPlacement(placement: NewPlacement, options: { edit?: boolean } = {}): void {
  const created = { ...placement, id: crypto.randomUUID() } as Placement;
  placements.push(created);
  selectedId = created.id;
  redrawPage(created.pageIndex);
  if (options.edit) {
    startEditing(created.id);
  }
  notifyChange();
}

export function deleteSelected(): boolean {
  return selectedId !== null && removePlacement(selectedId);
}

function removePlacement(id: string): boolean {
  const index = placements.findIndex((p) => p.id === id);
  if (index < 0) {
    return false;
  }
  const [removed] = placements.splice(index, 1);
  if (selectedId === id) {
    selectedId = null;
  }
  redrawPage(removed.pageIndex);
  notifyChange();
  return true;
}

function select(id: string | null): void {
  if (selectedId === id) {
    return;
  }
  selectedId = id;
  document.querySelectorAll<HTMLElement>(".place-item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
}

function redrawPage(pageIndex: number): void {
  const div = pageDivOf(pageIndex);
  if (div) {
    renderPlacements(div, pageIndex);
  }
}

function applyGeometry(element: HTMLElement, placement: Placement): void {
  element.style.left = `${placement.x * 100}%`;
  element.style.top = `${placement.y * 100}%`;
  if (placement.kind === "image") {
    element.style.width = `${placement.width * 100}%`;
    element.style.height = `${placement.height * 100}%`;
  } else {
    // --total-scale-factor is pdf.js's current scale: 1 pt = 1px × scale.
    element.style.fontSize = `calc(var(--total-scale-factor) * ${placement.fontSize}px)`;
  }
}

export function renderPlacements(pageDiv: HTMLElement, pageIndex: number): void {
  let layer = pageDiv.querySelector<HTMLDivElement>(":scope > .place-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "place-layer";
    pageDiv.append(layer);
  }
  layer.replaceChildren(...placements.filter((p) => p.pageIndex === pageIndex).map((p) => createItem(p, layer)));
}

function createRemoveButton(placement: Placement): HTMLButtonElement {
  const remove = document.createElement("button");
  remove.className = "place-remove";
  remove.title = "Elimina (Canc)";
  remove.textContent = "×";
  remove.addEventListener("pointerdown", (event) => event.stopPropagation());
  remove.addEventListener("click", () => removePlacement(placement.id));
  return remove;
}

function createContent(placement: Placement): HTMLElement {
  if (placement.kind === "image") {
    const img = document.createElement("img");
    img.src = placement.image.dataUrl;
    img.draggable = false;
    return img;
  }
  const text = document.createElement("span");
  text.className = "place-text";
  text.textContent = placement.text;
  text.style.fontFamily = TEXT_FONT_FAMILY;
  return text;
}

function createItem(placement: Placement, layer: HTMLDivElement): HTMLElement {
  const item = document.createElement("div");
  item.className = `place-item ${placement.kind}`;
  item.dataset.id = placement.id;
  item.classList.toggle("selected", placement.id === selectedId);
  const handle = document.createElement("div");
  handle.className = "place-resize";
  handle.title = "Trascina per ridimensionare";
  item.append(createContent(placement), handle, createRemoveButton(placement));
  applyGeometry(item, placement);
  attachDrag(item, handle, placement, layer);
  if (placement.kind === "text") {
    item.addEventListener("dblclick", () => startEditing(placement.id));
  }
  return item;
}

function startEditing(id: string): void {
  const placement = placements.find((p) => p.id === id);
  const span = document.querySelector<HTMLElement>(`.place-item[data-id="${id}"] .place-text`);
  if (placement?.kind !== "text" || !span) {
    return;
  }
  span.contentEditable = "plaintext-only";
  span.focus();
  document.getSelection()?.selectAllChildren(span);
  const finish = () => {
    span.contentEditable = "false";
    const text = span.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) {
      removePlacement(id);
      return;
    }
    if (text !== placement.text) {
      placement.text = text;
      notifyChange();
    }
  };
  span.addEventListener("blur", finish, { once: true });
  span.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      span.blur();
    }
    event.stopPropagation();
  });
}

function resize(placement: Placement, start: Placement, dx: number, bounds: DOMRect): void {
  if (placement.kind === "image" && start.kind === "image") {
    const aspect = placement.image.width / placement.image.height;
    const width = Math.min(Math.max(start.width + dx, MIN_WIDTH_FRACTION), 1 - start.x);
    placement.width = width;
    placement.height = (width * bounds.width) / aspect / bounds.height;
  } else if (placement.kind === "text" && start.kind === "text") {
    // Horizontal dragging scales the font size in proportion to the page.
    const pageHeight = pageHeightOf(placement.pageIndex);
    const pointsPerPixel = pageHeight / bounds.height;
    const grown = start.fontSize + dx * bounds.width * pointsPerPixel * 0.5;
    placement.fontSize = Math.min(Math.max(grown, MIN_FONT_SIZE), MAX_FONT_SIZE);
  }
}

function attachDrag(item: HTMLElement, handle: HTMLElement, placement: Placement, layer: HTMLDivElement): void {
  item.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).isContentEditable) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    select(placement.id);
    const resizing = event.target === handle;
    const pointerStart = { x: event.clientX, y: event.clientY };
    const start = structuredClone(placement);
    const bounds = layer.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    const widthFraction = itemBounds.width / bounds.width;
    const heightFraction = itemBounds.height / bounds.height;
    item.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - pointerStart.x) / bounds.width;
      const dy = (moveEvent.clientY - pointerStart.y) / bounds.height;
      if (resizing) {
        resize(placement, start, dx, bounds);
      } else {
        placement.x = Math.min(Math.max(start.x + dx, 0), 1 - widthFraction);
        placement.y = Math.min(Math.max(start.y + dy, 0), 1 - heightFraction);
      }
      applyGeometry(item, placement);
    };
    const end = () => {
      item.removeEventListener("pointermove", move);
      item.removeEventListener("pointerup", end);
      item.removeEventListener("pointercancel", end);
      notifyChange();
    };
    item.addEventListener("pointermove", move);
    item.addEventListener("pointerup", end);
    item.addEventListener("pointercancel", end);
  });
}
