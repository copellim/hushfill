// Builds the bytes of the PDF to save: pdf.js writes the filled fields,
// pdf-lib burns the added signatures and text into the page content.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDFDocument, PDFField, PDFFont, PDFImage, PDFRef, StandardFonts, degrees, popGraphicsState, pushGraphicsState, rgb } from "pdf-lib";
import { TEXT_BASELINE_RATIO, type ImagePlacement, type Placement, type TextPlacement } from "./placements";

export class EncryptedPdfError extends Error {}

const TEXT_COLOR = rgb(0.05, 0.05, 0.1);

interface PageGeometry {
  width: number;
  height: number;
  toPdf(x: number, y: number): [number, number];
}

interface DrawingResources {
  doc: PDFDocument;
  font: PDFFont;
  images: Map<string, PDFImage>;
}

// Wraps the existing content in q…Q: if it leaves the graphics matrix
// modified, what is added afterwards would end up shifted or scaled.
function isolateExistingContent(doc: PDFDocument, pageIndex: number): void {
  const page = doc.getPage(pageIndex);
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

async function pageGeometry(pdfDocument: PDFDocumentProxy, pageIndex: number): Promise<PageGeometry> {
  const viewport = (await pdfDocument.getPage(pageIndex + 1)).getViewport({ scale: 1 });
  return {
    width: viewport.width,
    height: viewport.height,
    toPdf: (x, y) => viewport.convertToPdfPoint(x, y) as [number, number],
  };
}

// Origin and rotation in PDF coordinates of a point and of the on-screen
// "rightwards" direction: also covers pages rotated by 90/180/270 degrees.
function anchor(geometry: PageGeometry, left: number, baseline: number, length: number): { x: number; y: number; angle: number } {
  const [x, y] = geometry.toPdf(left, baseline);
  const [toX, toY] = geometry.toPdf(left + length, baseline);
  return { x, y, angle: (Math.atan2(toY - y, toX - x) * 180) / Math.PI };
}

async function drawImage(resources: DrawingResources, geometry: PageGeometry, placement: ImagePlacement): Promise<void> {
  let image = resources.images.get(placement.image.dataUrl);
  if (!image) {
    image = await resources.doc.embedPng(placement.image.dataUrl);
    resources.images.set(placement.image.dataUrl, image);
  }
  const width = placement.width * geometry.width;
  const height = placement.height * geometry.height;
  const left = placement.x * geometry.width;
  const bottom = placement.y * geometry.height + height;
  const { x, y, angle } = anchor(geometry, left, bottom, width);
  resources.doc.getPage(placement.pageIndex).drawImage(image, { x, y, width, height, rotate: degrees(angle) });
}

function drawText(resources: DrawingResources, geometry: PageGeometry, placement: TextPlacement): void {
  const left = placement.x * geometry.width;
  const baseline = placement.y * geometry.height + placement.fontSize * TEXT_BASELINE_RATIO;
  const { x, y, angle } = anchor(geometry, left, baseline, 1);
  resources.doc.getPage(placement.pageIndex).drawText(placement.text, {
    x,
    y,
    size: placement.fontSize,
    font: resources.font,
    color: TEXT_COLOR,
    rotate: degrees(angle),
  });
}

// pdf-lib's removeField finds the widget's page through its /P entry,
// which may be missing after pdf.js has saved: the page would be left with a
// reference to a deleted object. The widgets are therefore removed by hand
// from every page before removing the field.
function detachWidgets(doc: PDFDocument, field: PDFField): void {
  const widgetRefs = new Set(field.acroField.getWidgets().map((widget) => doc.context.getObjectRef(widget.dict)));
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let index = (annots?.size() ?? 0) - 1; index >= 0; index--) {
      if (widgetRefs.has(annots!.get(index) as PDFRef)) {
        annots!.remove(index);
      }
    }
  }
}

function removeReplacedFields(doc: PDFDocument, placements: readonly Placement[]): void {
  const form = doc.getForm();
  for (const placement of placements) {
    if (placement.kind !== "image" || !placement.replacesFieldName) {
      continue;
    }
    const field = form.getFieldMaybe(placement.replacesFieldName);
    if (field) {
      detachWidgets(doc, field);
      form.removeField(field);
    }
  }
}

async function loadForDrawing(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof Error && /encrypted/i.test(error.message)) {
      throw new EncryptedPdfError("Il PDF è cifrato: i campi si possono compilare, ma firme e testi aggiunti non possono essere incisi nel file.");
    }
    throw error;
  }
}

export async function buildPdfBytes(pdfDocument: PDFDocumentProxy, placements: readonly Placement[]): Promise<Uint8Array> {
  // With no modified fields there is nothing to write: the original bytes are enough.
  const withForms = pdfDocument.annotationStorage.size > 0 ? await pdfDocument.saveDocument() : await pdfDocument.getData();
  if (placements.length === 0) {
    return withForms;
  }
  const doc = await loadForDrawing(withForms);
  removeReplacedFields(doc, placements);
  const resources: DrawingResources = { doc, font: await doc.embedFont(StandardFonts.Helvetica), images: new Map() };
  const geometries = new Map<number, PageGeometry>();
  for (const placement of placements) {
    let geometry = geometries.get(placement.pageIndex);
    if (!geometry) {
      geometry = await pageGeometry(pdfDocument, placement.pageIndex);
      geometries.set(placement.pageIndex, geometry);
      isolateExistingContent(doc, placement.pageIndex);
    }
    if (placement.kind === "image") {
      await drawImage(resources, geometry, placement);
    } else {
      drawText(resources, geometry, placement);
    }
  }
  return doc.save();
}
