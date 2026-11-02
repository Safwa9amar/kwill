# Rescue v2 — M1a: Foundations before more answer keys (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the M0 final review found must be right before any more answer keys are written: block identity, the content counts the invariants need, the model-client guard, the map contract, resumable runs, and Word render reliability.

**Architecture:** All changes are in `~/kwill-server`.
- A new pure module, `src/lib/rescue/read/content.ts`, extracts visible text (no `mc:Fallback` duplicates, paragraph-separated, footnotes, endnotes, text boxes, content controls) and object facts.
- The inventory and block keys move to **v2** on top of it.
- `src/lib/thesis-parts.ts` takes the model-free part-ordering helpers out of `thesis-classify.ts`, so Assemble (M1b) can use them behind the guard.
- The guard resolves imports to absolute paths and checks the **transitive** graph with esbuild.
- The lab CLI gains resumable runs, input validation and an atomic read.
- The one existing answer key (t01) is re-keyed to v2.

**Tech stack:** TypeScript, vitest, zod 4, esbuild 0.28 (already installed), `@kwill/docx-engine`.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md`. **Previous plan:** `2026-11-02-rescue-v2-m0-lab-brain-fonts.md` (its appendix lists the carry-overs this plan resolves).

**Scope note (change to the spec's milestone table):** the spec lists "Diagnose + 2-page preview" in M1. The preview needs Regenerate (M2) to repair two real pages, so the **preview moves to M2**. M1 is split:
- **M1a (this plan):** foundations.
- **M1b (next plan):** Assemble (split theses), Diagnose, and answer keys for the corpus.

---

## Ground rules (read before any task)

- **Repo and git:** `~/kwill-server`, branch `master`. Commit after every task, staging **exact paths only** (never `git add -A` or `.`). Another session has uncommitted edits in this repo (`package.json`, `package-lock.json`, some scripts, tests and docs): never stage, revert or touch files this plan does not list. End commit messages with your own model's `Co-Authored-By:` line. Fixes after review are **new commits**, never amends.
- **Checks:**
  - `npx vitest run src/lib/rescue` for the rescue folder.
  - `npx tsc --noEmit` for types.
  - The full suite `npx vitest run --testTimeout=60000` before the last task's commit.
  - Scripts are type-checked with `npx tsc --noEmit --ignoreConfig --strict false --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck <file>`.
- **tsconfig `strict: false`:** never rely on narrowing a `{ok:true}|{ok:false}` union. Use flat interfaces and `x.ok === false`. Imports are relative with no `.js` extension. Build a `Map` from pairs typed as tuples (`[a, b] as [number, number]`).
- **Unicode ranges are written as `\u` escapes, never pasted glyphs.**
- **Nothing under `src/lib/rescue/` may import model clients, the old pipeline (`src/lib/format/*`), `supabase`, `db`, `document-storage` or `thesis-render`.** Task 4 makes the guard enforce this transitively.
- **Privacy:** `lab/` holds students' theses and is gitignored. Corpus ids are **neutral** (`t01`…). Never print thesis text in reports, logs, commits or test output: counts, sizes and hashes only. Tests use `assets/thesis-base.docx` (Kwill's own seed) or inline XML fixtures, never lab files.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/thesis-parts.ts` (new) | Model-free part helpers moved out of `thesis-classify.ts` |
| `src/lib/thesis-classify.ts` (modify) | Imports and re-exports them; keeps only the model-calling code |
| `src/lib/rescue/read/content.ts` (new) | Visible text, footnote/endnote text, object signature and counts, prove-normalised words |
| `src/lib/rescue/blocks/block-key.ts` (modify) | Key v2: kind + holds + object signature + text + neighbours; `KEY_VERSION` |
| `src/lib/rescue/read/inventory.ts` (modify) | Inventory v2 on `content.ts`: text for every kind, notes, objects, `inventoryHash` |
| `src/lib/rescue/brain/tasks.ts` (modify) | New roles, `other` blocks with tag and text, instructions matching the validator, no backticks |
| `src/lib/rescue/map/map-result.ts` (new) | map.json v2 shape plus `mergeMapAnswers` |
| `src/lib/rescue/__tests__/no-model-client.test.ts` (rewrite) | Guard v2: absolute resolution, transitive esbuild check, string bans, scans `scripts/rescue-lab` |
| `scripts/rescue-lab/cli.ts` (modify) | `map --run`, id validation, `approve-map` checks, clean intake, atomic `read` with `status.json` |
| `scripts/rescue-lab/rekey-gold.ts` (new) | Re-keys an existing gold map from key v1 to v2 by block index |
| `src/lib/rescue/__tests__/*.test.ts` | Tests per module |

---

## Task 1: Move the model-free part helpers into `thesis-parts.ts`

**Files:**
- Create: `src/lib/thesis-parts.ts`
- Modify: `src/lib/thesis-classify.ts`
- Test: `src/__tests__/thesis-classify.test.ts` (unchanged; must still pass), `src/lib/rescue/__tests__/thesis-parts.test.ts` (new)

`thesis-classify.ts` mixes pure helpers (lines ~9–330) with `classifyParts`, which lazily imports a model provider (~line 383). The guard (Task 4) forbids rescue code from importing `thesis-classify`. Assemble (M1b) needs the pure helpers.

- [ ] **Step 1: Read the file:** `sed -n 1,400p src/lib/thesis-classify.ts`. Identify:
  - the pure exports: `ROLE_ORDER`, `PartRole`, `ClassifiedPart`, `PartInput`, `titleFromFilename`, `stripManualNumber`, `cleanTitle`, `titleFromContent`, `detectLanguage`, `heuristicRole`, `heuristicClassify`, `orderByRole`, and every private helper or constant they use;
  - the model-related code that stays: `ClassifyFailure`, `ClassifyResult`, `classifyFailure`, `parseClassification`, `buildClassifyPrompt`, `RETRYABLE`, `RETRYABLE_FOR_TEST`, `classifyParts`.
- [ ] **Step 2: Write the failing test** `src/lib/rescue/__tests__/thesis-parts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as parts from "../../thesis-parts";
import * as classify from "../../thesis-classify";

describe("thesis-parts", () => {
  it("exposes the model-free helpers", () => {
    for (const name of ["titleFromFilename", "stripManualNumber", "cleanTitle", "titleFromContent", "detectLanguage", "heuristicRole", "heuristicClassify", "orderByRole"]) {
      expect(typeof (parts as Record<string, unknown>)[name]).toBe("function");
    }
    expect(Array.isArray(parts.ROLE_ORDER)).toBe(true);
  });
  it("thesis-classify re-exports the very same functions (no behaviour change)", () => {
    expect(classify.titleFromFilename).toBe(parts.titleFromFilename);
    expect(classify.orderByRole).toBe(parts.orderByRole);
    expect(classify.ROLE_ORDER).toBe(parts.ROLE_ORDER);
  });
  it("imports nothing at module scope", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../thesis-parts.ts", import.meta.url), "utf8");
    expect(src.match(/^import\s/m)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run src/lib/rescue/__tests__/thesis-parts.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Move the code.**
  1. Cut the pure exports and their private helpers from `thesis-classify.ts` into `src/lib/thesis-parts.ts`, **unchanged**, with this header comment:

     ```ts
     // Model-free helpers for ordering and labelling the parts of a thesis that
     // a student split into several files. Moved out of thesis-classify.ts so
     // that code which must never reach a model client (src/lib/rescue) can use them.
     ```

  2. In `thesis-classify.ts`, add at the top:

     ```ts
     import { ROLE_ORDER, titleFromFilename, stripManualNumber, cleanTitle, titleFromContent, detectLanguage, heuristicRole, heuristicClassify, orderByRole } from "./thesis-parts";
     import type { PartRole, ClassifiedPart, PartInput } from "./thesis-parts";
     export * from "./thesis-parts";
     ```

     Then drop the import names it no longer uses itself.

  The other importers (`src/lib/thesis-structure.ts`, `src/routes/rescue.ts`, `src/lib/format/classify.ts`, `src/routes/thesis/layout.ts`, `src/__tests__/thesis-classify.test.ts`) keep working through the re-export. Do not edit them.
- [ ] **Step 5: Verify.** Run `npx vitest run src/lib/rescue/__tests__/thesis-parts.test.ts src/__tests__/thesis-classify.test.ts && npx tsc --noEmit`. Expected: all PASS; the existing classify tests are unchanged and green.
- [ ] **Step 6: Commit** `src/lib/thesis-parts.ts src/lib/thesis-classify.ts src/lib/rescue/__tests__/thesis-parts.test.ts` with the message `refactor(rescue): model-free thesis-parts helpers out of thesis-classify`.

---

## Task 2: Content extraction (`content.ts`)

**Files:**
- Create: `src/lib/rescue/read/content.ts`
- Test: `src/lib/rescue/__tests__/content.test.ts`

What the M0 review measured on the corpus:
- `paragraphText` counts text-box text twice, once from `mc:Choice` and once from `mc:Fallback` (611 extra words over 10 theses).
- It glues a text box's inner paragraphs together.
- It ignores footnote and endnote text (2,544 words in one thesis).
- It returns nothing for `w:sdt` blocks.

This module is the single source of visible text and object facts for every later stage.

- [ ] **Step 1: Write the failing test.**

```ts
// src/lib/rescue/__tests__/content.test.ts
import { describe, it, expect } from "vitest";
import { visibleXml, xmlText, proveWords, objectFacts, notesText } from "../read/content";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (inner: string) => `<w:p><w:r>${inner}</w:r></w:p>`;
const t = (s: string) => `<w:t xml:space="preserve">${s}</w:t>`;
const textbox = (paras: string[]) =>
  `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline><wp:extent cx="100" cy="200"/><wp:docPr id="7" name="Text Box 7"/><a:graphic><wps:txbx><w:txbxContent>${paras.map((x) => p(t(x))).join("")}</w:txbxContent></wps:txbx></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>${paras.map((x) => p(t(x))).join("")}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;

describe("visibleXml", () => {
  it("drops mc:Fallback copies and keeps mc:Choice", () => {
    const x = visibleXml(textbox(["A"]));
    expect(x).not.toContain("mc:Fallback");
    expect(x).toContain("w:txbxContent");
  });
});

describe("xmlText", () => {
  it("reads text-box text once, one line per inner paragraph", () => {
    expect(xmlText(visibleXml(textbox(["Titre", "Sous-titre"])))).toBe("Titre\nSous-titre");
  });
  it("turns tabs and breaks into spaces, decodes entities, ignores field codes and deleted text", () => {
    const x = `<w:p><w:r>${t("A&amp;B")}<w:tab/>${t("C")}<w:br/>${t("&#1605;")}</w:r><w:r><w:instrText>TOC \\o</w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`;
    expect(xmlText(x)).toBe("A&B C م");
  });
  it("reads the text inside a content control (w:sdt)", () => {
    expect(xmlText(`<w:sdt><w:sdtContent>${p(t("Sommaire"))}${p(t("Introduction"))}</w:sdtContent></w:sdt>`)).toBe("Sommaire\nIntroduction");
  });
});

describe("proveWords", () => {
  it("keeps tashkeel and digits (a lost diacritic must be detectable) but ignores bidi marks and spacing", () => {
    // NFC may reorder stacked marks (kasra before shadda), so compare against the NFC form.
    expect(proveWords("  مُذَكِّرَة\u200F ١٢٣  ")).toEqual(["مُذَكِّرَة".normalize("NFC"), "١٢٣"]);
    expect(proveWords("مذكرة")).not.toEqual(proveWords("مُذَكِّرَة"));
  });
});

describe("objectFacts", () => {
  it("counts drawings per object, OLE objects and equations, outside fallbacks only", () => {
    const xml = `${textbox(["x"])}<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5" cy="6"/><wp:docPr id="9" name="Picture 9"/></wp:inline></w:drawing><w:drawing><wp:inline><wp:extent cx="7" cy="8"/><wp:docPr id="10" name="Picture 10"/></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:object><o:OLEObject ProgID="Equation.3"/></w:object></w:r></w:p><w:p><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p>`;
    const f = objectFacts(xml);
    expect(f.drawings).toBe(3);
    expect(f.ole).toBe(1);
    expect(f.equations).toBe(1);
    expect(f.signature).toMatch(/^[0-9a-f]{12}$/);
  });
  it("gives different signatures to different pictures and an empty signature to plain text", () => {
    const pic = (id: number, cx: number) => `<w:drawing><wp:inline><wp:extent cx="${cx}" cy="1"/><wp:docPr id="${id}" name="Picture ${id}"/></wp:inline></w:drawing>`;
    expect(objectFacts(pic(1, 10)).signature).not.toBe(objectFacts(pic(2, 20)).signature);
    expect(objectFacts(p(t("x"))).signature).toBe("");
  });
});

describe("notesText", () => {
  it("returns the text of real notes, skipping separator notes (ids -1 and 0)", () => {
    const part = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${p(t("---"))}</w:footnote><w:footnote w:id="0">${p(t("sep"))}</w:footnote><w:footnote w:id="1">${p(t("Ibn Khaldoun"))}</w:footnote><w:footnote w:id="2">${p(t("p. 12"))}</w:footnote></w:footnotes>`;
    expect(notesText(part, "footnote")).toEqual(["Ibn Khaldoun", "p. 12"]);
    expect(notesText("", "footnote")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run src/lib/rescue/__tests__/content.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**

```ts
// src/lib/rescue/read/content.ts
// The single source of VISIBLE text and object facts for the rescue pipeline.
// - mc:Fallback is Word's duplicate rendering for old readers; counting it
//   double-counts every text box, so it is dropped before anything is read.
// - Paragraph ends become "\n", so a text box's lines stay separate.
// - Field codes (w:instrText) and deleted text (w:delText) are not visible.
import { createHash } from "node:crypto";

const FALLBACK = /<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g;
const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<\/w:p>/g;
const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function visibleXml(xml: string): string {
  return xml.replace(FALLBACK, "");
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible text of an XML fragment: tabs/breaks → space, paragraph ends → "\n". Call on visibleXml(). */
export function xmlText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[0] === "</w:p>") out += "\n";
    else out += " ";
  }
  return out.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l, i, a) => l || i < a.length - 1).join("\n").replace(/\n+$/, "");
}

