// Profiles: field headings, shared and defined by the user, values and
// signature per profile. All encrypted on disk by the main process.
import type { FormFieldInfo, Heading } from "./jev";
import type { SignatureImage } from "./signature-dialog";

export interface Profile {
  id: string;
  name: string;
  values: Record<string, string>; // heading id -> value
  signature: SignatureImage | null;
}

export interface ProfileStore {
  // 2: added the automatic heading "Data di oggi" (today's date).
  // 3: removed "Nome e cognome" (full name), now composed from Nome and Cognome.
  // 4: default descriptions of "Data di oggi" and "Comune di residenza".
  version: 4;
  headings: Heading[];
  profiles: Profile[];
  activeProfileId: string | null;
}

// The descriptions end up in the options sent to Jev: they must not tie the
// date alone to «Luogo e data» (place and date), which is a combined field.
const TODAY_HEADING: Omit<Heading, "id"> = {
  label: "Data di oggi",
  description: "Data del giorno in cui si compila il modulo",
  automatic: "today",
};

const CITY_DESCRIPTION = "Comune dove si abita, usato anche come luogo in cui si firma";

const DEFAULT_HEADINGS: [string, string][] = [
  ["Nome", ""],
  ["Cognome", ""],
  ["Data di nascita", "Nel formato gg/mm/aaaa"],
  ["Luogo di nascita", "Comune di nascita"],
  ["Codice fiscale", "16 caratteri alfanumerici"],
  ["Indirizzo di residenza", "Via o piazza e numero civico"],
  ["CAP", "Codice di avviamento postale della residenza"],
  ["Comune di residenza", CITY_DESCRIPTION],
  ["Provincia di residenza", "Sigla di due lettere"],
  ["Telefono", "Fisso o cellulare"],
  ["Email", "Posta elettronica ordinaria, non PEC"],
];

let store: ProfileStore = emptyStore();
const listeners = new Set<() => void>();

function emptyStore(): ProfileStore {
  return {
    version: 4,
    headings: [
      ...DEFAULT_HEADINGS.map(([label, description]) => ({ id: crypto.randomUUID(), label, description })),
      { id: crypto.randomUUID(), ...TODAY_HEADING },
    ],
    profiles: [],
    activeProfileId: null,
  };
}

// Label of the old default field, removed in version 3.
const LEGACY_FULL_NAME_LABEL = "Nome e cognome";

type SavedStore = { version: number } & Omit<ProfileStore, "version">;

// Each step runs only once: if the user later adds back or deletes a
// field, the version number prevents redoing it.
export function migrateStore(saved: SavedStore): ProfileStore {
  let store = saved;
  if (store.version < 2) {
    // Profiles saved before the automatic date receive it.
    store = { ...store, version: 2, headings: [...store.headings, { id: crypto.randomUUID(), ...TODAY_HEADING }] };
  }
  if (store.version < 3) {
    store = withoutLegacyFullName(store);
  }
  if (store.version < 4) {
    store = { ...store, version: 4, headings: store.headings.map(withCurrentDefaultDescription) };
  }
  return store as ProfileStore;
}

// Default descriptions changed in version 4: they are updated only if
// the user has not touched them.
const UPDATED_DESCRIPTIONS: { label: string; previous: string; current: string }[] = [
  { label: TODAY_HEADING.label, previous: "Data della compilazione, ad esempio in «Luogo e data» o accanto alla firma", current: TODAY_HEADING.description },
  { label: "Comune di residenza", previous: "", current: CITY_DESCRIPTION },
];

function withCurrentDefaultDescription(heading: Heading): Heading {
  const update = UPDATED_DESCRIPTIONS.find((u) => u.label === heading.label && u.previous === heading.description);
  return update ? { ...heading, description: update.current } : heading;
}

// The full name is now composed from Nome and Cognome (combined field): the
// old field is removed, with its values, from the headings and the profiles.
function withoutLegacyFullName(store: SavedStore): SavedStore {
  const legacy = findHeadingByLabel(store.headings, LEGACY_FULL_NAME_LABEL);
  if (!legacy) {
    return { ...store, version: 3 };
  }
  const profiles = store.profiles.map((profile) => {
    const { [legacy.id]: _removed, ...values } = profile.values;
    return { ...profile, values };
  });
  return { ...store, version: 3, headings: store.headings.filter((h) => h.id !== legacy.id), profiles };
}

// dd/mm/yyyy, the format of Italian forms.
export function todayText(now = new Date()): string {
  return new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
}

// What the fill review proposes to add to the profile:
// new fields (with the value typed by the user) and missing values.
export interface ProfileUpdates {
  newHeadings: { label: string; description: string; value: string }[];
  values: { headingId: string; value: string }[];
}

export function hasProfileUpdates(updates: ProfileUpdates): boolean {
  return updates.newHeadings.length > 0 || updates.values.length > 0;
}

