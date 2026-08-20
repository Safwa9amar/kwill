# Thesis Rescue P2 — Runner, DB & Routes (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the P1 engine reachable: extract the TOC policy out of its MCP handler, implement the step executors + the resumable runner, add the `rescue_runs` table (ephemeral diagnosis slot), and expose `POST /api/rescue/diagnose`, `GET /api/rescue/:id`, `POST /api/rescue/:id/answers`, `POST /api/rescue/:id/repair` with the paid gate.

**Architecture:** Diagnosis is ephemeral — the upload lands in the documents bucket under a `rescue-` docId, no `theses` row, no limit touched. Payment (any paid plan) creates the thesis from the already-uploaded bytes and runs the plan. The runner takes `withThesisLock` PER persisting step (never end-to-end), persists through `persistThesisDocx` (doctor + snapshot ring), writes per-step status back to `rescue_runs.plan` so a dropped connection resumes instead of restarting.

**Tech Stack:** Hono, drizzle (hand-written SQL migration — drizzle-kit is unusable here), Supabase storage, vitest. Repo: `~/modakerati-server`. Requires P1 merged.

**Prereqs verified during planning (do not re-derive):**
- `applyFrontMatterNumbering(doc, bodyStartIndex, opts)` already lives in `src/mcp/doc-page-numbering.ts:60` — P4+P5 need no extraction.
- `doc.engine.captions.convertTextCaptions(...)` / `insertCaptionList(...)` are engine-level (call sites: `src/mcp/tools/docx-apparatus.ts:152`, `:213`, and the insert at ~`:309`).
- `selectParagraphs` / `paginateParagraphBlocks` already live in `src/mcp/doc-paragraph-props.ts` (call site to mirror: `src/mcp/tools/docx-blocks.ts:317-345`).
- The ONLY real extraction is the `insert_table_of_contents` handler policy (`src/mcp/tools/docx-apparatus.ts` ~247–380).
- `persistThesisDocx` (`src/lib/thesis-history.ts:209`), `withThesisLock` (`src/lib/thesis-lock.ts:105`), `loadThesisEngine` (`src/lib/thesis-doc.ts:261`), `uploadDocx`/`removeDocx`/`downloadDocx` (`src/lib/document-storage.ts`), `currentPlanCode` (`src/lib/billing/quota.ts:133`), `thesisAllowance`/`thesisLimitBody` (`src/lib/billing/thesis-limit.ts`).

---

### Task 1: Extract the TOC policy

**Files:**
- Create: `src/lib/format/toc-policy.ts`
- Modify: `src/mcp/tools/docx-apparatus.ts` (the `insert_table_of_contents` handler becomes a wrapper)
- Test: `src/__tests__/format-toc-policy.test.ts`

The handler body (~247–380) does four things no other code path can reuse today: remove an existing field TOC (`replaceExisting`), remove a typed TOC (`replaceManualToc`, via `doc.engine.toc.findTypedTOC()`/`removeTypedTOC`), auto-promote inferred headings when the doc has none styled, insert + RTL-patch `TOCHeading`/`TOC1..9`. Move it verbatim; the wrapper keeps the MCP reply shape byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-toc-policy.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Mdocxengine, Doc } from "mdocxengine";
import { insertTocWithPolicy } from "../lib/format/toc-policy";

const SAMPLE = new URL("../../assets/thesis-base.docx", import.meta.url).pathname;

describe("insertTocWithPolicy", () => {
  it("inserts a field TOC at the top and reports entries", async () => {
    const doc = Doc.from(await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE)));
    const res = await insertTocWithPolicy(doc, { atIndex: 0 });
    expect(res.ok).toBe(true);
    const xml = doc.engine.zip.readAsText("word/document.xml") ?? "";
    expect(xml).toMatch(/\bTOC\s+\\o\b/);
  });

  it("on a doc with NO styled headings it promotes inferred titles before building", async () => {
    const doc = Doc.from(await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE)));
    // Strip real headings by demoting: rebuild each as a plain bold paragraph.
    const inferred = await doc.inferOutline();
    for (const h of inferred.filter((x) => x.confidence === "styled")) {
      await doc.editParagraph(h.index, h.title); // editParagraph preserves style — so instead:
    }
    // (If editParagraph keeps the heading style, replace this setup with a
    // fixture docx that has plain-text titles; assert promoted > 0 either way.)
    const res = await insertTocWithPolicy(doc, { atIndex: 0 });
    expect(res.ok).toBe(true);
  });
});
```

NB the second test's setup is allowed to evolve — the assertion that matters is the first one plus `promoted`/`entries` fields existing on the result. Do not weaken the wrapper-equivalence step below.

- [ ] **Step 2: Run — expect FAIL.** `cd ~/modakerati-server && npx vitest run src/__tests__/format-toc-policy.test.ts`

- [ ] **Step 3: Create `src/lib/format/toc-policy.ts`**

Signature + skeleton (the marked region is MOVED, unchanged, from the handler):

```ts
// src/lib/format/toc-policy.ts
// The TOC policy that used to live inline in the insert_table_of_contents MCP
// handler. Both that tool and the rescue runner call THIS — neither
// re-implements removal of typed TOCs, auto-promotion, or the RTL patching.
import type { Doc } from "mdocxengine";
import { detectDocRtl, applyRtlToStyles } from "../../mcp/doc-direction";

export interface TocPolicyOptions {
  title?: string;
  headingDepth?: number;
  atIndex?: number;
  includePageNumbers?: boolean;
  useHyperlinks?: boolean;
  replaceExisting?: boolean;      // default true here (runner semantics)
  replaceManualToc?: boolean;     // default true here
  autoDetectHeadings?: boolean;   // default true
  minConfidence?: "high" | "medium";
  rtl?: boolean;
}

export interface TocPolicyResult {
  ok: boolean;
  error?: string;
  atIndex?: number;
  entries?: number;
  headingDepth?: number;
  replacedExisting?: boolean;
  manualTocRemoved?: number;
  rtl?: boolean;
  promoted: Array<{ index: number; level: number; title: string; reason: string }>;
  weakCandidates: number;
  unpromoted: number;
}

