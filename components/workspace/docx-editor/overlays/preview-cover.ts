// Which blocks the server-path "applying" preview (OverlayLayer) is painted over
// right now — so the pending shimmer (PendingLayer) leaves them alone.
//
// Both fire on the same block: a table proposal's Approve, or a range rewrite the
// engine refused, paints the approved result over the block AND the server echo
// marks that block pending (host/use-docx-structure → markChanged). Two overlays on
// one block read as a glitch; the preview is the better picture (it is the result),
// so the shimmer defers to it.
//
// One source of truth, and it lives HERE, in the DOM: the preview's visibility —
// including its fade on the reload that lands the result — is OverlayLayer's own
// state, which the native stores never see (stores/docx-surface-store lives in the
// other JS context). OverlayLayer publishes; PendingLayer subscribes.
//
// Pure apart from the one React hook: the state is module-level (one surface per
// WebView), and the arithmetic is a plain function tested under node.

import { useSyncExternalStore } from "react";
import { rangeIndices } from "./find-block-element";
import type { ApplyingPreview } from "./types";

/** The body blocks a preview is painted over: its range, or its table. */
export function previewIndices(a: ApplyingPreview | null | undefined): number[] {
  if (!a) return [];
  return a.kind === "range" ? rangeIndices(a.start, a.end) : [a.index];
}

let covered: readonly number[] = [];
const listeners = new Set<() => void>();

export function setPreviewCover(indices: readonly number[]): void {
  if (indices.length === covered.length && indices.every((v, i) => v === covered[i])) return;
  covered = indices;
  for (const l of Array.from(listeners)) l();
}

export function getPreviewCover(): readonly number[] {
  return covered;
}

export function subscribePreviewCover(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The live cover, for a component. Stable reference until it changes. */
export function usePreviewCover(): readonly number[] {
  return useSyncExternalStore(subscribePreviewCover, getPreviewCover, getPreviewCover);
}

/**
 * The pending marks still to paint: `pending` minus what the preview covers.
 *
 * ⚠️ The preview hides on the reload the DOM sees; the pending mark is dropped when
 * the HOST hears of that reload (onReloaded → settle), one bridge round trip later.
 * Releasing the block the instant the preview fades would flash a shimmer in that
 * gap — so a mark that was pending WHILE covered stays `absorbed` until it leaves
 * `pending`. A block marked only after the cover lifted (a new server edit) shimmers
 * as usual.
 */
export function deferToPreview(
  pending: readonly number[],
  cover: readonly number[],
  absorbed: ReadonlySet<number>,
): { shown: number[]; absorbed: Set<number> } {
  const inPending = new Set(pending);
  const hidden = new Set<number>();
  for (const i of absorbed) if (inPending.has(i)) hidden.add(i);
  for (const i of cover) if (inPending.has(i)) hidden.add(i);
  return { shown: pending.filter((i) => !hidden.has(i)), absorbed: hidden };
}
