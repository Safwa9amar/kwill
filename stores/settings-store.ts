import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ThemeName } from "@/constants/colors";
import { getDeviceLanguage } from "@/lib/i18n";

type Language = "ar" | "en" | "fr";

export type ToolbarOrientation = "horizontal" | "vertical";

export type WriterEngine = "lexical" | "docx";

interface SettingsState {
  theme: ThemeName;
  language: Language;
  hasCompletedOnboarding: boolean;
  // When TRUE (default) the Lexical Writer streams AI ghost-text completions as the
  // student types (see stores/completion-store). FALSE fully disables the feature —
  // no completion fetches, no ghost. Read by WorkspaceLexicalView (completionEnabled).
  autocompleteEnabled: boolean;
  // Whether the student has ever touched the toggle above.
  //
  // Until they do, the DEFAULT is decided by their plan rather than by this
  // flag — autocomplete fires on every typing pause without being asked for,
  // and the free tier's whole monthly AI budget is about 14 DZD, so leaving an
  // unattended feature running inside it is the wrong default. See
  // lib/autocomplete-policy.ts. Once touched, their choice always wins.
  autocompleteTouched: boolean;
  // How the floating block toolbar (the ✦ bubble's expanded tool pill) lays its
  // chips out: "vertical" (default — a narrow side column that leaves the text
  // line unobstructed) or "horizontal" (a wide pill under the block). Read by
  // BlockContextBar + FloatingPill; the keyboard-docked bar is always horizontal.
  toolbarOrientation: ToolbarOrientation;
  // The thesis the app reopens on. The writer is the app's root surface now, so
  // launch has to know which document to paint before any screen has mounted —
  // hence persisted here rather than in the (in-memory) thesis store.
  lastThesisId: string | null;
  // Which surface the workspace mounts as the Writer (spec D12). "lexical" is the
  // shipping editor; "docx" is the docx-editor migration behind Settings →
  // Developer until parity is verified, then the default flips (Phase 5).
  writerEngine: WriterEngine;
  setTheme: (theme: ThemeName) => void;
  setLanguage: (language: Language) => void;
  completeOnboarding: () => void;
  setAutocompleteEnabled: (v: boolean) => void;
  setToolbarOrientation: (v: ToolbarOrientation) => void;
  setLastThesisId: (id: string | null) => void;
  setWriterEngine: (v: WriterEngine) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      // Only ever the value of a FRESH install — persist rehydrates over it for
      // anyone who has been here before. Reading the device rather than hardcoding
      // "fr" is what makes an Arabic phone open in Arabic before the student has
      // chosen anything; the language screen preselects the same value.
      language: getDeviceLanguage(),
      hasCompletedOnboarding: false,
      autocompleteEnabled: true,
      autocompleteTouched: false,
      toolbarOrientation: "vertical",
      lastThesisId: null,
      writerEngine: "lexical",
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      completeOnboarding: () => set({ hasCompletedOnboarding: true }),
      setAutocompleteEnabled: (v) => {
        console.log(`[autocomplete] setting toggled ${v ? "ON" : "OFF"}`);
        // Touching it takes the decision away from the plan default, in both
        // directions — a free user who wants ghost text keeps it.
        set({ autocompleteEnabled: v, autocompleteTouched: true });
      },
      setToolbarOrientation: (v) => set({ toolbarOrientation: v }),
      setLastThesisId: (id) => set({ lastThesisId: id }),
      setWriterEngine: (writerEngine) => set({ writerEngine }),
    }),
    {
      name: "kwill-settings",
      storage: createJSONStorage(() => AsyncStorage),
      // v2: autocompleteEnabled introduced, default ON.
      // v4: the "sync while editing" toggle was removed — the Lexical Writer now
      // always saves to the server on a short pause (the local-first path lost
      // edits). Any persisted syncWhileEditing value is simply ignored.
      // v5: toolbarOrientation introduced, default "horizontal" (the layout every
      // existing user already has).
      // v6: lastThesisId introduced — null means "launch into the empty writer",
      // which is exactly right for an existing user who has never had one stored.
      // v7: the toolbar default flipped to "vertical". Pre-launch, so this RESETS
      // every existing install rather than only fresh ones — v5 wrote "horizontal"
      // to everyone, so honouring the stored value would leave the new default
      // reaching nobody. Anyone who prefers the wide pill re-picks it in Settings.
      // v8: autocompleteTouched introduced. Existing installs are marked TOUCHED
      // — they have been living with autocomplete on, and silently switching it
      // off under them on upgrade would read as the feature breaking.
      version: 8,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<SettingsState>;
        const next = { ...s } as Partial<SettingsState>;
        if (version < 2) next.autocompleteEnabled = s.autocompleteEnabled ?? true;
        if (version < 5) next.toolbarOrientation = s.toolbarOrientation ?? "vertical";
        if (version < 6) next.lastThesisId = s.lastThesisId ?? null;
        if (version < 7) next.toolbarOrientation = "vertical";
        if (version < 8) next.autocompleteTouched = true;
        return next as SettingsState;
      },
    }
  )
);