export async function insertTocWithPolicy(doc: Doc, opts: TocPolicyOptions = {}): Promise<TocPolicyResult> {
  const {
    title, headingDepth, atIndex = 0, includePageNumbers, useHyperlinks,
    replaceExisting = true, replaceManualToc = true, autoDetectHeadings = true,
    minConfidence = "high", rtl,
  } = opts;
  const useRtl = rtl ?? (await detectDocRtl(doc));

  // ── MOVED VERBATIM from src/mcp/tools/docx-apparatus.ts (the callback body
  //    of insert_table_of_contents, from the removeTOC/findTypedTOC section
  //    down through insertTOC + applyRtlToStyles). Adapt only:
  //      - handler args → the locals above
  //      - `return { ok:false … }` early exits → return with promoted:[], weakCandidates:0, unpromoted:0
  //      - the giant `note:` strings → OMITTED (they are MCP-facing prose; the
  //        wrapper rebuilds them from this result, see Step 4)
  // ─────────────────────────────────────────────────────────────────────────

  // …moved code ends by returning:
  // return { ok: true, atIndex: res.atIndex, entries: res.entries, headingDepth: res.headingDepth,
  //          replacedExisting: replaced > 0, manualTocRemoved: manualRemoved, rtl: useRtl,
  //          promoted, weakCandidates, unpromoted };
}
```

- [ ] **Step 4: Rewrite the handler as a wrapper** — in `src/mcp/tools/docx-apparatus.ts`, the `insert_table_of_contents` callback becomes:

```ts
async ({ userId, thesisId, title, headingDepth, atIndex, includePageNumbers, useHyperlinks, replaceExisting, rtl, replaceManualToc, autoDetectHeadings, minConfidence }) => {
  const guard = await requireLiveThesis(thesisId, userId);
  if (guard.ok === false) return guard.reply;
  return withThesisDoc(guard.thesis, async (doc) => {
    const res = await insertTocWithPolicy(doc, {
      title, headingDepth, atIndex, includePageNumbers, useHyperlinks,
      // The TOOL's defaults differ from the runner's: the model must ask before
      // destroying, so absent flags stay falsy exactly as before.
      replaceExisting: replaceExisting ?? false,
      replaceManualToc: replaceManualToc ?? false,
      autoDetectHeadings, minConfidence, rtl,
    });
    if (res.ok === false) return res;
    return {
      ...res,
      promotedHeadings: res.promoted.length,
      promoted: res.promoted.slice(0, 40).map((p) => ({ level: p.level, title: p.title, why: p.reason })),
      unpromotedTitles: res.unpromoted,
      note: /* rebuild the existing note logic here, verbatim from the old handler,
               reading res.manualTocRemoved / res.entries / res.unpromoted /
               res.weakCandidates / res.promoted — same strings, same branches */ "",
    };
  });
},
```

⚠️ The `manualToc` reporting branch (the `{ title, entries, fromIndex, toIndex, sample }` object for a typed TOC that was found but NOT removed) reads `typed` — keep that data flowing by including `manualToc` in `TocPolicyResult` too if the old reply carried it. Diff the old handler's return keys against the new wrapper's until they match exactly.

- [ ] **Step 5: Run — new test green AND the whole suite** (this is a behavior-preserving refactor of a live tool):

Run: `npx vitest run src/__tests__/format-toc-policy.test.ts && npx vitest run src/__tests__ --testTimeout=60000`

- [ ] **Step 6: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/toc-policy.ts src/mcp/tools/docx-apparatus.ts src/__tests__/format-toc-policy.test.ts && git commit -m "refactor(format): TOC policy extracted from the MCP handler — one implementation, two callers"
```

---

### Task 2: Step executors

**Files:**
- Create: `src/lib/format/steps.ts`
- Test: `src/__tests__/format-steps.test.ts`

One file, one exported async function per plan step. Every executor takes `(doc, params, ctx)` and mutates the engine; NONE of them persists — the runner owns persistence. Labels are re-resolved by textHead before use (indices shift).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-steps.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Mdocxengine, Doc } from "mdocxengine";
import { resolveIndex, stepClean, stepStructure, stepPagination } from "../lib/format/steps";

const SAMPLE = new URL("../../assets/thesis-base.docx", import.meta.url).pathname;
const load = async () => Doc.from(await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE)));

describe("resolveIndex", () => {
  it("trusts the index while the text still matches, else re-finds by head", async () => {
    const doc = await load();
    const blocks = await doc.blocks();
    const target = blocks.findIndex((b) => (b as any).text?.trim());
    const head = ((blocks[target] as any).text as string).trim().slice(0, 80);
    expect(await resolveIndex(doc, target, head)).toBe(target);
    // Shift everything by one and the stale index must re-resolve.
    await doc.addParagraph("فقرة مقحمة", {}, 0);
    expect(await resolveIndex(doc, target, head)).toBe(target + 1);
    expect(await resolveIndex(doc, 0, "نص غير موجود إطلاقا")).toBeNull();
  });
});

describe("stepClean", () => {
  it("deletes the given blocks in descending order, resolving each first", async () => {
    const doc = await load();
    await doc.addParagraph("12", {}, 0);
    await doc.addParagraph("13", {}, 5);
    const before = (await doc.blocks()).length;
    const res = await stepClean(doc, { targets: [{ index: 0, textHead: "12" }, { index: 5, textHead: "13" }] });
    expect(res.deleted).toBe(2);
    expect((await doc.blocks()).length).toBe(before - 2);
  });
});

describe("stepStructure", () => {
  it("promotes each label to a real heading", async () => {
    const doc = await load();
    await doc.addParagraph("الفصل التجريبي الأول");
    const blocks = await doc.blocks();
    const idx = blocks.length - 1;
    const res = await stepStructure(doc, { promotions: [{ index: idx, level: 1, textHead: "الفصل التجريبي الأول" }] });
    expect(res.promoted).toBe(1);
    const detailed = await doc.blocksDetailed();
    expect((detailed[idx] as any).headingLevel).toBe(1);
  });
});

