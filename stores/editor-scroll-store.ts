import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Remembers WHERE in the Writer (Lexical or docx) the user was, PER thesis, so re-entering
// the editor lands there instead of at the top. The Writer scrolls inside its DOM
// WebView; leaving the workspace (back) unmounts that WebView and a Preview
// round-trip re-keys it — both reset it to the top.
//
// We store a BLOCK ANCHOR, not a raw pixel offset: figures load asynchronously and
// reflow the page after a fresh mount, so a pixel offset would land in the wrong
// place. Anchoring to "the block that was at the top of the viewport + how far it
// was scrolled past" survives that reflow (we scroll that block back to the same
// spot once it — and the images above it — have laid out). `y` is a raw fallback.
//
// PERSISTED to AsyncStorage so the position also survives an app reload/quit (not
// just a session). Kept OUTSIDE workspace-store on purpose: that store is reset()
// on every workspace-leave, which would wipe the value we need on the next entry.
export interface ScrollAnchor {
  y: number; // raw scroll offset (fallback if the anchor block can't be resolved)
  index: number; // block index of the first block at/under the viewport top (-1 = none)
  // px of that block scrolled above the viewport top. Lexical: >= 0. The docx
  // surface may store a NEGATIVE delta (it anchors on the first block with text,
  // which can start below the top) and stores it unscaled by zoom.
  delta: number;
  // docx surface only: the first ≤80 chars of the anchor block's text. Indices
  // shift (spec D7), so the block is re-found by TEXT, filtered by index. Absent
  // on anchors the Lexical surface saved; the docx host fills it from the DTO.
  text?: string;
}

// Cap the map so it can't grow unbounded across many theses over time. Records keep
// string keys in insertion order, so the oldest entries drop first.
const MAX_ENTRIES = 60;

interface EditorScrollState {
  byThesis: Record<string, ScrollAnchor>;
  save: (thesisId: string, anchor: ScrollAnchor) => void;
  get: (thesisId: string) => ScrollAnchor | null;
}

export const useEditorScrollStore = create<EditorScrollState>()(
  persist(
    (set, get) => ({
      byThesis: {},
      save: (thesisId, anchor) => {
        if (!thesisId) return;
        const cur = get().byThesis;
        // Re-insert so the freshest thesis is last (survives pruning longest).
        const next: Record<string, ScrollAnchor> = { ...cur };
        delete next[thesisId];
        next[thesisId] = anchor;
        const keys = Object.keys(next);
        if (keys.length > MAX_ENTRIES) {
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[k];
        }
        set({ byThesis: next });
      },
      get: (thesisId) => get().byThesis[thesisId] ?? null,
    }),
    {
      name: "kwill-editor-scroll",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the map is persisted; the methods come from the initializer on rehydrate.
      partialize: (s) => ({ byThesis: s.byThesis }),
      version: 1,
    },
  ),
);
