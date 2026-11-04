import { create } from "zustand";

// The student's typed note and dictation language for the one project open. Shared by the sheet (which writes it) and the CTA (which sends
// it), since gorhom renders those in two trees. A value belongs to the project it was typed for: changing the project drops the other one.

export interface NoteDraft {
  projectId: string | null;
  text: string | null;
  lang: string | null;
  setText(projectId: string, text: string): void;
  setLang(projectId: string, lang: string): void;
}

export const useNoteDraft = create<NoteDraft>()((set) => ({
  projectId: null,
  text: null,
  lang: null,
  // A value for another project starts a clean draft: the old project's text must never be read for this one.
  setText: (projectId, text) => set((s) => (s.projectId === projectId ? { text } : { projectId, text, lang: null })),
  setLang: (projectId, lang) => set((s) => (s.projectId === projectId ? { lang } : { projectId, lang, text: null })),
}));
