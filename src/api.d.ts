// Ponte esposto da electron/preload.cjs.
import type { JevRequest, JevResponse } from "./jev";

export interface PdfFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface SavedFile {
  path: string;
  name: string;
}

export interface JevStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
}

// Impostazioni di Jev come le vede la finestra: la chiave salvata non
// arriva mai al renderer, solo se c'è.
export interface JevSettingsView {
  hasSavedKey: boolean;
  model: string;
  baseUrl: string;
  defaults: { model: string; baseUrl: string };
  // Variabili TYPESAFE_* impostate nell'ambiente, che hanno la precedenza.
  fromEnvironment: { apiKey: boolean; model: boolean; baseUrl: boolean };
  storageFile: string;
}

// Valori del modulo. apiKey vuota = lascia la chiave salvata com'è.
export interface JevSettingsForm {
  apiKey: string;
  removeKey: boolean;
  model: string;
  baseUrl: string;
}

export interface JevTestResult {
  model: string;
  milliseconds: number;
}

declare global {
  interface Window {
    api: {
      getInitialFile(): Promise<PdfFile | null>;
      readFile(path: string): Promise<PdfFile>;
      openDialog(): Promise<PdfFile | null>;
      saveDialog(defaultPath: string): Promise<string | null>;
      writeFile(path: string, data: Uint8Array): Promise<SavedFile>;
      confirm(message: string, detail: string, okLabel: string): Promise<boolean>;
      setDirty(dirty: boolean): void;
      setTitle(title: string): void;
      pathForFile(file: File): string;
      loadProfiles(): Promise<string | null>;
      saveProfiles(json: string): Promise<void>;
      jevStatus(): Promise<JevStatus>;
      getJevSettings(): Promise<JevSettingsView>;
      saveJevSettings(form: JevSettingsForm): Promise<void>;
      testJev(form: JevSettingsForm): Promise<JevTestResult>;
      jevDecide(request: JevRequest): Promise<JevResponse>;
    };
  }
}
