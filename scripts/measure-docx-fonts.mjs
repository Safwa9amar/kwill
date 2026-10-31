#!/usr/bin/env node
// Measures the vertical metrics the docx-editor needs for the bundled Arabic
// faces (Task 27, spec D9), and the content hash/size of each bundled file.
//
//   node scripts/measure-docx-fonts.mjs                      # the bundled faces
//   node scripts/measure-docx-fonts.mjs path/to/trado.ttf …  # + any Word face
//
// What goes into `lineMetrics` is the REQUESTED face's line box, not the
// substitute's: the engine documents it as "Word line-box metrics for the
// requested face", and the fonts package's own Century Gothic → TeX Gyre
// Adventor entry carries Century Gothic's numbers (measure Word's
// `Century Gothic.ttf` with this script: 1.19140625 / 0.97119140625). Word sizes
// a single-spaced line from the face's Windows metrics, so:
//
//   heightEm   = (usWinAscent + usWinDescent) / unitsPerEm
//   baselineEm =  usWinAscent                 / unitsPerEm
//
// The Word faces themselves are proprietary and are NOT in the repo — pass their
// paths to measure them; only the resulting numbers are recorded, in
// components/workspace/docx-editor/bridge/fonts-manifest.ts.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_DIR = fileURLToPath(new URL("../assets/fonts/docx/", import.meta.url));

/** The few tables this needs, straight from the sfnt table directory. */
export function readFaceMetrics(buf) {
  const sfnt = buf.readUInt32BE(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x4f54544f /* OTTO */ && sfnt !== 0x74727565 /* true */) {
    throw new Error(`not a single-face sfnt (0x${sfnt.toString(16)}) — a .ttc needs a face index`);
  }
  const tables = new Map();
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString("latin1", rec, rec + 4), { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
  }
  const need = (tag) => {
    const t = tables.get(tag);
    if (!t) throw new Error(`missing ${tag} table`);
    return t.offset;
  };
  const head = need("head");
  const hhea = need("hhea");
  const os2 = need("OS/2");
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const m = {
    unitsPerEm,
    hheaAscender: buf.readInt16BE(hhea + 4),
    hheaDescender: buf.readInt16BE(hhea + 6),
    hheaLineGap: buf.readInt16BE(hhea + 8),
    fsSelection: buf.readUInt16BE(os2 + 62),
    typoAscender: buf.readInt16BE(os2 + 68),
    typoDescender: buf.readInt16BE(os2 + 70),
    typoLineGap: buf.readInt16BE(os2 + 72),
    winAscent: buf.readUInt16BE(os2 + 74),
    winDescent: buf.readUInt16BE(os2 + 76),
    variable: tables.has("fvar"),
    ...names(buf, tables.get("name")),
  };
  return {
    ...m,
    lineMetrics: {
      heightEm: (m.winAscent + m.winDescent) / unitsPerEm,
      baselineEm: m.winAscent / unitsPerEm,
    },
  };
}

// nameID 1/2 (family/subfamily) and 16/17 (typographic), Windows Unicode only.
function names(buf, t) {
  if (!t) return {};
  const base = t.offset;
  const count = buf.readUInt16BE(base + 2);
  const strings = base + buf.readUInt16BE(base + 4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const r = base + 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const language = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    if (platform !== 3 || (language !== 0x409 && out[id] != null)) continue;
    const len = buf.readUInt16BE(r + 8);
    const off = strings + buf.readUInt16BE(r + 10);
    const s = buf.subarray(off, off + len);
    let str = "";
    for (let j = 0; j + 1 < s.length; j += 2) str += String.fromCharCode(s.readUInt16BE(j));
    out[id] = str;
  }
  return { family: out[16] ?? out[1], subfamily: out[17] ?? out[2] };
}

function report(path) {
  const buf = readFileSync(path);
  const m = readFaceMetrics(buf);
  return {
    file: basename(path),
    family: m.family,
    subfamily: m.subfamily,
    byteLength: buf.length,
    hash: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
    unitsPerEm: m.unitsPerEm,
    win: [m.winAscent, m.winDescent],
    hhea: [m.hheaAscender, m.hheaDescender, m.hheaLineGap],
    typo: [m.typoAscender, m.typoDescender, m.typoLineGap],
    useTypoMetrics: (m.fsSelection & 0x80) !== 0,
    variable: m.variable,
    lineMetrics: m.lineMetrics,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bundled = readdirSync(BUNDLED_DIR).filter((f) => /\.(ttf|otf)$/i.test(f)).sort().map((f) => join(BUNDLED_DIR, f));
  const extra = process.argv.slice(2);
  for (const [title, paths] of [["bundled", bundled], ["requested (Word) faces", extra]]) {
    if (!paths.length) continue;
    console.log(`\n## ${title}`);
    for (const p of paths) console.log(JSON.stringify(report(p)));
  }
}
