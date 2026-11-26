// Review of Jev's proposals. Here, locally, every heading chosen by Jev
// is matched to the profile's value; the user can correct the match,
// the value, or exclude the field before it is written.
// When the user types a value the profile does not have, the review
// offers to save it: as a new field or as a missing value.
import { COMBINED_CHOICE, SIGNATURE_CHOICE, type FieldDecision, type Heading } from "./jev";
import { combinedValue, headingValue, suggestHeadingLabel, type Profile, type ProfileStore, type ProfileUpdates } from "./profiles";

export interface FillAction {
  decision: FieldDecision;
  value: string;
}

export interface AutofillResult {
  profile: Profile;
  textFills: FillAction[];
  signatureFields: FieldDecision[];
  profileUpdates: ProfileUpdates;
}

// Below this probability the proposal stays visible but unticked.
const AUTO_CHECK_PROBABILITY = 0.5;
// Special values of the "Informazione" (information) menu, next to the heading ids.
const NOT_FILLED = "";
const NEW_HEADING = "__nuovo";
const MANUAL_VALUE = "__a-mano";

const dialog = document.querySelector<HTMLDialogElement>("#autofill-dialog")!;
const profileSelect = document.querySelector<HTMLSelectElement>("#autofill-profile")!;
const rowsBox = document.querySelector<HTMLDivElement>("#autofill-rows")!;
const unmatchedBox = document.querySelector<HTMLDivElement>("#autofill-unmatched-rows")!;
const unmatchedDetails = document.querySelector<HTMLDetailsElement>("#autofill-unmatched")!;
const unmatchedSummary = unmatchedDetails.querySelector("summary")!;
const metaBox = document.querySelector<HTMLSpanElement>("#autofill-meta")!;
const applyButton = document.querySelector<HTMLButtonElement>("#autofill-apply")!;

interface Row {
  decision: FieldDecision;
  checkbox: HTMLInputElement;
  target: HTMLSelectElement;
  value: HTMLInputElement;
  // Name of the field to create, visible with "+ nuovo campo del profilo" (new profile field).
  newLabel: HTMLInputElement;
  // "Salva nel profilo" (save to profile), visible when the profile lacks the typed value.
  saveValue: HTMLInputElement;
  saveValueLabel: HTMLLabelElement;
}

let rows: Row[] = [];
let currentStore: ProfileStore | null = null;
let resolveDialog: ((result: AutofillResult | null) => void) | null = null;

function selectedProfile(): Profile | null {
  return currentStore?.profiles.find((p) => p.id === profileSelect.value) ?? null;
}

function describeField(decision: FieldDecision): string {
  const { field } = decision;
  const context = field.tooltip || field.label || field.fieldName;
  return `p. ${field.pageIndex + 1} · ${context}`;
}

function headingOf(target: string) {
  return currentStore?.headings.find((h) => h.id === target);
}

// The value comes from the profile only if the information is a heading or the signature.
function isWrittenByHand(target: string): boolean {
  return target === NEW_HEADING || target === MANUAL_VALUE;
}

function partHeadings(decision: FieldDecision): Heading[] {
  return decision.parts.map(headingOf).filter((heading): heading is Heading => heading !== undefined);
}

function resolveValue(row: Row, profile: Profile | null): string {
  const target = row.target.value;
  if (!profile || target === NOT_FILLED) {
    return "";
  }
  if (target === SIGNATURE_CHOICE) {
    return profile.signature ? "(firma del profilo)" : "";
  }
  if (target === COMBINED_CHOICE) {
    return combinedValue(partHeadings(row.decision), profile).value;
  }
  const heading = headingOf(target);
  return heading ? headingValue(heading, profile) : "";
}

function valuePlaceholder(row: Row, profile: Profile | null): string {
  const target = row.target.value;
  if (target === NOT_FILLED) {
    return "scrivi per compilarlo";
  }
  if (isWrittenByHand(target)) {
    return "valore";
  }
  if (target === COMBINED_CHOICE && profile) {
    return `mancano nel profilo: ${combinedValue(partHeadings(row.decision), profile).missing.join(", ")}`;
  }
  return "manca nel profilo: scrivilo qui";
}