/** Tokens for the "words never change" invariant: NFC, no bidi marks, whitespace-split. Diacritics and digits are KEPT. */
export function proveWords(text: string): string[] {
  const n = text.normalize("NFC").replace(BIDI, "").trim();
  return n ? n.split(/\s+/) : [];
}

export interface ObjectFacts {
  drawings: number;
  ole: number;
  equations: number;
  /** Hash of the objects' identity (docPr name + extent); "" when there is no object. */
  signature: string;
}

/** Counts are taken on the visible XML (fallbacks dropped here too). */
export function objectFacts(xml: string): ObjectFacts {
  const v = visibleXml(xml);
  const drawings = (v.match(/<w:drawing\b/g) ?? []).length + (v.match(/<w:pict\b/g) ?? []).length;
  const ole = (v.match(/<o:OLEObject\b/g) ?? []).length;
  const equations = (v.match(/<m:oMath\b/g) ?? []).length;
  const ids = [...v.matchAll(/<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[\s\S]*?<wp:docPr\b[^>]*\bname="([^"]*)"/g)].map((m) => `${m[3]}:${m[1]}x${m[2]}`);
  if (ole) ids.push(`ole:${ole}`);
  const signature = ids.length ? createHash("sha1").update(ids.join("|")).digest("hex").slice(0, 12) : "";
  return { drawings, ole, equations, signature };
}

