import { create } from "zustand";
import type { ImageTransformAction, SearchTarget } from "@/components/workspace/docx-editor/bridge/surface-types";

// What the docx Writer surface lets native tools do to the ENGINE directly, so the
// student sees an edit on the page the moment they tap — not after a server round
// trip and a reload (the "visual first" rule). WorkspaceDocxView registers each
// hook while it is mounted; under Lexical, or with no workspace open, they are
// null and every caller falls back to the path it had before.
//
// It also carries the "pending" marks: blocks a SERVER-side edit is about to change
// (a chart patch, a background removal, a crop, a sheet's apply). The surface paints
// a shimmer on them from the tap until the reload lands, so the page never looks
// unchanged after a tap.
//
// ⚠️ Kept apart from lexical-editor-store on purpose: that store is the shared
// command/state contract and is renamed in Phase 5; these are docx-only extras.

export type PendingSide = "header" | "footer";

/** The app's rotate/flip vocabulary (lib/thesis-image-edit) → the engine's. */
export function engineImageAction(op: "rotateRight" | "rotateLeft" | "flipH" | "flipV"): ImageTransformAction {
  return op === "rotateRight" ? "rotateCW" : op === "rotateLeft" ? "rotateCCW" : op;
}

type PendingEntry = {
  id: number;
  index: number;
  /** The server call has returned; the mark now waits for the reload that shows it. */
  awaitingReload: boolean;
};

interface DocxSurfaceState {
  /** Rotate/flip a picture in place. Returns false when the surface can't (not
   *  mounted) — the caller then takes its byte-rewriting server path. */
  imageTransform: ((index: number, action: ImageTransformAction) => boolean) | null;
  /** Replace search hits in the engine (one undo step for "all"). Returns false
   *  when the surface isn't mounted. */
  searchReplace: ((items: SearchTarget[], text: string) => boolean) | null;
  registerImageTransform: (f: DocxSurfaceState["imageTransform"]) => void;
  registerSearchReplace: (f: DocxSurfaceState["searchReplace"]) => void;

  /** Block indices with a server edit in flight (sorted, deduped). Stable array
   *  reference until it actually changes — safe to select directly. */
  pending: number[];
  /** Header/footer edges with a server edit in flight. */
  pendingChrome: PendingSide[];
  /**
   * Mark `index` pending until the returned `end()` — call it once the server call
   * has settled. `end()` keeps the mark until the next reload (the engine still
   * shows the old bytes until then); `end(false)` drops it at once (a failed call,
   * or a surface that already shows the result, like a chart's echoed SVG).
   */
  beginPending: (index: number) => (keepUntilReload?: boolean) => void;
  /** Blocks/edges a server echo changed (diffed by the host) — shimmer until reload. */
  markChanged: (indices: number[], sides: PendingSide[]) => void;
  /** The reload landed: drop every mark that was only waiting for it. */
  settle: () => void;
}

let seq = 0;
// A mark must never outlive a reload that never comes (a failed call that still
// said `end()`, a 304): this caps it.
const MAX_AWAIT_MS = 8000;

let entries: PendingEntry[] = [];
let chromeAwaiting: PendingSide[] = [];

function sameNums(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const useDocxSurfaceStore = create<DocxSurfaceState>((set, get) => {
  const publish = () => {
    const next = Array.from(new Set(entries.map((e) => e.index))).sort((a, b) => a - b);
    const chrome = Array.from(new Set(chromeAwaiting)).sort() as PendingSide[];
    const s = get();
    const patch: Partial<DocxSurfaceState> = {};
    if (!sameNums(s.pending, next)) patch.pending = next;
    if (s.pendingChrome.join() !== chrome.join()) patch.pendingChrome = chrome;
    if (Object.keys(patch).length) set(patch);
  };
  const awaitLater = (ids: number[]) => {
    setTimeout(() => {
      const before = entries.length;
      entries = entries.filter((e) => !(ids.includes(e.id) && e.awaitingReload));
      if (entries.length !== before) publish();
    }, MAX_AWAIT_MS);
  };
  return {
    imageTransform: null,
    searchReplace: null,
    registerImageTransform: (f) => set({ imageTransform: f }),
    registerSearchReplace: (f) => set({ searchReplace: f }),

    pending: [],
    pendingChrome: [],
    beginPending: (index) => {
      // No docx surface (Lexical, a preview): nothing would paint the mark, and
      // nothing would ever settle it. The surface registers its hooks on mount.
      if (!get().imageTransform) return () => {};
      const id = ++seq;
      entries = [...entries, { id, index, awaitingReload: false }];
      publish();
      let ended = false;
      return (keepUntilReload = true) => {
        if (ended) return;
        ended = true;
        entries = keepUntilReload
          ? entries.map((e) => (e.id === id ? { ...e, awaitingReload: true } : e))
          : entries.filter((e) => e.id !== id);
        publish();
        if (keepUntilReload) awaitLater([id]);
      };
    },
    markChanged: (indices, sides) => {
      if (!indices.length && !sides.length) return;
      const ids: number[] = [];
      entries = [
        ...entries,
        ...indices.map((index) => {
          const id = ++seq;
          ids.push(id);
          return { id, index, awaitingReload: true };
        }),
      ];
      chromeAwaiting = [...chromeAwaiting, ...sides];
      publish();
      awaitLater(ids);
      if (sides.length) {
        setTimeout(() => { chromeAwaiting = []; publish(); }, MAX_AWAIT_MS);
      }
    },
    settle: () => {
      entries = entries.filter((e) => !e.awaitingReload);
      chromeAwaiting = [];
      publish();
    },
  };
});
