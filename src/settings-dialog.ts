// Settings window: recognition engine and, for Jev, API key, model and
// server. The key is typed here and goes to the main process, which encrypts
// it with the keyring; it never comes back, the window only knows whether one
// is saved.
import type { JevSettingsForm, JevSettingsView } from "./api";
import { errorMessage as errorText } from "./errors";
import { getRecognitionEngine, setRecognitionEngine, type RecognitionEngine } from "./recognition-engine";

const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const engineSelect = document.querySelector<HTMLSelectElement>("#settings-engine")!;
const keyInput = document.querySelector<HTMLInputElement>("#settings-key")!;
const keyState = document.querySelector<HTMLSpanElement>("#settings-key-state")!;
const keyRemove = document.querySelector<HTMLButtonElement>("#settings-key-remove")!;
const modelInput = document.querySelector<HTMLInputElement>("#settings-model")!;
const modelEnv = document.querySelector<HTMLSpanElement>("#settings-model-env")!;
const urlInput = document.querySelector<HTMLInputElement>("#settings-url")!;
const urlEnv = document.querySelector<HTMLSpanElement>("#settings-url-env")!;
const result = document.querySelector<HTMLParagraphElement>("#settings-result")!;
const testButton = document.querySelector<HTMLButtonElement>("#settings-test")!;

let view: JevSettingsView | null = null;
// "Rimuovi chiave" (remove key) pressed: removal happens only on Salva (Save).
let removeKey = false;

function showResult(text: string, tone: "ok" | "error" | "" = ""): void {
  result.textContent = text;
  result.className = `note ${tone}`.trim();
}

function describeKeyState(): string {
  if (view?.fromEnvironment.apiKey) {
    return "In uso la chiave della variabile TYPESAFE_API_KEY, che ha la precedenza.";
  }
  if (removeKey) {
    return "La chiave salvata sarà rimossa con Salva.";
  }
  return view?.hasSavedKey ? "Chiave salvata e cifrata. Scrivine una nuova per sostituirla." : "Nessuna chiave salvata.";
}

function render(): void {
  engineSelect.value = getRecognitionEngine();
  if (!view) {
    return;
  }
  keyInput.value = "";
  keyInput.placeholder = view.hasSavedKey && !removeKey ? "•••••••• (salvata)" : "incolla la chiave da console.typesafe.ai";
  keyState.textContent = describeKeyState();
  keyRemove.disabled = !view.hasSavedKey || removeKey;
  modelInput.value = view.model;
  modelInput.placeholder = view.defaults.model;
  modelEnv.hidden = !view.fromEnvironment.model;
  urlInput.value = view.baseUrl;
  urlInput.placeholder = view.defaults.baseUrl;
  urlEnv.hidden = !view.fromEnvironment.baseUrl;
}

function readForm(): JevSettingsForm {
  return { apiKey: keyInput.value.trim(), removeKey: removeKey && !keyInput.value.trim(), model: modelInput.value, baseUrl: urlInput.value };
}

async function testConnection(): Promise<void> {
  testButton.disabled = true;
  showResult("Prova in corso…");
  try {
    const { model, milliseconds } = await window.api.testJev(readForm());
    showResult(`Jev risponde (${model}, ${milliseconds} ms).`, "ok");
  } catch (error) {
    showResult(errorText(error), "error");
  } finally {
    testButton.disabled = false;
  }
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  try {
    await window.api.saveJevSettings(readForm());
    setRecognitionEngine(engineSelect.value as RecognitionEngine);
    dialog.close();
  } catch (error) {
    showResult(errorText(error), "error");
  }
}

export function initSettingsDialog(): void {
  form.addEventListener("submit", (event) => void save(event));
  testButton.addEventListener("click", () => void testConnection());
  keyRemove.addEventListener("click", () => {
    removeKey = true;
    render();
  });
  keyInput.addEventListener("input", () => {
    if (keyInput.value) {
      removeKey = false;
      keyState.textContent = "La nuova chiave sostituirà quella salvata con Salva.";
    }
  });
  document.querySelector<HTMLButtonElement>("#settings-cancel")!.addEventListener("click", () => dialog.close());
  // On close the typed key does not stay in the field.
  dialog.addEventListener("close", () => {
    keyInput.value = "";
  });
}

export async function openSettingsDialog(): Promise<void> {
  removeKey = false;
  showResult("");
  try {
    view = await window.api.getJevSettings();
  } catch (error) {
    view = null;
    showResult(errorText(error), "error");
  }
  render();
  dialog.showModal();
  keyInput.focus();
}
