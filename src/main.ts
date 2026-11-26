import "./style.css";
import type { PdfFile } from "./api";
import { initAutofillDialog, reviewDecisions, type AutofillResult } from "./autofill-dialog";
import { errorMessage } from "./errors";
import { buildPdfBytes } from "./export";
import { collectFormFields } from "./form-fields";
import {
  buildJevRequests,
  buildPartRequests,
  collectPartAnswers,
  COMBINED_CHOICE,
  parseJevResponse,
  resolveCombined,
  type FieldDecision,
  type FormFieldInfo,
  type Heading,
} from "./jev";
import { recognizeFieldsLocally } from "./local-recognizer";
import { getRecognitionEngine } from "./recognition-engine";
import { addPlacement, clearPlacements, deleteSelected, getPlacements, initPlacements, renderPlacements, TEXT_BASELINE_RATIO, TEXT_FONT_FAMILY } from "./placements";
import { initProfileDialog, openProfileDialog } from "./profile-dialog";
import {
  getActiveProfile,
  getStore,
  hasProfileUpdates,
  loadProfiles,
  onProfilesChanged,
  replaceStore,
  setActiveProfile,
  withProfileUpdates,
} from "./profiles";
import { initSettingsDialog, openSettingsDialog } from "./settings-dialog";
import { askForSignature, initSignatureDialog, type SignatureImage } from "./signature-dialog";
import * as viewer from "./viewer";

// Initial width of a signature placed by hand, as a fraction of the page.
const DEFAULT_SIGNATURE_WIDTH = 0.28;
// Minimum height, in points, of a signature placed in a short signature field
// (often just one line): below this size it would be unreadable.
const MIN_FIELD_SIGNATURE_HEIGHT = 36;
// On a blank line the signature is 2.4 times the text size tall and drops
// below the line by a quarter of the text size.
const BLANK_SIGNATURE_HEIGHT_RATIO = 2.4;
const BLANK_SIGNATURE_SINK_RATIO = 0.25;
const TOAST_MS = 4500;
// Free text and text written on blank lines, in PDF points.
const DEFAULT_TEXT_SIZE = 11;
const MIN_FILL_TEXT_SIZE = 6;
const MAX_FILL_TEXT_SIZE = 12;
// Margin between the start of the line and the value, as a fraction of the
// text size: many lines start right after the label ("sottoscritto/a____"),
// and with a few fixed points the value looked stuck to the printed text.
const BLANK_TEXT_PADDING_RATIO = 0.6;
const BLANK_TEXT_RIGHT_PADDING = 2;
// form-fields.ts puts the rectangle's bottom edge 2 pt below the line's
// baseline; the text rests 1 pt above that baseline, so it does not touch
// the underscores.
const BLANK_RECT_BASELINE_OFFSET = 2;
const TEXT_ABOVE_LINE = 1;
const APP_NAME = "Hushfill";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const ui = {
  open: $<HTMLButtonElement>("#btn-open"),
  openEmpty: $<HTMLButtonElement>("#btn-open-empty"),
  save: $<HTMLButtonElement>("#btn-save"),
  zoomIn: $<HTMLButtonElement>("#btn-zoom-in"),
  zoomOut: $<HTMLButtonElement>("#btn-zoom-out"),
  fit: $<HTMLButtonElement>("#btn-fit"),
  zoomLabel: $<HTMLSpanElement>("#zoom-label"),
  pageInput: $<HTMLInputElement>("#page-input"),
  pageCount: $<HTMLSpanElement>("#page-count"),
  text: $<HTMLButtonElement>("#btn-text"),
  sign: $<HTMLButtonElement>("#btn-sign"),
  profileSelect: $<HTMLSelectElement>("#profile-select"),
  profiles: $<HTMLButtonElement>("#btn-profiles"),
  settings: $<HTMLButtonElement>("#btn-settings"),
  autofill: $<HTMLButtonElement>("#btn-autofill"),
  hint: $<HTMLDivElement>("#hint"),
  container: $<HTMLDivElement>("#viewer-container"),
  emptyState: $<HTMLDivElement>("#empty-state"),
  busy: $<HTMLDivElement>("#busy"),
  busyText: $<HTMLSpanElement>("#busy-text"),
  toast: $<HTMLDivElement>("#toast"),
  passwordDialog: $<HTMLDialogElement>("#password-dialog"),
  passwordForm: $<HTMLFormElement>("#password-form"),
  passwordInput: $<HTMLInputElement>("#password-input"),
  passwordMessage: $<HTMLParagraphElement>("#password-message"),
};

