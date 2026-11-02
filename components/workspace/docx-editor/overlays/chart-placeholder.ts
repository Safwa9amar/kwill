// Which painted placeholders can be a native Word chart?
//
// Ported from kwill-dashboard (bubble/chart-placeholder.ts). The engine paints every
// graphic it declines to draw as a `.docx-drawing-placeholder` labelled "Unsupported
// graphic (<kind>)". Since @docx-editor.dev/core 2.3x the engine reads the chart URI
// out of `a:graphicData`, so a native chart names itself "(chart)"
// (chart-placeholder.test.ts pins it against the installed package); "(graphic)" stays
// accepted for a chart wrapped in something the engine does not unwrap. Identity
// still comes from the drawing's node id, not from this.

const MAY_BE_A_CHART = /\((?:chart|graphic)\)/i;

/** True when a `.docx-drawing-placeholder`'s label may belong to a native chart. */
export function isChartPlaceholderLabel(label: string): boolean {
  return MAY_BE_A_CHART.test(label);
}
