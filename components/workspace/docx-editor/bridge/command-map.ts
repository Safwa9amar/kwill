// The native chrome → engine direction of the bridge, as a PURE translation.
// The envelope is the one lexical-editor-store dispatches today (BlockContextBar,
// FormatPanel, ListToolbar, AIDock, the ribbon…); keeping it means none of those
// callers change in Phase 1. Executing the actions needs a live editor and the
// React hooks that own paragraph style / format — that is Bridge.tsx.
//
// Two things worth knowing about the engine's vocabulary:
//  • Slots (`text.bold`, `alignment.left`, `list.bullet`, `history.undo`,
//    `format.clear`) TOGGLE against the current selection; the pill's
//    blockFormat carries booleans that mean "make it so", so those go out as
//    `marks` (SET semantics — the Bridge compares against the engine's current
//    state before toggling), after selecting the whole paragraph.
//  • There is no paragraph-direction command (no `bidi` anywhere in the typed
//    surface). Direction therefore takes the SERVER path — the same `format`
//    op the pill used before Lexical existed — and the surface reloads.

import type { BlockFmtChange, LexicalCommand } from "@/components/workspace/lexical/editor-components/types";

export type EngineAction =
  | { kind: "slot"; slot: string }
  | { kind: "style"; styleId: string }
  | { kind: "paragraph"; update: { alignment?: "left" | "center" | "right" | "justify" } }
  | { kind: "marks"; marks: Record<string, unknown> }
  | { kind: "selectParagraph" }
  | { kind: "server"; changes: { direction: "rtl" | "ltr" } }
  | { kind: "noop"; reason: string };

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
      if (v === "bullet") return [{ kind: "slot", slot: "list.bullet" }];
      if (v === "number") return [{ kind: "slot", slot: "list.numbered" }];
      return [{ kind: "noop", reason: `list: unknown value ${v}` }];
    case "direction":
      return v === "rtl" || v === "ltr"
        ? [{ kind: "server", changes: { direction: v } }]
        : [{ kind: "noop", reason: `direction: unknown value ${v}` }];
    case "color":
      return [{ kind: "marks", marks: { color: colorMark(v) } }];
    case "blockFormat": {
      let ch: BlockFmtChange;
      try {
        ch = JSON.parse(v) as BlockFmtChange;
      } catch {
        return [{ kind: "noop", reason: "blockFormat: malformed value" }];
      }
      const out: EngineAction[] = [{ kind: "selectParagraph" }];
      const marks: Record<string, unknown> = {};
      if (ch.bold != null) marks.bold = ch.bold;
      if (ch.italic != null) marks.italic = ch.italic;
      if (ch.underline != null) marks.underline = ch.underline;
      if ("color" in ch) marks.color = colorMark(ch.color);
      if (Object.keys(marks).length) out.push({ kind: "marks", marks });
      if (ch.clearFormatting) out.push({ kind: "slot", slot: "format.clear" });
      if (ch.level != null) out.push({ kind: "style", styleId: headingStyle(ch.level) });
      if (ch.alignment && ALIGNS.has(ch.alignment)) {
        out.push({ kind: "paragraph", update: { alignment: ch.alignment as "left" | "center" | "right" | "justify" } });
      }
      if (ch.direction === "rtl" || ch.direction === "ltr") out.push({ kind: "server", changes: { direction: ch.direction } });
      return out;
    }
    default:
      return [{ kind: "noop", reason: `${cmd.type}: not an engine command` }];
  }
}