let currentFile: { path: string; name: string } | null = null;
let dirty = false;
let pendingSignature: SignatureImage | null = null;
let textMode = false;
const measureContext = new OffscreenCanvas(1, 1).getContext("2d")!;
let toastTimer = 0;

// --- State and messages ---------------------------------------------------------

function showToast(message: string, kind: "info" | "error" = "info"): void {
  ui.toast.textContent = message;
  ui.toast.className = kind;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), kind === "error" ? TOAST_MS * 2 : TOAST_MS);
}

function setBusy(message: string | null): void {
  ui.busy.hidden = message === null;
  ui.busyText.textContent = message ?? "";
}

function updateTitle(): void {
  const name = currentFile ? `${dirty ? "• " : ""}${currentFile.name} — ` : "";
  const title = `${name}${APP_NAME}`;
  document.title = title;
  window.api.setTitle(title);
}

function setDirty(value: boolean): void {
  dirty = value;
  window.api.setDirty(value);
  updateTitle();
}

function setDocumentControlsEnabled(enabled: boolean): void {
  for (const button of [ui.save, ui.zoomIn, ui.zoomOut, ui.fit, ui.text, ui.sign, ui.autofill]) {
    button.disabled = !enabled;
  }
  ui.pageInput.disabled = !enabled;
  ui.emptyState.hidden = enabled;
}

function setHint(text: string): void {
  ui.hint.textContent = text;
}

// --- Opening and saving --------------------------------------------------------

function askPassword(wrong: boolean): Promise<string | null> {
  ui.passwordMessage.textContent = wrong ? "Password errata, riprova." : "Inserisci la password per aprire il documento.";
  ui.passwordInput.value = "";
  ui.passwordDialog.showModal();
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      ui.passwordForm.removeEventListener("submit", onSubmit);
      $("#password-cancel").removeEventListener("click", onCancel);
      ui.passwordDialog.close();
      resolve(value);
    };
    const onSubmit = (event: Event) => {
      event.preventDefault();
      finish(ui.passwordInput.value);
    };
    const onCancel = () => finish(null);
    ui.passwordForm.addEventListener("submit", onSubmit);
    $("#password-cancel").addEventListener("click", onCancel);
  });
}

async function confirmDiscardChanges(): Promise<boolean> {
  return !dirty || window.api.confirm("Ci sono modifiche non salvate.", "Aprendo un altro documento andranno perse.", "Continua senza salvare");
}

