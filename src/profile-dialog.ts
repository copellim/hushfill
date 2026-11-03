// Gestione profili: elenco, valori per intestazione, firma del profilo e
// intestazioni dei campi (comuni a tutti i profili). Si lavora su una copia
// e si salva tutto insieme con "Salva".
import { askForSignature } from "./signature-dialog";
import { cloneStore, headingValue, replaceStore, type Profile, type ProfileStore } from "./profiles";

const dialog = document.querySelector<HTMLDialogElement>("#profile-dialog")!;
const profileList = document.querySelector<HTMLUListElement>("#profile-list")!;
const editor = document.querySelector<HTMLDivElement>("#profile-editor")!;
const noProfiles = document.querySelector<HTMLParagraphElement>("#profile-none")!;
const nameInput = document.querySelector<HTMLInputElement>("#profile-name")!;
const valuesBox = document.querySelector<HTMLDivElement>("#profile-values")!;
const signatureImg = document.querySelector<HTMLImageElement>("#profile-signature-img")!;
const signatureSet = document.querySelector<HTMLButtonElement>("#profile-signature-set")!;
const signatureRemove = document.querySelector<HTMLButtonElement>("#profile-signature-remove")!;
const headingList = document.querySelector<HTMLDivElement>("#heading-list")!;
const errorBox = document.querySelector<HTMLParagraphElement>("#profile-error")!;

let draft: ProfileStore = cloneStore();
let selectedId: string | null = null;

function selectedProfile(): Profile | null {
  return draft.profiles.find((p) => p.id === selectedId) ?? null;
}

function switchTab(tab: string): void {
  dialog.querySelectorAll<HTMLButtonElement>("[data-ptab]").forEach((b) => b.classList.toggle("active", b.dataset.ptab === tab));
  dialog.querySelectorAll<HTMLElement>("[data-ppanel]").forEach((p) => (p.hidden = p.dataset.ppanel !== tab));
  if (tab === "profiles") {
    renderProfiles();
  } else {
    renderHeadings();
  }
}

function renderProfileList(): void {
  profileList.replaceChildren(
    ...draft.profiles.map((profile) => {
      const item = document.createElement("li");
      item.textContent = profile.name || "(senza nome)";
      item.classList.toggle("selected", profile.id === selectedId);
      if (profile.id === draft.activeProfileId) {
        item.title = "Profilo attivo";
        item.classList.add("active");
      }
      item.addEventListener("click", () => {
        selectedId = profile.id;
        renderProfiles();
      });
      return item;
    }),
  );
}

function renderProfiles(): void {
  renderProfileList();
  const profile = selectedProfile();
  editor.hidden = profile === null;
  noProfiles.hidden = profile !== null;
  if (!profile) {
    return;
  }
  nameInput.value = profile.name;
  valuesBox.replaceChildren(
    ...draft.headings.map((heading) => {
      const label = document.createElement("label");
      label.textContent = heading.label;
      label.title = heading.description;
      const input = document.createElement("input");
      input.type = "text";
      input.value = headingValue(heading, profile);
      input.placeholder = heading.description;
      if (heading.automatic) {
        // Calcolata a ogni compilazione: qui si mostra, non si salva.
        input.readOnly = true;
        input.title = "Automatica: la data del giorno in cui compili";
      } else {
        input.addEventListener("input", () => {
          profile.values[heading.id] = input.value;
        });
      }
      label.append(input);
      return label;
    }),
  );
  signatureImg.hidden = profile.signature === null;
  signatureImg.src = profile.signature?.dataUrl ?? "";
  signatureSet.textContent = profile.signature ? "Cambia firma" : "Crea firma";
  signatureRemove.hidden = profile.signature === null;
}

function renderHeadings(): void {
  headingList.replaceChildren(
    ...draft.headings.map((heading, index) => {
      const row = document.createElement("div");
      row.className = "heading-row";
      const label = document.createElement("input");
      label.value = heading.label;
      label.placeholder = "Intestazione (es. Codice fiscale)";
      label.addEventListener("input", () => (heading.label = label.value));
      const description = document.createElement("input");
      description.value = heading.description;
      description.placeholder = "Descrizione facoltativa, aiuta il riconoscimento";
      description.addEventListener("input", () => (heading.description = description.value));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Elimina";
      remove.title = "Elimina il campo e i suoi valori in tutti i profili";
      remove.addEventListener("click", () => {
        draft.headings.splice(index, 1);
        draft.profiles.forEach((p) => delete p.values[heading.id]);
        renderHeadings();
      });
      if (heading.automatic) {
        description.title = "Campo automatico: vale sempre la data di oggi, gg/mm/aaaa";
      }
      row.append(label, description, remove);
      return row;
    }),
  );
}

