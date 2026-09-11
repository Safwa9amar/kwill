// The docx-editor stamps every painted node with its structural id —
//
//     /word/document.xml#<doc>.<body>.<blockIndex>[.<run>.<text>…]
//
// — and the THIRD segment is the body-child index, which is exactly the
// `DocBlockDTO.index` our server hands out for the same load of the same bytes
// (verified on real theses: chart placeholders `#0.1.220.1.0` / `#0.1.250.1.0`
// were DTO blocks 220 / 250). This is the ONLY bridge between the engine's
// identity and the AI's address space, and it goes one way: ids are PARSED,
// never built. To reach a block FROM an index, search its text and filter the
// matches through this function (see bridge/find-block.ts).
//
// ⚠️ Valid as of a load. A local edit that inserts or deletes a paragraph mints
// ids the DTO knows nothing about; the surface reloads after such a save so the
// two agree again (spec D7).

const BODY_PART = "/word/document.xml#";
const RE = /#(\d+)\.(\d+)\.(\d+)(?:\.|$)/;

/** The body-child index carried by an engine node id, or null. */
export function blockIndexFromId(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = RE.exec(id);
  if (!m) return null;
  const n = Number(m[3]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Only the main body's indices are block indices — a header or footnote story
 *  has its own numbering and must never be mistaken for one. */
export function isBodyId(id: string | null | undefined): id is string {
  return !!id && id.startsWith(BODY_PART);
}
