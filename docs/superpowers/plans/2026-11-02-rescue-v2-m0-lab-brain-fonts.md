# Rescue v2 — M0: Lab, session brain, font embedding (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the rescue lab, so that Claude (in the Claude Code session) can act as the brain on a real thesis, and prove that the engine can embed fonts within their licences.

**Architecture:**
- **mdocxengine** gains a font-embedding part manager: fsType licence check, ODTTF obfuscation, `fontTable.xml`, rels, content types, `settings.xml`.
- **kwill-server** gains:
  - the first pure modules of `src/lib/rescue/` (block keys, read inventory, brain task schema, the session brain, map-task builder);
  - a guard test that keeps every model client out of that folder;
  - a dev-only lab CLI under `scripts/rescue-lab/` that renders theses through the real Word converter and queues map tasks for Claude to answer.

**Tech stack:** TypeScript, vitest, zod 4 (kwill-server), adm-zip, `@kwill/docx-engine` (`file:../mdocxengine`), the Word converter service (`scripts/word-convert-service.mjs`, port 8092), `pdffonts` (poppler).

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md`. This plan covers milestone **M0** only; M1+ get their own plans after M0 lands.

---

## Ground rules (read before any task)

- **Git:** work on each repo's current branch (`main` in mdocxengine, `master` in kwill-server) and commit after every task, staging **exact paths only** (`git add <paths>`, never `git add -A` or `git add .`). Other sessions work in these repos in parallel: kwill-server already has someone else's uncommitted edits (`package.json`, `package-lock.json`, scripts). Never stage, revert or "fix" files this plan does not list. Never stage `.DS_Store` or `app.json`. End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **mdocxengine:**
  - Tests: `npx vitest run <file>`. ⚠️ `npm run test:ci` **already fails on `main` before this plan** (global coverage ≈ 90% against 100% thresholds, in older files), so it is not a usable gate. The engine gate for this plan is: **(a)** every new source file at **100% coverage**, measured with `npx vitest run <specs> --coverage --coverage.include=<new files>` (the 100% thresholds then apply to those files only); **(b)** `npx vitest run` shows **no new failing spec** compared with the base commit `4fffabb`.
  - Specs live next to their source as `*.spec.ts`.
  - After changing the engine, run `npm run build` (`tsc && vite build --ssr`). kwill-server only sees `dist/`.
- **kwill-server:**
  - Tests: `npx vitest run <file>`; full suite `npx vitest run` (re-run slow suites with `--testTimeout=60000` before calling a timeout a failure).
  - Type check: `npx tsc --noEmit`.
  - Tests match `src/**/*.test.ts`.
  - `tsconfig` has `"strict": false`, so never rely on narrowing a `{ok:true}|{ok:false}` union. Use flat interfaces and `x.ok === false`.
  - Imports are relative, with no `.js` extension.
  - **`src/lib/supabase.ts` creates a client at import time.** No module under `src/lib/rescue/` may import `document-storage`, `supabase`, `db` or `thesis-render`; those come in later milestones behind lazy imports.
  - **No module under `src/lib/rescue/` may import any model client or the old pipeline** (`src/lib/format/*`). Task 7 enforces this.
- **Unicode ranges are written as `\u` escapes, never as pasted characters** (`/[\u064B-\u065F\u0670]/`, not the glyphs). A pasted range in Task 6 silently became U+064B–U+0670 and deleted Arabic-Indic digits.
- **Lab data is private.** `~/kwill-server/lab/` holds students' theses and is gitignored (Task 5). Never copy anything from `lab/` into a tracked path.

---

## File structure

**mdocxengine** (`~/mdocxengine`)

| File | Responsibility |
|---|---|
| `src/core/fonts/fsType.ts` | Read a font's OS/2 `fsType`; map it to an embedding permission |
| `src/core/fonts/fsType.spec.ts` | Tests |
| `src/core/fonts/obfuscate.ts` | ODTTF obfuscation (ECMA-376 font key), new font keys |
| `src/core/fonts/obfuscate.spec.ts` | Tests |
| `src/core/PartsManagers/FontTableManager.ts` | Embed a font into a .docx: odttf parts, fontTable rels, fontTable entry, content type, settings flag |
| `src/core/PartsManagers/FontTableManager.spec.ts` | Tests |
| `src/index.ts` (modify) | Wire `fontTable` into `Mdocxengine`; export the new symbols |

**kwill-server** (`~/kwill-server`)

| File | Responsibility |
|---|---|
| `.gitignore` (modify) | Ignore `lab/` |
| `scripts/rescue-lab/README.md` | How the lab works, folder layout, privacy rule |
| `src/lib/rescue/blocks/block-key.ts` | Content-based block keys (`normalizeForKey`, `blockKeys`) |
| `src/lib/rescue/read/inventory.ts` | Read stage core: blocks + facts + counts + word fingerprint |
| `src/lib/rescue/brain/tasks.ts` | Role/format vocabularies, map-task and answer schemas, validation, instructions |
| `src/lib/rescue/brain/session-brain.ts` | File-queue brain: write a task, wait for a valid answer |
| `src/lib/rescue/map/build-map-tasks.ts` | Split an inventory into windowed map tasks with page images |
| `src/lib/rescue/__tests__/*.test.ts` | One test file per module + the guard test |
| `scripts/rescue-lab/render.ts` | Render a .docx through the Word converter: PDF, page PNGs, overview sheets, page map |
| `scripts/rescue-lab/cli.ts` | Lab commands: `intake`, `read`, `map`, `pending`, `approve-map` |
| `scripts/rescue-lab/font-proof.ts` | The D-14 feasibility proof |

---

## Task 1: fsType reader (engine)

**Files:**
- Create: `~/mdocxengine/src/core/fonts/fsType.ts`
- Test: `~/mdocxengine/src/core/fonts/fsType.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/fonts/fsType.spec.ts
import { describe, it, expect } from "vitest";
import { readFsType, embeddingPermission, canEmbed } from "./fsType";

/** A minimal sfnt: header + one table record + a 10-byte table. */
function fakeFont(tag: string, fsType = 0, tableLen = 10): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  const rec = Buffer.alloc(16);
  rec.write(tag, 0, "latin1");
  rec.writeUInt32BE(28, 8);
  rec.writeUInt32BE(tableLen, 12);
  const table = Buffer.alloc(tableLen);
  if (tableLen >= 10) table.writeUInt16BE(fsType, 8);
  return Buffer.concat([header, rec, table]);
}

describe("readFsType", () => {
  it("reads fsType from the OS/2 table", () => {
    expect(readFsType(fakeFont("OS/2", 0x0008))).toBe(0x0008);
  });
  it("is null for a buffer shorter than an sfnt header", () => {
    expect(readFsType(Buffer.alloc(4))).toBeNull();
  });
  it("is null when the font has no OS/2 table", () => {
    expect(readFsType(fakeFont("head"))).toBeNull();
  });
  it("is null when a table record runs past the end", () => {
    const f = fakeFont("OS/2");
    expect(readFsType(f.subarray(0, 20))).toBeNull();
  });
  it("is null when the OS/2 table is truncated", () => {
    expect(readFsType(fakeFont("OS/2", 0, 6))).toBeNull();
  });
});

describe("embeddingPermission", () => {
  it.each([
    [null, "unknown"],
    [0x0000, "installable"],
    [0x0008, "editable"],
    [0x0004, "preview-print"],
    [0x0002, "restricted"],
    [0x000a, "editable"], // least restrictive bit wins
    [0x0208, "restricted"], // bitmap-only embedding cannot carry outlines
    [0x0001, "unknown"], // reserved bit only
  ] as const)("fsType %s → %s", (fs, want) => {
    expect(embeddingPermission(fs)).toBe(want);
  });
});