async function showFile(file: PdfFile): Promise<void> {
  exitModes();
  clearPlacements();
  try {
    const pdfDocument = await viewer.openDocument(file.data, askPassword);
    if (!pdfDocument) {
      return;
    }
    // pdf.js's types declare the hook as null, but it is a callback.
    (pdfDocument.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => setDirty(true);
    currentFile = { path: file.path, name: file.name };
    ui.pageCount.textContent = `/ ${pdfDocument.numPages}`;
    ui.pageInput.max = String(pdfDocument.numPages);
    setDocumentControlsEnabled(true);
    setDirty(false);
  } catch (error) {
    showToast(`Impossibile aprire ${file.name}: ${errorMessage(error)}`, "error");
  }
}

async function openWithDialog(): Promise<void> {
  if (!(await confirmDiscardChanges())) {
    return;
  }
  const file = await window.api.openDialog();
  if (file) {
    await showFile(file);
  }
}

function signedCopyPath(originalPath: string): string {
  return originalPath.replace(/(\.pdf)?$/i, "-firmato.pdf");
}

async function save(): Promise<void> {
  const pdfDocument = viewer.getDocument();
  if (!pdfDocument || !currentFile) {
    return;
  }
  exitModes();
  const target = await window.api.saveDialog(signedCopyPath(currentFile.path));
  if (!target) {
    return;
  }
  setBusy("Salvataggio…");
  try {
    const bytes = await buildPdfBytes(pdfDocument, getPlacements());
    const saved = await window.api.writeFile(target, bytes);
    setDirty(false);
    showToast(`Salvato: ${saved.path}`);
  } catch (error) {
    showToast(`Salvataggio non riuscito: ${errorMessage(error)}`, "error");
  } finally {
    setBusy(null);
  }
}

// --- Signature --------------------------------------------------------------------

function exitModes(): void {
  pendingSignature = null;
  ui.container.classList.remove("placing");
  textMode = false;
  ui.text.classList.remove("active");
  setHint("");
}

function startPlacing(signature: SignatureImage): void {
  exitModes();
  pendingSignature = signature;
  ui.container.classList.add("placing");
  setHint("Clicca sulla pagina dove vuoi la firma · Esc per annullare");
}

async function chooseSignature(): Promise<void> {
  const profile = getActiveProfile();
  if (profile?.signature) {
    startPlacing(profile.signature);
    setHint(`Clicca dove mettere la firma di «${profile.name}» · Esc annulla · Shift+clic su Firma per una nuova`);
    return;
  }
  await drawNewSignature();
}

async function drawNewSignature(): Promise<void> {
  const profile = getActiveProfile();
  const result = await askForSignature({ profileName: profile?.name ?? null, okLabel: "Posiziona" });
  if (!result) {
    return;
  }
  if (result.saveToProfile && profile) {
    const store = structuredClone(getStore());
    store.profiles.find((p) => p.id === profile.id)!.signature = result.signature;
    await replaceStore(store).catch((error) => showToast(`Firma non salvata nel profilo: ${errorMessage(error)}`, "error"));
  }
  startPlacing(result.signature);
}

function addTextAtClick(event: MouseEvent, page: HTMLElement): void {
  const bounds = page.getBoundingClientRect();
  const pageIndex = Number(page.dataset.pageNumber) - 1;
  const fontHeight = (DEFAULT_TEXT_SIZE / viewer.pageHeightPoints(pageIndex)) * bounds.height;
  addPlacement(
    {
      kind: "text",
      pageIndex,
      text: "",
      fontSize: DEFAULT_TEXT_SIZE,
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top - fontHeight / 2) / bounds.height,
    },
    { edit: true },
  );
}

function handlePageClick(event: MouseEvent): void {
  const page = (event.target as HTMLElement).closest<HTMLElement>(".page");
  if (!page || (event.target as HTMLElement).closest(".place-item")) {
    return;
  }
  if (textMode) {
    event.preventDefault();
    event.stopPropagation();
    addTextAtClick(event, page);
    return;
  }
  if (pendingSignature) {
    placePendingSignature(event, page, pendingSignature);
  }
}

function placePendingSignature(event: MouseEvent, page: HTMLElement, signature: SignatureImage): void {
  event.preventDefault();
  event.stopPropagation();
  const bounds = page.getBoundingClientRect();
  const width = DEFAULT_SIGNATURE_WIDTH;
  const height = (width * bounds.width) / (signature.width / signature.height) / bounds.height;
  const clickX = (event.clientX - bounds.left) / bounds.width;
  const clickY = (event.clientY - bounds.top) / bounds.height;
  addPlacement({
    kind: "image",
    pageIndex: Number(page.dataset.pageNumber) - 1,
    image: signature,
    x: Math.min(Math.max(clickX - width / 2, 0), 1 - width),
    y: Math.min(Math.max(clickY - height / 2, 0), 1 - height),
    width,
    height,
  });
  exitModes();
}

// Maximum height of the signature: in a real signature field at least the
// field's; on a printed blank line a multiple of the text size, so it does
// not spill onto the lines above.
function signatureBoxHeight(field: FormFieldInfo, rectHeight: number): number {
  if (field.source === "blank") {
    return (field.fontSize ?? DEFAULT_TEXT_SIZE) * BLANK_SIGNATURE_HEIGHT_RATIO;
  }
  return Math.max(rectHeight, MIN_FIELD_SIGNATURE_HEIGHT);
}