function findHeadingByLabel(headings: Heading[], label: string): Heading | undefined {
  const wanted = label.trim().toLocaleLowerCase("it");
  return headings.find((h) => h.label.trim().toLocaleLowerCase("it") === wanted);
}

// New store with the updates applied to the given profile. A "new" field
// that already exists with the same name is not duplicated: only its value
// is received, and only if the profile lacks it (no overwriting without asking).
export function withProfileUpdates(current: ProfileStore, profileId: string, updates: ProfileUpdates): ProfileStore {
  const next = structuredClone(current);
  const profile = next.profiles.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error("Il profilo da aggiornare non esiste più.");
  }
  const setIfMissing = (heading: Heading, value: string) => {
    if (!heading.automatic && !profile.values[heading.id]) {
      profile.values[heading.id] = value;
    }
  };
  for (const { label, description, value } of updates.newHeadings) {
    let heading = findHeadingByLabel(next.headings, label);
    if (!heading) {
      heading = { id: crypto.randomUUID(), label: label.trim(), description: description.trim() };
      next.headings.push(heading);
    }
    setIfMissing(heading, value);
  }
  for (const { headingId, value } of updates.values) {
    const heading = next.headings.find((h) => h.id === headingId);
    if (heading) {
      setIfMissing(heading, value);
    }
  }
  return next;
}

const MAX_SUGGESTED_LABEL = 40;
const CONTEXT_PREFIX = /^(a sinistra|sopra|sotto):\s*/i;
// "iscritto all'albo n.", "tessera nr.": the trailing abbreviation of "numero"
// (number) is the value's placeholder, not part of the name.
const TRAILING_NUMBER_ABBREVIATION = /\s+(n|nr|num|n°)\.?$/i;
// Meaningless technical names generated by form editors.
const GENERIC_FIELD_NAME = /^(text|testo|campo|field|untitled)[\s_.-]*\d*$/i;

// Name proposed for a new profile field, from the text the form prints
// next to the field: "a sinistra: Numero di tessera:" → "Numero di
// tessera". If it is long the last words, closest to the field, are kept.
export function suggestHeadingLabel(field: Pick<FormFieldInfo, "tooltip" | "label" | "fieldName">): string {
  const fieldName = GENERIC_FIELD_NAME.test(field.fieldName) ? "" : field.fieldName;
  const source = (field.tooltip || field.label.replace(CONTEXT_PREFIX, "") || fieldName)
    .replace(/[\s:.,;]+$/, "")
    .replace(TRAILING_NUMBER_ABBREVIATION, "")
    .trim();
  let words = source.split(/\s+/).filter(Boolean);
  while (words.length > 1 && words.join(" ").length > MAX_SUGGESTED_LABEL) {
    words = words.slice(1);
  }
  const label = words.join(" ").slice(0, MAX_SUGGESTED_LABEL);
  return label.charAt(0).toLocaleUpperCase("it") + label.slice(1);
}

// Value of a heading for a profile: computed if automatic.
export function headingValue(heading: Heading, profile: Profile): string {
  return heading.automatic === "today" ? todayText() : (profile.values[heading.id] ?? "");
}

function isDateHeading(heading: Heading): boolean {
  return heading.automatic === "today" || /^data\b/i.test(heading.label.trim());
}

// Value of a combined field, composed locally in the given order: space
// between the parts, comma before a date ("Parma, 03/11/2026"). If a part is
// missing the value stays empty: better to ask for it than to write half.
export function combinedValue(parts: Heading[], profile: Profile): { value: string; missing: string[] } {
  const missing = parts.filter((heading) => !headingValue(heading, profile)).map((heading) => heading.label);
  if (missing.length > 0) {
    return { value: "", missing };
  }
  const value = parts.map((heading, index) => separatorBefore(heading, index) + headingValue(heading, profile)).join("");
  return { value, missing };
}

function separatorBefore(heading: Heading, index: number): string {
  if (index === 0) {
    return "";
  }
  return isDateHeading(heading) ? ", " : " ";
}

export function getStore(): ProfileStore {
  return store;
}

export function getActiveProfile(): Profile | null {
  return store.profiles.find((p) => p.id === store.activeProfileId) ?? null;
}

export function onProfilesChanged(listener: () => void): void {
  listeners.add(listener);
}

export async function loadProfiles(): Promise<void> {
  const json = await window.api.loadProfiles();
  store = json ? migrateStore(JSON.parse(json)) : emptyStore();
  listeners.forEach((listener) => listener());
}

// Replaces the whole store and saves it: whoever edits works on a copy
// and confirms at the end, so an "Annulla" (cancel) leaves no half-made changes.
export async function replaceStore(next: ProfileStore): Promise<void> {
  await window.api.saveProfiles(JSON.stringify(next));
  store = next;
  listeners.forEach((listener) => listener());
}

export async function setActiveProfile(id: string | null): Promise<void> {
  await replaceStore({ ...store, activeProfileId: id });
}

export function cloneStore(): ProfileStore {
  return structuredClone(store);
}