describe("canEmbed", () => {
  it("allows only installable and editable fonts", () => {
    expect(canEmbed("installable")).toBe(true);
    expect(canEmbed("editable")).toBe(true);
    expect(canEmbed("preview-print")).toBe(false);
    expect(canEmbed("restricted")).toBe(false);
    expect(canEmbed("unknown")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/mdocxengine && npx vitest run src/core/fonts/fsType.spec.ts`
Expected: FAIL, `Cannot find module './fsType'`.

- [ ] **Step 3: Implement**

```ts
// src/core/fonts/fsType.ts
// A font's licence for embedding lives in its OS/2 table's fsType field
// (OpenType spec, "OS/2 — fsType"). Simplified Arabic and Traditional Arabic
// carry 0x0002 (restricted): Word refuses to embed them and so must we.

export type EmbeddingPermission = "installable" | "editable" | "preview-print" | "restricted" | "unknown";

/** fsType from the OS/2 table, or null when the buffer is not a usable sfnt. */
export function readFsType(font: Buffer): number | null {
  if (font.length < 12) return null;
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (rec + 16 > font.length) return null;
    if (font.toString("latin1", rec, rec + 4) !== "OS/2") continue;
    const offset = font.readUInt32BE(rec + 8);
    if (offset + 10 > font.length) return null;
    return font.readUInt16BE(offset + 8);
  }
  return null;
}

/** Bits 1–3 are the usage permissions; when several are set the least restrictive applies. */
export function embeddingPermission(fsType: number | null): EmbeddingPermission {
  if (fsType === null) return "unknown";
  if (fsType & 0x0200) return "restricted";
  const usage = fsType & 0x000f;
  if (usage === 0) return "installable";
  if (usage & 0x0008) return "editable";
  if (usage & 0x0004) return "preview-print";
  if (usage & 0x0002) return "restricted";
  return "unknown";
}

/** We only embed fonts the student may keep editing with. */
export function canEmbed(p: EmbeddingPermission): boolean {
  return p === "installable" || p === "editable";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/fonts/fsType.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd ~/mdocxengine && git add src/core/fonts/fsType.ts src/core/fonts/fsType.spec.ts
git commit -m "feat(fonts): read a font's embedding licence from OS/2 fsType

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: ODTTF obfuscation (engine)

**Files:**
- Create: `~/mdocxengine/src/core/fonts/obfuscate.ts`
- Test: `~/mdocxengine/src/core/fonts/obfuscate.spec.ts`

Background: an embedded font in a .docx is an `.odttf` part, which is the TTF with its first 32 bytes XORed with a 16-byte key derived from the `w:fontKey` GUID. The key is the GUID's hex digits read in reverse byte order: the last byte of the GUID string is key[0]. LibreOffice and Word both use this.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/fonts/obfuscate.spec.ts
import { describe, it, expect } from "vitest";
import { fontKeyBytes, obfuscateFont, newFontKey } from "./obfuscate";

const GUID = "{00112233-4455-6677-8899-AABBCCDDEEFF}";

describe("fontKeyBytes", () => {
  it("reverses the GUID's bytes", () => {
    expect(fontKeyBytes(GUID).toString("hex")).toBe("ffeeddccbbaa99887766554433221100");
  });
  it("accepts a GUID without braces or dashes", () => {
    expect(fontKeyBytes("00112233445566778899AABBCCDDEEFF")).toEqual(fontKeyBytes(GUID));
  });
  it("rejects anything that is not 32 hex digits", () => {
    expect(() => fontKeyBytes("{not-a-guid}")).toThrow(/Invalid font key/);
  });
});

describe("obfuscateFont", () => {
  it("XORs the first 32 bytes with the key, twice over", () => {
    const out = obfuscateFont(Buffer.alloc(40), GUID);
    const key = fontKeyBytes(GUID);
    expect(out.subarray(0, 16)).toEqual(key);
    expect(out.subarray(16, 32)).toEqual(key);
    expect(out.subarray(32)).toEqual(Buffer.alloc(8));
  });
  it("is its own inverse and never mutates the input", () => {
    const font = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
    const copy = Buffer.from(font);
    expect(obfuscateFont(obfuscateFont(font, GUID), GUID)).toEqual(copy);
    expect(font).toEqual(copy);
  });
  it("handles a font shorter than 32 bytes", () => {
    expect(obfuscateFont(Buffer.alloc(3), GUID).toString("hex")).toBe("ffeedd");
  });
});

describe("newFontKey", () => {
  it("formats 16 random bytes as a braced upper-case GUID", () => {
    const key = newFontKey(() => Buffer.from("00112233445566778899aabbccddeeff", "hex"));
    expect(key).toBe(GUID);
  });
  it("uses crypto randomness by default", () => {
    expect(newFontKey()).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/fonts/obfuscate.spec.ts`
Expected: FAIL, `Cannot find module './obfuscate'`.

- [ ] **Step 3: Implement**

```ts
// src/core/fonts/obfuscate.ts
// ECMA-376 embedded-font obfuscation: XOR the first 32 bytes of the TTF with a
// 16-byte key taken from the w:fontKey GUID in reverse byte order.
import { randomBytes } from "node:crypto";

export function fontKeyBytes(guid: string): Buffer {
  const hex = guid.replace(/[{}-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Invalid font key GUID: ${guid}`);
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(30 - 2 * i, 2), 16);
  return key;
}

/** Returns a new buffer; XOR makes the same call de-obfuscate. */
export function obfuscateFont(font: Buffer, guid: string): Buffer {
  const out = Buffer.from(font);
  const key = fontKeyBytes(guid);
  const n = Math.min(32, out.length);
  for (let i = 0; i < n; i++) out[i] ^= key[i % 16];
  return out;
}

export function newFontKey(random: () => Buffer = () => randomBytes(16)): string {
  const h = random().toString("hex").toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/fonts/obfuscate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/fonts/obfuscate.ts src/core/fonts/obfuscate.spec.ts
git commit -m "feat(fonts): ODTTF obfuscation and font keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: FontTableManager (engine)

**Files:**
- Create: `~/mdocxengine/src/core/PartsManagers/FontTableManager.ts`
- Test: `~/mdocxengine/src/core/PartsManagers/FontTableManager.spec.ts`
- Modify: `~/mdocxengine/src/index.ts` (constructor wiring around lines 68–95; manager exports around lines 231–262)

Design notes:
- **The manager talks only to the zip** (`getEntry`, `getData`, `addFile`), plus `ContentTypesManager.addDefault` and `addOverride` for the content types. Rels are written by string surgery because `word/_rels/fontTable.xml.rels` usually does not exist yet.
- **It embeds all variants or none:** if any variant's licence forbids embedding, nothing is written.
- **Sequence order matters.** Inside `w:font`, the `w:embed*` elements come last (after `w:sig`), in this order: `embedRegular`, `embedBold`, `embedItalic`, `embedBoldItalic`. Inside `w:settings`, `w:embedTrueTypeFonts` comes after `w:printFormsData`. ⚠️ The doctor does **not** enforce either order (it has no CT_Font sequence, and settings order is only a warning), so the spec's own assertions are the only guard. Keep them.

- [ ] **Step 1: Read the wiring you will copy**

Run: `sed -n 40,100p ~/mdocxengine/src/index.ts` and `sed -n 80,100p ~/mdocxengine/src/core/PartsManagers/FootnoteManager.ts`
Note how `FootnoteManager` receives the zip and `contentTypes` and how it is exported. `FontTableManager` takes `(zip, contentTypes)` in the same way.

- [ ] **Step 2: Write the failing test**

```ts
// src/core/PartsManagers/FontTableManager.spec.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { Mdocxengine } from "../../index";
import { checkDocxBuffer } from "../../doctor";
import { obfuscateFont } from "../fonts/obfuscate";

const SAMPLE = readFileSync(new URL("../../../samples/example.docx", import.meta.url));

/** sfnt with an OS/2 table carrying `fsType`, padded so obfuscation has 32+ bytes. */
function fakeFont(fsType: number, fill = 7): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  const rec = Buffer.alloc(16);
  rec.write("OS/2", 0, "latin1");
  rec.writeUInt32BE(28, 8);
  rec.writeUInt32BE(10, 12);
  const table = Buffer.alloc(10);
  table.writeUInt16BE(fsType, 8);
  return Buffer.concat([header, rec, table, Buffer.alloc(40, fill)]);
}
let n = 0;
const fixedKey = () => `{00000000-0000-0000-0000-${String(++n).padStart(12, "0")}}`;

async function load(mutate?: (z: AdmZip) => void) {
  const z = new AdmZip(SAMPLE);
  mutate?.(z);
  const engine = await Mdocxengine.loadFromBuffer(z.toBuffer());
  engine.fontTable.newKey = fixedKey;
  return engine;
}
const text = (e: Mdocxengine, p: string) => e.zip.readAsText(p) ?? "";

describe("FontTableManager.embedFont", () => {
  it("embeds an editable font: odttf part, rel, fontTable entry, content type, settings flag", async () => {
    const e = await load();
    const font = fakeFont(0x0008);
    const res = await e.fontTable.embedFont({ name: "Amiri", regular: font });
    expect(res).toEqual({ name: "Amiri", embedded: true, variants: ["regular"], settingsUpdated: true });

    const ft = text(e, "word/fontTable.xml");
    const m = ft.match(/<w:font\b[^>]*w:name="Amiri"[^>]*>([\s\S]*?)<\/w:font>/);
    expect(m).not.toBeNull();
    const embed = m![1].match(/<w:embedRegular r:id="(rId\d+)" w:fontKey="(\{[^"]+\})"\/>/)!;
    const rels = text(e, "word/_rels/fontTable.xml.rels");
    expect(rels).toContain(`Id="${embed[1]}"`);
    expect(rels).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"');
    const target = rels.match(new RegExp(`Id="${embed[1]}"[^>]*Target="([^"]+)"`))![1];
    const stored = e.zip.getEntry(`word/${target}`)!.getData();
    expect(obfuscateFont(stored, embed[2])).toEqual(font);
    expect(text(e, "[Content_Types].xml")).toMatch(/Extension="odttf"[^>]*obfuscatedFont/);
    expect(text(e, "word/settings.xml")).toContain("<w:embedTrueTypeFonts/>");

    const report = await checkDocxBuffer(Buffer.from(e.zip.toBuffer()));
    expect(report.findings.filter((f) => f.severity === "fatal")).toEqual([]);
  });

  it("refuses a restricted font and writes nothing", async () => {
    const e = await load();
    const before = text(e, "word/fontTable.xml");
    const res = await e.fontTable.embedFont({ name: "Simplified Arabic", regular: fakeFont(0x0002) });
    expect(res).toEqual({ name: "Simplified Arabic", embedded: false, reason: "restricted", variants: [], settingsUpdated: false });
    expect(text(e, "word/fontTable.xml")).toBe(before);
    expect(e.zip.getEntries().some((x) => x.entryName.startsWith("word/fonts/"))).toBe(false);
  });

  it("refuses all variants when one variant is not embeddable", async () => {
    const e = await load();
    const res = await e.fontTable.embedFont({ name: "Mixed", regular: fakeFont(0), bold: fakeFont(0x0004) });
    expect(res.embedded).toBe(false);
    expect(res.reason).toBe("preview-print");
  });

  it("refuses a font whose licence cannot be read", async () => {
    const e = await load();
    const res = await e.fontTable.embedFont({ name: "Broken", regular: Buffer.alloc(8) });
    expect(res).toMatchObject({ embedded: false, reason: "unknown" });
  });

  it("embeds every variant in schema order and numbers parts and rels upward", async () => {
    const e = await load();
    await e.fontTable.embedFont({ name: "A", regular: fakeFont(0) });
    const res = await e.fontTable.embedFont({
      name: "B", regular: fakeFont(0), bold: fakeFont(0), italic: fakeFont(0), boldItalic: fakeFont(0),
    });
    expect(res.variants).toEqual(["regular", "bold", "italic", "boldItalic"]);
    const b = text(e, "word/fontTable.xml").match(/<w:font\b[^>]*w:name="B"[^>]*>([\s\S]*?)<\/w:font>/)![1];
    const order = [...b.matchAll(/<w:(embed\w+)\b/g)].map((x) => x[1]);
    expect(order).toEqual(["embedRegular", "embedBold", "embedItalic", "embedBoldItalic"]);
    expect(e.zip.getEntry("word/fonts/font5.odttf")).toBeTruthy();
    expect(e.fontTable.embeddedFonts()).toEqual(["A", "B"]);
  });

  it("replaces an existing entry's embeds and keeps its other children", async () => {
    const e = await load((z) => z.addFile("word/fontTable.xml", Buffer.from(
      '<?xml version="1.0"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:font w:name="Amiri"><w:charset w:val="00"/><w:embedRegular r:id="rId9" w:fontKey="{X}"/></w:font>' +
      '<w:font w:name="Tahoma"/></w:fonts>')));
    await e.fontTable.embedFont({ name: "Amiri", regular: fakeFont(0) });
    await e.fontTable.embedFont({ name: "Tahoma", regular: fakeFont(0) });
    const ft = text(e, "word/fontTable.xml");
    expect(ft).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    expect(ft).toMatch(/<w:font w:name="Amiri"><w:charset w:val="00"\/><w:embedRegular r:id="rId\d+" w:fontKey="\{0/);
    expect(ft).not.toContain('r:id="rId9"');
    expect(ft).toMatch(/<w:font w:name="Tahoma"><w:embedRegular /);
    expect(e.fontTable.listFonts()).toEqual(["Amiri", "Tahoma"]);
  });

  it("creates fontTable.xml, its override and document rel when the file has none", async () => {
    const e = await load((z) => {
      z.deleteFile("word/fontTable.xml");
      const rels = z.readAsText("word/_rels/document.xml.rels").replace(/<Relationship\b[^>]*fontTable[^>]*\/>/g, "");
      z.addFile("word/_rels/document.xml.rels", Buffer.from(rels));
    });
    expect(e.fontTable.listFonts()).toEqual([]);
    await e.fontTable.embedFont({ name: "Amiri", regular: fakeFont(0) });
    expect(text(e, "word/fontTable.xml")).toContain('w:name="Amiri"');
    expect(text(e, "[Content_Types].xml")).toContain('PartName="/word/fontTable.xml"');
    expect(text(e, "word/_rels/document.xml.rels")).toMatch(/relationships\/fontTable"[^>]*Target="fontTable.xml"|Target="fontTable.xml"[^>]*relationships\/fontTable"/);
  });

  it("does not duplicate an existing document rel to fontTable.xml", async () => {
    const e = await load((z) => z.deleteFile("word/fontTable.xml"));
    await e.fontTable.embedFont({ name: "Amiri", regular: fakeFont(0) });
    expect(text(e, "word/_rels/document.xml.rels").match(/Target="fontTable\.xml"/g)).toHaveLength(1);
  });

  it("places embedTrueTypeFonts after the settings it must follow, once", async () => {
    const e = await load((z) => z.addFile("word/settings.xml", Buffer.from(
      '<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>')));
    await e.fontTable.embedFont({ name: "A", regular: fakeFont(0) });
    await e.fontTable.embedFont({ name: "B", regular: fakeFont(0) });
    const s = text(e, "word/settings.xml");
    expect(s).toContain('<w:zoom w:percent="100"/><w:embedTrueTypeFonts/><w:defaultTabStop');
    expect(s.match(/embedTrueTypeFonts/g)).toHaveLength(1);
  });

  it("puts embedTrueTypeFonts first when no earlier setting exists", async () => {
    const e = await load((z) => z.addFile("word/settings.xml", Buffer.from(
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/></w:settings>')));
    await e.fontTable.embedFont({ name: "A", regular: fakeFont(0) });
    expect(text(e, "word/settings.xml")).toMatch(/<w:settings [^>]*><w:embedTrueTypeFonts\/><w:defaultTabStop/);
  });

  it("reports settingsUpdated:false when the document has no settings part", async () => {
    const e = await load((z) => z.deleteFile("word/settings.xml"));
    const res = await e.fontTable.embedFont({ name: "A", regular: fakeFont(0) });
    expect(res.settingsUpdated).toBe(false);
    expect(res.embedded).toBe(true);
  });

  it("escapes the font name in XML", async () => {
    const e = await load();
    await e.fontTable.embedFont({ name: 'A&B "C"', regular: fakeFont(0) });
    expect(text(e, "word/fontTable.xml")).toContain('w:name="A&amp;B &quot;C&quot;"');
    expect(e.fontTable.listFonts()).toContain('A&B "C"');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/core/PartsManagers/FontTableManager.spec.ts`
Expected: FAIL. `engine.fontTable` is undefined, or the module is not found.

- [ ] **Step 4: Implement the manager**

```ts
// src/core/PartsManagers/FontTableManager.ts
// Embeds TrueType fonts into a .docx the way Word does: an obfuscated
// word/fonts/fontN.odttf per variant, a relationship from fontTable.xml, a
// w:embedRegular|Bold|Italic|BoldItalic element on the font's w:font entry, the
// odttf Default content type, and w:embedTrueTypeFonts in settings.xml.
// Fonts whose licence forbids embedding are refused, and nothing is written.
import type { ZipManager } from "../../utils/ZipManager";
import type { ContentTypesManager } from "./ContentTypesManager";
import { readFsType, embeddingPermission, canEmbed, type EmbeddingPermission } from "../fonts/fsType";
import { obfuscateFont, newFontKey } from "../fonts/obfuscate";

const FONT_TABLE = "word/fontTable.xml";
const FONT_TABLE_RELS = "word/_rels/fontTable.xml.rels";
const DOC_RELS = "word/_rels/document.xml.rels";
const SETTINGS = "word/settings.xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const FONT_REL = `${R_NS}/font`;
const FONT_TABLE_REL = `${R_NS}/fontTable`;
const ODTTF_CT = "application/vnd.openxmlformats-officedocument.obfuscatedFont";
const FONT_TABLE_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export type FontVariant = "regular" | "bold" | "italic" | "boldItalic";
const VARIANTS: FontVariant[] = ["regular", "bold", "italic", "boldItalic"];
const EMBED_TAG: Record<FontVariant, string> = {
  regular: "embedRegular", bold: "embedBold", italic: "embedItalic", boldItalic: "embedBoldItalic",
};
/** Children of w:settings that must come BEFORE w:embedTrueTypeFonts (CT_Settings). */
const SETTINGS_BEFORE = [
  "writeProtection", "view", "zoom", "removePersonalInformation", "removeDateAndTime",
  "doNotDisplayPageBoundaries", "displayBackgroundShape", "printPostScriptOverText",
  "printFractionalCharacterWidth", "printFormsData",
];

export interface EmbedFontInput { name: string; regular: Buffer; bold?: Buffer; italic?: Buffer; boldItalic?: Buffer }
export interface EmbedFontResult {
  name: string;
  embedded: boolean;
  reason?: EmbeddingPermission;
  variants: FontVariant[];
  settingsUpdated: boolean;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unescAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class FontTableManager {
  /** Replaceable in tests so font keys are deterministic. */
  newKey: () => string = () => newFontKey();

  constructor(private zip: ZipManager, private contentTypes: ContentTypesManager) {}

  /** A part's text, or "" when the part does not exist. */
  private read(path: string): string {
    const entry = this.zip.getEntry(path);
    return entry ? entry.getData().toString("utf-8") : "";
  }

  /** Every w:font name in fontTable.xml, in document order. */
  listFonts(): string[] {
    const xml = this.read(FONT_TABLE);
    return [...xml.matchAll(/<w:font\b[^>]*\bw:name="([^"]*)"/g)].map((m) => unescAttr(m[1]));
  }

  /** Names of fonts that carry at least one embedded variant. */
  embeddedFonts(): string[] {
    const xml = this.read(FONT_TABLE);
    return [...xml.matchAll(/<w:font\b[^>]*\bw:name="([^"]*)"[^>]*>([\s\S]*?)<\/w:font>/g)]
      .filter((m) => /<w:embed(Regular|Bold|Italic|BoldItalic)\b/.test(m[2]))
      .map((m) => unescAttr(m[1]));
  }

  async embedFont(input: EmbedFontInput): Promise<EmbedFontResult> {
    const present = VARIANTS.filter((v) => input[v]);
    for (const v of present) {
      const p = embeddingPermission(readFsType(input[v] as Buffer));
      if (!canEmbed(p)) return { name: input.name, embedded: false, reason: p, variants: [], settingsUpdated: false };
    }
    await this.ensureFontTable();
    const embeds: string[] = [];
    for (const v of present) {
      const key = this.newKey();
      const target = this.addFontPart(obfuscateFont(input[v] as Buffer, key));
      const relId = this.addFontRel(target);
      embeds.push(`<w:${EMBED_TAG[v]} r:id="${relId}" w:fontKey="${key}"/>`);
    }
    await this.contentTypes.addDefault("odttf", ODTTF_CT);
    this.writeFontEntry(input.name, embeds.join(""));
    const settingsUpdated = this.ensureEmbedSetting();
    return { name: input.name, embedded: true, variants: present, settingsUpdated };
  }

  private async ensureFontTable(): Promise<void> {
    if (!this.zip.getEntry(FONT_TABLE)) {
      this.zip.addFile(FONT_TABLE, Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W_NS}" xmlns:r="${R_NS}"></w:fonts>`, "utf-8"));
      await this.contentTypes.addOverride(`/${FONT_TABLE}`, FONT_TABLE_CT);
      const rels = this.read(DOC_RELS);
      if (!/Target="fontTable\.xml"/.test(rels)) {
        this.zip.addFile(DOC_RELS, Buffer.from(appendRel(rels, FONT_TABLE_REL, "fontTable.xml").xml, "utf-8"));
      }
      return;
    }
    const xml = this.read(FONT_TABLE);
    if (!/<w:fonts\b[^>]*\bxmlns:r=/.test(xml)) {
      this.zip.addFile(FONT_TABLE, Buffer.from(xml.replace(/<w:fonts\b/, `<w:fonts xmlns:r="${R_NS}"`), "utf-8"));
    }
  }

  private addFontPart(bytes: Buffer): string {
    let k = 1;
    while (this.zip.getEntry(`word/fonts/font${k}.odttf`)) k++;
    this.zip.addFile(`word/fonts/font${k}.odttf`, bytes);
    return `fonts/font${k}.odttf`;
  }

  private addFontRel(target: string): string {
    const rels = this.read(FONT_TABLE_RELS) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}"></Relationships>`;
    const { xml, id } = appendRel(rels, FONT_REL, target);
    this.zip.addFile(FONT_TABLE_RELS, Buffer.from(xml, "utf-8"));
    return id;
  }

  private writeFontEntry(name: string, embeds: string): void {
    const xml = this.read(FONT_TABLE);
    const n = escRe(escAttr(name));
    const open = new RegExp(`<w:font\\b[^>]*\\bw:name="${n}"[^>]*?(/?)>`);
    const m = xml.match(open);
    let next: string;
    if (!m) {
      next = xml.replace("</w:fonts>", `<w:font w:name="${escAttr(name)}">${embeds}</w:font></w:fonts>`);
    } else if (m[1] === "/") {
      next = xml.replace(m[0], `${m[0].slice(0, -2)}>${embeds}</w:font>`);
    } else {
      const start = (m.index as number) + m[0].length;
      const end = xml.indexOf("</w:font>", start);
      const body = xml.slice(start, end).replace(/<w:embed(Regular|Bold|Italic|BoldItalic)\b[^>]*\/>/g, "");
      next = xml.slice(0, start) + body + embeds + xml.slice(end);
    }
    this.zip.addFile(FONT_TABLE, Buffer.from(next, "utf-8"));
  }

  /** Adds w:embedTrueTypeFonts in schema position. False when there is no settings part. */
  private ensureEmbedSetting(): boolean {
    const xml = this.read(SETTINGS);
    if (!xml) return false;
    if (xml.includes("<w:embedTrueTypeFonts")) return true;
    let at = -1;
    for (const tag of SETTINGS_BEFORE) {
      const re = new RegExp(`<w:${tag}\\b[^>]*/>|<w:${tag}\\b[^>]*>[\\s\\S]*?</w:${tag}>`, "g");
      for (const m of xml.matchAll(re)) at = Math.max(at, (m.index as number) + m[0].length);
    }
    if (at < 0) {
      const open = xml.match(/<w:settings\b[^>]*>/) as RegExpMatchArray;
      at = (open.index as number) + open[0].length;
    }
    this.zip.addFile(SETTINGS, Buffer.from(`${xml.slice(0, at)}<w:embedTrueTypeFonts/>${xml.slice(at)}`, "utf-8"));
    return true;
  }
}

/** Appends a Relationship with the next free rIdN. */
export function appendRel(relsXml: string, type: string, target: string): { xml: string; id: string } {
  const ids = [...relsXml.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
  const id = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
  const rel = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  return { xml: relsXml.replace("</Relationships>", `${rel}</Relationships>`), id };
}
```

- [ ] **Step 5: Wire it into the engine**

In `~/mdocxengine/src/index.ts`:
1. Add the import next to the other manager imports: `import { FontTableManager } from "./core/PartsManagers/FontTableManager";`
2. Add the public field beside the others in `class Mdocxengine`: `public fontTable: FontTableManager;`
3. In the constructor, after `contentTypes` is constructed: `this.fontTable = new FontTableManager(this.zip, this.contentTypes);`
4. Export, beside the other manager exports (around lines 231–262):

```ts
export { FontTableManager, appendRel } from "./core/PartsManagers/FontTableManager";
export type { EmbedFontInput, EmbedFontResult, FontVariant } from "./core/PartsManagers/FontTableManager";
export { readFsType, embeddingPermission, canEmbed } from "./core/fonts/fsType";
export type { EmbeddingPermission } from "./core/fonts/fsType";
export { obfuscateFont, fontKeyBytes, newFontKey } from "./core/fonts/obfuscate";
```

The manager reads parts through its own `read()` helper (`getEntry` → `getData()`), so it does not depend on how `ZipManager.readAsText` reports a missing entry, and both branches of every guard are reachable from the tests (the coverage gate needs that).

- [ ] **Step 6: Run the manager tests**

Run: `npx vitest run src/core/PartsManagers/FontTableManager.spec.ts`
Expected: PASS. If the doctor test reports a fatal finding, print it (`console.log(report.findings)`) and fix the manager. Never relax the assertion. (If `DoctorReport` names its list differently than `findings`, read `src/doctor/index.ts` around line 72 and use that name.) The "does not duplicate" test assumes `samples/example.docx` already has a fontTable relationship; if it does not, the mutate in that test must add one first.

- [ ] **Step 7: Run the engine gate**

Run: `npx vitest run src/core/fonts src/core/PartsManagers/FontTableManager.spec.ts --coverage --coverage.include='src/core/fonts/**' --coverage.include=src/core/PartsManagers/FontTableManager.ts`
Expected: all pass, and the coverage table shows 100% for `fsType.ts`, `obfuscate.ts` and `FontTableManager.ts` (statements, branches, functions, lines). If a branch in `FontTableManager.ts` is uncovered, add the missing case to the spec (the report lists the line); do not add `/* v8 ignore */`.
Then run `npx vitest run` (no coverage) and confirm no spec fails that passed at base commit `4fffabb`. If any spec fails, run it on `4fffabb` in a temporary `git worktree` to prove it is pre-existing.

- [ ] **Step 8: Commit**

```bash
git add src/core/PartsManagers/FontTableManager.ts src/core/PartsManagers/FontTableManager.spec.ts src/index.ts
git commit -m "feat(fonts): FontTableManager embeds licensed fonts into a docx

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Build the engine for the server

**Files:** none (build output in `dist/` is gitignored)

- [ ] **Step 1: Build**

Run: `cd ~/mdocxengine && npm run build`
Expected: exits 0; `dist/index.mjs` contains `FontTableManager`.

- [ ] **Step 2: Confirm kwill-server sees it**

Run: `cd ~/kwill-server && node -e "import('@kwill/docx-engine').then(m => console.log(typeof m.FontTableManager, typeof m.readFsType))"`
Expected: `function function`

---

## Task 5: Lab scaffolding (server)

**Files:**
- Modify: `~/kwill-server/.gitignore`
- Create: `~/kwill-server/scripts/rescue-lab/README.md`

- [ ] **Step 1: Ignore the lab folder**

Append to `.gitignore`:

```
# Rescue lab — students' theses, renders, brain tasks. Never commit.
lab/
```

- [ ] **Step 2: Verify**

Run: `cd ~/kwill-server && mkdir -p lab/corpus && touch lab/corpus/x.docx && git check-ignore lab/corpus/x.docx && rm lab/corpus/x.docx`
Expected: prints `lab/corpus/x.docx`.

- [ ] **Step 3: Write the README**

```markdown
# Rescue lab (dev-only)

The lab runs the Rescue v2 pipeline on real theses, with **Claude in the Claude Code
session as the brain** (spec: ~/kwill/docs/superpowers/specs/2026-11-02-rescue-v2-design.md).

## Privacy
`lab/` holds students' theses and is gitignored. Never copy anything from it into a
tracked path, a commit, a PR, an issue or a chat outside this machine.

## Layout
    lab/
      corpus/<id>/
        meta.json              source (disk|gmail), original names, permission note
        original/              the uploaded file(s), untouched
        read/inventory.json    blocks, keys, facts, counts, fingerprint
        read/document.pdf      Word's rendering
        read/pages/page-NNN.png
        read/overview/sheet-NN.png   9 pages per sheet
        read/page-map.json     which block starts on which page
        gold/map.json          Claude's approved roles (the answer key)
      runs/<runId>/map.json    merged answers of one map run
      tasks/<runId>/<taskId>.task.json      written by the pipeline
      tasks/<runId>/<taskId>.answer.json    written by Claude
      tasks/<runId>/<taskId>.error.json     why an answer was rejected
      tasks/<runId>/<taskId>.accepted       marker

## Commands (from ~/kwill-server)
The Word converter must be running: `node scripts/word-convert-service.mjs` (port 8092).

    npx tsx scripts/rescue-lab/cli.ts intake <id> <file.docx>... --source disk|gmail --permission "<note>"
    npx tsx scripts/rescue-lab/cli.ts read <id>
    npx tsx scripts/rescue-lab/cli.ts map <id>
    npx tsx scripts/rescue-lab/cli.ts pending
    npx tsx scripts/rescue-lab/cli.ts approve-map <id> <runId>
    npx tsx scripts/rescue-lab/font-proof.ts
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore scripts/rescue-lab/README.md
git commit -m "chore(rescue-lab): ignore lab/ and document the lab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Block keys (server)

**Files:**
- Create: `~/kwill-server/src/lib/rescue/blocks/block-key.ts`
- Test: `~/kwill-server/src/lib/rescue/__tests__/block-key.test.ts`

A block key identifies a block by **content**, never by position (CLAUDE.md: indices shift). It hashes the block's kind, its normalised text, and a little context from each neighbour. Identical bases get `#2`, `#3`, … in document order. Editing a block changes its own key and its neighbours' keys; M4's re-run diff handles that with a second, text-only matching pass.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rescue/__tests__/block-key.test.ts
import { describe, it, expect } from "vitest";
import { normalizeForKey, blockKeys } from "../blocks/block-key";

const p = (text: string) => ({ kind: "paragraph", text });

describe("normalizeForKey", () => {
  it("ignores tatweel, tashkeel, bidi marks, case and whitespace runs", () => {
    expect(normalizeForKey("  الفـــصل   الأَوَّل‏ ")).toBe("الفصل الأول");
    expect(normalizeForKey("Chapitre  I")).toBe("chapitre i");
  });
});

describe("blockKeys", () => {
  it("is stable across calls", () => {
    const blocks = [p("مقدمة"), p("نص"), p("خاتمة")];
    expect(blockKeys(blocks)).toEqual(blockKeys(blocks));
  });
  it("gives the same text different keys in different places", () => {
    const keys = blockKeys([p("أ"), p("خلاصة"), p("ب"), p("خلاصة"), p("ج")]);
    expect(keys[1]).not.toBe(keys[3]);
  });
  it("suffixes identical blocks in identical surroundings", () => {
    const keys = blockKeys([p("X"), p(""), p("X"), p(""), p("X")]);
    expect(keys[3]).toBe(`${keys[1]}#2`);
    expect(new Set(keys).size).toBe(5);
  });
  it("separates kinds", () => {
    const [a] = blockKeys([{ kind: "paragraph", text: "T" }]);
    const [b] = blockKeys([{ kind: "table", text: "T" }]);
    expect(a).not.toBe(b);
  });
  it("does not change when only tatweel or spacing changes", () => {
    expect(blockKeys([p("الفصل الأول")])).toEqual(blockKeys([p("الفـصل  الأول")]));
  });
  it("is 16 hex characters", () => {
    expect(blockKeys([p("a")])[0]).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/kwill-server && npx vitest run src/lib/rescue/__tests__/block-key.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rescue/blocks/block-key.ts
// Content-based identity for a block. Never store indices — they shift.
import { createHash } from "node:crypto";

export interface KeyInput { kind: string; text: string }

const BIDI = /[​-‏‪-‮⁦-⁩﻿]/g;
const TATWEEL = /ـ/g;
const TASHKEEL = /[ً-ٰٟ]/g;

export function normalizeForKey(text: string): string {
  return text
    .normalize("NFC")
    .replace(BIDI, "")
    .replace(TATWEEL, "")
    .replace(TASHKEEL, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function blockKeys(blocks: KeyInput[]): string[] {
  const norm = blocks.map((b) => normalizeForKey(b.text));
  const seen = new Map<string, number>();
  return blocks.map((b, i) => {
    const prev = (norm[i - 1] ?? "").slice(-40);
    const next = (norm[i + 1] ?? "").slice(0, 40);
    const base = createHash("sha1")
      .update(`${b.kind}\u0001${norm[i]}\u0001${prev}\u0001${next}`)
      .digest("hex")
      .slice(0, 16);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rescue/__tests__/block-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rescue/blocks/block-key.ts src/lib/rescue/__tests__/block-key.test.ts
git commit -m "feat(rescue): content-based block keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Guard test — no model client in the rescue module (server)

**Files:**
- Test: `~/kwill-server/src/lib/rescue/__tests__/no-model-client.test.ts`

Until milestone M7, the brain is Claude in the session. A model client inside `src/lib/rescue/` would quietly spend money and bypass the answer key. Folders inside `src/lib/rescue/` must never be named `ai` or `format`, so these patterns stay unambiguous.

- [ ] **Step 1: Write the test**

```ts
// src/lib/rescue/__tests__/no-model-client.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)); // src/lib/rescue/

/** Import specifiers a rescue module must never use (static or dynamic). */
const FORBIDDEN: RegExp[] = [
  /^(\.\.\/)+ai(\/|$)/,              // every model client and provider lives under src/lib/ai
  /^(\.\.\/)+embedding-service$/,
  /^(\.\.\/)+stt$/,
  /^(\.\.\/)+tts$/,
  /^(\.\.\/)+format(\/|$)/,          // the old pipeline (calls models, deleted after v2)
  /^(\.\.\/)+thesis-classify$/,
  /^(\.\.\/)+thesis-structure$/,
  /^(\.\.\/)+thesis-plan$/,
  /^(\.\.\/)+chat-memory$/,
  /^openai$/,
  /^@openrouter\/sdk$/,
];
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g; // from "x" · import("x") · import "x"

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("src/lib/rescue stays model-free until M7", () => {
  const files = sourceFiles(ROOT);

  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports no model client and nothing from the old pipeline", () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(SPECIFIER)) {
        if (FORBIDDEN.some((re) => re.test(m[1]))) violations.push(`${relative(ROOT, f)} → ${m[1]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Prove it catches a violation**

Temporarily add `import "../../ai/features";` as the first line of `src/lib/rescue/blocks/block-key.ts`.
Run: `npx vitest run src/lib/rescue/__tests__/no-model-client.test.ts`
Expected: FAIL listing `blocks/block-key.ts → ../../ai/features`.
**Remove the line again** and re-run. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "test(rescue): guard — no model client in src/lib/rescue until M7

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Read inventory (server)

**Files:**
- Create: `~/kwill-server/src/lib/rescue/read/inventory.ts`
- Test: `~/kwill-server/src/lib/rescue/__tests__/inventory.test.ts`

The inventory is what every later stage reads: one entry per engine body block (same indexing as `injectBlockMarkers`, so the page map lines up), its key, its facts, the document counts, and a fingerprint of the word sequence for Prove (M2).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rescue/__tests__/inventory.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readInventory, wordsOf, fingerprintOf } from "../read/inventory";
import { injectBlockMarkers } from "../../render/page-markers";

const SAMPLE = readFileSync(new URL("../../../../assets/thesis-base.docx", import.meta.url));

describe("wordsOf / fingerprintOf", () => {
  it("splits normalised text into words", () => {
    expect(wordsOf("  الفـصل   الأول ")).toEqual(["الفصل", "الأول"]);
    expect(wordsOf("   ")).toEqual([]);
  });
  it("fingerprints the word sequence, not its spacing", () => {
    expect(fingerprintOf(["a", "b"])).toBe(fingerprintOf(wordsOf("a   b")));
    expect(fingerprintOf(["a", "b"])).not.toBe(fingerprintOf(["b", "a"]));
    expect(fingerprintOf(["a"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readInventory", () => {
  it("lists every engine block with a unique key and consistent counts", async () => {
    const inv = await readInventory(SAMPLE);
    expect(inv.blocks.length).toBeGreaterThan(0);
    expect(new Set(inv.blocks.map((b) => b.key)).size).toBe(inv.blocks.length);
    inv.blocks.forEach((b, i) => expect(b.i).toBe(i));
    expect(inv.counts.blocks).toBe(inv.blocks.length);
    expect(inv.counts.tables).toBe(inv.blocks.filter((b) => b.kind === "table").length);
    expect(inv.counts.figures).toBe(inv.blocks.filter((b) => b.flags.includes("drawing")).length);
    expect(inv.counts.words).toBe(inv.blocks.reduce((n, b) => n + wordsOf(b.text).length, 0));
  });

  it("uses the same block indexing as the page markers", async () => {
    const inv = await readInventory(SAMPLE);
    expect(injectBlockMarkers(SAMPLE).blockCount).toBe(inv.blocks.length);
  });

  it("is deterministic", async () => {
    const [a, b] = await Promise.all([readInventory(SAMPLE), readInventory(SAMPLE)]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.blocks.map((x) => x.key)).toEqual(b.blocks.map((x) => x.key));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/rescue/__tests__/inventory.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rescue/read/inventory.ts
// Stage 1 (READ) core: what is in the student's file, with no judgement.
import { createHash } from "node:crypto";
import {
  Mdocxengine,
  paragraphText,
  paragraphStyleId,
  paragraphHeadingLevel,
  paragraphAlignment,
  paragraphFontSizePt,
  paragraphIsBold,
} from "@kwill/docx-engine";
import { holdsOf, isBlankText } from "../../docx-empty-blocks";
import { blockKeys, normalizeForKey } from "../blocks/block-key";

export type InvBlockKind = "paragraph" | "table" | "other";

export interface InvBlock {
  i: number;
  key: string;
  kind: InvBlockKind;
  text: string;
  styleId: string | null;
  level: number;
  align: string | null;
  bold: boolean;
  sizePt: number | null;
  /** holdsOf() names (math, section-break, page-break, drawing, bookmark, field, footnote) + "blank". */
  flags: string[];
}

export interface InventoryCounts {
  blocks: number;
  words: number;
  footnotes: number;
  figures: number;
  tables: number;
  equations: number;
  sectionBreaks: number;
}

export interface Inventory {
  blocks: InvBlock[];
  counts: InventoryCounts;
  /** sha256 of the normalised word sequence — Prove compares against it. */
  fingerprint: string;
}

const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

function tableText(xml: string): string {
  return (xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map((p) => paragraphText(p)).join(" ");
}

export function wordsOf(text: string): string[] {
  const n = normalizeForKey(text);
  return n ? n.split(" ") : [];
}

export function fingerprintOf(words: string[]): string {
  return createHash("sha256").update(words.join(" ")).digest("hex");
}

export async function readInventory(docx: Buffer): Promise<Inventory> {
  const engine = await Mdocxengine.loadFromBuffer(docx);
  const raw = await engine.document.getBlocks();

  const partial = raw.map((b) => {
    const kind: InvBlockKind = b.kind === "paragraph" ? "paragraph" : b.kind === "table" ? "table" : "other";
    const isPara = kind === "paragraph";
    const text = isPara ? paragraphText(b.xml) : kind === "table" ? tableText(b.xml) : "";
    const flags: string[] = [...holdsOf(b.xml)];
    if (isPara && isBlankText(text)) flags.push("blank");
    return {
      kind,
      text,
      xml: b.xml,
      styleId: isPara ? paragraphStyleId(b.xml) : null,
      level: isPara ? paragraphHeadingLevel(b.xml) : 0,
      align: isPara ? paragraphAlignment(b.xml) : null,
      bold: isPara ? paragraphIsBold(b.xml) : false,
      sizePt: isPara ? paragraphFontSizePt(b.xml) : null,
      flags,
    };
  });

  const keys = blockKeys(partial);
  const blocks: InvBlock[] = partial.map((b, i) => ({
    i, key: keys[i], kind: b.kind, text: b.text, styleId: b.styleId, level: b.level,
    align: b.align, bold: b.bold, sizePt: b.sizePt, flags: b.flags,
  }));

  const words = blocks.flatMap((b) => wordsOf(b.text));
  const counts: InventoryCounts = {
    blocks: blocks.length,
    words: words.length,
    footnotes: partial.reduce((n, b) => n + count(b.xml, /<w:footnoteReference\b/g), 0),
    figures: blocks.filter((b) => b.flags.includes("drawing")).length,
    tables: blocks.filter((b) => b.kind === "table").length,
    equations: partial.reduce((n, b) => n + count(b.xml, /<m:oMath\b/g), 0),
    sectionBreaks: blocks.filter((b) => b.flags.includes("section-break")).length,
  };
  return { blocks, counts, fingerprint: fingerprintOf(words) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rescue/__tests__/inventory.test.ts`
Expected: PASS. If the indexing test fails, the counts differ between `getBlocks()` and `injectBlockMarkers`. Open `src/lib/render/page-markers.ts` around line 100, see which blocks it counts, and align `readInventory` to it (filter the same way). The page map in Task 11 depends on these matching.

- [ ] **Step 5: Run the guard and type check**

Run: `npx vitest run src/lib/rescue && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rescue/read/inventory.ts src/lib/rescue/__tests__/inventory.test.ts
git commit -m "feat(rescue): read inventory — blocks, keys, facts, counts, fingerprint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Brain task schema — map (server)

**Files:**
- Create: `~/kwill-server/src/lib/rescue/brain/tasks.ts`
- Test: `~/kwill-server/src/lib/rescue/__tests__/tasks.test.ts`

Only the `map` task is defined in M0; the other tasks (`order_parts`, `ask`, `review`, `read_cover`, `read_guide`, `parse_note`) land in the milestones that use them. `MAP_INSTRUCTIONS` is what Claude reads when answering, and it seeds the production prompt in M7. It lives in `src/lib/rescue/`, not in `src/lib/ai/types.ts`, so the backtick rule does not apply; still, write it without backticks.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rescue/__tests__/tasks.test.ts
import { describe, it, expect } from "vitest";
import { ROLES, validateMapAnswer, type MapTask } from "../brain/tasks";

const task = (index = 0): MapTask => ({
  id: "map-w0", kind: "map", runId: "r1", corpusId: "t1",
  window: { index, count: 2, from: 0, to: 1, total: 4 },
  instructions: "…",
  blocks: [
    { key: "k0", i: 0, kind: "paragraph", text: "مقدمة", styleId: null, level: 0, align: "center", bold: true, sizePt: 16, flags: [] },
    { key: "k1", i: 1, kind: "paragraph", text: "", styleId: null, level: 0, align: null, bold: false, sizePt: null, flags: ["blank"] },
  ],
  context: { before: [], after: [] },
  pages: [],
});

const answer = (extra: object = {}) => ({
  taskId: "map-w0",
  roles: [{ key: "k0", role: "h1", confidence: 0.9 }, { key: "k1", role: "junk", confidence: 1 }],
  format: "classic",
  ...extra,
});

describe("validateMapAnswer", () => {
  it("accepts a complete answer", () => {
    const res = validateMapAnswer(task(), answer());
    expect(res.ok).toBe(true);
    expect(res.value?.roles).toHaveLength(2);
  });
  it("rejects a missing key, an unknown key and a duplicate", () => {
    const res = validateMapAnswer(task(), answer({
      roles: [{ key: "k0", role: "h1", confidence: 0.9 }, { key: "k0", role: "body", confidence: 0.5 }, { key: "zz", role: "body", confidence: 1 }],
    }));
    expect(res.ok).toBe(false);
    expect(res.errors?.join("\n")).toMatch(/missing.*k1/i);
    expect(res.errors?.join("\n")).toMatch(/unknown.*zz/i);
    expect(res.errors?.join("\n")).toMatch(/twice.*k0/i);
  });
  it("rejects a role outside the vocabulary and an out-of-range confidence", () => {
    const res = validateMapAnswer(task(), answer({ roles: [{ key: "k0", role: "title", confidence: 2 }, { key: "k1", role: "junk", confidence: 1 }] }));
    expect(res.ok).toBe(false);
  });
  it("requires the document format on the first window only", () => {
    expect(validateMapAnswer(task(0), answer({ format: undefined })).ok).toBe(false);
    expect(validateMapAnswer(task(1), answer({ format: undefined })).ok).toBe(true);
  });
  it("rejects an answer for another task", () => {
    expect(validateMapAnswer(task(), answer({ taskId: "other" })).ok).toBe(false);
  });
  it("forbids junk on a block with text", () => {
    const res = validateMapAnswer(task(), answer({ roles: [{ key: "k0", role: "junk", confidence: 1 }, { key: "k1", role: "junk", confidence: 1 }] }));
    expect(res.ok).toBe(false);
    expect(res.errors?.join("\n")).toMatch(/junk.*k0.*text/i);
  });
  it("exposes the full role vocabulary", () => {
    expect(ROLES).toContain("caption-figure");
    expect(ROLES).toContain("typed-toc");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/rescue/__tests__/tasks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rescue/brain/tasks.ts
// The brain's contract. Claude answers these in M0–M6; a model does in M7.
// Every answer is validated here — a wrong answer is rejected, never repaired.
import { z } from "zod";
import { isBlankText } from "../../docx-empty-blocks";

export const ROLES = [
  "cover", "dedication", "thanks", "abbreviations",
  "abstract-ar", "abstract-fr", "abstract-en",
  "typed-toc", "typed-list", "divider-page", "part",
  "h1", "h2", "h3", "h4",
  "body", "quote", "list-item",
  "figure", "table", "equation", "caption-figure", "caption-table",
  "bibliography-heading", "bibliography-entry",
  "annex-heading", "annex-body",
  "junk",
] as const;
export type Role = (typeof ROLES)[number];

export const FORMATS = ["classic", "imrad", "1275"] as const;
export type DocFormat = (typeof FORMATS)[number];

export interface MapBlock {
  key: string;
  i: number;
  kind: string;
  /** Truncated to 400 characters; `fullLength` is set when cut. */
  text: string;
  fullLength?: number;
  styleId: string | null;
  level: number;
  align: string | null;
  bold: boolean;
  sizePt: number | null;
  flags: string[];
}

export interface MapTask {
  id: string;
  kind: "map";
  runId: string;
  corpusId: string;
  window: { index: number; count: number; from: number; to: number; total: number };
  instructions: string;
  blocks: MapBlock[];
  /** A few blocks either side of the window, for context only — do not answer them. */
  context: { before: MapBlock[]; after: MapBlock[] };
  /** Page images (absolute paths) and the keys of the blocks that start on each page. */
  pages: { page: number; image: string; keys: string[] }[];
}

export interface MapRole { key: string; role: Role; confidence: number }
export interface MapAnswer { taskId: string; roles: MapRole[]; format?: DocFormat; notes?: string }

/** Flat on purpose: tsconfig has strict:false, which does not narrow unions. */
export interface Validation<T> { ok: boolean; value?: T; errors?: string[] }

const AnswerSchema = z.object({
  taskId: z.string(),
  roles: z.array(z.object({
    key: z.string(),
    role: z.enum(ROLES),
    confidence: z.number().min(0).max(1),
  })),
  format: z.enum(FORMATS).optional(),
  notes: z.string().optional(),
});

export function validateMapAnswer(task: MapTask, raw: unknown): Validation<MapAnswer> {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const a = parsed.data as MapAnswer;
  const errors: string[] = [];
  if (a.taskId !== task.id) errors.push(`taskId is ${a.taskId}, expected ${task.id}`);
  if (task.window.index === 0 && !a.format) errors.push("format is required on the first window");

  const byKey = new Map(task.blocks.map((b) => [b.key, b]));
  const seen = new Set<string>();
  for (const r of a.roles) {
    if (!byKey.has(r.key)) errors.push(`unknown key ${r.key}`);
    else if (seen.has(r.key)) errors.push(`answered twice: ${r.key}`);
    seen.add(r.key);
    const b = byKey.get(r.key);
    if (b && r.role === "junk" && !isBlankText(b.text)) {
      errors.push(`junk on ${r.key}, which has text — junk may only remove empty paragraphs`);
    }
  }
  for (const b of task.blocks) if (!seen.has(b.key)) errors.push(`missing key ${b.key}`);
  return errors.length ? { ok: false, errors } : { ok: true, value: a };
}

export const MAP_INSTRUCTIONS = [
  "You are mapping an Algerian mémoire (master/licence thesis). Give EVERY block in `blocks` exactly one role.",
  "Do not answer the blocks in `context`; they are there so you can see what surrounds the window.",
  "Look at the page images before deciding anything about covers, dedications, divider pages and title pages: a cover is recognised by how the page looks, never by bold capitals alone.",
  "Roles: cover (any line of a cover page) · dedication (الإهداء) · thanks (شكر وعرفان / remerciements) · abbreviations (list of abbreviations) · abstract-ar/fr/en (the abstract and its keywords, by language) · typed-toc (a table of contents typed by hand, not a Word field) · typed-list (a list of figures/tables typed by hand) · divider-page (a page that only announces a part or chapter) · part (a part title above chapters) · h1 (chapter, introduction, conclusion, bibliography and annex titles) · h2 · h3 · h4 · body · quote · list-item · figure (a picture, chart or drawn diagram) · table · equation · caption-figure · caption-table · bibliography-heading · bibliography-entry · annex-heading · annex-body · junk (an EMPTY paragraph used as spacing — never a block with text).",
  "A numbered line like '1. Définition' or '2.1 Selon Maslow' is usually a heading, not a list item.",
  "confidence is 0..1. Use below 0.7 only when you genuinely cannot tell — those become questions for the student, at most 5 per thesis.",
  "On the first window, also give `format`: classic, imrad, or 1275 (business-model / startup mémoire).",
  "Answer as JSON: { taskId, roles: [{ key, role, confidence }], format?, notes? } in a file named <taskId>.answer.json next to the task.",
].join("\n");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rescue/__tests__/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rescue/brain/tasks.ts src/lib/rescue/__tests__/tasks.test.ts
git commit -m "feat(rescue): map task contract — roles, formats, validation, instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Session brain (server)

**Files:**
- Create: `~/kwill-server/src/lib/rescue/brain/session-brain.ts`
- Test: `~/kwill-server/src/lib/rescue/__tests__/session-brain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rescue/__tests__/session-brain.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBrain, BrainTimeoutError, listPending } from "../brain/session-brain";
import type { Validation } from "../brain/tasks";

const isEven = (raw: unknown): Validation<number> =>
  typeof (raw as { n?: unknown })?.n === "number" && (raw as { n: number }).n % 2 === 0
    ? { ok: true, value: (raw as { n: number }).n }
    : { ok: false, errors: ["n must be an even number"] };

const later = (ms: number, fn: () => Promise<void>) => setTimeout(() => void fn(), ms);

describe("SessionBrain", () => {
  it("writes the task and resolves with the first valid answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-"));
    const brain = new SessionBrain({ dir, pollMs: 10, timeoutMs: 2000 });
    later(30, () => writeFile(join(dir, "t1.answer.json"), JSON.stringify({ n: 4 })));
    await expect(brain.ask({ id: "t1", kind: "test" }, isEven)).resolves.toBe(4);
    expect(JSON.parse(await readFile(join(dir, "t1.task.json"), "utf8"))).toEqual({ id: "t1", kind: "test" });
    expect(await readdir(dir)).toContain("t1.accepted");
  });

  it("rejects an invalid answer with a reason, then accepts a corrected one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-"));
    const brain = new SessionBrain({ dir, pollMs: 10, timeoutMs: 2000 });
    later(20, () => writeFile(join(dir, "t2.answer.json"), JSON.stringify({ n: 3 })));
    later(150, () => writeFile(join(dir, "t2.answer.json"), JSON.stringify({ n: 6 })));
    await expect(brain.ask({ id: "t2", kind: "test" }, isEven)).resolves.toBe(6);
    const err = JSON.parse(await readFile(join(dir, "t2.error.json"), "utf8"));
    expect(err).toEqual({ attempt: 1, errors: ["n must be an even number"] });
    expect(await readdir(dir)).toContain("t2.answer.rejected-1.json");
  });

  it("explains malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-"));
    const brain = new SessionBrain({ dir, pollMs: 10, timeoutMs: 2000 });
    later(20, () => writeFile(join(dir, "t3.answer.json"), "{ not json"));
    later(150, () => writeFile(join(dir, "t3.answer.json"), JSON.stringify({ n: 2 })));
    await brain.ask({ id: "t3", kind: "test" }, isEven);
    const err = JSON.parse(await readFile(join(dir, "t3.error.json"), "utf8"));
    expect(err.errors[0]).toMatch(/not valid JSON/);
  });

  it("times out when no valid answer arrives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-"));
    const brain = new SessionBrain({ dir, pollMs: 10, timeoutMs: 80 });
    await expect(brain.ask({ id: "t4", kind: "test" }, isEven)).rejects.toBeInstanceOf(BrainTimeoutError);
  });

  it("lists pending tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-"));
    await writeFile(join(dir, "a.task.json"), "{}");
    await writeFile(join(dir, "b.task.json"), "{}");
    await writeFile(join(dir, "b.accepted"), "");
    expect(await listPending(dir)).toEqual(["a"]);
    expect(await listPending(join(dir, "missing"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/rescue/__tests__/session-brain.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rescue/brain/session-brain.ts
// The M0–M6 brain: Claude, answering from the Claude Code session through a
// file queue. ask() writes <id>.task.json and waits for <id>.answer.json; an
// invalid answer is moved aside with a written reason and the wait goes on.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Validation } from "./tasks";

export interface BrainTaskBase { id: string; kind: string }

export interface SessionBrainOptions {
  dir: string;
  pollMs?: number;
  /** Default 6 hours: Claude may be rescuing another thesis. */
  timeoutMs?: number;
}

export class BrainTimeoutError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readAnswer(path: string): Promise<{ found: boolean; value?: unknown; parseError?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { found: false };
  }
  try {
    return { found: true, value: JSON.parse(text) };
  } catch (e) {
    return { found: true, parseError: (e as Error).message };
  }
}

export class SessionBrain {
  constructor(private readonly opts: SessionBrainOptions) {}

  async ask<T>(task: BrainTaskBase, validate: (raw: unknown) => Validation<T>): Promise<T> {
    const { dir } = this.opts;
    await mkdir(dir, { recursive: true });
    const base = join(dir, task.id);
    await writeFile(`${base}.task.json`, JSON.stringify(task, null, 2));
    const deadline = Date.now() + (this.opts.timeoutMs ?? 6 * 3600_000);
    let attempt = 0;
    while (Date.now() < deadline) {
      const a = await readAnswer(`${base}.answer.json`);
      if (a.found) {
        const res: Validation<T> = a.parseError
          ? { ok: false, errors: [`answer is not valid JSON: ${a.parseError}`] }
          : validate(a.value);
        if (res.ok === true) {
          await writeFile(`${base}.accepted`, new Date().toISOString());
          return res.value as T;
        }
        attempt++;
        await rename(`${base}.answer.json`, `${base}.answer.rejected-${attempt}.json`);
        await writeFile(`${base}.error.json`, JSON.stringify({ attempt, errors: res.errors ?? [] }, null, 2));
      }
      await sleep(this.opts.pollMs ?? 1000);
    }
    throw new BrainTimeoutError(`No valid answer for ${task.id} before the timeout`);
  }
}

/** Task ids in `dir` that have no .accepted marker. */
export async function listPending(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const accepted = new Set(names.filter((n) => n.endsWith(".accepted")).map((n) => n.slice(0, -".accepted".length)));
  return names
    .filter((n) => n.endsWith(".task.json"))
    .map((n) => n.slice(0, -".task.json".length))
    .filter((id) => !accepted.has(id))
    .sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rescue/__tests__/session-brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rescue/brain/session-brain.ts src/lib/rescue/__tests__/session-brain.test.ts
git commit -m "feat(rescue): session brain — file-queue tasks answered by Claude

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Lab renderer (server, dev-only script module)

**Files:**
- Create: `~/kwill-server/scripts/rescue-lab/render.ts`

This lives in `scripts/` because it serves a local file to the local Word converter; production rendering (M1+) goes through `thesis-render`'s storage path. It is verified by running it (Task 13), not by unit tests, because it needs Word.

- [ ] **Step 1: Implement**

```ts
// scripts/rescue-lab/render.ts
// Renders a .docx through the real Word converter (scripts/word-convert-service.mjs):
// the PDF, page PNGs, 9-page overview sheets, and the page map (which block
// starts on which page). Serves the bytes from a throwaway local HTTP server,
// because the converter fetches a URL rather than accepting bytes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertDocxToPdf, convertDocxToPagePngs, isWordConverterReachable } from "../../src/lib/word-converter";
import { unzipPagePngs, tileOverview, OVERVIEW_MAX } from "../../src/lib/render/page-images";
import { extractPdfText } from "../../src/lib/render/pdf-text";
import { injectBlockMarkers, bottomMarginPt, topMarginPt } from "../../src/lib/render/page-markers";
import { buildPageMap, type PageMap } from "../../src/lib/render/page-map";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PAGE_W = 1100;
const PAGE_H = Math.round(PAGE_W * 1.4142);

export async function serveOnce<T>(bytes: Buffer, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": DOCX_MIME, "Content-Length": bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}/document.docx`);
  } finally {
    server.close();
  }
}

export async function assertConverter(): Promise<void> {
  if (!(await isWordConverterReachable())) {
    throw new Error("Word converter not reachable. Start it: node scripts/word-convert-service.mjs (and check WORD_CONVERTER_URL in .env)");
  }
}

export interface LabRender {
  pdfPath: string;
  pagePaths: string[];
  overviewPaths: string[];
  pageMap: PageMap;
}

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

export async function renderForLab(docx: Buffer, outDir: string, title: string): Promise<LabRender> {
  await assertConverter();
  await mkdir(join(outDir, "pages"), { recursive: true });
  await mkdir(join(outDir, "overview"), { recursive: true });

  const pdf = await serveOnce(docx, (srcUrl) => convertDocxToPdf({ srcUrl, title }));
  const pdfPath = join(outDir, "document.pdf");
  await writeFile(pdfPath, pdf);

  const zip = await serveOnce(docx, (srcUrl) => convertDocxToPagePngs({ srcUrl, title, widthPx: PAGE_W, heightPx: PAGE_H }));
  const pngs = unzipPagePngs(zip);
  const pagePaths: string[] = [];
  for (let i = 0; i < pngs.length; i++) {
    const p = join(outDir, "pages", `page-${pad(i + 1)}.png`);
    await writeFile(p, pngs[i]);
    pagePaths.push(p);
  }

  const overviewPaths: string[] = [];
  for (let s = 0; s < pngs.length; s += OVERVIEW_MAX) {
    const pages = pngs.slice(s, s + OVERVIEW_MAX).map((buffer, k) => ({ buffer, page: s + k + 1 }));
    const p = join(outDir, "overview", `sheet-${pad(s / OVERVIEW_MAX + 1, 2)}.png`);
    await writeFile(p, await tileOverview(pages));
    overviewPaths.push(p);
  }

  const marked = injectBlockMarkers(docx);
  const markedPdf = await serveOnce(marked.bytes, (srcUrl) => convertDocxToPdf({ srcUrl, title: `${title} (marked)` }));
  const pageMap = buildPageMap(await extractPdfText(markedPdf), {
    bottomMarginPt: bottomMarginPt(docx),
    topMarginPt: topMarginPt(docx),
    kinds: marked.kinds,
    unmapped: marked.unmarked,
  });
  await writeFile(join(outDir, "page-map.json"), JSON.stringify(pageMap, null, 2));
  return { pdfPath, pagePaths, overviewPaths, pageMap };
}
```

- [ ] **Step 2: Type-check the script**

`npm run build` does not typecheck `scripts/`. Run: `cd ~/kwill-server && npx tsc --noEmit --ignoreConfig --strict false --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck scripts/rescue-lab/render.ts`
Expected: no errors. If `OverviewPage`'s field names differ from `{ buffer, page }`, read `src/lib/render/page-images.ts` around line 60 and match them.

- [ ] **Step 3: Commit**

```bash
git add scripts/rescue-lab/render.ts
git commit -m "feat(rescue-lab): render a docx through Word — PDF, pages, overviews, page map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Map-task builder (server)

**Files:**
- Create: `~/kwill-server/src/lib/rescue/map/build-map-tasks.ts`
- Test: `~/kwill-server/src/lib/rescue/__tests__/build-map-tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rescue/__tests__/build-map-tasks.test.ts
import { describe, it, expect } from "vitest";
import { buildMapTasks } from "../map/build-map-tasks";
import type { Inventory, InvBlock } from "../read/inventory";

const block = (i: number, text = `t${i}`): InvBlock => ({
  i, key: `k${i}`, kind: "paragraph", text, styleId: null, level: 0, align: null, bold: false, sizePt: null, flags: [],
});
const inv = (n: number): Inventory => ({
  blocks: Array.from({ length: n }, (_, i) => block(i)),
  counts: { blocks: n, words: n, footnotes: 0, figures: 0, tables: 0, equations: 0, sectionBreaks: 0 },
  fingerprint: "f",
});
// block i starts on page floor(i/10)+1
const pageOf = new Map(Array.from({ length: 300 }, (_, i) => [i, Math.floor(i / 10) + 1] as [number, number]));
const image = (p: number) => `/lab/pages/page-${p}.png`;

describe("buildMapTasks", () => {
  it("splits blocks into windows that cover every block exactly once", () => {
    const tasks = buildMapTasks(inv(250), { runId: "r", corpusId: "c", windowSize: 100, pageOf, pageImage: image });
    expect(tasks.map((t) => t.window)).toEqual([
      { index: 0, count: 3, from: 0, to: 99, total: 250 },
      { index: 1, count: 3, from: 100, to: 199, total: 250 },
      { index: 2, count: 3, from: 200, to: 249, total: 250 },
    ]);
    expect(tasks.flatMap((t) => t.blocks.map((b) => b.i))).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(tasks[0].id).toBe("map-r-w0");
  });

  it("adds context blocks that are not part of the window", () => {
    const [, second] = buildMapTasks(inv(250), { runId: "r", corpusId: "c", windowSize: 100, contextSize: 3, pageOf, pageImage: image });
    expect(second.context.before.map((b) => b.i)).toEqual([97, 98, 99]);
    expect(second.context.after.map((b) => b.i)).toEqual([200, 201, 202]);
  });

  it("gives the first window the first six pages and later windows their own pages, at most four", () => {
    const [first, second] = buildMapTasks(inv(250), { runId: "r", corpusId: "c", windowSize: 100, pageOf, pageImage: image });
    expect(first.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.pages[0]).toEqual({ page: 1, image: image(1), keys: ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"] });
    expect(second.pages.length).toBeLessThanOrEqual(4);
    second.pages.forEach((p) => expect(p.page).toBeGreaterThanOrEqual(11));
  });

  it("truncates long text and records the full length", () => {
    const long = inv(1);
    long.blocks[0].text = "x".repeat(1000);
    const [t] = buildMapTasks(long, { runId: "r", corpusId: "c", pageOf, pageImage: image });
    expect(t.blocks[0].text.length).toBe(401);
    expect(t.blocks[0].fullLength).toBe(1000);
  });

  it("works without a page map", () => {
    const [t] = buildMapTasks(inv(5), { runId: "r", corpusId: "c", pageOf: new Map(), pageImage: image });
    expect(t.pages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/rescue/__tests__/build-map-tasks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rescue/map/build-map-tasks.ts
// Turns an inventory into windowed map tasks for the brain. Windows keep each
// task readable (about 120 blocks); context blocks show what surrounds a
// window; page images let the brain LOOK at covers and divider pages.
import type { Inventory, InvBlock } from "../read/inventory";
import { MAP_INSTRUCTIONS, type MapBlock, type MapTask } from "../brain/tasks";

export interface BuildMapTasksOptions {
  runId: string;
  corpusId: string;
  windowSize?: number;
  contextSize?: number;
  /** block index -> 1-based page it starts on (from the page map). */
  pageOf: Map<number, number>;
  pageImage: (page: number) => string;
  firstWindowPages?: number;
  maxPagesPerWindow?: number;
}

const MAX_TEXT = 400;

function toMapBlock(b: InvBlock): MapBlock {
  const cut = b.text.length > MAX_TEXT;
  return {
    key: b.key, i: b.i, kind: b.kind,
    text: cut ? `${b.text.slice(0, MAX_TEXT)}…` : b.text,
    ...(cut ? { fullLength: b.text.length } : {}),
    styleId: b.styleId, level: b.level, align: b.align, bold: b.bold, sizePt: b.sizePt, flags: b.flags,
  };
}

/** Evenly spread pick of at most `max` items, keeping the first and last. */
function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, k) => items[Math.round((k * (items.length - 1)) / (max - 1))]);
}

export function buildMapTasks(inv: Inventory, opts: BuildMapTasksOptions): MapTask[] {
  const size = opts.windowSize ?? 120;
  const ctx = opts.contextSize ?? 3;
  const firstPages = opts.firstWindowPages ?? 6;
  const maxPages = opts.maxPagesPerWindow ?? 4;
  const total = inv.blocks.length;
  const count = Math.max(1, Math.ceil(total / size));

  const keysOnPage = new Map<number, string[]>();
  for (const b of inv.blocks) {
    const page = opts.pageOf.get(b.i);
    if (page === undefined) continue;
    keysOnPage.set(page, [...(keysOnPage.get(page) ?? []), b.key]);
  }
  const pageEntry = (page: number) => ({ page, image: opts.pageImage(page), keys: keysOnPage.get(page) ?? [] });

  return Array.from({ length: count }, (_, index) => {
    const from = index * size;
    const to = Math.min(total, from + size) - 1;
    const windowBlocks = inv.blocks.slice(from, to + 1);
    let pages: number[];
    if (keysOnPage.size === 0) pages = [];
    else if (index === 0) pages = [...keysOnPage.keys()].filter((p) => p <= firstPages).sort((a, b) => a - b);
    else {
      const own = [...new Set(windowBlocks.map((b) => opts.pageOf.get(b.i)).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
      pages = spread(own, maxPages);
    }
    return {
      id: `map-${opts.runId}-w${index}`,
      kind: "map" as const,
      runId: opts.runId,
      corpusId: opts.corpusId,
      window: { index, count, from, to, total },
      instructions: MAP_INSTRUCTIONS,
      blocks: windowBlocks.map(toMapBlock),
      context: {
        before: inv.blocks.slice(Math.max(0, from - ctx), from).map(toMapBlock),
        after: inv.blocks.slice(to + 1, to + 1 + ctx).map(toMapBlock),
      },
      pages: pages.map(pageEntry),
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rescue/__tests__/build-map-tasks.test.ts`
Expected: PASS. In the second test, window 1 owns pages 11–20, spread to 4 pages.

- [ ] **Step 5: Run the whole rescue folder, the guard and the type check**

Run: `npx vitest run src/lib/rescue && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rescue/map/build-map-tasks.ts src/lib/rescue/__tests__/build-map-tasks.test.ts
git commit -m "feat(rescue): windowed map tasks with context and page images

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Lab CLI (server, dev-only)

**Files:**
- Create: `~/kwill-server/scripts/rescue-lab/cli.ts`

- [ ] **Step 1: Implement**

```ts
// scripts/rescue-lab/cli.ts
// Rescue lab commands. Run from ~/kwill-server:  npx tsx scripts/rescue-lab/cli.ts <command> ...
// The brain is Claude in the Claude Code session: `map` writes tasks under
// lab/tasks/<runId>/ and waits for Claude's <taskId>.answer.json files.
import "dotenv/config";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readInventory, type Inventory } from "../../src/lib/rescue/read/inventory";
import { buildMapTasks } from "../../src/lib/rescue/map/build-map-tasks";
import { SessionBrain, listPending } from "../../src/lib/rescue/brain/session-brain";
import { validateMapAnswer, type MapAnswer } from "../../src/lib/rescue/brain/tasks";
import type { PageMap } from "../../src/lib/render/page-map";
import { renderForLab } from "./render";

const LAB = resolve(process.cwd(), "lab");
const corpusDir = (id: string) => join(LAB, "corpus", id);
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8")) as T;
const writeJson = (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2));
const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Meta { id: string; source: "disk" | "gmail"; originalNames: string[]; parts: boolean; permission: string; addedAt: string }

async function intake(args: string[]) {
  const [id, ...rest] = args;
  const files = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
  const source = flag(args, "source");
  const permission = flag(args, "permission");
  if (!id || files.length === 0 || (source !== "disk" && source !== "gmail") || !permission) {
    throw new Error('usage: intake <id> <file.docx>... --source disk|gmail --permission "<note>"');
  }
  const dir = join(corpusDir(id), "original");
  await mkdir(dir, { recursive: true });
  for (const f of files) await copyFile(f, join(dir, files.length === 1 ? "original.docx" : basename(f)));
  const meta: Meta = { id, source, originalNames: files.map((f) => basename(f)), parts: files.length > 1, permission, addedAt: new Date().toISOString() };
  await writeJson(join(corpusDir(id), "meta.json"), meta);
  console.log(`intake ${id}: ${files.length} file(s)${meta.parts ? " — split thesis (Assemble lands in M1)" : ""}`);
}

async function read(args: string[]) {
  const [id] = args;
  const meta = await readJson<Meta>(join(corpusDir(id), "meta.json"));
  if (meta.parts) throw new Error(`${id} is split into ${meta.originalNames.length} parts; Assemble lands in M1`);
  const docx = await readFile(join(corpusDir(id), "original", "original.docx"));
  const out = join(corpusDir(id), "read");
  await mkdir(out, { recursive: true });
  const inv = await readInventory(docx);
  await writeJson(join(out, "inventory.json"), inv);
  console.log(`inventory: ${inv.counts.blocks} blocks · ${inv.counts.words} words · ${inv.counts.figures} figures · ${inv.counts.tables} tables · ${inv.counts.footnotes} footnotes · ${inv.counts.equations} equations`);
  const r = await renderForLab(docx, out, id);
  console.log(`render: ${r.pagePaths.length} pages · ${r.overviewPaths.length} overview sheets · ${r.pageMap.unmapped.length} unmapped blocks`);
}

async function map(args: string[]) {
  const [id] = args;
  const read = join(corpusDir(id), "read");
  const inv = await readJson<Inventory>(join(read, "inventory.json"));
  const pageMap = await readJson<PageMap>(join(read, "page-map.json"));
  const runId = `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const tasks = buildMapTasks(inv, {
    runId,
    corpusId: id,
    pageOf: new Map(pageMap.blocks.map((b) => [b.index, b.page] as [number, number])),
    pageImage: (p) => join(read, "pages", `page-${String(p).padStart(3, "0")}.png`),
  });
  const brain = new SessionBrain({ dir: join(LAB, "tasks", runId) });
  console.log(`map run ${runId}: ${tasks.length} task(s) written to lab/tasks/${runId}/ — waiting for Claude's answers`);
  const answers: MapAnswer[] = await Promise.all(tasks.map((t) => brain.ask(t, (raw) => validateMapAnswer(t, raw))));
  const roles: Record<string, { role: string; confidence: number }> = {};
  for (const a of answers) for (const r of a.roles) roles[r.key] = { role: r.role, confidence: r.confidence };
  const result = { runId, corpusId: id, format: answers[0].format, roles, fingerprint: inv.fingerprint };
  const runDir = join(LAB, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, "map.json"), result);
  const tally = Object.values(roles).reduce<Record<string, number>>((t, r) => ({ ...t, [r.role]: (t[r.role] ?? 0) + 1 }), {});
  const unsure = Object.values(roles).filter((r) => r.confidence < 0.7).length;
  console.log(`map done (${result.format}): ${JSON.stringify(tally)} · ${unsure} below 0.7`);
}

async function pending() {
  const runs = await readdir(join(LAB, "tasks")).catch(() => [] as string[]);
  for (const run of runs) {
    const ids = await listPending(join(LAB, "tasks", run));
    if (ids.length) console.log(`${run}: ${ids.join(", ")}`);
  }
}

async function approveMap(args: string[]) {
  const [id, runId] = args;
  const gold = join(corpusDir(id), "gold");
  await mkdir(gold, { recursive: true });
  await copyFile(join(LAB, "runs", runId, "map.json"), join(gold, "map.json"));
  console.log(`gold/map.json for ${id} ← run ${runId}`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = {
  intake, read, map, pending: () => pending(), "approve-map": approveMap,
};
const run = commands[cmd];
if (!run) {
  console.error(`commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
run(args).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --ignoreConfig --strict false --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck scripts/rescue-lab/cli.ts`
Expected: no errors.

- [ ] **Step 3: Smoke-test intake and read on the base sample**

Make sure the converter is up: `curl -s localhost:8092/healthcheck` (expected `true`; otherwise run `node scripts/word-convert-service.mjs` in another terminal).
Run:
```bash
npx tsx scripts/rescue-lab/cli.ts intake base assets/thesis-base.docx --source disk --permission "Kwill's own seed asset"
npx tsx scripts/rescue-lab/cli.ts read base
ls lab/corpus/base/read/pages | head -3
```
Expected: an `inventory:` line, a `render:` line with ≥ 1 page, and `page-001.png`. `git status --short lab` prints nothing (the folder is ignored).

- [ ] **Step 4: Commit**

```bash
git add scripts/rescue-lab/cli.ts
git commit -m "feat(rescue-lab): lab CLI — intake, read, map, pending, approve-map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: The font-embedding proof (D-14)

**Files:**
- Create: `~/kwill-server/scripts/rescue-lab/font-proof.ts`
- Modify: `~/kwill-server/scripts/rescue-lab/README.md` (record the result)

Amiri allows embedding (fsType 0) and is **not installed** on this Mac, so Word can only show it if it's embedded. Simplified Arabic is restricted and must be refused.

- [ ] **Step 1: Implement**

```ts
// scripts/rescue-lab/font-proof.ts
// D-14 proof. A paragraph in Amiri (not installed on this Mac) is rendered by
// Word twice: without and with Amiri embedded. pdffonts must show Amiri only
// in the embedded version. Simplified Arabic (fsType 0x0002) must be refused.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Mdocxengine, readFsType, embeddingPermission } from "@kwill/docx-engine";
import { convertDocxToPdf } from "../../src/lib/word-converter";
import { serveOnce, assertConverter } from "./render";

const OUT = resolve(process.cwd(), "lab", "font-proof");
const AMIRI = join(homedir(), "kwill/docs/marketing/promo-04-before-after/public/fonts");
const SIMPLIFIED = join(homedir(), "Library/Fonts/Simplified Arabic.ttf");
const PARA =
  '<w:p><w:pPr><w:bidi/><w:jc w:val="center"/></w:pPr><w:r><w:rPr>' +
  '<w:rFonts w:ascii="Amiri" w:hAnsi="Amiri" w:cs="Amiri"/><w:rtl/><w:sz w:val="56"/><w:szCs w:val="56"/>' +
  "</w:rPr><w:t>اختبار تضمين خط أميري — Amiri</w:t></w:r></w:p>";

async function build(embed: boolean): Promise<Buffer> {
  const engine = await Mdocxengine.loadFromBuffer(await readFile("assets/thesis-base.docx"));
  const blocks = await engine.document.getBlocks();
  await engine.document.saveBlocks([...blocks, { kind: "paragraph", tag: "w:p", xml: PARA }]);
  if (embed) {
    const res = await engine.fontTable.embedFont({
      name: "Amiri",
      regular: await readFile(join(AMIRI, "Amiri-Regular.ttf")),
      bold: await readFile(join(AMIRI, "Amiri-Bold.ttf")),
    });
    console.log("embed Amiri:", res);
  }
  return Buffer.from(engine.zip.toBuffer());
}

function fontsIn(pdfPath: string): string {
  return execFileSync("pdffonts", [pdfPath], { encoding: "utf8" });
}

await assertConverter();
await mkdir(OUT, { recursive: true });
const results: Record<string, boolean> = {};
for (const embed of [false, true]) {
  const label = embed ? "embedded" : "plain";
  const docx = await build(embed);
  await writeFile(join(OUT, `${label}.docx`), docx);
  const pdf = await serveOnce(docx, (srcUrl) => convertDocxToPdf({ srcUrl, title: `font-proof-${label}` }));
  const pdfPath = join(OUT, `${label}.pdf`);
  await writeFile(pdfPath, pdf);
  const fonts = fontsIn(pdfPath);
  console.log(`\n── ${label} ──\n${fonts}`);
  results[label] = /amiri/i.test(fonts);
}

const restricted = embeddingPermission(readFsType(await readFile(SIMPLIFIED)));
const engine = await Mdocxengine.loadFromBuffer(await readFile("assets/thesis-base.docx"));
const refused = await engine.fontTable.embedFont({ name: "Simplified Arabic", regular: await readFile(SIMPLIFIED) });

console.log("\nRESULT");
console.log(`plain render uses Amiri:    ${results.plain}   (expected false — not installed)`);
console.log(`embedded render uses Amiri: ${results.embedded}   (expected true)`);
console.log(`Simplified Arabic licence:  ${restricted}   (expected restricted); embedded=${refused.embedded} reason=${refused.reason}`);
const pass = !results.plain && results.embedded && refused.embedded === false;
console.log(pass ? "PASS — D-14 holds: licensed fonts embed and Word uses them; restricted fonts are refused." : "FAIL — see the output above.");
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Run the proof**

Run: `cd ~/kwill-server && npx tsx scripts/rescue-lab/font-proof.ts`
Expected: the plain PDF's `pdffonts` table has **no** Amiri row (Word substituted); the embedded PDF lists `Amiri` (`emb yes`); Simplified Arabic is `restricted`, `embedded=false reason=restricted`; final line `PASS`.

**If the plain render already shows Amiri,** the font is installed somewhere on this Mac. Check `fc-list | grep -i amiri` / Font Book and repeat with any embeddable font that is not installed. **If the embedded render does not show Amiri,** open `lab/font-proof/embedded.docx` in Word manually. If Word shows Amiri but the converter did not, it's a converter issue, so note it; if Word does not, the embedding is wrong, so fix the engine (Task 3), rebuild (Task 4) and repeat. Do not mark D-14 proven until this script prints PASS.

- [ ] **Step 3: Record the result in the README**

Append to `scripts/rescue-lab/README.md`:

```markdown
## D-14 font embedding — proven <YYYY-MM-DD>
`npx tsx scripts/rescue-lab/font-proof.ts` → PASS. Amiri (fsType 0, not installed) renders in
Word only when embedded; Simplified Arabic (fsType 0x0002) is refused by the engine.
```
(Write the real date.)

- [ ] **Step 4: Commit**

```bash
git add scripts/rescue-lab/font-proof.ts scripts/rescue-lab/README.md
git commit -m "test(rescue-lab): prove licensed font embedding in Word (D-14)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Corpus intake (main session — Claude with the user, not a subagent)

**Files:** none tracked (everything goes into the ignored `lab/`).

This task touches students' files and the user's Gmail, so it runs in the main session with the user, never in a subagent.

- [ ] **Step 1: The theses on disk**

Intake the real theses already on this Mac, one **neutral** id each (`t01`, `t02`, …; never a student's name), with `--source disk --permission "<note>"`. Keep the id ↔ original-file mapping only in the gitignored `lab/PRIVATE-corpus-ids.json`.
Then ask the user to confirm the permission notes; update each `meta.json` with their answer.

- [ ] **Step 2: The theses in the user's Gmail**

1. Open Gmail in the user's signed-in Chrome (claude-in-chrome; a new tab). Search `has:attachment filename:docx (مذكرة OR mémoire OR memoire OR thesis OR تخرج)`.
2. **List, don't download:** for each result, note the attachment file name, sender, date and size. Show the list to the user.
3. Download **only the batches the user confirms**, then intake each with `--source gmail --permission "<what the user said>"`. Put split theses (several files from one sender for one thesis) under one id.
4. Never open, forward or reply to any email. Never download anything not confirmed.

- [ ] **Step 3: Read every corpus thesis**

For each id: `npx tsx scripts/rescue-lab/cli.ts read <id>`. Split theses print the M1 notice; that's expected. Fix any crash in `readInventory` with a regression test before continuing.

---

## Task 16: M0 exit — Claude answers a map task on a real thesis (main session)

**Files:** none tracked.

- [ ] **Step 1: Start a map run**

In a background terminal: `npx tsx scripts/rescue-lab/cli.ts map t01`
Expected: `map run t01-…: N task(s) written … waiting for Claude's answers`.

- [ ] **Step 2: Claude answers each task**

For each `lab/tasks/<runId>/*.task.json`:
1. Read the task (its `instructions`, `blocks`, `context`).
2. Open its `pages[].image` PNGs with the Read tool and look at them.
3. Write `<taskId>.answer.json`.

If an `.error.json` appears, read the reasons, correct the answer, and write `<taskId>.answer.json` again.

- [ ] **Step 3: Verify**

Expected: the background run prints `map done (<format>): {…} · K below 0.7` and `lab/runs/<runId>/map.json` exists with a role for every block.

- [ ] **Step 4: Approve the answer key**

After checking a sample of the roles against the page images: `npx tsx scripts/rescue-lab/cli.ts approve-map t01 <runId>`
Expected: `gold/map.json for t01 ← run …`.

- [ ] **Step 5: Final gate for M0**

Run:
```bash
cd ~/mdocxengine && npx vitest run src/core/fonts src/core/PartsManagers/FontTableManager.spec.ts --coverage --coverage.include='src/core/fonts/**' --coverage.include=src/core/PartsManagers/FontTableManager.ts && npx vitest run
cd ~/kwill-server && npx vitest run src/lib/rescue && npx tsc --noEmit && npx vitest run --testTimeout=60000
```
Expected: new engine files at 100% coverage and no new failing engine spec versus `4fffabb`; rescue tests, guard and type check green; the full server suite shows **no new failures**. For any failing test outside `src/lib/rescue`, show it also fails on the commit just before Task 6 (check that commit out in a temporary `git worktree` and run the same test there). Only then may it be called pre-existing.

**M0 is done** when: font-proof prints PASS, the corpus is read, and `gold/map.json` exists for one real thesis. Next: write the M1 plan (Assemble · Read · Map · Diagnose · preview) with what M0 taught.

---

## Carried into the M1/M2 plans (from M0 reviews and the first corpus run)

- Inventory fingerprint ignores text of kind "other" blocks and textbox (w:txbxContent) text inside paragraphs/tables; tableText's lazy <w:p> match can split nested textbox paragraphs. Prove (M2) must count words including textboxes or the "words never change" invariant is blind there.
- equations count unverified on real data (all 8 samples have 0) — add a fixture with m:oMathPara > m:oMath.
- figures = blocks holding drawing/pict/object (a table with an image counts as figure + table).
- footnotes counts only w:footnoteReference; endnotes not counted — add endnotes to the Prove counts.
- Alignment inventory vs injectBlockMarkers verified on 8 real samples (all match) — consider a gated test over lab/ (never commit student data).
- engine: npm run test:ci fails on main at baseline (~90% global coverage); gate = new files 100% + no new failing spec.
- block-key: editing a block changes its neighbours' keys → M4 re-run diff needs a second text-only matching pass.
- FontTableManager minor follow-ups (Task 3 re-review, non-blocking): self-closing <w:settings/> → malformed (expand or skip); old rel with absolute Target leaves orphan part; &apos;-encoded names duplicate w:font; addOverride/addDefault after zip writes (malformed [Content_Types] → partial write); one test name promises "unrelated parts" check it doesn't do.
- block-key: an empty-text drawing paragraph shares the blank-paragraph key family (t01 blocks 341/343 = 5610c07d…#28/#30) — include holds (drawing/table/sectPr) or an image hash in the key, or the M4 re-run diff can confuse a figure with blank lines.
- map vocabulary gaps (t01): toc-field/list-field (real Word fields), figure-source (Source: lines), layout table of figures; run-in bold labels not in the student's TOC → mapped h4 (candidate student question: include in TOC?).
- Local Word converter: runs from `~/modakerati-server/tmp/word-convert/`; Word can raise a macOS "Grant File Access" dialog for `convert-input.docx` that only the user can grant — every later conversion then fails (osascript -1728). The lab should detect this and say so instead of failing per thesis.
- Corpus run 1 (t01, 897 blocks): 283 of 284 unmapped page-map blocks are blank paragraphs (by design, no marker); the existing TOC and lists are REAL fields inside w:sdt (kind "other"); 6 divider pages drawn as shapes; a broken hyperlink field ("Error! Hyperlink reference not valid.") in the bibliography.