// Puts the signature in the rectangle of a signature field or a blank line,
// scaled proportionally and resting on the line.
async function placeSignatureInField(field: FormFieldInfo, image: SignatureImage): Promise<void> {
  const pdfDocument = viewer.getDocument()!;
  const viewport = (await pdfDocument.getPage(field.pageIndex + 1)).getViewport({ scale: 1 });
  const [ax, ay] = viewport.convertToViewportPoint(field.rect[0], field.rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(field.rect[2], field.rect[3]);
  const left = Math.min(ax, bx);
  // A handwritten signature drops a little below the line: imitate it.
  const sinkBelowLine = field.source === "blank" ? (field.fontSize ?? DEFAULT_TEXT_SIZE) * BLANK_SIGNATURE_SINK_RATIO : 0;
  const bottom = Math.max(ay, by) + sinkBelowLine;
  const boxWidth = Math.abs(bx - ax);
  const boxHeight = signatureBoxHeight(field, Math.abs(by - ay));
  const aspect = image.width / image.height;
  let width = boxWidth;
  let height = width / aspect;
  if (height > boxHeight) {
    height = boxHeight;
    width = height * aspect;
  }
  addPlacement({
    kind: "image",
    pageIndex: field.pageIndex,
    image,
    replacesFieldName: field.source === "acroform" ? field.fieldName : undefined,
    x: (left + (boxWidth - width) / 2) / viewport.width,
    y: Math.max(bottom - height, 0) / viewport.height,
    width: width / viewport.width,
    height: height / viewport.height,
  });
}

// Writes a value over a printed blank line: just above the line, in the
// size of the surrounding text, shrunk if it does not fit.
async function placeTextOnBlank(field: FormFieldInfo, value: string): Promise<void> {
  const pdfDocument = viewer.getDocument()!;
  const viewport = (await pdfDocument.getPage(field.pageIndex + 1)).getViewport({ scale: 1 });
  const [x1, lineY, x2] = field.rect;
  const baselinePdf = lineY + BLANK_RECT_BASELINE_OFFSET + TEXT_ABOVE_LINE;
  let fontSize = Math.min(Math.max(field.fontSize ?? DEFAULT_TEXT_SIZE, MIN_FILL_TEXT_SIZE), MAX_FILL_TEXT_SIZE);
  const leftPadding = fontSize * BLANK_TEXT_PADDING_RATIO;
  const [left, baseline] = viewport.convertToViewportPoint(x1 + leftPadding, baselinePdf);
  const available = x2 - x1 - leftPadding - BLANK_TEXT_RIGHT_PADDING;
  measureContext.font = `${fontSize}px ${TEXT_FONT_FAMILY}`;
  const textWidth = measureContext.measureText(value).width;
  if (textWidth > available) {
    fontSize = Math.max(MIN_FILL_TEXT_SIZE, (fontSize * available) / textWidth);
  }
  addPlacement({
    kind: "text",
    pageIndex: field.pageIndex,
    text: value,
    fontSize,
    x: left / viewport.width,
    y: (baseline - fontSize * TEXT_BASELINE_RATIO) / viewport.height,
  });
}

// --- Filling: local recognition or with Jev -------------------------------------

async function recognizeFieldsWithJev(fields: FormFieldInfo[]): Promise<FieldDecision[]> {
  const { headings } = getStore();
  const decisions: FieldDecision[] = [];
  for (const prepared of buildJevRequests(fields, headings)) {
    const response = await window.api.jevDecide(prepared.request);
    decisions.push(...parseJevResponse(prepared, response));
  }
  return recognizeCombinedParts(decisions, headings);
}

// Second pass, only if Jev saw fields with several pieces of information
// together: for each one it asks which headings belong to it.
async function recognizeCombinedParts(decisions: FieldDecision[], headings: Heading[]): Promise<FieldDecision[]> {
  const partsByDecision = new Map<FieldDecision, string[]>();
  for (const prepared of buildPartRequests(decisions, headings)) {
    collectPartAnswers(prepared, await window.api.jevDecide(prepared.request), partsByDecision);
  }
  return decisions.map((decision) =>
    decision.target === COMBINED_CHOICE ? resolveCombined(decision, partsByDecision.get(decision) ?? [], headings) : decision,
  );
}

async function applyAutofill(result: AutofillResult): Promise<void> {
  for (const fill of result.textFills) {
    if (fill.decision.field.source === "blank") {
      await placeTextOnBlank(fill.decision.field, fill.value);
    } else {
      viewer.setFieldValue(fill.decision.field.ids, fill.value);
    }
  }
  for (const decision of result.signatureFields) {
    await placeSignatureInField(decision.field, result.profile.signature!);
  }
  const total = result.textFills.length + result.signatureFields.length;
  if (total > 0) {
    setDirty(true);
  }
  const saved = await saveProfileUpdates(result);
  showToast(`${total} campi compilati con il profilo «${result.profile.name}».${saved}`);
}

// The values typed in the review that the profile did not have: the document
// is already filled, so a save error is reported without undoing it.
async function saveProfileUpdates(result: AutofillResult): Promise<string> {
  const { profileUpdates } = result;
  if (!hasProfileUpdates(profileUpdates)) {
    return "";
  }
  try {
    await replaceStore(withProfileUpdates(getStore(), result.profile.id, profileUpdates));
  } catch (error) {
    showToast(`Campi compilati, ma il profilo non è stato aggiornato: ${errorMessage(error)}`, "error");
    return "";
  }
  const added = profileUpdates.newHeadings.length;
  const filled = profileUpdates.values.length;
  const parts = [countText(added, "campo aggiunto", "campi aggiunti"), countText(filled, "valore salvato", "valori salvati")];
  return ` Profilo aggiornato: ${parts.filter(Boolean).join(", ")}.`;
}

function countText(count: number, singular: string, plural: string): string {
  if (count === 0) {
    return "";
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

// Engine chosen in Settings, with the name to show in the review;
// null if it is Jev but the key is missing.
async function describeEngine(): Promise<{ local: boolean; name: string } | null> {
  if (getRecognitionEngine() === "local") {
    return { local: true, name: "riconoscimento sul computer" };
  }
  const status = await window.api.jevStatus();
  return status.configured ? { local: false, name: status.model } : null;
}

async function autofill(): Promise<void> {
  const pdfDocument = viewer.getDocument();
  if (!pdfDocument) {
    return;
  }
  exitModes();
  const engine = await describeEngine();
  if (!engine) {
    showToast("Jev non è configurato: inserisci la chiave API nelle Impostazioni o scegli il riconoscimento sul computer.", "error");
    void openSettingsDialog();
    return;
  }
  if (getStore().profiles.length === 0) {
    showToast("Crea prima un profilo con i tuoi dati.");
    openProfileDialog();
    return;
  }
  setBusy("Lettura dei campi del modulo…");
  try {
    const fields = await collectFormFields(pdfDocument);
    if (fields.length === 0) {
      showToast("Questo PDF non ha campi compilabili: usa Testo e Firma per compilarlo a mano.");
      return;
    }
    for (const field of fields) {
      field.currentValue = viewer.currentFieldValue(field.ids[0], field.currentValue);
    }
    setBusy(`Riconoscimento di ${fields.length} campi…`);
    const started = performance.now();
    const decisions = engine.local ? recognizeFieldsLocally(fields, getStore().headings) : await recognizeFieldsWithJev(fields);
    const elapsed = Math.round(performance.now() - started);
    setBusy(null);
    const result = await reviewDecisions(decisions, getStore(), `${fields.length} campi · ${engine.name} · ${elapsed} ms`);
    if (result) {
      await applyAutofill(result);
    }
  } catch (error) {
    showToast(`Riconoscimento non riuscito: ${errorMessage(error)}`, "error");
  } finally {
    setBusy(null);
  }
}

// --- Profiles in the toolbar -----------------------------------------------------

function renderProfileSelect(): void {
  const { profiles, activeProfileId } = getStore();
  const options = profiles.map((p) => new Option(p.name, p.id, false, p.id === activeProfileId));
  ui.profileSelect.replaceChildren(...(options.length ? options : [new Option("Nessun profilo", "")]));
  ui.profileSelect.disabled = options.length === 0;
}

// --- Wiring -----------------------------------------------------------------------

function bindViewerEvents(): void {
  viewer.eventBus.on("pagesinit", () => viewer.fitWidth());
  viewer.eventBus.on("scalechanging", ({ scale }: { scale: number }) => {
    ui.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  });
  viewer.eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
    ui.pageInput.value = String(pageNumber);
  });
  viewer.eventBus.on("pagerendered", ({ source, pageNumber }: { source: { div: HTMLElement }; pageNumber: number }) => {
    renderPlacements(source.div, pageNumber - 1);
  });
}

function bindToolbar(): void {
  ui.open.addEventListener("click", () => void openWithDialog());
  ui.openEmpty.addEventListener("click", () => void openWithDialog());
  ui.save.addEventListener("click", () => void save());
  ui.zoomIn.addEventListener("click", viewer.zoomIn);
  ui.zoomOut.addEventListener("click", viewer.zoomOut);
  ui.fit.addEventListener("click", viewer.fitWidth);
  ui.pageInput.addEventListener("change", () => {
    viewer.pdfViewer.currentPageNumber = Number(ui.pageInput.value);
  });
  ui.text.addEventListener("click", () => {
    const enable = !textMode;
    exitModes();
    textMode = enable;
    ui.text.classList.toggle("active", enable);
    ui.container.classList.toggle("placing", enable);
    setHint(enable ? "Clicca sulla pagina per scrivere · doppio clic su un testo per modificarlo · Esc per uscire" : "");
  });
  ui.sign.addEventListener("click", (event) => void (event.shiftKey ? drawNewSignature() : chooseSignature()));
  ui.profiles.addEventListener("click", openProfileDialog);
  ui.settings.addEventListener("click", () => void openSettingsDialog());
  ui.autofill.addEventListener("click", () => void autofill());
  ui.profileSelect.addEventListener("change", () => {
    setActiveProfile(ui.profileSelect.value || null).catch((error) => showToast(errorMessage(error), "error"));
  });
  ui.container.addEventListener("click", handlePageClick, true);
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function bindKeyboard(): void {
  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Escape" && (pendingSignature || textMode)) {
      exitModes();
    } else if ((event.key === "Delete" || event.key === "Backspace") && !isTyping(event.target)) {
      if (deleteSelected()) {
        event.preventDefault();
      }
    } else if (mod && event.key.toLowerCase() === "o") {
      event.preventDefault();
      void openWithDialog();
    } else if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    } else if (mod && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      viewer.zoomIn();
    } else if (mod && event.key === "-") {
      event.preventDefault();
      viewer.zoomOut();
    } else if (mod && event.key === "0") {
      event.preventDefault();
      viewer.fitWidth();
    }
  });
  ui.container.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey && viewer.getDocument()) {
        event.preventDefault();
        if (event.deltaY < 0) {
          viewer.zoomIn();
        } else {
          viewer.zoomOut();
        }
      }
    },
    { passive: false },
  );
}

function bindDragAndDrop(): void {
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file || !/\.pdf$/i.test(file.name) || !(await confirmDiscardChanges())) {
      return;
    }
    await showFile(await window.api.readFile(window.api.pathForFile(file)));
  });
}

async function start(): Promise<void> {
  initSignatureDialog();
  initProfileDialog();
  initAutofillDialog();
  initSettingsDialog();
  initPlacements({ onChange: () => setDirty(true), pageDiv: viewer.pageDiv, pageHeight: viewer.pageHeightPoints });
  bindViewerEvents();
  bindToolbar();
  bindKeyboard();
  bindDragAndDrop();
  onProfilesChanged(renderProfileSelect);
  renderProfileSelect();
  setDocumentControlsEnabled(false);
  updateTitle();
  loadProfiles().catch((error) => showToast(`Profili non caricati: ${errorMessage(error)}`, "error"));
  const initial = await window.api.getInitialFile();
  if (initial) {
    await showFile(initial);
  }
}

void start();
