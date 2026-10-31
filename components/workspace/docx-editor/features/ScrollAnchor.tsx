// Reading-position persistence on the docx surface (Task 25) — the DOM half.
// Rendered inside <DocxEditor> beside the Bridge.
//
// Reports the anchor (features/scroll-anchor.ts) on a 700ms poll plus throttled
// scroll events — the same cadence ScrollSyncPlugin uses on the Lexical surface,
// for the same reason: scroll events from an inner scroller are not something to
// trust alone in a WebView, and the poll is cheap when nothing moved.
//
// Restores on `restore.nonce`: find the block by text (filtered by index) →
// `scrollToBlock` → re-apply the delta every frame until the block holds still,
// because the pages keep re-laying out as faces land and the fit zoom settles.
// Reporting is held off meanwhile, so the top-of-document position a fresh page
// starts at is never saved over the place we are about to return to.
//
// `onBusy` lets the host page keep its placeholder up until the first landing,
// so the student sees the sheet appear where they left it — not appear at the
// top and jump.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core/contracts/editor";
import { findBlockMatch } from "../bridge/find-block";
import { WILL_LOAD_EVENT, anchorKey, anchorQueries, correction, pickAnchor, type DocxScrollAnchor, type PaintedPiece } from "./scroll-anchor";

const POLL_MS = 700;
const THROTTLE_MS = 200;
// How long to keep searching for the text while the engine is still parsing.
const FIND_MS = 4000;
// The placeholder waits at most this long for a landing.
const BUSY_CAP_MS = 2500;
// Past the host page's 8s reveal cap, so a slow face cannot re-lay the pages out
// after the landing gave up.
const HARD_STOP_MS = 9000;
// Frames the block must hold still: 3 to lift the placeholder, 8 — once the sheet
// is visible — to finish. Faces still landing behind the placeholder move the
// block again, so the landing keeps correcting until the reveal.
const SETTLED_TO_SHOW = 3;
const SETTLED_TO_FINISH = 8;

const VIEWPORT = ".docx-editor-one-surface__viewport";


function scrollParent(el: Element | null): HTMLElement | null {
  for (let e = el?.parentElement ?? null; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return null;
}

/** The element that scrolls the pages: the engine's viewport, else whatever
 *  scrollable ancestor the pages have (a class rename must not kill this). */
function viewportEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(VIEWPORT) ?? scrollParent(document.querySelector(".docx-pages"));
}

/** Every painted element that carries a paragraph id, outermost per id. */
function collectPieces(vp: HTMLElement): PaintedPiece[] {
  const out: PaintedPiece[] = [];
  for (const el of Array.from(vp.querySelectorAll<HTMLElement>("[data-paragraph-id]"))) {
    const id = el.getAttribute("data-paragraph-id");
    if (!id) continue;
    if (el.parentElement?.closest("[data-paragraph-id]")?.getAttribute("data-paragraph-id") === id) continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    out.push({ id, top: r.top, bottom: r.bottom, text: el.textContent ?? "" });
  }
  return out;
}

/** Top of a paragraph's first painted piece, or null while it is not painted. */
function blockTop(vp: HTMLElement, id: string): number | null {
  let top: number | null = null;
  const sel = `[data-paragraph-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')}"]`;
  for (const el of Array.from(vp.querySelectorAll<HTMLElement>(sel))) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) top = top == null ? r.top : Math.min(top, r.top);
  }
  return top;
}

