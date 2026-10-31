import { describe, it, expect } from "vitest";
import { readOoxmlPackage, projectDrawing, writeZip } from "@docx-editor.dev/core/store";
import { isChartPlaceholderLabel } from "./chart-placeholder";

// ─────────────────────────────────────────────────────────────────────────────
// Ported from kwill-dashboard. The label predicate exists because of a specific
// engine behavior: it cannot NAME a native chart in its placeholder label. The
// second suite pins that behavior against the installed package itself (verified
// unchanged at 2.21.1) — if an upgrade ever makes the engine record the chart URI
// (label "(chart)"), it fails, telling us the filter can finally be tightened to a
// positive match.
// ─────────────────────────────────────────────────────────────────────────────

describe("isChartPlaceholderLabel", () => {
  it("keeps what a chart labels itself today — and would label itself tomorrow", () => {
    expect(isChartPlaceholderLabel("Unsupported graphic (graphic)")).toBe(true);
    expect(isChartPlaceholderLabel("Unsupported graphic (chart)")).toBe(true);
  });
  it("drops every kind the engine does resolve", () => {
    for (const kind of ["textbox", "group", "canvas", "diagram"]) {
      expect(isChartPlaceholderLabel(`Unsupported graphic (${kind})`)).toBe(false);
    }
  });
});

// A minimal .docx whose one drawing is EXACTLY the paragraph our server's
// insertChart writes (thesis-charts.ts) — namespaces declared inline on the
// drawing, classic c:chart part behind a relationship.
const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const DOCUMENT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
  `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
  `<wp:extent cx="4680000" cy="2736000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
  `<wp:docPr id="1001" name="Chart 1"/><wp:cNvGraphicFramePr/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<a:graphicData uri="${CHART_URI}">` +
  `<c:chart xmlns:c="${CHART_URI}" xmlns:r="${REL_NS}" r:id="rId9"/>` +
  `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<c:chartSpace xmlns:c="${CHART_URI}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<c:chart><c:plotArea><c:layout/><c:barChart><c:ser><c:idx val="0"/><c:order val="0"/>` +
  `<c:val><c:numRef><c:f>Feuil1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/>` +
  `<c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt>` +
  `</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

function chartDocxBytes(): Uint8Array {
  const enc = new TextEncoder();
  return writeZip(
    new Map<string, Uint8Array>([
      ["[Content_Types].xml", enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
        `</Types>`)],
      ["_rels/.rels", enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`)],
      ["word/_rels/document.xml.rels", enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId9" Type="${REL_NS}/chart" Target="charts/chart1.xml"/>` +
        `</Relationships>`)],
      ["word/document.xml", enc.encode(DOCUMENT_XML)],
      ["word/charts/chart1.xml", enc.encode(CHART_XML)],
    ]),
  );
}

type AnyNode = { kind?: string; children?: readonly AnyNode[] };
function findDrawing(node: AnyNode): AnyNode | null {
  if (node.kind === "drawing") return node;
  for (const c of node.children ?? []) {
    const hit = findDrawing(c);
    if (hit) return hit;
  }
  return null;
}

describe("engine canary: a native chart cannot label itself '(chart)'", () => {
  it("projectDrawing records missing-graphic-data, not the chart URI", () => {
    const res = readOoxmlPackage(chartDocxBytes());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const main = res.package.parts.get(res.package.mainDocumentPart)!;
    const drawing = findDrawing(main.root as AnyNode);
    expect(drawing).not.toBeNull();
    const projection = projectDrawing(drawing as never, {
      ownerPartName: res.package.mainDocumentPart,
      supportedMcRequires: new Set(),
      limits: { maxCompatibilityBranches: 64, maxVisitedElements: 4096, maxDrawingDepth: 64 },
    });
    expect(projection).not.toBeNull();
    expect(projection!.picture).toBeNull();
    const refusal = projection!.diagnostics.find((d) => d.code === "unsupported-graphic");
    // THE pinned behavior: the engine never sees the chart URI, so the label kind
    // falls back to "graphic". If this starts failing with detail === CHART_URI,
    // the engine learned to name charts — tighten isChartPlaceholderLabel to a
    // positive "(chart)"/"(graphic)" match and update chart-placeholder.ts's note.
    expect(refusal?.detail).toBe("missing-graphic-data");
  });
});