function createProfile(source: Profile | null): void {
  const profile: Profile = source
    ? { ...structuredClone(source), id: crypto.randomUUID(), name: `${source.name} (copia)` }
    : { id: crypto.randomUUID(), name: "Nuovo profilo", values: {}, signature: null };
  draft.profiles.push(profile);
  selectedId = profile.id;
  draft.activeProfileId ??= profile.id;
  renderProfiles();
  nameInput.select();
}

async function deleteSelectedProfile(): Promise<void> {
  const profile = selectedProfile();
  if (!profile) {
    return;
  }
  const confirmed = await window.api.confirm(`Eliminare il profilo «${profile.name}»?`, "I suoi dati e la sua firma verranno cancellati al salvataggio.", "Elimina");
  if (!confirmed) {
    return;
  }
  draft.profiles = draft.profiles.filter((p) => p.id !== profile.id);
  if (draft.activeProfileId === profile.id) {
    draft.activeProfileId = draft.profiles[0]?.id ?? null;
  }
  selectedId = draft.profiles[0]?.id ?? null;
  renderProfiles();
}

async function changeSignature(): Promise<void> {
  const profile = selectedProfile();
  if (!profile) {
    return;
  }
  const result = await askForSignature({ profileName: null, okLabel: "Usa questa firma" });
  if (result) {
    profile.signature = result.signature;
    renderProfiles();
  }
}

function validationError(): string | null {
  if (draft.headings.some((h) => h.label.trim() === "")) {
    return "Ogni campo del profilo deve avere un'intestazione.";
  }
  const labels = draft.headings.map((h) => h.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) {
    return "Due campi del profilo hanno la stessa intestazione.";
  }
  return null;
}

async function save(): Promise<void> {
  const error = validationError();
  errorBox.textContent = error ?? "";
  if (error) {
    return;
  }
  draft.headings = draft.headings.map((h) => ({ ...h, label: h.label.trim(), description: h.description.trim() }));
  try {
    await replaceStore(draft);
    dialog.close();
  } catch (saveError) {
    errorBox.textContent = saveError instanceof Error ? saveError.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(saveError);
  }
}

export function initProfileDialog(): void {
  dialog.querySelectorAll<HTMLButtonElement>("[data-ptab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.ptab!)));
  nameInput.addEventListener("input", () => {
    const profile = selectedProfile();
    if (profile) {
      profile.name = nameInput.value;
      renderProfileList();
    }
  });
  document.querySelector("#profile-new")!.addEventListener("click", () => createProfile(null));
  document.querySelector("#profile-duplicate")!.addEventListener("click", () => createProfile(selectedProfile()));
  document.querySelector("#profile-delete")!.addEventListener("click", () => void deleteSelectedProfile());
  document.querySelector("#profile-set-active")!.addEventListener("click", () => {
    draft.activeProfileId = selectedId;
    renderProfileList();
  });
  signatureSet.addEventListener("click", () => void changeSignature());
  signatureRemove.addEventListener("click", () => {
    const profile = selectedProfile();
    if (profile) {
      profile.signature = null;
      renderProfiles();
    }
  });
  document.querySelector("#heading-add")!.addEventListener("click", () => {
    draft.headings.push({ id: crypto.randomUUID(), label: "", description: "" });
    renderHeadings();
    headingList.querySelector<HTMLInputElement>(".heading-row:last-child input")?.focus();
  });
  document.querySelector("#profile-cancel")!.addEventListener("click", () => dialog.close());
  document.querySelector("#profile-save")!.addEventListener("click", () => void save());
}

export function openProfileDialog(): void {
  draft = cloneStore();
  selectedId = draft.activeProfileId ?? draft.profiles[0]?.id ?? null;
  errorBox.textContent = "";
  switchTab("profiles");
  dialog.showModal();
}