/** Text of each real footnote/endnote in a notes part; separator notes (id -1, 0) skipped. */
export function notesText(partXml: string, kind: "footnote" | "endnote"): string[] {
  if (!partXml) return [];
  const re = new RegExp(`<w:${kind}\\b([^>]*)>([\\s\\S]*?)<\\/w:${kind}>`, "g");
  const out: string[] = [];
  for (const m of partXml.matchAll(re)) {
    const id = Number((m[1].match(/\bw:id="(-?\d+)"/) ?? [])[1]);
    if (id <= 0 || /\bw:type="(separator|continuationSeparator|continuationNotice)"/.test(m[1])) continue;
    out.push(xmlText(visibleXml(m[2])));
  }
  return out;
}
```

- [ ] **Step 4: Run it.** `npx vitest run src/lib/rescue/__tests__/content.test.ts`. Expected: PASS. If the `xmlText` blank-line filter fights a test, simplify it to: split on `\n`, trim each line, join with `\n`, then strip leading and trailing newlines. Keep the tests' expectations.
- [ ] **Step 5: Commit** `src/lib/rescue/read/content.ts src/lib/rescue/__tests__/content.test.ts` with the message `feat(rescue): visible-text and object facts — no fallback duplicates, notes, text boxes, sdt`.

---

## Task 3: Block key v2 and inventory v2

**Files:**
- Modify: `src/lib/rescue/blocks/block-key.ts`, `src/lib/rescue/read/inventory.ts`
- Modify: `src/lib/rescue/__tests__/block-key.test.ts`, `src/lib/rescue/__tests__/inventory.test.ts`

Key v1 hashed only kind, text and neighbours. So every empty paragraph, **every empty-text picture** and every page-break carrier between other empty blocks fell into one family told apart only by position. In one thesis that family held 483 blocks, including 20 figures. v2 adds the block's holds and its object signature.

- [ ] **Step 1: Update the block-key tests.** Keep every existing test; give the inputs the new optional fields and add these:

```ts
it("separates an empty-text picture from an empty paragraph with the SAME neighbours", () => {
  const pic = blockKeys([p("A"), { kind: "paragraph", text: "", holds: ["drawing", "blank"], objects: "aa11" }, p("B")])[1];
  const blank = blockKeys([p("A"), { kind: "paragraph", text: "", holds: ["blank"] }, p("B")])[1];
  expect(pic).not.toBe(blank);
});
it("ignores the 'blank' flag itself (a blank line keyed with or without it is the same block)", () => {
  expect(blockKeys([{ kind: "paragraph", text: "", holds: ["blank"] }])[0]).toBe(blockKeys([{ kind: "paragraph", text: "" }])[0]);
});
it("separates two different pictures", () => {
  const a = blockKeys([{ kind: "paragraph", text: "", objects: "aaaa" }])[0];
  const b = blockKeys([{ kind: "paragraph", text: "", objects: "bbbb" }])[0];
  expect(a).not.toBe(b);
});
it("separates a page-break carrier from a blank line", () => {
  const a = blockKeys([{ kind: "paragraph", text: "", holds: ["page-break"] }])[0];
  const b = blockKeys([{ kind: "paragraph", text: "" }])[0];
  expect(a).not.toBe(b);
});
it("exposes KEY_VERSION 2", () => expect(KEY_VERSION).toBe(2));
```

  Add `KEY_VERSION` to the test's import.
- [ ] **Step 2: Implement key v2** in `block-key.ts`. Keep `normalizeForKey` unchanged and replace `blockKeys`:

```ts
export const KEY_VERSION = 2;