function buildTargetSelect(store: ProfileStore, decision: FieldDecision): HTMLSelectElement {
  const select = document.createElement("select");
  const parts = partHeadings(decision);
  const options: [string, string][] = [
    [NOT_FILLED, "— non compilare"],
    ...(parts.length > 1 ? [[COMBINED_CHOICE, parts.map((h) => h.label).join(" + ")] as [string, string]] : []),
    ...store.headings.map((h): [string, string] => [h.id, h.label]),
    [SIGNATURE_CHOICE, "Firma"],
    [NEW_HEADING, "+ nuovo campo del profilo"],
    [MANUAL_VALUE, "valore a mano, senza salvarlo"],
  ];
  const selected = decision.target ?? NOT_FILLED;
  for (const [value, text] of options) {
    select.append(new Option(text, value, false, value === selected));
  }
  return select;
}

// The typed value is missing from the profile for a (non-automatic) heading.
function isMissingFromProfile(row: Row, profile: Profile | null): boolean {
  const heading = headingOf(row.target.value);
  return Boolean(heading && !heading.automatic && profile && !profile.values[heading.id] && row.value.value.trim());
}

function refreshExtras(row: Row, profile: Profile | null): void {
  const isNew = row.target.value === NEW_HEADING;
  row.newLabel.hidden = !isNew;
  if (isNew && !row.newLabel.value) {
    row.newLabel.value = suggestHeadingLabel(row.decision.field);
  }
  const wasHidden = row.saveValueLabel.hidden;
  row.saveValueLabel.hidden = !isMissingFromProfile(row, profile);
  if (wasHidden && !row.saveValueLabel.hidden) {
    row.saveValue.checked = true;
  }
}

function refreshRow(row: Row, profile: Profile | null, resetCheck: boolean): void {
  const target = row.target.value;
  const isSignature = target === SIGNATURE_CHOICE;
  // For values typed by hand, what the user typed is kept.
  const value = isWrittenByHand(target) ? row.value.value : resolveValue(row, profile);
  row.value.value = value;
  row.value.readOnly = isSignature;
  row.value.placeholder = valuePlaceholder(row, profile);
  const { maxLen, currentValue } = row.decision.field;
  const tooLong = !isSignature && maxLen !== null && value.length > maxLen;
  row.value.title = tooLong ? `Il campo accetta al massimo ${maxLen} caratteri` : "";
  row.value.classList.toggle("invalid", tooLong);
  if (resetCheck) {
    row.checkbox.checked =
      target !== NOT_FILLED && value !== "" && currentValue === "" && !tooLong && row.decision.probability >= AUTO_CHECK_PROBABILITY;
  }
  refreshExtras(row, profile);
}

// Typing into an unrecognised field is the proposal: it becomes a new
// profile field, with a name derived from the form and editable.
function onValueTyped(row: Row): void {
  if (row.target.value === NOT_FILLED && row.value.value.trim()) {
    row.target.value = NEW_HEADING;
  }
  row.checkbox.checked = row.value.value !== "";
  refreshExtras(row, selectedProfile());
}

function buildFieldLabel(decision: FieldDecision): HTMLSpanElement {
  const label = document.createElement("span");
  label.className = "autofill-field";
  label.textContent = describeField(decision);
  label.title = [decision.field.fieldName, decision.field.label].filter(Boolean).join("\n");
  if (decision.field.currentValue) {
    const filled = document.createElement("small");
    filled.textContent = `già compilato: ${decision.field.currentValue}`;
    label.append(filled);
  }
  return label;
}

function buildValueCell(): Pick<Row, "value" | "newLabel" | "saveValue" | "saveValueLabel"> & { cell: HTMLDivElement } {
  const cell = document.createElement("div");
  cell.className = "autofill-value";
  const value = document.createElement("input");
  value.type = "text";
  const newLabel = document.createElement("input");
  newLabel.type = "text";
  newLabel.placeholder = "Nome del nuovo campo (es. Numero di tessera)";
  newLabel.title = "Il campo viene aggiunto a tutti i profili; il valore va nel profilo scelto";
  newLabel.hidden = true;
  const saveValueLabel = document.createElement("label");
  saveValueLabel.className = "check small";
  const saveValue = document.createElement("input");
  saveValue.type = "checkbox";
  saveValueLabel.append(saveValue, " salva nel profilo");
  saveValueLabel.hidden = true;
  cell.append(value, newLabel, saveValueLabel);
  return { cell, value, newLabel, saveValue, saveValueLabel };
}