describe("stepPagination", () => {
  it("keepNext + widow control on headings, pageBreakBefore on level 1", async () => {
    const doc = await load();
    const res = await stepPagination(doc, {});
    expect(res.ok).toBe(true);
    const xml = doc.engine.zip.readAsText("word/document.xml") ?? "";
    expect(xml).toContain("<w:keepNext");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-steps.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/steps.ts
// One executor per plan step. Executors MUTATE and never persist — the runner
// wraps each in the lock + persistThesisDocx. Every stored index is re-resolved
// by textHead first (the block-links pattern): trust it while the text matches,
// otherwise re-find, otherwise report and move on. Nothing here throws for a
// missing block — a vanished target is a skipped item, not a dead run.
import type { Doc } from "mdocxengine";
import type { NormFormatting } from "../db/norm-profiles";
import { applyNormProfileToDocument } from "../thesis-formatting";
import { applyFrontMatterNumbering } from "../../mcp/doc-page-numbering";
import { selectParagraphs, paginateParagraphBlocks } from "../../mcp/doc-paragraph-props";
import { detectDocRtl, applyRtlToStyles, preferredCaptionLabel } from "../../mcp/doc-direction";
import { insertTocWithPolicy } from "./toc-policy";

const norm = (s: string) => s.trim().slice(0, 80);

/** Trust `index` while its text still starts with `textHead`; else re-find by head; else null. */
export async function resolveIndex(doc: Doc, index: number, textHead: string): Promise<number | null> {
  const blocks = await doc.blocks();
  const head = norm(textHead);
  const textAt = (i: number) => norm(((blocks[i] as { text?: string })?.text ?? ""));
  if (index >= 0 && index < blocks.length && head && textAt(index).startsWith(head)) return index;
  for (let i = 0; i < blocks.length; i++) if (head && textAt(i).startsWith(head)) return i;
  return null;
}

export interface Anchor { index: number; textHead: string }

// ── clean ────────────────────────────────────────────────────────────────────
export async function stepClean(doc: Doc, params: { targets: Anchor[] }): Promise<{ deleted: number; missed: number }> {
  // Resolve all first, then delete DESCENDING so earlier deletes don't shift later targets.
  const resolved: number[] = [];
  let missed = 0;
  for (const t of params.targets) {
    const i = await resolveIndex(doc, t.index, t.textHead);
    if (i === null) missed++; else resolved.push(i);
  }
  for (const i of [...new Set(resolved)].sort((a, b) => b - a)) await doc.deleteBlock(i);
  return { deleted: new Set(resolved).size, missed };
}

// ── structure ────────────────────────────────────────────────────────────────
export async function stepStructure(
  doc: Doc,
  params: { promotions: Array<Anchor & { level: number }> },
): Promise<{ promoted: number; missed: number }> {
  let promoted = 0, missed = 0;
  for (const p of params.promotions) {
    const i = await resolveIndex(doc, p.index, p.textHead);
    if (i === null) { missed++; continue; }
    try { await doc.setHeadingLevel(i, p.level); promoted++; } catch { missed++; }
  }
  return { promoted, missed };
}

// ── norms ────────────────────────────────────────────────────────────────────
export async function stepNorms(
  doc: Doc,
  params: { formatting: NormFormatting; bindingSide: string; language?: string },
): Promise<{ styles: string[] }> {
  const res = await applyNormProfileToDocument(
    doc.engine as never, params.formatting, params.bindingSide, params.language);
  return { styles: res.styles };
}

// ── sections-numbering (spec P4+P5, one atomic engine operation) ────────────
export async function stepSectionsNumbering(
  doc: Doc,
  params: { bodyStart: Anchor },
): Promise<{ ok: boolean; error?: string; totalSections?: number }> {
  const i = await resolveIndex(doc, params.bodyStart.index, params.bodyStart.textHead);
  if (i === null || i < 1) return { ok: false, error: "body start not found" };
  const res = await applyFrontMatterNumbering(doc, i, { alignment: "center" });
  return res.ok === false ? { ok: false, error: res.error } : { ok: true, totalSections: (res as { totalSections?: number }).totalSections };
}

// ── pagination ───────────────────────────────────────────────────────────────
// Mirrors src/mcp/tools/docx-blocks.ts:317-345 (set_paragraph_pagination), with
// the runner's fixed policy: headings keep their text, everything gets widow
// control, and level-1 headings start a page.
export async function stepPagination(doc: Doc, _params: Record<string, never>): Promise<{ ok: boolean; changed: number }> {
  const infos = await doc.blocks();
  const body = await doc.engine.document.getBlocks();
  let changed = 0;

  const heads = paginateParagraphBlocks(infos, body, { scope: "headings" }, { keepWithNext: true, widowControl: true });
  changed += heads.changed;

  // Level-1 headings additionally start a page.
  const detailed = await doc.blocksDetailed();
  const h1s = detailed.filter((b) => (b as { headingLevel?: number }).headingLevel === 1).map((b) => b.index);
  if (h1s.length > 0) {
    const breaks = paginateParagraphBlocks(infos, body, { scope: "headings", indices: h1s }, { pageBreakBefore: true });
    changed += breaks.changed;
  }
  if (changed > 0) await doc.engine.document.saveBlocks(body);
  return { ok: true, changed };
}
// ⚠️ Signature check before coding: read paginateParagraphBlocks at
// src/mcp/doc-paragraph-props.ts:122 and mirror the docx-blocks call EXACTLY
// (including whether saveBlocks is the caller's job there).

// ── captions ─────────────────────────────────────────────────────────────────
export async function stepCaptions(doc: Doc, _params: Record<string, never>): Promise<{ converted: number }> {
  const res = await doc.engine.captions.convertTextCaptions({});
  return { converted: res.converted.length };
}

// ── apparatus (BOTTOM-UP: lists first, TOC last, all at index 0) ────────────
export async function stepApparatus(
  doc: Doc,
  params: { toc: boolean; listOfFigures: boolean; listOfTables: boolean },
): Promise<{ tocEntries: number; lists: string[] }> {
  const useRtl = await detectDocRtl(doc);
  const lists: string[] = [];

  // Inserting in REVERSE final order at a fixed index means no insert
  // invalidates the next one's target: tables list, then figures list, then
  // the TOC above them — final top-down order: TOC, figures, tables.
  if (params.listOfTables) {
    await doc.engine.captions.insertCaptionList(preferredCaptionLabel(doc, "table"), undefined, 0, useRtl);
    lists.push("tables");
  }
  if (params.listOfFigures) {
    await doc.engine.captions.insertCaptionList(preferredCaptionLabel(doc, "figure"), undefined, 0, useRtl);
    lists.push("figures");
  }
  if (useRtl && lists.length > 0) {
    const body = await doc.engine.document.getBlocks();
    if (applyRtlToStyles(body, ["TableofFigures", "TOCHeading"]) > 0) await doc.engine.document.saveBlocks(body);
  }

  let tocEntries = 0;
  if (params.toc) {
    const res = await insertTocWithPolicy(doc, { atIndex: 0, rtl: useRtl });
    tocEntries = res.entries ?? 0;
  }
  return { tocEntries, lists };
}
// ⚠️ Signature check: insertCaptionList's real parameters are at the call site
// src/mcp/tools/docx-apparatus.ts:309 (`insertCaptionList(finalLabel, title, atIndex ?? 0, useRtl)`)
// and preferredCaptionLabel's at src/mcp/doc-direction.ts — mirror them, do not guess.
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-steps.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/steps.ts src/__tests__/format-steps.test.ts && git commit -m "feat(format): step executors — mutate only, resolve by textHead, never persist"
```

---

### Task 3: The runner

**Files:**
- Create: `src/lib/format/runner.ts`
- Test: `src/__tests__/format-runner.test.ts`

- [ ] **Step 1: Write the failing test** (the runner is tested with a FAKE executor table + in-memory persistence — no storage, no DB)

```ts
// src/__tests__/format-runner.test.ts
import { describe, it, expect } from "vitest";
import { runPlan, type RunnerIo } from "../lib/format/runner";
import type { FormatPlan } from "../lib/format/types";

const plan = (over: Partial<Record<string, string>> = {}): FormatPlan => ({
  steps: [
    { id: "snapshot", status: (over.snapshot as any) ?? "pending" },
    { id: "clean", status: (over.clean as any) ?? "pending", params: {} },
    { id: "structure", status: (over.structure as any) ?? "pending", params: {} },
    { id: "norms", status: (over.norms as any) ?? "pending", params: {} },
    { id: "sections-numbering", status: (over["sections-numbering"] as any) ?? "pending", params: {} },
    { id: "pagination", status: (over.pagination as any) ?? "pending", params: {} },
    { id: "captions", status: (over.captions as any) ?? "skipped", params: {} },
    { id: "apparatus", status: (over.apparatus as any) ?? "pending", params: {} },
    { id: "finish", status: (over.finish as any) ?? "pending" },
  ],
  labels: [], questions: [], bodyStartIndex: 5, degraded: false,
  signals: { typedCaptionCount: 0, figureCount: 0, tableCount: 0, hasRealToc: false },
});

const io = (executed: string[], fail: Set<string> = new Set()): RunnerIo => ({
  executeStep: async (step) => {
    if (fail.has(step.id)) throw new Error(`${step.id} exploded`);
    executed.push(step.id);
    return { note: step.id };
  },
  savePlan: async () => {},
});

describe("runPlan", () => {
  it("runs pending steps in order, skips skipped, marks done", async () => {
    const executed: string[] = [];
    const p = plan();
    await runPlan(p, io(executed));
    expect(executed).toEqual(["snapshot", "clean", "structure", "norms", "sections-numbering", "pagination", "apparatus", "finish"]);
    expect(p.steps.every((s) => s.status === "done" || s.status === "skipped")).toBe(true);
  });

  it("a failed dependency fails downstream steps but not independent ones", async () => {
    const executed: string[] = [];
    const p = plan();
    await runPlan(p, io(executed, new Set(["structure"])));
    expect(p.steps.find((s) => s.id === "structure")?.status).toBe("failed");
    // sections-numbering, pagination, apparatus depend on structure → failed (dependency), not run.
    expect(executed).not.toContain("sections-numbering");
    expect(executed).not.toContain("apparatus");
    // norms and captions do not depend on structure → still run (captions was skipped here).
    expect(executed).toContain("norms");
    expect(p.steps.find((s) => s.id === "finish")?.status).toBe("done"); // finish always runs
  });

  it("resume: done steps are not re-executed", async () => {
    const executed: string[] = [];
    const p = plan({ snapshot: "done", clean: "done", structure: "done" });
    await runPlan(p, io(executed));
    expect(executed).toEqual(["norms", "sections-numbering", "pagination", "apparatus", "finish"]);
  });

  it("persists the plan after every step transition", async () => {
    let saves = 0;
    const p = plan();
    await runPlan(p, { executeStep: async () => ({}), savePlan: async () => { saves++; } });
    // 8 executed steps × (running + terminal) = 16 saves minimum.
    expect(saves).toBeGreaterThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-runner.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/runner.ts
// Deterministic execution of a FormatPlan. The runner owns ORDER, DEPENDENCIES,
// STATUS and RESUME; it does not know how to mutate a document (RunnerIo does)
// so it is testable without storage, DB, or an engine. The route (Task 5) wires
// RunnerIo.executeStep to: withThesisLock → loadThesisEngine → the step
// executor → persistThesisDocx. Lock PER STEP, never across the run — a
// multi-minute hold would block every other write to the thesis.
import type { FormatPlan, PlanStep, PlanStepId } from "./types";
import { STEP_DEPS, STEP_ORDER } from "./types";

export interface RunnerIo {
  /** Execute ONE step (lock + load + mutate + persist live inside). */
  executeStep(step: PlanStep, plan: FormatPlan): Promise<Record<string, unknown>>;
  /** Persist the whole plan (status board) — called after every transition. */
  savePlan(plan: FormatPlan): Promise<void>;
}

export async function runPlan(plan: FormatPlan, io: RunnerIo): Promise<FormatPlan> {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const failedDeps = (id: PlanStepId): boolean =>
    STEP_DEPS[id].some((dep) => {
      const d = byId.get(dep);
      return d !== undefined && d.status === "failed";
    });

  for (const id of STEP_ORDER) {
    const step = byId.get(id);
    if (!step || step.status === "done" || step.status === "skipped") continue;

    // "finish" always runs — the document must leave normalized + doctored even
    // after failures; everything else is fenced by its dependencies.
    if (id !== "finish" && failedDeps(id)) {
      step.status = "failed";
      step.error = "dependency failed";
      await io.savePlan(plan);
      continue;
    }

    step.status = "running";
    await io.savePlan(plan);
    try {
      const out = await io.executeStep(step, plan);
      step.status = "done";
      if (out && typeof out === "object") step.detail = JSON.stringify(out).slice(0, 500);
    } catch (e) {
      step.status = "failed";
      step.error = (e as Error)?.message?.slice(0, 300) ?? "failed";
    }
    await io.savePlan(plan);
  }
  return plan;
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-runner.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/runner.ts src/__tests__/format-runner.test.ts && git commit -m "feat(format): runner — order, deps, resume, status; io injected"
```

---

### Task 4: `rescue_runs` — schema + migration

**Files:**
- Modify: `src/db/schema.ts` (append the table at the end, before any closing exports)
- Create: `sql/2026-08-18-rescue.sql`

⚠️ drizzle-kit is unusable in this repo — the SQL is written BY HAND and must match the drizzle table exactly. ensureSchema will not create this (it's dead on prod); the SQL file is the source of truth for deployment.

- [ ] **Step 1: Add the drizzle table** to `src/db/schema.ts`:

```ts
// ── Rescue runs ──────────────────────────────────────────────────────────────
// The ephemeral diagnosis slot. An uploaded .docx is classified HERE — no
// theses row, no thesis-limit spend — and becomes a thesis only at repair
// (payment). Unpaid rows expire via expires_at and are swept opportunistically
// on the next diagnose request.
export const rescueRuns = pgTable("rescue_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  /** Storage key of the uploaded bytes: documents/<userId>/rescue-<id>.docx */
  docPath: text("doc_path").notNull(),
  language: text("language"),
  normProfileId: uuid("norm_profile_id").references(() => normProfiles.id),
  /** diagnosing | diagnosed | repairing | done | failed | expired */
  status: text("status").notNull().default("diagnosing"),
  degraded: boolean("degraded").notNull().default(false),
  verdict: jsonb("verdict"),
  /** The FormatPlan — steps with live status, labels, questions. */
  plan: jsonb("plan"),
  /** Student answers, keyed by question id. */
  answers: jsonb("answers").default({}),
  /** Set at repair — the thesis the run became. */
  thesisId: uuid("thesis_id").references(() => theses.id, { onDelete: "set null" }),
  conformity: jsonb("conformity"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
});
```

Check the file's existing imports: `boolean` and `sql` may need adding to the `drizzle-orm/pg-core` / `drizzle-orm` import lines.

- [ ] **Step 2: Write the migration**

```sql
-- sql/2026-08-18-rescue.sql
-- The rescue lane's ephemeral diagnosis slot. See the spec:
-- docs/superpowers/specs/2026-08-18-thesis-rescue-mise-en-page-design.md (repo: modakerati)
create table if not exists rescue_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  filename text not null,
  doc_path text not null,
  language text,
  norm_profile_id uuid references norm_profiles(id),
  status text not null default 'diagnosing',
  degraded boolean not null default false,
  verdict jsonb,
  plan jsonb,
  answers jsonb default '{}'::jsonb,
  thesis_id uuid references theses(id) on delete set null,
  conformity jsonb,
  created_at timestamptz default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index if not exists rescue_runs_user_idx on rescue_runs (user_id, created_at desc);
create index if not exists rescue_runs_expiry_idx on rescue_runs (expires_at);
```

- [ ] **Step 3: Apply locally** (local Supabase, DB on the 5433x port range — check `.env` for the exact DSN) and typecheck:

Run: `psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" -f sql/2026-08-18-rescue.sql && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
cd ~/modakerati-server && git add src/db/schema.ts sql/2026-08-18-rescue.sql && git commit -m "feat(db): rescue_runs — the ephemeral diagnosis slot"
```

---

### Task 5: Routes — diagnose (free) + read

**Files:**
- Create: `src/routes/rescue.ts`
- Modify: `src/index.ts` (mount)
- Test: `src/__tests__/rescue-diagnose.test.ts` (pure helpers only; the route is exercised by hand + in P3)

- [ ] **Step 1: Implement the route file**

```ts
// src/routes/rescue.ts
// مسار الإنقاذ. Diagnosis is FREE and EPHEMERAL: bytes land in storage under a
// rescue- docId, get classified, and produce a verdict + plan — no theses row,
// no thesis-limit spend. Repair (Task 6) is the paid door that creates the
// thesis from the bytes already here.
import { Hono } from "hono";
import { and, eq, lt } from "drizzle-orm";
import type { AppVariables } from "../types";
import { db, rescueRuns, normProfiles } from "../db";
import { uploadDocx, downloadDocx, removeDocx } from "../lib/document-storage";
import { Mdocxengine, Doc } from "mdocxengine";
import { collectFacts } from "../lib/format/extract";
import { buildCandidates } from "../lib/format/candidates";
import { classifyWindows } from "../lib/format/classify";
import { reconcile, type Answers } from "../lib/format/reconcile";
import { buildVerdict } from "../lib/format/verdict";
import { buildFormatPlan } from "../lib/format/plan";
import { extractFormatting } from "../lib/thesis-extractor";
import { detectLanguage } from "../lib/thesis-classify";

export const rescueRoutes = new Hono<{ Variables: AppVariables }>();

/** Longest run of body paragraphs with neither a real heading nor a heading label. */
function longestHeadingGap(
  facts: import("../lib/format/types").BlockFacts[],
  labels: import("../lib/format/types").BlockLabel[],
): number {
  const heads = new Set(labels.filter((l) => l.role === "heading").map((l) => l.index));
  let gap = 0, worst = 0;
  for (const f of facts) {
    if (f.kind !== "paragraph") continue;
    if (f.headingLevel > 0 || heads.has(f.index)) gap = 0;
    else worst = Math.max(worst, ++gap);
  }
  return worst;
}

/** Opportunistic sweep — runs on each diagnose; no cron to configure or forget. */
async function sweepExpired(): Promise<void> {
  const dead = await db.select().from(rescueRuns).where(lt(rescueRuns.expiresAt, new Date())).limit(20);
  for (const run of dead) {
    try { await removeDocx(run.docPath); } catch { /* the row is the record; bytes best-effort */ }
    await db.delete(rescueRuns).where(eq(rescueRuns.id, run.id));
  }
}

rescueRoutes.post("/diagnose", async (c) => {
  const userId = c.get("userId");
  const { base64, filename, normProfileId } = await c.req.json();
  if (!base64 || !filename) return c.json({ error: "base64 and filename required" }, 400);
  if (!normProfileId) return c.json({ error: "normProfileId required" }, 400);

  await sweepExpired().catch(() => {});

  const [profile] = await db.select().from(normProfiles).where(eq(normProfiles.id, normProfileId));
  if (!profile) return c.json({ error: "Unknown norm profile" }, 400);

  const buffer = Buffer.from(base64, "base64");

  // 1. The ephemeral slot: a rescue- docId in the same bucket, no theses row.
  const [row] = await db.insert(rescueRuns).values({
    userId, filename, docPath: "pending", normProfileId,
  }).returning();
  const docPath = await uploadDocx(userId, `rescue-${row.id}`, buffer);

  try {
    const engine = await Mdocxengine.loadFromBuffer(buffer);
    const doc = Doc.from(engine);

    // 2-3. Extract → classify → reconcile.
    const facts = await collectFacts(doc);
    const language = detectLanguage(facts.map((f) => f.text).join(" ").slice(0, 4000));
    const { windows, truncated } = buildCandidates(facts);
    const cls = await classifyWindows(windows, language);
    let { labels, questions } = reconcile(facts, cls.labels, {});
    let degraded = cls.degraded || truncated;

    // The net is ACCOUNTABLE (spec): a long stretch with no heading means the
    // net failed — widen once and re-classify before pricing a verdict on it.
    if (longestHeadingGap(facts, labels) > 150) {
      const wide = buildCandidates(facts, { maxHeadingWords: 24 });
      const cls2 = await classifyWindows(wide.windows, language);
      const again = reconcile(facts, [...cls.labels, ...cls2.labels], {});
      labels = again.labels;
      questions = again.questions;
      degraded = degraded || cls2.degraded || wide.truncated;
    }

    // Cheap document-level signals for the verdict.
    const xml = engine.zip.readAsText("word/document.xml") ?? "";
    const detected = extractFormatting(xml);
    const scan = await doc.engine.captions.convertTextCaptions({ dryRun: true }).catch(() => ({ converted: [] as unknown[] }));
    // Figures = image blocks ∪ blocks the model labelled figure, deduped by index.
    const figureIdx = new Set<number>(facts.filter((f) => f.kind === "image").map((f) => f.index));
    for (const l of labels) if (l.role === "figure") figureIdx.add(l.index);
    const figureCount = figureIdx.size;
    const tableCount = facts.filter((f) => f.kind === "table").length;
    const hasRealToc = /\bTOC\s+\\o\b/.test(xml);

    const verdict = buildVerdict({
      labels, detected, expected: profile.formatting,
      hasRealToc, typedCaptionCount: scan.converted.length,
      figureCount, hasListOfFigures: false, tableCount, hasListOfTables: false,
    });
    const plan = buildFormatPlan({
      labels, questions, profileId: profile.id, degraded,
      typedCaptionCount: scan.converted.length, figureCount, tableCount, hasRealToc,
    });

    const [updated] = await db.update(rescueRuns).set({
      docPath, language, status: "diagnosed", degraded, verdict, plan,
    }).where(eq(rescueRuns.id, row.id)).returning();

    return c.json({
      runId: updated.id, status: updated.status, degraded,
      verdict, questions: plan.questions,
      steps: plan.steps.map((s) => ({ id: s.id, status: s.status })),
    });
  } catch (e: unknown) {
    await db.update(rescueRuns).set({ status: "failed" }).where(eq(rescueRuns.id, row.id));
    console.error("rescue diagnose failed:", row.id, (e as Error)?.message ?? e);
    return c.json({ error: "Could not read that .docx" }, 422);
  }
});

rescueRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  const [run] = await db.select().from(rescueRuns)
    .where(and(eq(rescueRuns.id, c.req.param("id")), eq(rescueRuns.userId, userId)));
  if (!run) return c.json({ error: "Not found" }, 404);
  const plan = run.plan as { steps?: unknown[]; questions?: unknown[] } | null;
  return c.json({
    runId: run.id, status: run.status, degraded: run.degraded,
    verdict: run.verdict, thesisId: run.thesisId, conformity: run.conformity,
    questions: plan?.questions ?? [], steps: plan?.steps ?? [],
  });
});
```

Export `rescueRuns` from `src/db/index.ts` the same way the other tables are re-exported (check how `normProfiles` flows through there and copy it).

- [ ] **Step 2: Mount** — in `src/index.ts`, next to the other mounts (~line 131):

```ts
import { rescueRoutes } from "./routes/rescue";
// …
app.route("/api/rescue", rescueRoutes);
```

- [ ] **Step 3: Typecheck + suite.** `npx tsc --noEmit && npx vitest run src/__tests__ --testTimeout=60000`

- [ ] **Step 4: Hand-smoke locally** (server running, a real token, any .docx):

```bash
TOKEN=… ; B64=$(base64 -i ~/Downloads/sample-thesis.docx)
curl -s localhost:3001/api/rescue/diagnose -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"base64\":\"$B64\",\"filename\":\"sample.docx\",\"normProfileId\":\"<a real norm profile uuid>\"}" | head -c 2000
```

Expected: `{"runId":"…","status":"diagnosed","verdict":{"issues":[…],"total":N},…}` and NO new row in `theses`.

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/routes/rescue.ts src/index.ts src/db/index.ts && git commit -m "feat(rescue): free ephemeral diagnosis — verdict + plan, no thesis row"
```

---

### Task 6: Routes — answers + paid repair

**Files:**
- Modify: `src/routes/rescue.ts`

- [ ] **Step 1: Answers endpoint** — append:

```ts
rescueRoutes.post("/:id/answers", async (c) => {
  const userId = c.get("userId");
  const { answers } = await c.req.json() as { answers: Answers };
  const [run] = await db.select().from(rescueRuns)
    .where(and(eq(rescueRuns.id, c.req.param("id")), eq(rescueRuns.userId, userId)));
  if (!run) return c.json({ error: "Not found" }, 404);
  if (run.status !== "diagnosed") return c.json({ error: `Run is ${run.status}` }, 409);

  // Re-reconcile with the student's answers folded in, and rebuild the plan.
  const buffer = await downloadDocx(run.docPath);
  const doc = Doc.from(await Mdocxengine.loadFromBuffer(buffer));
  const facts = await collectFacts(doc);
  const prior = (run.plan as { labels?: unknown[] } | null)?.labels ?? [];
  const aiLabels = (prior as import("../lib/format/types").BlockLabel[]).filter((l) => l.source === "ai");
  const merged = { ...(run.answers as Answers ?? {}), ...(answers ?? {}) };
  const { labels, questions } = reconcile(facts, aiLabels, merged);

  // The document-level signals were captured once at diagnosis and ride on the
  // plan — rebuild reads them verbatim, never re-derives them.
  const oldPlan = run.plan as import("../lib/format/types").FormatPlan;
  const plan = buildFormatPlan({
    labels, questions, profileId: run.normProfileId!, degraded: run.degraded,
    ...oldPlan.signals,
  });
  await db.update(rescueRuns).set({ answers: merged, plan }).where(eq(rescueRuns.id, run.id));
  return c.json({ runId: run.id, questions: plan.questions, steps: plan.steps.map((s) => ({ id: s.id, status: s.status })) });
});
```

- [ ] **Step 2: Repair endpoint** — append:

```ts
rescueRoutes.post("/:id/repair", async (c) => {
  const userId = c.get("userId");
  const [run] = await db.select().from(rescueRuns)
    .where(and(eq(rescueRuns.id, c.req.param("id")), eq(rescueRuns.userId, userId)));
  if (!run) return c.json({ error: "Not found" }, 404);
  if (run.status === "done") return c.json({ runId: run.id, status: "done", thesisId: run.thesisId, conformity: run.conformity });
  if (run.status !== "diagnosed" && run.status !== "repairing") return c.json({ error: `Run is ${run.status}` }, 409);

  // ── The paywall. Any paid plan opens the door; free gets 402 → subscription
  //    screen. NEVER read the plan via currentPeriod (it spends the trial).
  const { currentPlanCode } = await import("../lib/billing/quota");
  const planCode = await currentPlanCode(userId);
  if (planCode === "free") return c.json({ error: "payment_required", code: "rescue_repair" }, 402);

  // ── Creating the thesis is a normal creation door: the allowance applies.
  const { thesisAllowance, thesisLimitBody } = await import("../lib/billing/thesis-limit");

  let thesisId = run.thesisId;
  if (!thesisId) {
    const allowance = await thesisAllowance(userId);
    if (!allowance.canCreate) return c.json(thesisLimitBody(allowance), 402);
    // Mirror what POST /api/thesis/import inserts (src/routes/thesis/layout.ts:106-135):
    // same title derivation, same docMode value, same normProfileId wiring — copy
    // that insert here with title = filename minus extension.
    const bytes = await downloadDocx(run.docPath);
    const { db: db2, theses } = await import("../db");
    const [thesis] = await db2.insert(theses).values({
      userId,
      title: run.filename.replace(/\.docx$/i, ""),
      normProfileId: run.normProfileId,
      language: run.language ?? "ar",
      docMode: "live-docx",           // ⚠️ verify the exact literal used by /import and match it
    }).returning();
    const newPath = await uploadDocx(userId, thesis.id, bytes);
    await db2.update(theses).set({ docPath: newPath }).where(eq(theses.id, thesis.id));
    thesisId = thesis.id;
    await db.update(rescueRuns).set({ thesisId, status: "repairing" }).where(eq(rescueRuns.id, run.id));
  }

  // ── Execute (or resume) the plan.
  const { runPlan } = await import("../lib/format/runner");
  const { stepClean, stepStructure, stepNorms, stepSectionsNumbering, stepPagination, stepCaptions, stepApparatus } = await import("../lib/format/steps");
  const { verifyDocument } = await import("../lib/format/verify");
  const { withThesisLock } = await import("../lib/thesis-lock");
  const { loadThesisEngine } = await import("../lib/thesis-doc");
  const { persistThesisDocx } = await import("../lib/thesis-history");
  const { normalizeDocxRtl } = await import("../lib/thesis-rtl");

  const [profile] = await db.select().from(normProfiles).where(eq(normProfiles.id, run.normProfileId!));
  const plan = run.plan as import("../lib/format/types").FormatPlan;
  const labelFor = (index: number) => plan.labels.find((l) => l.index === index);

  const io = {
    savePlan: async (p: import("../lib/format/types").FormatPlan) => {
      await db.update(rescueRuns).set({ plan: p }).where(eq(rescueRuns.id, run.id));
    },
    executeStep: async (step: import("../lib/format/types").PlanStep, p: import("../lib/format/types").FormatPlan) => {
      const { db: db3, theses } = await import("../db");
      const [thesis] = await db3.select().from(theses).where(eq(theses.id, thesisId!));
      if (!thesis?.docPath) throw new Error("thesis has no document");

      // Lock PER STEP; fresh engine INSIDE the lock; persist before release.
      return withThesisLock(thesis.id, async () => {
        const engine = await loadThesisEngine(thesis.docPath!);
        const doc = Doc.from(engine);

        // finish persists ITS OWN way — the make_thesis_ready pattern
        // (src/mcp/tools/docx-document.ts:138-176): normalize the BYTES and
        // persist the normalized buffer WITHOUT an engine (they came from the
        // buffer, not a cacheable engine); verify the final bytes.
        if (step.id === "finish") {
          const bytes = Buffer.from(engine.zip.toBuffer());
          const normalized = await normalizeDocxRtl(bytes).catch(() => null);
          const finalBytes = normalized ?? bytes;
          await persistThesisDocx({
            thesisId: thesis.id, userId, buffer: finalBytes,
            label: "Rescue: finish", source: "import",
          });
          const record = await verifyDocument(
            Doc.from(await Mdocxengine.loadFromBuffer(finalBytes)),
            profile!.formatting, { degraded: p.degraded });
          await db.update(rescueRuns).set({ conformity: record }).where(eq(rescueRuns.id, run.id));
          return { checks: record.checks.length, normalized: normalized !== null };
        }

        let out: Record<string, unknown> = {};
        switch (step.id) {
          case "snapshot":
            // The persist below snapshots the pre-edit bytes — this pins the
            // "Before formatting" restore point, the single Undo.
            out = { note: "before-formatting snapshot" };
            break;
          case "clean":
            // step.params is the SINGLE source of truth (P1 review decision) —
            // never rebuilt from p.labels, so the two can't drift.
            out = await stepClean(doc,
              (step.params as { targets: Array<{ index: number; textHead: string }> } | undefined) ?? { targets: [] });
            break;
          case "structure":
            out = await stepStructure(doc,
              (step.params as { promotions: Array<{ index: number; textHead: string; level: number }> } | undefined) ?? { promotions: [] });
            break;
          case "norms":
            out = await stepNorms(doc, {
              formatting: profile!.formatting, bindingSide: profile!.bindingSide,
              language: run.language ?? undefined,
            });
            break;
          case "sections-numbering": {
            // The anchor was stored on the step at plan build (P1 plan.ts).
            const anchor = (step.params as { bodyStart?: { index: number; textHead: string } })?.bodyStart;
            if (!anchor) throw new Error("no body start anchor");
            out = await stepSectionsNumbering(doc, { bodyStart: anchor });
            if ((out as { ok?: boolean }).ok === false) throw new Error(String((out as { error?: string }).error ?? "sections failed"));
            break;
          }
          case "pagination": out = await stepPagination(doc, {}); break;
          case "captions": out = await stepCaptions(doc, {}); break;
          case "apparatus":
            out = await stepApparatus(doc, (step.params ?? { toc: true, listOfFigures: false, listOfTables: false }) as never);
            break;
        }

        await persistThesisDocx({
          thesisId: thesis.id, userId,
          buffer: Buffer.from(engine.zip.toBuffer()), engine,
          label: `Rescue: ${step.id}`, source: "import",
        });
        return out;
      });
    },
  };

  const finished = await runPlan(plan, io);
  const failed = finished.steps.some((s) => s.status === "failed");
  await db.update(rescueRuns).set({ status: failed ? "failed" : "done", plan: finished }).where(eq(rescueRuns.id, run.id));

  const [fresh] = await db.select().from(rescueRuns).where(eq(rescueRuns.id, run.id));
  return c.json({ runId: run.id, status: fresh.status, thesisId, conformity: fresh.conformity,
    steps: finished.steps.map((s) => ({ id: s.id, status: s.status, error: s.error })) });
});
```

⚠️ Verify the `docMode` literal against what `POST /api/thesis/import` inserts (`src/routes/thesis/layout.ts:106-135`) and match it exactly — the plan writes `"live-docx"` from memory, the code is the authority.

- [ ] **Step 3: Typecheck + full suite.** `npx tsc --noEmit && npx vitest run src/__tests__ --testTimeout=60000`

- [ ] **Step 4: Hand-smoke the full lane** (needs a user on a paid plan locally — set one via the dashboard or SQL):

```bash
# diagnose (Task 5 smoke) → note runId, then:
curl -s -X POST localhost:3001/api/rescue/<runId>/repair -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# expect: status done, thesisId set, conformity.checks[], every step done/skipped
# re-POST → expect the idempotent short-circuit: {"status":"done",…} with no re-run
```

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/routes/rescue.ts src/lib/format/plan.ts src/lib/format/types.ts src/__tests__/format-plan.test.ts && git commit -m "feat(rescue): paid repair — thesis born at payment, per-step lock+persist, resumable"
```

---

## Done means

- The TOC tool's behavior is unchanged (full suite green) and `insertTocWithPolicy` is the one implementation.
- `rescue_runs` exists locally; the SQL file is committed for the prod hand-apply (the deploy itself is the user's call — server versioning: this is a feature → `deploy minor`, and the migration must be applied on cloud BEFORE the deploy).
- Diagnose creates NO thesis row and touches NO limit; repair 402s for free users, creates the thesis through the allowance, runs the plan per-step under the lock, resumes idempotently, and stores a conformity record.
- `npx tsc --noEmit` and the full vitest suite are green.
