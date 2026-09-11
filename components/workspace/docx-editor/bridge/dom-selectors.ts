// The engine stamps painted elements with their node id (`/word/document.xml#…`,
// see lib/docx-block-id.ts). Which ATTRIBUTE carries it differs per node kind
// (`data-drawing-node-id` on drawings; paragraphs use their own) and is not part
// of the typed API, so nothing here names an attribute: an element "has a node
// id" when ANY attribute value starts with the body part prefix. A block-level id
// has exactly three segments; runs and text nodes go deeper.
//
// Pure enough to run under node: nothing touches `document`/`window` at import
// time, so dom-selectors.test.ts can assert the predicate with no DOM at all.

import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

const BODY_PREFIX = "/word/document.xml#";

export function isBlockLevelId(id: string | null | undefined): boolean {
  return isBodyId(id) && /#\d+\.\d+\.\d+$/.test(id);
}

/** The body node id an element carries, if any. */
export function nodeIdOf(el: Element): string | null {
  for (const a of Array.from(el.attributes)) if (a.value.startsWith(BODY_PREFIX)) return a.value;
  return null;
}

/** The nearest painted BLOCK (paragraph / table) element at or above `node`. */
export function blockElementOf(node: Node | null): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const id = nodeIdOf(el);
    if (id && isBlockLevelId(id)) return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

export type SpannedBlock = { index: number; text: string; el: HTMLElement };

/**
 * Every painted body block the current browser selection spans, in document
 * order, plus which one holds the FOCUS end. Mirrors what read-state.ts reported
 * for Lexical (`blocks` + `index`/`text`) so the native multi-block selection
 * keeps working unchanged. Pages the engine has virtualised out are not in the
 * DOM and therefore not in this list — a limitation the host tolerates: a
 * selection that long is an AI "range" ask, and those re-resolve by text.
 */
export function spannedBlocks(sel: Selection | null): { blocks: SpannedBlock[]; focus: SpannedBlock | null } {
  if (!sel || sel.rangeCount === 0) return { blocks: [], focus: null };
  const range = sel.getRangeAt(0);
  const first = blockElementOf(range.startContainer);
  const last = blockElementOf(range.endContainer);
  if (!first) return { blocks: [], focus: null };
  const toBlock = (el: HTMLElement): SpannedBlock | null => {
    const index = blockIndexFromId(nodeIdOf(el));
    return index == null ? null : { index, text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), el };
  };
  const out: SpannedBlock[] = [];
  let el: HTMLElement | null = first;
  while (el) {
    const b = toBlock(el);
    if (b) out.push(b);
    if (el === last || !last) break;
    // Walk forward through the painted siblings between the two ends.
    let next: Element | null = el.nextElementSibling;
    while (next && !isBlockLevelId(nodeIdOf(next))) next = next.nextElementSibling;
    el = next as HTMLElement | null;
  }
  const focusEl = blockElementOf(sel.focusNode);
  const focus = focusEl ? toBlock(focusEl) : (out[0] ?? null);
  return { blocks: out, focus };
}