export function ScrollAnchor(p: {
  editorRef: RefObject<DocxEditorRef | null>;
  restore: { anchor: DocxScrollAnchor; nonce: number } | null | undefined;
  onScroll: (a: DocxScrollAnchor) => void;
  onRestored: () => void;
  onBusy: (busy: boolean) => void;
  /** The host page has revealed the sheet (its placeholder is down). */
  revealed: boolean;
}) {
  const latest = useRef(p);
  latest.current = p;
  // Off until the first restore settles — or immediately, when there is none.
  const armed = useRef(!p.restore);
  // A restore present at mount is meant for THIS page, so nothing is "seen" yet.
  // NaN: a host nonce is a number ≥ 0 and a reload's is negative — neither equals it.
  const seen = useRef(Number.NaN);
  // The restore to run: the host's (open time), or the one a load() asked for.
  const [active, setActive] = useState(p.restore ?? null);
  useEffect(() => {
    if (p.restore && p.restore.nonce !== active?.nonce) setActive(p.restore);
  }, [p.restore?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const localSeq = useRef(0);
  const cancel = useRef<(() => void) | null>(null);
  const forceMeasure = useRef(false);

  const editorOf = () => latest.current.editorRef.current?.getEditor() ?? null;
  const zoom = () => {
    const z = editorOf()?.getZoom();
    return typeof z === "number" && z > 0 ? z : 1;
  };

  // ── report ──
  useEffect(() => {
    let lastKey = "";
    let lastTop = -1;
    let lastHeight = -1;
    const emit = () => {
      if (!armed.current) return;
      const vp = viewportEl();
      if (!vp) return;
      if (!forceMeasure.current && vp.scrollTop === lastTop && vp.scrollHeight === lastHeight) return;
      forceMeasure.current = false;
      lastTop = vp.scrollTop;
      lastHeight = vp.scrollHeight;
      const a = pickAnchor(collectPieces(vp), vp.getBoundingClientRect().top, zoom(), vp.scrollTop);
      if (!a) return;
      const k = anchorKey(a);
      if (k === lastKey) return;
      lastKey = k;
      latest.current.onScroll(a);
    };
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const onScrollEvt = () => {
      if (throttle) return;
      throttle = setTimeout(() => { throttle = null; emit(); }, THROTTLE_MS);
    };
    // Capture on the document: an inner scroller's scroll event does not bubble,
    // but it does pass the document on its way down. Passive — reporting never
    // cancels a scroll.
    const opts = { passive: true, capture: true } as const;
    document.addEventListener("scroll", onScrollEvt, opts);
    const poll = setInterval(emit, POLL_MS);
    return () => {
      if (throttle) clearTimeout(throttle);
      clearInterval(poll);
      document.removeEventListener("scroll", onScrollEvt, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── a load() is coming: remember where the student is reading ──
  useEffect(() => {
    const onWillLoad = () => {
      const vp = viewportEl();
      if (!vp || vp.scrollTop <= 0) return;
      const a = pickAnchor(collectPieces(vp), vp.getBoundingClientRect().top, zoom(), vp.scrollTop);
      if (a) setActive({ anchor: a, nonce: -(++localSeq.current) });
    };
    window.addEventListener(WILL_LOAD_EVENT, onWillLoad);
    return () => window.removeEventListener(WILL_LOAD_EVENT, onWillLoad);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── restore ──
  useEffect(() => {
    const r = active;
    if (!r || r.nonce === seen.current) return;
    seen.current = r.nonce;
    cancel.current?.();
    armed.current = false;
    latest.current.onBusy(true);

    const t0 = Date.now();
    const queries = anchorQueries(r.anchor.text);
    let match: TextMatch | null = null;
    let raf = 0;
    let settledFrames = 0;
    let unpainted = 0;
    let done = false;
    let busy = true;
    const release = () => { if (busy) { busy = false; latest.current.onBusy(false); } };
    const finish = (notify: boolean) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(hard);
      clearTimeout(busyCap);
      document.removeEventListener("touchstart", userTook, true);
      document.removeEventListener("wheel", userTook, true);
      if (cancel.current === stop) cancel.current = null;
      armed.current = true;
      forceMeasure.current = true;
      release();
      if (notify) latest.current.onRestored();
    };
    const stop = () => finish(false);
    cancel.current = stop;

    const step = () => {
      if (done) return;
      const editor = editorOf();
      const vp = viewportEl();
      if (editor && vp) {
        if (!match) {
          for (const q of queries) { match = findBlockMatch(editor, r.anchor.index, q); if (match) break; }
          if (match) {
            editor.scrollToBlock(match.blockId);
          } else if (Date.now() - t0 > FIND_MS || queries.length === 0) {
            // Nothing to search for, or it is gone: the raw offset is all that is left.
            if (r.anchor.y > 0) vp.scrollTop = r.anchor.y;
            finish(true);
            return;
          }
        } else {
          const top = blockTop(vp, match.blockId);
          if (top == null) {
            // Not painted (yet): scrollToBlock has put it in view; if its pieces
            // never turn up under that id, that landing is the best we get.
            if (++unpainted > 30) { finish(true); return; }
            if (unpainted % 10 === 0) editor.scrollToBlock(match.blockId);
          } else {
            const before = vp.scrollTop;
            const c = correction(top, vp.getBoundingClientRect().top, r.anchor.delta, zoom());
            if (Math.abs(c) >= 1) vp.scrollTop = before + c;
            // Still, or clamped at an end of the document: either way, landed.
            settledFrames = Math.abs(vp.scrollTop - before) < 0.5 ? settledFrames + 1 : 0;
            if (settledFrames >= SETTLED_TO_SHOW) release();
            if (settledFrames >= SETTLED_TO_FINISH && latest.current.revealed) { finish(true); return; }
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // The student scrolling ends it — never fight their finger.
    const userTook = () => finish(true);
    document.addEventListener("touchstart", userTook, { passive: true, capture: true });
    document.addEventListener("wheel", userTook, { passive: true, capture: true });
    const hard = setTimeout(() => finish(true), HARD_STOP_MS);
    const busyCap = setTimeout(release, BUSY_CAP_MS);
    return () => finish(false);
  }, [active?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
