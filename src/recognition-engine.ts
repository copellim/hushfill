// Motore che riconosce i campi per "Compila": in locale (predefinito, niente
// esce dal computer) o Jev. La scelta non è un segreto: sta nel localStorage
// del renderer, non nei file cifrati col portachiavi.
export type RecognitionEngine = "local" | "jev";

const STORAGE_KEY = "hushfill.recognition-engine";

export function getRecognitionEngine(): RecognitionEngine {
  try {
    return localStorage.getItem(STORAGE_KEY) === "jev" ? "jev" : "local";
  } catch {
    // Storage illeggibile: il motore locale funziona senza configurazione.
    return "local";
  }
}

export function setRecognitionEngine(engine: RecognitionEngine): void {
  localStorage.setItem(STORAGE_KEY, engine);
}
