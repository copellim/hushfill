// Bridge exposed by electron/preload.cjs.
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

// Jev settings as the window sees them: the saved key never reaches the
// renderer, only whether there is one.
export interface JevSettingsView {
  hasSavedKey: boolean;
  model: string;
  baseUrl: string;
  defaults: { model: string; baseUrl: string };
  // TYPESAFE_* variables set in the environment, which take precedence.
  fromEnvironment: { apiKey: boolean; model: boolean; baseUrl: boolean };
  storageFile: string;
}

// Form values. Empty apiKey = leave the saved key as it is.
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
