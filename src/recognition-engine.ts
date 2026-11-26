// Engine that recognises the fields for "Compila" (Fill): local (default,
// nothing leaves the computer) or Jev. The choice is not a secret: it lives in
// the renderer's localStorage, not in the files encrypted with the keyring.
export type RecognitionEngine = "local" | "jev";

const STORAGE_KEY = "hushfill.recognition-engine";

export function getRecognitionEngine(): RecognitionEngine {
  try {
    return localStorage.getItem(STORAGE_KEY) === "jev" ? "jev" : "local";
  } catch {
    // Unreadable storage: the local engine works without configuration.
    return "local";
  }
}

export function setRecognitionEngine(engine: RecognitionEngine): void {
  localStorage.setItem(STORAGE_KEY, engine);
}
