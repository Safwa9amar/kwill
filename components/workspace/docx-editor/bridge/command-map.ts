// The native chrome → engine direction of the bridge, as a PURE translation.
// The envelope is the one lexical-editor-store dispatches today (BlockContextBar,
// FormatPanel, ListToolbar, AIDock, the ribbon…); keeping it means none of those
// callers change in Phase 1. Executing the actions needs a live editor and the
// React hooks that own paragraph style / format — that is Bridge.tsx, plus
// bridge/command-actions.ts for the kinds that need the paginated surface.
//
// Things worth knowing about the engine's vocabulary:
//  • Slots (`text.bold`, `alignment.left`, `list.bullet`, `history.undo`,
//    `format.clear`) TOGGLE against the current selection. A value that means
//    "make it so" (a colour, a list kind) goes out as SET semantics instead —
//    `marks`, `list` — and is compared against the engine's state before toggling.
//  • Direction is `setParagraphDirection` (engine ≥ 2.33): local, like the rest.
//  • `blockFormat` (the pill's whole-block change) is NOT run from here: the docx
//    host turns it into the `format` op it describes and sends it through
//    `thesis-doc-store.mutate`, which applies it in the engine first (applyOp,
//    bridge/op-map.ts) or on the server when the engine cannot. One path for every
//    student edit, and the block model is patched for the native chrome as well.
//    (It never worked from here anyway: BlockContextBar sends `{indices, changes}`
//    and this read the changes off the top level, so every pill format was a noop.)
//
// Every value the native callers dispatch is covered (FormatPanel, ListToolbar,
// BottomInsertDrawer, FloatingPill, DockToolsSheet, the history buttons):
//   list    ul|bullet → bullet, ol|number → number, none → off — SET, not toggle:
//           the bubble sends the kind it WANTS; check → bullet, because Word has
//           no checklist and Lexical's own export degraded it to bullets;
//           indent/outdent → adjustIndent.
//   insert  {kind} from the Insert drawer: the "/query" before the caret goes
//           first (the drawer's clearSlash), then text kinds restyle the paragraph
//           (a new paragraph after it when text remains — Lexical's rule),
//           pageBreak → insertBreak, table → insertTable, toc → insertToc (a
//           generated, linked TOC of heading levels 1–3), footnote → insertNote —
//           all in the engine, so they land on the page at once. figure /
//           pasteImage / equation / divider are the drawer's own native paths (it
//           dispatches clearSlash, then runs them), so here they only clear.
//   focus / blur  open / close the keyboard (keyboard toggle, the pill, the drawer).
//   serialize / patchBlocks  Lexical-only: WorkspaceLexicalView is their only
//           sender, nothing dispatches them to this surface — noop.

import type { LexicalCommand } from "@/components/workspace/lexical/editor-components/types";

export type EngineAction =
  | { kind: "slot"; slot: string }
  | { kind: "style"; styleId: string }
  | { kind: "paragraph"; update: { alignment?: "left" | "center" | "right" | "justify" } }
  | { kind: "marks"; marks: Record<string, unknown> }
  | { kind: "selectParagraph" }
  | { kind: "direction"; direction: "rtl" | "ltr" }
  | { kind: "list"; list: "bullet" | "number" | null }
  | { kind: "indent"; direction: "increase" | "decrease" }
  | { kind: "insert"; then: InsertThen }
  | { kind: "focus" }
  | { kind: "blur" }
  | { kind: "noop"; reason: string };

/** What the Insert drawer wants once the "/query" is gone. `null` = nothing more
 *  (it asked for clearSlash alone, or it runs a native path itself). */
export type InsertThen =
  | { style: string }
  | { list: "bullet" | "number" }
  | { pageBreak: true }
  | { table: { rows: number; cols: number } }
  | { toc: true }
  | { footnote: true }
  | null;