function buildRow(decision: FieldDecision, store: ProfileStore): { element: HTMLElement; row: Row } {
  const element = document.createElement("div");
  element.className = "autofill-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const target = buildTargetSelect(store, decision);
  const { cell, value, newLabel, saveValue, saveValueLabel } = buildValueCell();
  const confidence = document.createElement("span");
  confidence.className = "autofill-confidence";
  confidence.textContent = decision.target ? `${Math.round(decision.probability * 100)}%` : "";
  confidence.title = "Probabilità stimata per la scelta";
  confidence.classList.toggle("low", decision.probability < AUTO_CHECK_PROBABILITY);
  const row: Row = { decision, checkbox, target, value, newLabel, saveValue, saveValueLabel };
  target.addEventListener("change", () => refreshRow(row, selectedProfile(), true));
  value.addEventListener("input", () => onValueTyped(row));
  newLabel.addEventListener("input", () => newLabel.classList.remove("invalid"));
  element.append(checkbox, buildFieldLabel(decision), target, cell, confidence);
  return { element, row };
}

function render(decisions: FieldDecision[], store: ProfileStore): void {
  rows = [];
  const matched: HTMLElement[] = [];
  const unmatched: HTMLElement[] = [];
  for (const decision of decisions) {
    const { element, row } = buildRow(decision, store);
    rows.push(row);
    (decision.target ? matched : unmatched).push(element);
  }
  rowsBox.replaceChildren(...matched);
  unmatchedBox.replaceChildren(...unmatched);
  unmatchedDetails.hidden = unmatched.length === 0;
  unmatchedSummary.textContent = `${unmatched.length} campi non riconosciuti: scrivi un valore per compilarli e aggiungerli al profilo`;
  rows.forEach((row) => refreshRow(row, selectedProfile(), true));
}

function collectProfileUpdates(checked: Row[]): ProfileUpdates {
  return {
    newHeadings: checked
      .filter((row) => row.target.value === NEW_HEADING && row.value.value.trim())
      .map((row) => ({ label: row.newLabel.value, description: row.decision.field.tooltip || row.decision.field.label, value: row.value.value.trim() })),
    values: checked
      .filter((row) => !row.saveValueLabel.hidden && row.saveValue.checked)
      .map((row) => ({ headingId: row.target.value, value: row.value.value.trim() })),
  };
}

function collectResult(profile: Profile): AutofillResult {
  const checked = rows.filter((row) => row.checkbox.checked && row.target.value !== NOT_FILLED);
  return {
    profile,
    textFills: checked
      .filter((row) => row.target.value !== SIGNATURE_CHOICE && row.value.value !== "")
      .map((row) => ({ decision: row.decision, value: row.value.value })),
    signatureFields: checked.filter((row) => row.target.value === SIGNATURE_CHOICE && profile.signature).map((row) => row.decision),
    profileUpdates: collectProfileUpdates(checked),
  };
}

// A new field without a name cannot be saved: it is flagged instead of being lost.
function firstUnnamedNewHeading(): Row | undefined {
  return rows.find((row) => row.checkbox.checked && row.target.value === NEW_HEADING && row.value.value.trim() && !row.newLabel.value.trim());
}

function apply(): void {
  const profile = selectedProfile();
  if (!profile) {
    close(null);
    return;
  }
  const unnamed = firstUnnamedNewHeading();
  if (unnamed) {
    unmatchedDetails.open = true;
    unnamed.newLabel.classList.add("invalid");
    unnamed.newLabel.focus();
    return;
  }
  close(collectResult(profile));
}

function close(result: AutofillResult | null): void {
  dialog.close();
  resolveDialog?.(result);
  resolveDialog = null;
}

export function initAutofillDialog(): void {
  profileSelect.addEventListener("change", () => rows.forEach((row) => refreshRow(row, selectedProfile(), true)));
  document.querySelector("#autofill-cancel")!.addEventListener("click", () => close(null));
  applyButton.addEventListener("click", apply);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(null);
  });
}

export function reviewDecisions(decisions: FieldDecision[], store: ProfileStore, meta: string): Promise<AutofillResult | null> {
  currentStore = store;
  profileSelect.replaceChildren(...store.profiles.map((p) => new Option(p.name, p.id, false, p.id === store.activeProfileId)));
  metaBox.textContent = meta;
  render(decisions, store);
  dialog.showModal();
  return new Promise((resolve) => {
    resolveDialog = resolve;
  });
}
