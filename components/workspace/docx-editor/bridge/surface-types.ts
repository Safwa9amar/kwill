// Shapes that cross the DOM bridge for the Phase 3 structure features (equation,
// header/footer, charts, pictures, search, slash, paste). TYPES ONLY: imported by
// both the native host and the 'use dom' side, so nothing here may carry a value.

/** The engine's own picture transforms (`transformImage.action`). */
export type ImageTransformAction = "rotateCW" | "rotateCCW" | "flipH" | "flipV";

/** One native → DOM picture command; `nonce` makes a repeat tap a new command. */
export type ImageCommandInput = { index: number; action: ImageTransformAction; nonce: number };

/**
 * One search hit, addressed the way BOTH sides can agree on it.
 *
 * The panel's matcher runs over the DTO with Arabic folding (alef/ya/ta-marbuta,
 * tashkeel), which the engine's `findMatches` cannot do — so the hit travels as the
 * LITERAL text it covers in the document, plus where it sits: the DOM searches that
 * literal and keeps the engine match in `blockIndex` nearest `start` (paragraphs) or
 * the `ordinal`-th one (table cells, whose offsets the flattened DTO text cannot give).
 */
export type SearchTarget = { blockIndex: number; literal: string; start: number; ordinal: number };

export type SearchFocusInput = SearchTarget & { nonce: number };
export type SearchReplaceInput = { items: SearchTarget[]; text: string; nonce: number };
export type SearchReplaceResult = { nonce: number; replaced: number; missed: number };

/** A chart the server rebuilt as SVG, keyed by its DTO block index. */
export type ChartOverlayInput = { index: number; svg: string };

/** Same payload as Lexical's SlashPlugin → `onInsertTrigger`. */
export type InsertTrigger = { active: boolean; index: number; query: string };
