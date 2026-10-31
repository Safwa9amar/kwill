// Native half of reading-position persistence on the docx surface (Task 25).
//
// The anchor to land on is decided ONCE per page (a fresh WebView — the first
// mount, or the remount after a crash), synchronously, so it rides the surface's
// first props: the DOM then holds its placeholder until the first landing and
// the student never watches the sheet open at the top and jump. The docx view
// stays mounted across a Preview round-trip (its layer is only hidden), and its
// pages scroll inside the engine's own viewport, so nothing else resets the
// position — unlike the Lexical WebView, which needed a restore on every focus.
//
// Reports are stored per thesis, with the DTO's text for the block (see
// scroll-restore.ts) — but never before the persisted map has rehydrated, or a
// fresh page's top position would be saved over the place we are about to read.

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorScrollStore } from "@/stores/editor-scroll-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import type { DocxScrollAnchor } from "../features/scroll-anchor";
import { anchorToSave, restoreAnchor } from "./scroll-restore";

type Restore = { anchor: DocxScrollAnchor; nonce: number } | null;

const blocksOf = (thesisId: string) => {
  const d = useThesisDocStore.getState().byId[thesisId];
  return d?.available ? d.blocks : undefined;
};

export function useDocxScrollRestore({ thesisId, deepLinkBlock, surfaceKey }: {
  thesisId: string;
  deepLinkBlock?: number | null;
  /** Bumped when the host remounts the WebView; a new page needs a new landing. */
  surfaceKey: number;
}) {
  const nonce = useRef(0);
  // The link that opened this entry, until the student moves on from it.
  const deepLinkRef = useRef<number | null>(deepLinkBlock ?? null);
  const compute = (): Restore => {
    if (!useEditorScrollStore.persist.hasHydrated() && deepLinkRef.current == null) return null;
    const anchor = restoreAnchor({
      saved: useEditorScrollStore.getState().get(thesisId),
      deepLinkBlock: deepLinkRef.current,
      blocks: blocksOf(thesisId),
    });
    return anchor ? { anchor, nonce: ++nonce.current } : null;
  };
  const [scrollRestore, setScrollRestore] = useState<Restore>(compute);

  // A remount (crash recovery) lands on the newest saved position.
  const firstKey = useRef(surfaceKey);
  useEffect(() => {
    if (surfaceKey === firstKey.current) return;
    setScrollRestore(compute());
  }, [surfaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The persisted map rehydrates asynchronously; if the page opened before it
  // did, land once it has.
  useEffect(() => {
    const p = useEditorScrollStore.persist;
    if (p.hasHydrated()) return;
    return p.onFinishHydration(() => { if (deepLinkRef.current == null) setScrollRestore(compute()); });
  }, [thesisId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback(async (a: DocxScrollAnchor) => {
    if (!useEditorScrollStore.persist.hasHydrated()) return;
    // Reporting is held off while a landing settles, so this is the student
    // moving under their own steam: the link has done its job.
    deepLinkRef.current = null;
    useEditorScrollStore.getState().save(thesisId, anchorToSave(a, blocksOf(thesisId)));
  }, [thesisId]);

  const onScrollRestored = useCallback(async () => {}, []);

  return { scrollRestore, onScroll, onScrollRestored };
}
