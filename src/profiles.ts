// Profili: intestazioni dei campi condivise e definite dall'utente, valori
// e firma per profilo. Tutto cifrato su disco dal processo principale.
import type { FormFieldInfo, Heading } from "./jev";
import type { SignatureImage } from "./signature-dialog";

export interface Profile {
  id: string;
  name: string;
  values: Record<string, string>; // id intestazione -> valore
  signature: SignatureImage | null;
}

export interface ProfileStore {
  // 2: aggiunta l'intestazione automatica "Data di oggi".
  // 3: tolta "Nome e cognome", ora composta da Nome e Cognome.
  // 4: descrizioni predefinite di "Data di oggi" e "Comune di residenza".
  version: 4;
  headings: Heading[];
  profiles: Profile[];
  activeProfileId: string | null;
}

// Le descrizioni finiscono nelle opzioni mandate a Jev: non devono legare la
// data da sola a «Luogo e data», che è un campo combinato.
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

// Etichetta del vecchio campo predefinito, tolto nella versione 3.
const LEGACY_FULL_NAME_LABEL = "Nome e cognome";

type SavedStore = { version: number } & Omit<ProfileStore, "version">;

// Ogni passo gira una volta sola: se poi l'utente riaggiunge o elimina un
// campo, il numero di versione impedisce di rifarlo.
export function migrateStore(saved: SavedStore): ProfileStore {
  let store = saved;
  if (store.version < 2) {
    // I profili salvati prima della data automatica la ricevono.
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

// Descrizioni predefinite cambiate nella versione 4: si aggiornano solo se
// l'utente non le ha toccate.
const UPDATED_DESCRIPTIONS: { label: string; previous: string; current: string }[] = [
  { label: TODAY_HEADING.label, previous: "Data della compilazione, ad esempio in «Luogo e data» o accanto alla firma", current: TODAY_HEADING.description },
  { label: "Comune di residenza", previous: "", current: CITY_DESCRIPTION },
];

function withCurrentDefaultDescription(heading: Heading): Heading {
  const update = UPDATED_DESCRIPTIONS.find((u) => u.label === heading.label && u.previous === heading.description);
  return update ? { ...heading, description: update.current } : heading;
}

// Il nome completo ora si compone da Nome e Cognome (campo combinato): il
// vecchio campo si toglie, con i suoi valori, dalle intestazioni e dai profili.
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

// gg/mm/aaaa, il formato dei moduli italiani.
export function todayText(now = new Date()): string {
  return new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
}

// Cosa la revisione della compilazione propone di aggiungere al profilo:
// campi nuovi (con il valore scritto dall'utente) e valori mancanti.
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

// Nuovo store con gli aggiornamenti applicati al profilo indicato. Un campo
// "nuovo" che esiste già con lo stesso nome non si duplica: ne riceve solo il
// valore, e solo se nel profilo manca (non si sovrascrive senza chiedere).
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
// "iscritto all'albo n.", "tessera nr.": l'abbreviazione di "numero" in coda
// è il segnaposto del valore, non parte del nome.
const TRAILING_NUMBER_ABBREVIATION = /\s+(n|nr|num|n°)\.?$/i;
// Nomi tecnici senza significato generati dagli editor di moduli.
const GENERIC_FIELD_NAME = /^(text|testo|campo|field|untitled)[\s_.-]*\d*$/i;

// Nome proposto per un nuovo campo del profilo, dal testo che il modulo
// stampa accanto al campo: "a sinistra: Numero di tessera:" → "Numero di
// tessera". Se è lungo si tengono le ultime parole, le più vicine al campo.
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

// Valore di un'intestazione per un profilo: calcolato se automatica.
export function headingValue(heading: Heading, profile: Profile): string {
  return heading.automatic === "today" ? todayText() : (profile.values[heading.id] ?? "");
}

function isDateHeading(heading: Heading): boolean {
  return heading.automatic === "today" || /^data\b/i.test(heading.label.trim());
}

// Valore di un campo combinato, composto in locale nell'ordine dato: spazio
// tra le parti, virgola prima di una data ("Parma, 03/11/2026"). Se manca
// una parte il valore resta vuoto: meglio chiederla che scrivere metà.
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

// Sostituisce lo store intero e lo salva: chi modifica lavora su una copia
// e conferma alla fine, così un "Annulla" non lascia mezze modifiche.
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
