// The page answers a tap at once even when the edit must round-trip: an op that
// goes to the server (bridge/op-map.ts says which, and why) marks the painted
// blocks it will change — a pulse while it is in flight, a fade for the ones it
// removes — until the reload that follows repaints them (spec D3), or a timeout.
//
// ⚠️ A class on the ENGINE's painted elements, never a style the engine positions
// by: opacity only. A host-side `direction`/`text-align` on these elements was
// tried for RTL at 2.16 and wrecked word spacing, because the engine places runs
// itself (Phase 1 findings) — do not "preview" a direction change that way.
//
// The engine may repaint an element and drop the class early; it is a hint, not
// state, so nothing depends on it surviving.

import type { Engine } from "./apply-op";
import { locateParagraph } from "./apply-op";
import { blockIndexFromId } from "@/lib/docx-block-id";
import { isBlockLevelId, nodeIdOf } from "./dom-selectors";
import type { PendingMark } from "./op-map";

const STYLE_ID = "kw-pending-style";
const CSS =
  ".kw-busy{animation:kw-pulse 1.1s ease-in-out infinite}" +
  ".kw-removing{opacity:.3;transition:opacity .2s}" +
  "@keyframes kw-pulse{0%,100%{opacity:1}50%{opacity:.4}}";
const TTL_MS = 15000;
const marked = new Map<HTMLElement, string>();

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Every painted body BLOCK element (paragraph / table / drawing host) on the
 *  pages the engine has materialised. Virtualised pages are not in the DOM, and a
 *  block off screen needs no mark. */
function paintedBlocks(): { el: HTMLElement; id: string }[] {
  const out: { el: HTMLElement; id: string }[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const id = nodeIdOf(n as Element);
    if (id && isBlockLevelId(id)) out.push({ el: n as HTMLElement, id });
  }
  return out;
}

export function markPending(e: Engine | null, mark: PendingMark): void {
  try {
    ensureStyle();
    const cls = mark.look === "removing" ? "kw-removing" : "kw-busy";
    const painted = paintedBlocks();
    const hit = new Set<HTMLElement>();
    for (const ref of mark.at) {
      // Prefer the engine's own answer for a paragraph it can find by text; fall
      // back to the id's index (positional as of the load — good enough for a hint).
      const id = e && ref.text ? locateParagraph(e, ref, new Map())?.id ?? null : null;
      for (const p of painted) {
        if (id ? p.id === id : blockIndexFromId(p.id) === ref.index) hit.add(p.el);
      }
    }
    for (const el of hit) {
      el.classList.add(cls);
      marked.set(el, cls);
    }
    setTimeout(() => {
      for (const el of hit) {
        if (marked.get(el) !== cls) continue;
        el.classList.remove(cls);
        marked.delete(el);
      }
    }, TTL_MS);
  } catch {
    // A hint that could not be painted is not an error worth surfacing.
  }
}

/** Drop every mark — a document was (re)loaded, so whatever was in flight has
 *  landed or been abandoned; the timeout is only the backstop. */
export function clearPending(): void {
  for (const [el, cls] of marked) el.classList.remove(cls);
  marked.clear();
}