export interface KeyInput { kind: string; text: string; holds?: string[]; objects?: string }

export function blockKeys(blocks: KeyInput[]): string[] {
  const norm = blocks.map((b) => normalizeForKey(b.text));
  const seen = new Map<string, number>();
  return blocks.map((b, i) => {
    const prev = (norm[i - 1] ?? "").slice(-40);
    const next = (norm[i + 1] ?? "").slice(0, 40);
    const holds = (b.holds ?? []).filter((h) => h !== "blank").sort().join(",");
    const base = createHash("sha1")
      .update(`v${KEY_VERSION}\u0001${b.kind}\u0001${holds}\u0001${b.objects ?? ""}\u0001${norm[i]}\u0001${prev}\u0001${next}`)
      .digest("hex")
      .slice(0, 16);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
```

- [ ] **Step 3: Update the inventory tests.** Keep the existing ones (unique keys, consistent counts, page-marker alignment, determinism), adjusting for the renamed counts below. Add:

```ts
it("reports keyVersion 2 and a stable inventoryHash that changes with the content", async () => {
  const a = await readInventory(SAMPLE);
  expect(a.keyVersion).toBe(2);
  expect(a.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
  expect((await readInventory(SAMPLE)).inventoryHash).toBe(a.inventoryHash);
});
it("counts words from body and notes separately and fingerprints both", async () => {
  const inv = await readInventory(SAMPLE);
  expect(inv.counts.words).toBe(inv.counts.bodyWords + inv.counts.noteWords);
  expect(inv.fingerprint).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 4: Implement inventory v2** in `inventory.ts`. Required changes, keeping the rest of the module as is:
  - **Text for every kind:** `text = xmlText(visibleXml(b.xml))`. Paragraph text keeps inner `\n` (text boxes); the `kind === "other"` blocks now get their text and a `tag`: `w:sdt` → `"sdt"`; anything without visible text whose XML is only bookmarks → `"bookmark"`; otherwise the element name.
  - **Per-block `objects`** (`ObjectFacts` from `objectFacts(b.xml)`) on `InvBlock`; `flags` as before.
  - **Keys:** `blockKeys(partial.map(b => ({ kind: b.kind, text: b.text, holds: b.flags, objects: b.objects.signature })))`.
  - **Notes:** read `word/footnotes.xml` and `word/endnotes.xml` from `engine.zip` (`entry ? entry.getData().toString("utf-8") : ""`), then `notesText(…)`.
  - **Counts:** `{ blocks, words, bodyWords, noteWords, footnotes /* references in the body */, endnotes /* references */, footnoteTexts, endnoteTexts, drawings /* sum of per-block objects.drawings */, ole, figures /* blocks with ≥1 drawing, as before */, tables, equations /* sum of objects.equations */, sectionBreaks }`.
  - **Fingerprint:** sha256 of `proveWords` over the body block texts in order, then a `\u0002` separator, then the note texts in order. That gives the "words never change" baseline with diacritics kept.
  - **`keyVersion: KEY_VERSION`**, and **`inventoryHash`**: sha256 of `JSON.stringify(blocks.map(b => [b.key, b.kind, b.text]))`.
  - Keep `wordsOf` (used for counting only) but base `counts.words` on `proveWords`. Delete `fingerprintOf` if nothing else uses it, and update its test accordingly.
- [ ] **Step 5: Verify.** Run `npx vitest run src/lib/rescue && npx tsc --noEmit`. Expected: all PASS. The page-marker alignment test (`injectBlockMarkers(SAMPLE).blockCount === inv.blocks.length`) must still hold.
- [ ] **Step 6: Commit** `src/lib/rescue/blocks/block-key.ts src/lib/rescue/read/inventory.ts src/lib/rescue/__tests__/block-key.test.ts src/lib/rescue/__tests__/inventory.test.ts` with the message `feat(rescue): block key v2 (holds + objects) and inventory v2 (visible text, notes, objects, hash)`.

---

## Task 4: Guard v2: absolute resolution, transitive check, string bans

**Files:**
- Rewrite: `src/lib/rescue/__tests__/no-model-client.test.ts`

The M0 review got past the regex guard with `./../../ai/x`, `../../rescue/../ai/x`, `openai/helpers/zod`, a template-literal `import()`, `createRequire`, and a raw `fetch("https://openrouter.ai/…")`. Supabase and db were not forbidden at all, and nothing transitive was checked.

- [ ] **Step 1: Write the new guard.**

```ts
// src/lib/rescue/__tests__/no-model-client.test.ts
// Until milestone M7 the brain is Claude in the session. Nothing reachable from
// src/lib/rescue or scripts/rescue-lab may reach a model client, the old rescue
// pipeline, or code that opens Supabase/Postgres at import time.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const ROOTS = [join(REPO, "src/lib/rescue"), join(REPO, "scripts/rescue-lab")];
const SRC = (p: string) => join(REPO, "src", p);

/** Repo files that must never be reached (exact files, or directories with a trailing slash). */
const FORBIDDEN_FILES = [
  "lib/ai/", "lib/format/", "lib/embedding-service.ts", "lib/stt.ts", "lib/tts.ts",
  "lib/thesis-classify.ts", "lib/thesis-structure.ts", "lib/thesis-plan.ts", "lib/chat-memory.ts",
  "lib/supabase.ts", "db/", "lib/document-storage.ts", "lib/thesis-render.ts",
].map(SRC);
/** Packages that must never be reached (any subpath). */
const FORBIDDEN_PACKAGES = ["openai", "@openrouter/sdk", "@supabase/supabase-js", "pg", "postgres", "drizzle-orm"];
/** Source text that betrays a model call or a raw dynamic load. */
const FORBIDDEN_TEXT: RegExp[] = [
  /openrouter\.ai/i, /api\.openai\.com/i, /api\.anthropic\.com/i, /generativelanguage\.googleapis/i,
  /OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY/,
  /\bcreateRequire\b/, /\bimport\s*\(\s*`/, /\brequire\s*\(/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [full] : [];
  });
}
const files = ROOTS.flatMap(sourceFiles);
const isForbiddenFile = (abs: string) => FORBIDDEN_FILES.some((f) => (f.endsWith("/") ? abs.startsWith(f) : abs === f || abs === f.replace(/\.ts$/, "")));
const isForbiddenPackage = (spec: string) => FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));

describe("rescue code stays model-free and DB-free until M7", () => {
  it("scans real files in both roots", () => {
    expect(files.some((f) => f.includes("src/lib/rescue"))).toBe(true);
    expect(files.some((f) => f.includes("scripts/rescue-lab"))).toBe(true);
  });

  it("contains no forbidden text (model URLs, API-key names, raw dynamic loads)", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const re of FORBIDDEN_TEXT) if (re.test(src)) hits.push(`${relative(REPO, f)} ~ ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("reaches no forbidden file or package, directly or transitively", { timeout: 60_000 }, async () => {
    const result = await build({
      entryPoints: files, bundle: true, write: false, metafile: true, platform: "node", format: "esm",
      absWorkingDir: REPO, outdir: join(REPO, ".guard-out"), packages: "external", logLevel: "silent",
    });
    const reached = Object.keys(result.metafile.inputs).map((p) => resolve(REPO, p));
    const packages = Object.values(result.metafile.inputs).flatMap((i) => i.imports.filter((x) => x.external).map((x) => x.path));
    expect(reached.filter(isForbiddenFile).map((f) => relative(REPO, f))).toEqual([]);
    expect([...new Set(packages.filter(isForbiddenPackage))]).toEqual([]);
  });
});
```

  `esbuild` (0.28.1) is not a direct dependency. It is hoisted into `node_modules` through vite and tsx, so `import { build } from "esbuild"` resolves. Do **not** add it to `package.json`: another session has uncommitted edits there.
- [ ] **Step 2: Run it.** `npx vitest run src/lib/rescue/__tests__/no-model-client.test.ts`. Expected: PASS today. A controller probe on 2026-11-02 found the reachable graph is 17 files: the rescue modules, the three lab scripts, `docx-empty-blocks`, `docx-math`, `docx-shapes`, `rag/text`, `render/{page-images,page-map,page-markers,pdf-text}` and `word-converter`. None is forbidden. If the transitive check reports a real hit, **stop and report** (NEEDS_CONTEXT). Do not weaken the lists.
- [ ] **Step 3: Prove it catches each bypass.** Put each of these, one at a time, as the first line of `src/lib/rescue/blocks/block-key.ts`, run the guard (expect FAIL naming it), remove it, and confirm `git diff src/lib/rescue/blocks/block-key.ts` is empty:
  1. `import "./../../ai/features";`
  2. `import "../../rescue/../db";`
  3. `import "openai/helpers/zod";`
  4. `const u = "https://openrouter.ai/api";`
  5. ``await import(`../../ai/${"x"}`);``

  Paste the five FAIL lines in your report.
- [ ] **Step 4: Commit** `src/lib/rescue/__tests__/no-model-client.test.ts` with the message `test(rescue): guard v2 — absolute + transitive (esbuild) + string bans, covers the lab scripts`.

---

## Task 5: Map contract v2 and map.json v2

**Files:**
- Modify: `src/lib/rescue/brain/tasks.ts`, `src/lib/rescue/map/build-map-tasks.ts`, `src/lib/rescue/__tests__/tasks.test.ts`, `src/lib/rescue/__tests__/build-map-tasks.test.ts`
- Create: `src/lib/rescue/map/map-result.ts`, `src/lib/rescue/__tests__/map-result.test.ts`

What the first answer key revealed:
- An existing **real** TOC or list (Word field, often inside `w:sdt`) had to be forced into `typed-toc`/`typed-list`, which the instructions define as "not a Word field".
- "Source: …" lines under figures had no role.
- `other` blocks reached the brain with no text and no tag.
- The validator's junk rule (empty paragraph only, with no holds) was stricter than the instructions said.
- The instructions contained backticks, which would break the M7 prompt catalogue.

- [ ] **Step 1: Tests first.** In `tasks.test.ts`:
  - add `expect(ROLES).toContain("toc-field"); expect(ROLES).toContain("list-field"); expect(ROLES).toContain("figure-source");`;
  - add `it("has no backticks in the instructions", () => expect(MAP_INSTRUCTIONS.includes("`")).toBe(false));`;
  - add a case asserting `MAP_INSTRUCTIONS` mentions each of: "toc-field", "list-field", "figure-source", "page or section break", ".answer.json.tmp".

  In `build-map-tasks.test.ts`, add a case where one block is `{ kind: "other", tag: "sdt", text: "Sommaire\nIntroduction", … }` and assert the task's `MapBlock` carries `tag: "sdt"` and that text.
- [ ] **Step 2: Create `map-result.ts`** with the map.json v2 shape and the merge the CLI uses. Test first in `map-result.test.ts`: merging two answers gives every key with its `i`, `role` and `confidence`; `keyVersion` is 2; `inventoryHash`, `fingerprint`, `corpusId`, `runId` and `format` are carried over; a key answered in two windows throws.

```ts
// src/lib/rescue/map/map-result.ts
import type { Inventory } from "../read/inventory";
import type { MapAnswer, Role, DocFormat } from "../brain/tasks";
import { KEY_VERSION } from "../blocks/block-key";

export interface MapResult {
  keyVersion: number;
  corpusId: string;
  runId: string;
  inventoryHash: string;
  fingerprint: string;
  format?: DocFormat;
  roles: Record<string, { i: number; role: Role; confidence: number }>;
}

export function mergeMapAnswers(inv: Inventory, answers: MapAnswer[], meta: { corpusId: string; runId: string }): MapResult {
  const indexOf = new Map(inv.blocks.map((b) => [b.key, b.i] as [string, number]));
  const roles: MapResult["roles"] = {};
  for (const a of answers) {
    for (const r of a.roles) {
      if (roles[r.key]) throw new Error(`key ${r.key} answered in two windows`);
      roles[r.key] = { i: indexOf.get(r.key) as number, role: r.role, confidence: r.confidence };
    }
  }
  return {
    keyVersion: KEY_VERSION, corpusId: meta.corpusId, runId: meta.runId,
    inventoryHash: inv.inventoryHash, fingerprint: inv.fingerprint,
    format: answers.find((a) => a.format)?.format, roles,
  };
}
```

- [ ] **Step 3: Update `tasks.ts`.**
  - **ROLES:** add `"toc-field"` (an existing table of contents that is a real Word field, including one inside a content control) and `"list-field"` (an existing list of figures/tables that is a real Word field) right after `"typed-list"`, and `"figure-source"` right after `"caption-table"`.
  - **`MapBlock`:** gains `tag?: string` (set for kind "other").
  - **Rewrite `MAP_INSTRUCTIONS`** without any backtick. It must state:
    - the junk rule exactly as validated: "junk is only an EMPTY paragraph used as spacing. Never on a block of another kind, and never on a paragraph that carries a picture, a page or section break, an equation, a footnote, a bookmark or a field, even if it has no text";
    - the new roles: toc-field, list-field ("a real Word field: do not relabel it typed-toc or typed-list"), and figure-source ("a 'Source: …' line under a figure or table");
    - that blocks of kind other carry a tag (sdt = content control, bookmark = an anchor with no text);
    - the answer convention: "write the JSON to <taskId>.answer.json.tmp in the task's folder, then rename it to <taskId>.answer.json".
- [ ] **Step 4: Update `build-map-tasks.ts`.** `toMapBlock` copies `tag` when present. `InvBlock` from Task 3 has `tag?`.
- [ ] **Step 5: Verify.** Run `npx vitest run src/lib/rescue && npx tsc --noEmit`. Expected: all PASS.
- [ ] **Step 6: Commit** the six paths with the message `feat(rescue): map contract v2 — field TOC/list + figure-source roles, tagged other blocks, map.json v2`.

---

## Task 6: Lab CLI: resumable runs, validation, atomic read

**Files:**
- Modify: `scripts/rescue-lab/cli.ts`, `scripts/rescue-lab/README.md`

- [ ] **Step 1: Implement these changes in `cli.ts`.** Keep the existing command names.
  - **Validation:** every `id` and `runId` must match `/^[a-z0-9][a-z0-9-]{0,80}$/`, otherwise throw. This stops `..` from escaping `lab/`.
  - **`intake`:** if `corpus/<id>/original` exists, remove it first with `rm(dir, { recursive: true, force: true })`, so re-intake leaves no stale parts. Refuse an id containing letters outside `[a-z0-9-]`, which steers people towards neutral ids.
  - **`read`:**
    1. Write into `corpus/<id>/read.tmp/`: inventory, render and page map.
    2. On success, replace `read/` with `read.tmp/` (`rm` the old one, then `rename`).
    3. On a render failure, still move the inventory into place, write `read/status.json` as `{ "inventory": "ok", "render": "failed", "error": "<first 300 chars of the message>", "at": "<ISO>" }`, and exit 1.
    4. On success, `status.json` is `{ "inventory": "ok", "render": "ok", "pages": N, "unmapped": M, "at": "<ISO>" }`.
  - **`map <id> [--run <runId>]`:**
    - Without `--run`, mint a new `runId` as today (`${id}-${ISO with : and . replaced by -}`, lowercased so it passes validation). Immediately write `lab/runs/<runId>/run.json` as `{ "corpusId": id, "inventoryHash": inv.inventoryHash, "createdAt": ISO }`, before any task is written.
    - With `--run`, read that `run.json`. Refuse if `corpusId` differs. If `inventoryHash` differs from the current inventory's, throw "the thesis was re-read since this run started; start a new run".
    - Otherwise rebuild the tasks with the same `runId`. Task ids are `map-${runId}-w${i}`, so they come out identical, and the session brain's resume path returns already-accepted answers at once.
    - Write `lab/runs/<runId>/map.json` with `mergeMapAnswers` (Task 5).
  - **`pending [--prune]`:** with `--prune`, delete `lab/tasks/<runId>` folders whose `lab/runs/<runId>/map.json` exists, i.e. finished runs.
  - **`approve-map <id> <runId>`:** refuse unless the run's `map.json` has `corpusId === id`, `keyVersion === 2`, and `inventoryHash` equal to the current `read/inventory.json` hash.
- [ ] **Step 2: Update the README's commands section** to document `map <id> --run <runId>`, `pending --prune`, `read/status.json`, and the neutral-id rule.
- [ ] **Step 3: Type-check** the CLI with the scripts command from the ground rules.
- [ ] **Step 4: Smoke test** on the seed asset only (id `base-smoke`):
  1. `npx tsx scripts/rescue-lab/cli.ts intake base-smoke assets/thesis-base.docx --source disk --permission "Kwill seed asset"`
  2. `npx tsx scripts/rescue-lab/cli.ts read base-smoke` (Word converter running; if it is not, `read` must exit 1 and leave `status.json` with `render: failed`, which is also a pass of the failure path)
  3. `cat lab/corpus/base-smoke/read/status.json`
  4. An invalid id: `npx tsx scripts/rescue-lab/cli.ts read ../x` must throw.

  Then `rm -rf lab/corpus/base-smoke`.
- [ ] **Step 5: Commit** `scripts/rescue-lab/cli.ts scripts/rescue-lab/README.md` with the message `feat(rescue-lab): resumable map runs, id validation, atomic read with status.json`.

---

## Task 7: Re-key the t01 answer key to v2 (controller, main session)

**Files:**
- Create: `scripts/rescue-lab/rekey-gold.ts` (tracked)
- Gitignored outputs: `lab/corpus/t01/gold/map.json`

The first answer key (897 blocks, key v1) must survive the key change. The old `read/inventory.json` has each block's `i` and v1 key. Re-reading the original gives each `i` a v2 key. Block **indices are identical** between the two reads, because the page-marker alignment holds and nothing moved.

- [ ] **Step 1: Write `rekey-gold.ts`.** It reads `lab/corpus/<id>/gold/map.json` (v1: `roles` keyed by v1 key, no `i`) and the OLD `read/inventory.json` (v1, saved before re-reading; copy it to `read/inventory.v1.json` first). It then runs `readInventory` on `original/original.docx`, maps v1 key → i → v2 key, and writes a v2 `MapResult`: roles keyed by v2 key with `i`, `keyVersion` 2, the new `inventoryHash` and `fingerprint`, and `corpusId`. It refuses if the block counts differ, and prints only counts.
- [ ] **Step 2: Run it on t01:**
  1. `cp lab/corpus/t01/read/inventory.json lab/corpus/t01/read/inventory.v1.json`
  2. `npx tsx scripts/rescue-lab/rekey-gold.ts t01`
  3. `npx tsx scripts/rescue-lab/cli.ts read t01`

  Then confirm the new `read/inventory.json` hash equals the gold's `inventoryHash`.
- [ ] **Step 3: Brain edits for the new roles (Claude, main session).** In the re-keyed gold, relabel by index:
  - the content-control TOC blocks: `typed-toc` → `toc-field`;
  - the real TableofFigures entries and their headings: `typed-list` → `list-field`;
  - the "Source: …" lines under figures: `body` → `figure-source`;
  - the body-level bookmark-only block, if its new tag is "bookmark": choose its role from the page images.

  Validate the result by building the map tasks for t01 and running `validateMapAnswer` on each window's slice of the gold. All must pass.
- [ ] **Step 4: Commit** only `scripts/rescue-lab/rekey-gold.ts` with the message `feat(rescue-lab): re-key an answer key from block key v1 to v2`. Gold files stay in the gitignored `lab/`.

---

## Task 8: Word render reliability

**Files:**
- Modify: `src/lib/render/page-markers.ts` (⚠️ has an uncommitted import rename from another session — see Step 6), `scripts/word-convert-service.mjs`, `src/lib/word-converter.ts`, `scripts/rescue-lab/render.ts`
- Test: `src/__tests__/page-markers-zip.test.ts` (new), `scripts/rescue-lab/__tests__/` (none; the lab is smoke-tested)

The diagnosis (2026-11-02) ran the 9 failing corpus files through Word and found three independent causes.

1. **A macOS "Grant File Access" dialog blocks Word.**
   - The service deletes and recreates `convert-input.docx` for every job, and the grant does not survive that. Word then sits behind stacked dialogs until osascript is killed at 120 s.
   - This is not a code bug, but the code makes it worse (delete and recreate) and hides it (a silent 120 s timeout).
2. **The marker step breaks zips whose entries carry flag bit 3 (data descriptor).**
   - AdmZip keeps the flag but writes no descriptor, and Word refuses the file with `-10000`.
   - This is deterministic on t02, the only corpus file whose entries all carry bit 3.
   - `clearFalseDataDescriptors` (already exported by `@kwill/docx-engine`) fixes it.
   - The docx doctor reports "ok" on the broken file, so it cannot catch this.
3. **A failed `save as` leaves the document open in Word.**
   - The AppleScript has no error handling, so `close theDoc` never runs.
   - The next job's `open` of the same path then fails (`-1728`, `-2753`). Worse, it can **return the stale document's PDF as a success**: one t21 render came back as another thesis.

Also: the lab sends every thesis through Word three times (plain PDF, page PNGs, marked PDF), and the client timeout is a flat 150 s, which is too short for t08 (22.6 MB).

- [ ] **Step 1: Test first (cause 2).** In `src/__tests__/page-markers-zip.test.ts`:
  - load `assets/thesis-base.docx` and set general-purpose flag bit 3 on every entry, in both the local headers (signature `0x04034b50`, flags at offset +6) and the central directory (signature `0x02014b50`, flags at offset +8);
  - assert the file still unzips (`new AdmZip(buf).getEntries().length > 0`);
  - run `injectBlockMarkers(buf)`;
  - assert that no central-directory entry in `result.bytes` has bit 3 set, and that `result.blockCount` equals the count from the unmodified asset.

  Run it. Expected: FAIL (bit 3 survives).
- [ ] **Step 2: Fix (cause 2).** In `page-markers.ts`, return `bytes: clearFalseDataDescriptors(zip.toBuffer())`, importing it from `@kwill/docx-engine` in the same import statement the working tree already uses. Run the test: PASS.
- [ ] **Step 3: Service robustness (causes 1 and 3)** in `scripts/word-convert-service.mjs`:
  - **Close only our own stale document before opening.** At the top of the `tell` block, run `repeat with d in (documents whose full name is "<DOCX_PATH>")` then `close d saving no`. Never `close every document`: the person at this Mac may have their own documents open.
  - **Close on failure.** Wrap `save as` in `try … on error errMsg number errNum` → `close theDoc saving no` → `error errMsg number errNum` → `end try`, so the failure still propagates.
  - **Keep the input file's identity between jobs** so the macOS grant survives. Do not `unlink(DOCX_PATH)` after a job; truncate it with `writeFile(DOCX_PATH, "")`, so no thesis copy is left behind. Write each new job's bytes in place with `writeFile`, which truncates and rewrites the same inode. Keep the PDF unlink as is. Add a comment explaining why.
  - **Fail fast and clearly on the dialog.**
    1. Run osascript with a timeout scaled to size: `120_000 + 8_000 * MB`.
    2. If osascript fails, check System Events: `tell application "System Events" to get name of every window of process "Microsoft Word"`.
    3. If a window name contains "Grant File Access", reject with `"Word is waiting on a macOS 'Grant File Access' dialog for convert-input.docx — click Select/Grant on this Mac, then retry"`.
    4. If the check itself errors, return the original error.
  - **Before/after check that the PDF belongs to this job.** Delete any old PDF before the job, and after `save as` require that the PDF's mtime is later than the job start; otherwise reject with "Word returned a stale PDF".
- [ ] **Step 4: Client timeout** in `src/lib/word-converter.ts`. The converter fetches by URL and does not know the size up front, so add an optional `sizeBytes?: number` to both functions' options. Use `AbortSignal.timeout(150_000 + 8_000 * Math.ceil((sizeBytes ?? 0) / 1_048_576))`. Existing callers are unchanged (the default is the same 150 s).
- [ ] **Step 5: Lab render** in `scripts/rescue-lab/render.ts`:
  - **One Word call fewer.** Rasterize the plain PDF locally with `pdftoppm -png -scale-to-x <PAGE_W> -scale-to-y -1` (poppler is installed on this Mac). Fall back to the service's `/render-pages` only if `pdftoppm` is missing.
  - **Pass `sizeBytes`** to every converter call.
  - **Retry once.** If a conversion fails with `-1728`, `-2753`, `-10000` or "stale PDF", wait 3 s and retry. The service now closes its stale document, so the retry is clean. Never retry the Grant File Access error; surface it.
  - **Right-document guard.**
    1. After the plain PDF, compute `extractPdfText` words.
    2. Require that at least 60% of the inventory's first 300 distinct `proveWords` tokens (length ≥ 4) appear in the PDF text.
    3. On failure, throw "rendered PDF does not match this thesis (overlap X%)". Print only the percentage, never the words.
- [ ] **Step 6: Commit hunk-only for `page-markers.ts`.** It already carries another session's uncommitted import rename (`mdocxengine` → `@kwill/docx-engine`); that hunk must NOT be committed by us.
  1. Build a patch of only our change: `git diff src/lib/render/page-markers.ts > /tmp/pm.patch`.
  2. Edit the patch to drop the import hunk, or write the patch by hand against `HEAD`.
  3. Stage it with `git apply --cached`.
  4. Check with `git diff --cached src/lib/render/page-markers.ts` that only the `clearFalseDataDescriptors` lines are staged.

  ⚠️ `HEAD` still imports from `"mdocxengine"`, so the staged import must add `clearFalseDataDescriptors` to that import.
  - The committed `package.json` maps `"mdocxengine": "file:../mdocxengine"`, the same engine repo, and that repo exports it: `grep -n clearFalseDataDescriptors ~/mdocxengine/src/index.ts`.
  - `node_modules` has only the renamed `@kwill/docx-engine`. That is the other session's working tree, and it is why the working copy keeps its own import line.

  The staged file must match `HEAD`'s `package.json`. The working file must match the working `package.json`.

  The other three files are stage-whole only if `git diff` shows no foreign hunks. Commit with the message `fix(render): Word conversions survive bit-3 zips, stale open documents and the file-access dialog`.
- [ ] **Step 7: Restart the service and smoke it** (controller, main session):
  1. Stop the running `word-convert-service.mjs` (only that pid), start it the same way, and check `curl -s localhost:8092/healthcheck`.
  2. The first job then closes the stale `convert-input.docx` that the diagnosis left open in Word.
  3. Render `assets/thesis-base.docx` through `cli.ts` with id `base-smoke`, then remove it.

---

## Task 9: Re-read the whole corpus (controller, main session)

Run after Tasks 3, 6 and 8. Earlier renders may have been contaminated by the stale document (cause 3), so **every** single-file thesis is re-read, including the ones that rendered before.

- [ ] **Step 1:** For each single-file id (t01–t16, t21), run `npx tsx scripts/rescue-lab/cli.ts read <id>`, one at a time. Do t01 last; Task 7 already re-read it. Record from each `status.json` only: id, render ok/failed, pages, unmapped, and the right-document overlap %.
- [ ] **Step 2:** For any failure, read the error class only (Grant File Access, timeout, `-1728`/`-10000`, mismatch) and act:
  - Grant File Access: ask the user to click Grant on the Mac, then retry.
  - Timeout on t08: retry once with Word otherwise idle.
  - Anything else: open a systematic-debugging pass on that one file.
- [ ] **Step 3:** Update `lab/PRIVATE-corpus-ids.json` (gitignored) with each id's read status. There is no commit; the lab is gitignored.

---

## Done when

- `npx vitest run src/lib/rescue`, `npx tsc --noEmit` and the full server suite (`npx vitest run --testTimeout=60000`) are green.
- Guard v2 fails on all bypasses (five, plus non-literal `import()`) and passes on the tree.
- The t01 answer key is v2, valid under contract v2, and matches a fresh read.
- Every single-file corpus thesis has a fresh `read/status.json`, each render either OK with a right-document overlap ≥ 60%, or failed with a named cause.

## Carry-overs (not in M1a)

- An engine doctor rule for false data descriptors: entries with flag bit 3 set and no descriptor. The doctor reports "ok" today on a zip Word refuses. This needs an engine `main` change plus `npm run build`.
- For the user to decide: the converter listens on `0.0.0.0` with no auth and fetches any URL (SSRF). The production server reaches it through a tunnel, so binding to localhost or adding a token must be coordinated with that tunnel.