// Word's built-in style ids for the drawer's text kinds. A thesis that does not
// define one (Quote, Title…) has the engine refuse it — logged, nothing changes.
const INSERT_STYLE: Record<string, string> = {
  h1: "Heading1", h2: "Heading2", h3: "Heading3", h4: "Heading4", h5: "Heading5", h6: "Heading6",
  quote: "Quote", normal: "Normal", title: "Title", subtitle: "Subtitle",
  intenseQuote: "IntenseQuote", noSpacing: "NoSpacing",
};

// The drawer's "table" tile has no size picker (Lexical never inserted one; the
// tile is live on the docx surface only): a small grid the student grows from the
// table bubble.
const INSERT_TABLE = { rows: 3, cols: 3 };

function insertThen(kind: string): InsertThen {
  if (INSERT_STYLE[kind]) return { style: INSERT_STYLE[kind] };
  if (kind === "bullet" || kind === "number") return { list: kind };
  if (kind === "pageBreak") return { pageBreak: true };
  if (kind === "table") return { table: INSERT_TABLE };
  if (kind === "toc") return { toc: true };
  if (kind === "footnote") return { footnote: true };
  return null;
}

const ALIGNS = new Set(["left", "center", "right", "justify"]);

function colorMark(hex: string | null | undefined): Record<string, unknown> {
  const v = (hex ?? "").replace(/^#/, "").trim();
  return v ? { kind: "hex", value: v.toUpperCase() } : { kind: "auto" };
}

function headingStyle(level: number): string {
  return level <= 0 ? "Normal" : `Heading${Math.min(6, level)}`;
}

export function mapCommand(cmd: LexicalCommand): EngineAction[] {
  const v = cmd.value ?? "";
  switch (cmd.type) {
    case "bold":
    case "italic":
    case "underline":
      return [{ kind: "slot", slot: `text.${cmd.type}` }];
    case "undo":
      return [{ kind: "slot", slot: "history.undo" }];
    case "redo":
      return [{ kind: "slot", slot: "history.redo" }];
    case "clearFormatting":
      return [{ kind: "slot", slot: "format.clear" }];
    case "align":
      return ALIGNS.has(v)
        ? [{ kind: "slot", slot: `alignment.${v}` }]
        : [{ kind: "noop", reason: `align: unknown value ${v}` }];
    case "heading": {
      const m = /^h([1-6])$/.exec(v);
      if (m) return [{ kind: "style", styleId: headingStyle(Number(m[1])) }];
      if (v === "paragraph") return [{ kind: "style", styleId: "Normal" }];
      return [{ kind: "noop", reason: `heading: unknown value ${v}` }];
    }
    case "quote":
      return [{ kind: "style", styleId: "Quote" }];
    case "list":
      if (v === "ul" || v === "bullet" || v === "check") return [{ kind: "list", list: "bullet" }];
      if (v === "ol" || v === "number") return [{ kind: "list", list: "number" }];
      if (v === "none") return [{ kind: "list", list: null }];
      if (v === "indent") return [{ kind: "indent", direction: "increase" }];
      if (v === "outdent") return [{ kind: "indent", direction: "decrease" }];
      return [{ kind: "noop", reason: `list: unknown value ${v}` }];
    case "insert": {
      let kind: unknown;
      try {
        kind = (JSON.parse(v) as { kind?: unknown }).kind;
      } catch {
        return [{ kind: "noop", reason: "insert: malformed value" }];
      }
      return typeof kind === "string" ? [{ kind: "insert", then: insertThen(kind) }] : [{ kind: "noop", reason: "insert: no kind" }];
    }
    case "focus":
      return [{ kind: "focus" }];
    case "blur":
      return [{ kind: "blur" }];
    case "direction":
      return v === "rtl" || v === "ltr"
        ? [{ kind: "direction", direction: v }]
        : [{ kind: "noop", reason: `direction: unknown value ${v}` }];
    case "color":
      return [{ kind: "marks", marks: { color: colorMark(v) } }];
    case "blockFormat":
      return [{ kind: "noop", reason: "blockFormat: the docx host sends it through mutate → applyOp as a format op" }];
    default:
      return [{ kind: "noop", reason: `${cmd.type}: not an engine command` }];
  }
}
