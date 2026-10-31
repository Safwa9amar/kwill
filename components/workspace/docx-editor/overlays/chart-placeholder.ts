// Which painted placeholders can be a native Word chart?
//
// Ported from kwill-dashboard (bubble/chart-placeholder.ts). The engine paints every
// graphic it declines to draw as a `.docx-drawing-placeholder` labelled "Unsupported
// graphic (<kind>)". The kind would be the discriminator we want — except the engine
// only types `a:graphicData` when it holds a `pic:pic`, so a chart's graphicData
// stays generic, the refusal records `missing-graphic-data` instead of the chart
// URI, and every chart labels itself with the catch-all "(graphic)" — still true at
// @docx-editor.dev/core 2.21.1, even though that version carries a chart-URI → kind
// table (chart-placeholder.test.ts pins it against the installed package). So the
// label can never CONFIRM a chart; all it can do is rule out the kinds the engine
// does resolve. Identity comes from the drawing's node id, not from this.

/** Kinds the engine names in a placeholder label, none of which a chart can be.
 *  English on purpose: DocxEditorDom mounts the editor with its default (en) strings. */
const NOT_A_CHART = /\((?:textbox|group|canvas|diagram)\)/i;

/** True when a `.docx-drawing-placeholder`'s label may belong to a native chart —
 *  "(graphic)" today, "(chart)" if the engine ever learns to name one. */
export function isChartPlaceholderLabel(label: string): boolean {
  return !NOT_A_CHART.test(label);
}
