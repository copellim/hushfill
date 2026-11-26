// pdf.js viewer: loading, zoom, pages, forms and free text.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf_viewer.mjs reads pdf.js from globalThis.pdfjsLib: it must be set before
// importing it, which is why the import is dynamic.
(globalThis as unknown as { pdfjsLib: typeof pdfjs }).pdfjsLib = pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
await import("pdfjs-dist/web/pdf_viewer.css");
const { EventBus, PDFLinkService, PDFViewer, LinkTarget } = viewerModule;

export type { PDFDocumentProxy };

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

const container = document.querySelector<HTMLDivElement>("#viewer-container")!;
export const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
export const pdfViewer = new PDFViewer({
  container,
  eventBus,
  linkService,
  annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
  // Added text and signatures are handled by placements.ts: the pdf.js editor
  // would save annotations, which not every reader shows the same way.
  annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
});
linkService.setViewer(pdfViewer);

let loadingTask: PDFDocumentLoadingTask | null = null;
let currentDocument: PDFDocumentProxy | null = null;

export function getDocument(): PDFDocumentProxy | null {
  return currentDocument;
}

export function pageDiv(pageIndex: number): HTMLElement | null {
  return pdfViewer.getPageView(pageIndex)?.div ?? null;
}

export async function openDocument(
  data: Uint8Array,
  askPassword: (wrong: boolean) => Promise<string | null>,
): Promise<PDFDocumentProxy | null> {
  await closeDocument();
  const task = pdfjs.getDocument({ data, enableXfa: false });
  loadingTask = task;
  task.onPassword = async (update: (password: string) => void, reason: number) => {
    const password = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (password === null) {
      void task.destroy();
    } else {
      update(password);
    }
  };
  try {
    currentDocument = await task.promise;
  } catch (error) {
    if (task.destroyed) {
      return null;
    }
    throw error;
  }
  pdfViewer.setDocument(currentDocument);
  linkService.setDocument(currentDocument);
  return currentDocument;
}

export async function closeDocument(): Promise<void> {
  pdfViewer.setDocument(null as unknown as PDFDocumentProxy);
  linkService.setDocument(null);
  await loadingTask?.destroy();
  loadingTask = null;
  currentDocument = null;
}

export function zoomIn(): void {
  if (pdfViewer.currentScale < MAX_SCALE) {
    pdfViewer.increaseScale();
  }
}

export function zoomOut(): void {
  if (pdfViewer.currentScale > MIN_SCALE) {
    pdfViewer.decreaseScale();
  }
}

export function fitWidth(): void {
  pdfViewer.currentScaleValue = "page-width";
}

// Page height in PDF points, as displayed (rotation included).
export function pageHeightPoints(pageIndex: number): number {
  const pageView = pdfViewer.getPageView(pageIndex);
  return pageView ? pageView.viewport.height / pageView.viewport.scale : 842;
}

// Writes a value into a form field: into pdf.js's storage (which is what
// ends up in the saved file) and, if the page is already drawn, also into
// the on-screen element.
export function setFieldValue(ids: string[], value: string): void {
  if (!currentDocument) {
    return;
  }
  for (const id of ids) {
    currentDocument.annotationStorage.setValue(id, { value });
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-element-id="${id}"]`);
    if (element) {
      element.value = value;
    }
  }
}

export function currentFieldValue(id: string, fallback: string): string {
  const stored = currentDocument?.annotationStorage.getValue(id, { value: fallback }) as { value?: unknown } | undefined;
  return typeof stored?.value === "string" ? stored.value : fallback;
}
