# Thesis Rescue P1 — Format Engine (server lib) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/lib/format/` in ~/modakerati-server — the pure, model-optional engine that turns an imported .docx into (a) a semantic block map, (b) a verdict, (c) a FormatPlan, and (d) a conformity record. No routes, no DB, no UI in this plan.

**Architecture:** The AI is the eyes, the plan is the hands. `extract` reads facts per block (via mdocxengine `blocksDetailed`/`inferOutline`), `candidates` picks what the model looks at, `classify` labels them (feature `rescue.classify`, heuristic fallback → degraded), `reconcile` merges styled/heuristic/AI/student labels into one map + the ~5 questions, `verdict` prices the damage, `plan` emits ordered steps, `verify` re-reads the doc and asserts the norms hold.

**Tech Stack:** TypeScript, vitest, mdocxengine (`Doc`, `blocksDetailed`, `inferOutline`), existing `thesis-analysis.ts` / `thesis-classify.ts` helpers. Repo: `~/modakerati-server`. Test fixture: `assets/thesis-base.docx` (pattern: `src/__tests__/norm-profile-apply.test.ts`).

**Spec:** `~/modakerati/docs/superpowers/specs/2026-08-18-thesis-rescue-mise-en-page-design.md`

**Deviation from the spec's step table (approved rationale):** spec steps P4 (sections) + P5 (chrome) collapse into ONE plan step `sections-numbering`, because the engine operation that implements both — `applyFrontMatterNumbering` (src/mcp/doc-page-numbering.ts:60) — atomically splits sections AND writes the roman/arabic footers. Plan step ids: `snapshot, clean, structure, norms, sections-numbering, pagination, captions, apparatus, finish`.

---

### Task 1: Types + step order

**Files:**
- Create: `src/lib/format/types.ts`
- Test: `src/__tests__/format-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-types.test.ts
import { describe, it, expect } from "vitest";
import { STEP_ORDER, STEP_DEPS, type PlanStepId } from "../lib/format/types";

describe("format plan step graph", () => {
  it("every dependency comes earlier in STEP_ORDER", () => {
    for (const [step, deps] of Object.entries(STEP_DEPS) as [PlanStepId, PlanStepId[]][]) {
      for (const dep of deps) {
        expect(STEP_ORDER.indexOf(dep)).toBeLessThan(STEP_ORDER.indexOf(step));
      }
    }
  });
  it("apparatus depends on structure and captions (TOC needs real headings, lists need real captions)", () => {
    expect(STEP_DEPS.apparatus).toContain("structure");
    expect(STEP_DEPS.apparatus).toContain("captions");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `cd ~/modakerati-server && npx vitest run src/__tests__/format-types.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/types.ts
// The shared vocabulary of the rescue pipeline. Everything here is JSON-safe:
// FormatPlan and Verdict are persisted (rescue_runs.plan / .verdict in P2) and
// travel to the app as-is.

/** What a block IS. The model may only ever answer with one of these. */
export type SemanticRole =
  | "title-page" | "dedication" | "thanks" | "abstract" | "toc"
  | "list-of-figures" | "list-of-tables" | "abbreviations"
  | "heading" | "body" | "quote" | "annex"
  | "table" | "table-caption" | "figure" | "figure-caption"
  | "noise";

export const SEMANTIC_ROLES: readonly SemanticRole[] = [
  "title-page", "dedication", "thanks", "abstract", "toc",
  "list-of-figures", "list-of-tables", "abbreviations",
  "heading", "body", "quote", "annex",
  "table", "table-caption", "figure", "figure-caption", "noise",
];

/** One block's observable facts — blocksDetailed + inferOutline, merged. */
export interface BlockFacts {
  index: number;
  kind: "paragraph" | "table" | "image" | "other";
  /** Trimmed, capped at 200 chars. */
  text: string;
  wordCount: number;
  bold: boolean;
  fontSizePt: number | null;
  alignment: string | null;
  /** Real Word heading level (0 = none) — from the style/outlineLvl. */
  headingLevel: number;
  looksLikeCaption: boolean;
  /** inferOutline's guess for this index, when it made one. */
  inferred?: { level: number; confidence: "styled" | "high" | "medium" | "low"; reason: string };
}

/**
 * A semantic label, index- AND text-anchored. Indices shift under edits;
 * every consumer re-resolves via textHead (the block-links pattern).
 */
export interface BlockLabel {
  index: number;
  /** First 80 chars of the block's text — the re-resolution anchor. */
  textHead: string;
  role: SemanticRole;
  /** Headings only. الفصل=1, المبحث=2, المطلب=3. */
  level?: 1 | 2 | 3 | 4;
  confidence: "high" | "medium" | "low";
  source: "styled" | "heuristic" | "ai" | "student";
}

/** One card in the app's question stack. Dismissing = the safest default. */
export interface RescueQuestion {
  id: string;                     // `q-${index}`
  index: number;
  textHead: string;
  /** Text heads of the surrounding blocks, for context in the card. */
  before: string;
  after: string;
  suggested: { role: SemanticRole; level?: 1 | 2 | 3 | 4 };
  /** Every card also gets a "not a heading / keep as is" choice in the UI. */
  choices: Array<{ role: SemanticRole; level?: 1 | 2 | 3 | 4 }>;
}

export type PlanStepId =
  | "snapshot" | "clean" | "structure" | "norms"
  | "sections-numbering" | "pagination" | "captions" | "apparatus" | "finish";

export const STEP_ORDER: readonly PlanStepId[] = [
  "snapshot", "clean", "structure", "norms",
  "sections-numbering", "pagination", "captions", "apparatus", "finish",
];

/** A step runs only when every dependency is "done". Independent failures don't cascade. */
export const STEP_DEPS: Record<PlanStepId, PlanStepId[]> = {
  snapshot: [],
  clean: ["snapshot"],
  structure: ["snapshot"],
  norms: ["snapshot"],
  "sections-numbering": ["structure"],
  pagination: ["structure"],
  captions: ["snapshot"],
  apparatus: ["structure", "captions"],
  finish: [],
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: PlanStepId;
  status: StepStatus;
  /** Step-specific inputs, computed at plan build (indices, profileId, …). */
  params?: Record<string, unknown>;
  /** Human line for the progress UI / conformity record. */
  detail?: string;
  error?: string;
}

export interface FormatPlan {
  steps: PlanStep[];
  labels: BlockLabel[];
  questions: RescueQuestion[];
  /** Block index where arabic page numbering starts; null = numbering skipped. */
  bodyStartIndex: number | null;
  /** True when classification fell back to heuristics or was truncated. */
  degraded: boolean;
  /** Document-level signals captured at diagnosis, re-read verbatim when the
   *  plan is rebuilt after answers — never re-derived from lossy step params. */
  signals: { typedCaptionCount: number; figureCount: number; tableCount: number; hasRealToc: boolean };
}

export interface VerdictIssue {
  code: string;
  severity: "error" | "warning" | "info";
  count: number;
  message: string;
}

export interface Verdict { issues: VerdictIssue[]; total: number }

export interface ConformityCheck { code: string; ok: boolean; detail: string }
export interface ConformityRecord { checks: ConformityCheck[]; degraded: boolean }
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd ~/modakerati-server && npx vitest run src/__tests__/format-types.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/types.ts src/__tests__/format-types.test.ts && git commit -m "feat(format): rescue pipeline vocabulary — roles, labels, plan steps"
```

---

### Task 2: Extract — block facts

**Files:**
- Create: `src/lib/format/extract.ts`
- Test: `src/__tests__/format-extract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-extract.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Mdocxengine, Doc } from "mdocxengine";
import { collectFacts } from "../lib/format/extract";

const SAMPLE = new URL("../../assets/thesis-base.docx", import.meta.url).pathname;

describe("collectFacts", () => {
  it("returns one fact per block, index-aligned, with inferOutline merged in", async () => {
    const doc = Doc.from(await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE)));
    const facts = await collectFacts(doc);
    const blocks = await doc.blocks();
    expect(facts.length).toBe(blocks.length);
    facts.forEach((f, i) => expect(f.index).toBe(i));
    // The seed template has real styled headings — they must surface as styled.
    const styled = facts.filter((f) => f.inferred?.confidence === "styled");
    expect(styled.length).toBeGreaterThan(0);
    for (const f of styled) expect(f.headingLevel).toBeGreaterThan(0);
  });
  it("caps text at 200 chars", async () => {
    const doc = Doc.from(await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE)));
    for (const f of await collectFacts(doc)) expect(f.text.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd ~/modakerati-server && npx vitest run src/__tests__/format-extract.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/extract.ts
// Facts, not opinions: everything downstream (candidates, verdict, verify)
// reads the document through this one lens.
import type { Doc } from "mdocxengine";
import type { BlockFacts } from "./types";

const TEXT_CAP = 200;

export async function collectFacts(doc: Doc): Promise<BlockFacts[]> {
  const detailed = await doc.blocksDetailed();
  const inferred = await doc.inferOutline();
  const byIndex = new Map(inferred.map((h) => [h.index, h]));

  return detailed.map((b) => {
    const hit = byIndex.get(b.index);
    return {
      index: b.index,
      kind: b.kind === "paragraph" ? "paragraph"
        : b.kind === "table" ? "table"
        : b.kind === "image" ? "image" : "other",
      text: (b.text ?? "").trim().slice(0, TEXT_CAP),
      wordCount: b.wordCount,
      bold: b.bold,
      fontSizePt: b.fontSizePt,
      alignment: b.alignment,
      headingLevel: (b as { headingLevel?: number }).headingLevel ?? 0,
      looksLikeCaption: b.looksLikeCaption,
      ...(hit ? { inferred: { level: hit.level, confidence: hit.confidence, reason: hit.reason } } : {}),
    };
  });
}
```

NB: `blocksDetailed` items carry `headingLevel` on paragraphs (see mdocxengine `Doc.ts` — `toBlockInfo`); if `kind` values differ at compile time (`image` may come through as a paragraph with a drawing), match on what `tsc` reports and keep the mapping total — every raw kind maps to one of the four.

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-extract.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/extract.ts src/__tests__/format-extract.test.ts && git commit -m "feat(format): collectFacts — blocksDetailed + inferOutline in one lens"
```

---

### Task 3: Candidates — the recall net + windows

**Files:**
- Create: `src/lib/format/candidates.ts`
- Test: `src/__tests__/format-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-candidates.test.ts
import { describe, it, expect } from "vitest";
import { buildCandidates, NOISE_RE } from "../lib/format/candidates";
import type { BlockFacts } from "../lib/format/types";

const para = (index: number, text: string, over: Partial<BlockFacts> = {}): BlockFacts => ({
  index, kind: "paragraph", text, wordCount: text.split(/\s+/).filter(Boolean).length,
  bold: false, fontSizePt: 12, alignment: null, headingLevel: 0, looksLikeCaption: false, ...over,
});

describe("buildCandidates", () => {
  it("nets medium/low inferred, tables, images, pattern hits and page-number noise — not settled body", () => {
    const facts: BlockFacts[] = [
      para(0, "المقدمة العامة", { inferred: { level: 1, confidence: "medium", reason: "bold, short" } }),
      para(1, "هذا نص طويل جدا ".repeat(20)),                               // body — excluded
      { ...para(2, ""), kind: "table" },                                       // table — included
      para(3, "12"),                                                           // typed page number — included
      para(4, "الفصل الأول: الإطار النظري"),                                  // pattern hit — included
      para(5, "عنوان مؤكد", { headingLevel: 1,
        inferred: { level: 1, confidence: "styled", reason: "heading style" } }), // settled — excluded
    ];
    const { candidateIndices } = buildCandidates(facts);
    expect(candidateIndices).toContain(0);
    expect(candidateIndices).toContain(2);
    expect(candidateIndices).toContain(3);
    expect(candidateIndices).toContain(4);
    expect(candidateIndices).not.toContain(1);
    expect(candidateIndices).not.toContain(5);
  });

  it("windows are ordered, overlap, and carry prev/next context heads", () => {
    const facts = Array.from({ length: 150 }, (_, i) => para(i, `عنوان قصير ${i}`, { bold: true, wordCount: 2 }));
    const { windows } = buildCandidates(facts, { windowSize: 60, overlap: 5 });
    expect(windows.length).toBeGreaterThan(1);
    const w0 = windows[0].items.map((x) => x.i);
    const w1 = windows[1].items.map((x) => x.i);
    expect(w1[0]).toBe(w0[w0.length - 5]); // 5-item overlap
    expect(windows[0].items[0]).toHaveProperty("next");
  });

  it("over the char ceiling it drops non-inferred candidates first and reports truncated", () => {
    const facts = Array.from({ length: 400 }, (_, i) =>
      para(i, `سطر قصير غامق رقم ${i} بكلمات كثيرة نسبيا هنا`, { bold: true, wordCount: 8 }));
    facts[0] = para(0, "الفصل الأول", { inferred: { level: 1, confidence: "medium", reason: "pattern" } });
    const { candidateIndices, truncated } = buildCandidates(facts, { maxChars: 2000 });
    expect(truncated).toBe(true);
    expect(candidateIndices).toContain(0); // inferred candidates survive the cut
  });

  it("NOISE_RE matches bare page numbers only", () => {
    expect(NOISE_RE.test("12")).toBe(true);
    expect(NOISE_RE.test("- 12 -")).toBe(true);
    expect(NOISE_RE.test("الفصل 12")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-candidates.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/candidates.ts
// The net decides what the model LOOKS AT, never what something IS.
// Deliberately over-inclusive; verify.ts audits for gaps after the run.
import type { BlockFacts } from "./types";

/** A hand-typed page number standing alone in a paragraph. */
export const NOISE_RE = /^[-–—\s]*\d{1,4}[-–—\s]*$/;

/** Chapter/section wording in the three languages + dotted numbering. */
export const HEADING_HINT_RE =
  /^(الفصل|الباب|المبحث|المطلب|المقدمة|الخاتمة|Chapitre|Chapter|Partie|Section|Introduction|Conclusion|\d+(\.\d+)+\s)/i;

export interface CandidateItem {
  i: number;
  /** Text, capped at 160 chars for the prompt. */
  t: string;
  b?: 1;              // bold
  sz?: number;        // fontSizePt
  al?: string;        // alignment
  k?: "table" | "image";
  cap?: 1;            // looksLikeCaption
  pb?: 1;             // reserved: page-break-before flag (not read in P1)
  /** Text heads of the blocks around it — context decides the answer. */
  prev?: string;
  next?: string;
}

export interface CandidateWindow { items: CandidateItem[] }

export interface CandidateSet {
  candidateIndices: number[];
  windows: CandidateWindow[];
  truncated: boolean;
}

export interface CandidateOptions {
  windowSize?: number;   // candidates per model call
  overlap?: number;      // shared tail between consecutive windows
  maxChars?: number;     // hard token ceiling, expressed in prompt chars
  maxHeadingWords?: number;
}

const HEAD = (s: string) => s.slice(0, 80);

export function buildCandidates(facts: BlockFacts[], opts: CandidateOptions = {}): CandidateSet {
  const { windowSize = 60, overlap = 5, maxChars = 60_000, maxHeadingWords = 14 } = opts;

  // Which short lines repeat? A running head shows up on every page.
  const repeats = new Map<string, number>();
  for (const f of facts) {
    if (f.kind === "paragraph" && f.wordCount > 0 && f.wordCount <= 8) {
      repeats.set(f.text, (repeats.get(f.text) ?? 0) + 1);
    }
  }

  type Scored = { f: BlockFacts; fromOutline: boolean };
  const picked: Scored[] = [];
  for (const f of facts) {
    // Settled: a real styled heading, or a heuristic call strong enough to apply silently.
    if (f.inferred?.confidence === "styled" || f.inferred?.confidence === "high") continue;
    if (f.kind === "table" || f.kind === "image") { picked.push({ f, fromOutline: false }); continue; }
    if (f.kind !== "paragraph" || !f.text) continue;

    const fromOutline = f.inferred?.confidence === "medium" || f.inferred?.confidence === "low";
    const short = f.wordCount > 0 && f.wordCount <= maxHeadingWords;
    const styledOff = f.bold || f.alignment === "center";
    const isNoise = NOISE_RE.test(f.text) || ((repeats.get(f.text) ?? 0) >= 3 && short);
    const patterned = HEADING_HINT_RE.test(f.text);

    if (fromOutline || isNoise || patterned || f.looksLikeCaption || (short && styledOff)) {
      picked.push({ f, fromOutline });
    }
  }

  // The ceiling is a RULE, not an estimate: past it, the weakest signals go
  // first — everything inferOutline itself flagged survives — and the run is
  // marked degraded so the conformity record can say so.
  const cost = (s: Scored) => s.f.text.length + 40;
  let total = picked.reduce((n, s) => n + cost(s), 0);
  let truncated = false;
  if (total > maxChars) {
    truncated = true;
    for (let i = picked.length - 1; i >= 0 && total > maxChars; i--) {
      if (!picked[i].fromOutline) { total -= cost(picked[i]); picked.splice(i, 1); }
    }
  }

  const candidateIndices = picked.map((s) => s.f.index);
  const items: CandidateItem[] = picked.map(({ f }) => ({
    i: f.index,
    t: f.text.slice(0, 160),
    ...(f.bold ? { b: 1 as const } : {}),
    ...(f.fontSizePt != null ? { sz: f.fontSizePt } : {}),
    ...(f.alignment ? { al: f.alignment } : {}),
    ...(f.kind === "table" || f.kind === "image" ? { k: f.kind } : {}),
    ...(f.looksLikeCaption ? { cap: 1 as const } : {}),
    ...(f.index > 0 ? { prev: HEAD(facts[f.index - 1]?.text ?? "") } : {}),
    ...(f.index < facts.length - 1 ? { next: HEAD(facts[f.index + 1]?.text ?? "") } : {}),
  }));

  const windows: CandidateWindow[] = [];
  for (let start = 0; start < items.length; start += windowSize - overlap) {
    windows.push({ items: items.slice(start, start + windowSize) });
    if (start + windowSize >= items.length) break;
  }

  return { candidateIndices, windows, truncated };
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-candidates.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/candidates.ts src/__tests__/format-candidates.test.ts && git commit -m "feat(format): candidate net — recall-oriented, char-ceilinged, windowed"
```

---

### Task 4: Classify — the one model call

**Files:**
- Create: `src/lib/format/classify.ts`
- Modify: `src/lib/ai/features.ts` (add one FEATURES entry, after the `thesis.classify-parts` entry)
- Test: `src/__tests__/format-classify.test.ts`

- [ ] **Step 1: Write the failing test** (pure parts only — prompt + parser + merge; never the live call)

```ts
// src/__tests__/format-classify.test.ts
import { describe, it, expect } from "vitest";
import { buildWindowPrompt, parseWindowReply } from "../lib/format/classify";
import type { CandidateWindow } from "../lib/format/candidates";

const win: CandidateWindow = {
  items: [
    { i: 4, t: "الفصل الأول: الإطار النظري", b: 1, prev: "…", next: "تمهيد" },
    { i: 9, t: "12" },
    { i: 11, t: "جدول رقم 1: توزيع العينة", cap: 1 },
  ],
};

describe("classify prompt + parser", () => {
  it("prompt lists every candidate with its index and flags", () => {
    const p = buildWindowPrompt(win, "ar");
    expect(p).toContain("[4]");
    expect(p).toContain("الفصل الأول");
    expect(p).toContain("[9]");
  });

  it("parses a JSON reply into labels, dropping unknown roles and unknown indices", () => {
    const raw = `[
      {"i":4,"role":"heading","level":1,"conf":"high"},
      {"i":9,"role":"noise","conf":"high"},
      {"i":11,"role":"table-caption","conf":"medium"},
      {"i":999,"role":"heading","level":1,"conf":"high"},
      {"i":4,"role":"banana","conf":"high"}
    ]`;
    const labels = parseWindowReply(raw, win);
    expect(labels.map((l) => l.index)).toEqual([4, 9, 11]);
    expect(labels[0]).toMatchObject({ role: "heading", level: 1, confidence: "high", source: "ai", textHead: expect.stringContaining("الفصل") });
  });

  it("returns [] on prose or broken JSON (the window falls back, the run degrades)", () => {
    expect(parseWindowReply("Sorry, here is my thinking…", win)).toEqual([]);
  });

  it("clamps level to 1..4", () => {
    const labels = parseWindowReply(`[{"i":4,"role":"heading","level":9,"conf":"high"}]`, win);
    expect(labels[0].level).toBe(4);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-classify.test.ts`

- [ ] **Step 3: Implement** — mirror `thesis-classify.ts` exactly (lazy feature import, retry loop, `classifyFailure`):

```ts
// src/lib/format/classify.ts
// The only model call in the rescue pipeline. Shape and discipline copied from
// lib/thesis-classify.ts: lazy feature import, bounded retries, and a reply
// parser that never throws — a bad window degrades the run, it never sinks it.
import type { CandidateWindow } from "./candidates";
import type { BlockLabel, SemanticRole } from "./types";
import { SEMANTIC_ROLES } from "./types";
import { classifyFailure, type ClassifyFailure } from "../thesis-classify";

const ROLE_SET = new Set<string>(SEMANTIC_ROLES);

export function buildWindowPrompt(win: CandidateWindow, language: string): string {
  const lines = win.items.map((it) => {
    const flags = [
      it.b && "bold", it.sz && `size:${it.sz}`, it.al && `align:${it.al}`,
      it.k && `kind:${it.k}`, it.cap && "caption-like",
    ].filter(Boolean).join(", ");
    return [
      `[${it.i}] "${it.t}"${flags ? `  (${flags})` : ""}`,
      it.prev !== undefined ? `  before: "${it.prev}"` : null,
      it.next !== undefined ? `  after: "${it.next}"` : null,
    ].filter(Boolean).join("\n");
  });
  return `Document language: ${language}. Label each numbered block.\n\n${lines.join("\n\n")}`;
}

export function parseWindowReply(raw: string, win: CandidateWindow): BlockLabel[] {
  const known = new Map(win.items.map((it) => [it.i, it]));
  let arr: unknown[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : [];
    arr = Array.isArray(parsed) ? parsed : [];
  } catch { arr = []; }

  const out: BlockLabel[] = [];
  const seen = new Set<number>();
  for (const hit of arr) {
    if (!hit || typeof hit !== "object") continue;
    const h = hit as { i?: unknown; role?: unknown; level?: unknown; conf?: unknown };
    const i = typeof h.i === "number" ? h.i : NaN;
    const item = known.get(i);
    if (!item || seen.has(i)) continue;
    if (typeof h.role !== "string" || !ROLE_SET.has(h.role)) continue;
    seen.add(i);
    const conf = h.conf === "high" || h.conf === "medium" || h.conf === "low" ? h.conf : "low";
    const level = h.role === "heading" && typeof h.level === "number"
      ? (Math.min(4, Math.max(1, Math.round(h.level))) as 1 | 2 | 3 | 4)
      : undefined;
    out.push({ index: i, textHead: item.t.slice(0, 80), role: h.role as SemanticRole,
      ...(level ? { level } : {}), confidence: conf, source: "ai" });
  }
  return out;
}

export interface ClassifyRunResult {
  labels: BlockLabel[];
  degraded: boolean;
  reason?: ClassifyFailure;
  /** Model calls actually spent. */
  attempts: number;
}

const ATTEMPTS_PER_WINDOW = 2;

/** Classify every window; a window that stays unparseable is skipped (degraded). */
export async function classifyWindows(
  windows: CandidateWindow[],
  language: string,
): Promise<ClassifyRunResult> {
  const labels: BlockLabel[] = [];
  let degraded = false;
  let reason: ClassifyFailure | undefined;
  let attempts = 0;

  for (const win of windows) {
    let done = false;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_WINDOW && !done; attempt++) {
      attempts++;
      try {
        const { featureProvider, featureSystemPrompt } = await import("../ai/features");
        const { ai, model } = featureProvider("rescue.classify");
        const prompt = attempt === 1
          ? buildWindowPrompt(win, language)
          : `${buildWindowPrompt(win, language)}\n\n---\nYour previous answer could not be parsed. Reply with ONLY the JSON array — no explanation, no markdown fence, starting with [ and ending with ].`;
        const res = await ai.chat([{ role: "user", content: prompt }], {
          model,
          systemPrompt: featureSystemPrompt("rescue.classify", { roles: SEMANTIC_ROLES.join(", ") }),
        });
        const parsed = parseWindowReply(typeof res === "string" ? res : (res as { text?: string }).text ?? "", win);
        if (parsed.length > 0) { labels.push(...parsed); done = true; }
      } catch (e) {
        reason = classifyFailure(e);
        // Same policy as thesis-classify: a rejected key answers the same way
        // forever — stop burning the remaining windows on it.
        if (reason === "key_rejected" || reason === "no_credit" || reason === "model_denied" || reason === "model_missing") {
          return { labels, degraded: true, reason, attempts };
        }
      }
    }
    if (!done) degraded = true;
  }
  return { labels, degraded, ...(reason ? { reason } : {}), attempts };
}
```

⚠️ Check `ai.chat`'s exact reply shape at `src/lib/thesis-classify.ts` (the code right after the `ai.chat(` call, ~line 400) and match it — do not guess between `string` and `{text}`.

- [ ] **Step 4: Add the feature entry** — in `src/lib/ai/features.ts`, directly after the `thesis.classify-parts` object in `FEATURES`, insert:

```ts
  {
    key: "rescue.classify",
    label: "Rescue — block classification",
    group: "Rescue",
    hint: "Labels an imported thesis's blocks (headings, captions, noise) before the formatting run. One windowed call per ~60 candidate blocks.",
    volume: "low",
    defaultSystemPrompt:
      'You label blocks of an academic thesis (mémoire). Allowed roles: {roles}. For role "heading" also give "level" 1-4 (الفصل/Chapitre=1, المبحث/Section=2, المطلب=3). "noise" = hand-typed page numbers or repeated running heads that must be deleted. Reply with ONLY a JSON array: [{"i":<index>,"role":"<role>","level":<1-4 headings only>,"conf":"high"|"medium"|"low"}]. Label every block you are shown. No prose, no markdown fence.',
  },
```

⚠️ `features.ts` prose lives in normal strings here (not the types.ts template literal) — but keep the prompt free of backticks anyway.

- [ ] **Step 5: Run — expect PASS, plus the features suite still green**

Run: `npx vitest run src/__tests__/format-classify.test.ts && npx vitest run src/lib/ai/__tests__ --testTimeout=60000`

- [ ] **Step 6: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/classify.ts src/lib/ai/features.ts src/__tests__/format-classify.test.ts && git commit -m "feat(format): windowed block classification behind feature rescue.classify"
```

---

### Task 5: Reconcile — one map, few questions

**Files:**
- Create: `src/lib/format/reconcile.ts`
- Test: `src/__tests__/format-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-reconcile.test.ts
import { describe, it, expect } from "vitest";
import { reconcile } from "../lib/format/reconcile";
import type { BlockFacts, BlockLabel } from "../lib/format/types";

const para = (index: number, text: string, over: Partial<BlockFacts> = {}): BlockFacts => ({
  index, kind: "paragraph", text, wordCount: text.split(/\s+/).filter(Boolean).length,
  bold: false, fontSizePt: 12, alignment: null, headingLevel: 0, looksLikeCaption: false, ...over,
});
const ai = (index: number, over: Partial<BlockLabel> = {}): BlockLabel => ({
  index, textHead: `t${index}`, role: "heading", level: 1, confidence: "high", source: "ai", ...over,
});

describe("reconcile", () => {
  it("styled headings and heuristic-high are labels without any AI input", () => {
    const facts = [
      para(0, "الفصل الأول", { headingLevel: 1, inferred: { level: 1, confidence: "styled", reason: "style" } }),
      para(1, "المبحث الأول", { inferred: { level: 2, confidence: "high", reason: "pattern" } }),
      para(2, "نص عادي طويل ".repeat(10)),
    ];
    const { labels, questions } = reconcile(facts, [], {});
    expect(labels.find((l) => l.index === 0)).toMatchObject({ role: "heading", level: 1, source: "styled" });
    expect(labels.find((l) => l.index === 1)).toMatchObject({ role: "heading", level: 2, source: "heuristic" });
    expect(questions).toEqual([]);
  });

  it("ai-high applies silently; ai-medium/low becomes a question capped at 8", () => {
    const facts = Array.from({ length: 20 }, (_, i) => para(i, `سطر ${i}`));
    const aiLabels = [
      ai(1),                                             // high → silent label
      ...Array.from({ length: 12 }, (_, k) => ai(k + 2, { confidence: "medium" as const })),
    ];
    const { labels, questions } = reconcile(facts, aiLabels, {});
    expect(labels.find((l) => l.index === 1)?.source).toBe("ai");
    expect(questions.length).toBe(8);
    // An unanswered question is NOT a heading label — the safest default.
    expect(labels.find((l) => l.index === 2 && l.role === "heading")).toBeUndefined();
  });

  it("a student answer beats everything and closes the question", () => {
    const facts = [para(0, "عنوان غامض")];
    const aiLabels = [ai(0, { confidence: "low" as const })];
    const { labels, questions } = reconcile(facts, aiLabels, { "q-0": { role: "heading", level: 2 } });
    expect(labels.find((l) => l.index === 0)).toMatchObject({ role: "heading", level: 2, source: "student" });
    expect(questions).toEqual([]);
  });

  it("dismissed = body, no question survives", () => {
    const facts = [para(0, "عنوان غامض")];
    const { labels, questions } = reconcile(facts, [ai(0, { confidence: "low" as const })], { "q-0": { role: "body" } });
    expect(labels.find((l) => l.index === 0 && l.role === "heading")).toBeUndefined();
    expect(questions).toEqual([]);
  });

  it("repairs level jumps: a heading deeper than parent+1 is clamped", () => {
    const facts = [
      para(0, "الفصل الأول", { headingLevel: 1, inferred: { level: 1, confidence: "styled", reason: "style" } }),
      para(1, "مطلب عميق"),
    ];
    const { labels } = reconcile(facts, [ai(1, { level: 4 as const })], {});
    expect(labels.find((l) => l.index === 1)?.level).toBe(2);
  });

  it("noise is only auto-deleted when the regex agrees; otherwise it is asked", () => {
    const facts = [para(0, "12"), para(1, "جامعة الجزائر — كلية الحقوق")];
    const aiLabels = [ai(0, { role: "noise" as const, level: undefined }), ai(1, { role: "noise" as const, level: undefined })];
    const { labels, questions } = reconcile(facts, aiLabels, {});
    expect(labels.find((l) => l.index === 0)?.role).toBe("noise");
    expect(labels.find((l) => l.index === 1)?.role).not.toBe("noise");
    expect(questions.some((q) => q.index === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-reconcile.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/reconcile.ts
// Merge every opinion about the document into ONE map, and turn genuine
// uncertainty into at most MAX_QUESTIONS dismissible cards. Precedence:
// student > styled > heuristic-high > ai-high. ai-medium/low never applies
// silently — a false heading poisons the TOC, numbering and page breaks at
// once, so uncertainty is asked, and a dismissal means "not a heading".
import type { BlockFacts, BlockLabel, RescueQuestion, SemanticRole } from "./types";
import { NOISE_RE } from "./candidates";

export const MAX_QUESTIONS = 8;

export type Answers = Record<string, { role: SemanticRole; level?: 1 | 2 | 3 | 4 }>;

export interface ReconcileResult { labels: BlockLabel[]; questions: RescueQuestion[] }

const HEAD = (s: string) => s.slice(0, 80);

export function reconcile(facts: BlockFacts[], aiLabels: BlockLabel[], answers: Answers): ReconcileResult {
  const byIndex = new Map<number, BlockLabel>();
  const questions: RescueQuestion[] = [];

  // 1. Ground truth: styled headings + heuristic-high from inferOutline.
  for (const f of facts) {
    if (f.inferred?.confidence === "styled") {
      byIndex.set(f.index, { index: f.index, textHead: HEAD(f.text), role: "heading",
        level: Math.min(4, f.inferred.level) as 1 | 2 | 3 | 4, confidence: "high", source: "styled" });
    } else if (f.inferred?.confidence === "high") {
      byIndex.set(f.index, { index: f.index, textHead: HEAD(f.text), role: "heading",
        level: Math.min(4, f.inferred.level) as 1 | 2 | 3 | 4, confidence: "high", source: "heuristic" });
    }
  }

  // 2. The model's opinions.
  for (const l of aiLabels) {
    const settled = byIndex.get(l.index);
    if (settled && (settled.source === "styled" || settled.source === "student")) continue;

    const fact = facts[l.index];
    if (!fact) continue;

    if (l.role === "noise") {
      // Deleting is the one destructive label. Auto only when code agrees.
      if (l.confidence === "high" && NOISE_RE.test(fact.text)) {
        byIndex.set(l.index, { ...l, textHead: HEAD(fact.text) });
      } else {
        pushQuestion(questions, facts, l);
      }
      continue;
    }

    if (l.confidence === "high") {
      byIndex.set(l.index, { ...l, textHead: HEAD(fact.text) });
    } else if (l.role === "heading") {
      pushQuestion(questions, facts, l);
    }
    // medium/low non-heading, non-noise: harmless either way — leave as body.
  }

  // 3. The student's answers close questions and beat everything.
  for (const [qid, a] of Object.entries(answers)) {
    const index = Number(qid.replace(/^q-/, ""));
    const fact = facts[index];
    if (!fact) continue;
    const qi = questions.findIndex((q) => q.index === index);
    if (qi >= 0) questions.splice(qi, 1);
    if (a.role === "body") { byIndex.delete(index); continue; }
    byIndex.set(index, { index, textHead: HEAD(fact.text), role: a.role,
      ...(a.level ? { level: a.level } : {}), confidence: "high", source: "student" });
  }

  // 4. Cap + order the questions by document position.
  questions.sort((a, b) => a.index - b.index);
  questions.splice(MAX_QUESTIONS);

  // 5. Hierarchy repair on the heading labels, in document order:
  //    a heading may be at most one level deeper than the one before it.
  let prevLevel = 0;
  const labels = [...byIndex.values()].sort((a, b) => a.index - b.index);
  for (const l of labels) {
    if (l.role !== "heading" || !l.level) continue;
    if (l.level > prevLevel + 1) l.level = (prevLevel + 1) as 1 | 2 | 3 | 4;
    prevLevel = l.level;
  }

  return { labels, questions };
}

function pushQuestion(questions: RescueQuestion[], facts: BlockFacts[], l: BlockLabel): void {
  if (questions.some((q) => q.index === l.index)) return;
  const fact = facts[l.index];
  questions.push({
    id: `q-${l.index}`,
    index: l.index,
    textHead: HEAD(fact.text),
    before: HEAD(facts[l.index - 1]?.text ?? ""),
    after: HEAD(facts[l.index + 1]?.text ?? ""),
    suggested: { role: l.role, ...(l.level ? { level: l.level } : {}) },
    choices: l.role === "heading"
      ? [{ role: "heading", level: 1 }, { role: "heading", level: 2 }, { role: "heading", level: 3 }]
      : [{ role: l.role }],
  });
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-reconcile.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/reconcile.ts src/__tests__/format-reconcile.test.ts && git commit -m "feat(format): reconcile — one label map, at most 8 dismissible questions"
```

---

### Task 6: Verdict — the sales pitch, priced honestly

**Files:**
- Create: `src/lib/format/verdict.ts`
- Test: `src/__tests__/format-verdict.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-verdict.test.ts
import { describe, it, expect } from "vitest";
import { buildVerdict } from "../lib/format/verdict";
import type { NormFormatting } from "../db/norm-profiles";

const NORMS: NormFormatting = {
  font: "Traditional Arabic", fontSize: 16,
  headingSizes: { h1: 20, h2: 18, h3: 17 }, headingBold: true,
  margins: { binding: 3, opposite: 2, top: 2.5, bottom: 2.5 }, spacing: 1.5,
  footnoteFontSize: 12, alignment: "justify",
  pagination: { frontMatter: "roman", body: "arabic", position: "bottom-center" }, tocStyle: "dotted",
};

describe("buildVerdict", () => {
  it("counts unreal headings, noise, formatting mismatches, missing apparatus", () => {
    const v = buildVerdict({
      labels: [
        { index: 1, textHead: "الفصل الأول", role: "heading", level: 1, confidence: "high", source: "ai" },
        { index: 2, textHead: "المبحث", role: "heading", level: 2, confidence: "high", source: "heuristic" },
        { index: 3, textHead: "عنوان حقيقي", role: "heading", level: 1, confidence: "high", source: "styled" },
        { index: 9, textHead: "12", role: "noise", confidence: "high", source: "ai" },
      ],
      detected: { font: "Calibri", fontSize: 11, spacing: 1 },
      expected: NORMS,
      hasRealToc: false,
      typedCaptionCount: 5,
      figureCount: 3, hasListOfFigures: false,
      tableCount: 0, hasListOfTables: false,
    });
    const codes = v.issues.map((i) => i.code);
    expect(codes).toContain("headings-not-real");     // 2 (styled one excluded)
    expect(v.issues.find((i) => i.code === "headings-not-real")?.count).toBe(2);
    expect(codes).toContain("noise-blocks");
    expect(codes).toContain("wrong-font");
    expect(codes).toContain("wrong-font-size");
    expect(codes).toContain("wrong-spacing");
    expect(codes).toContain("no-real-toc");
    expect(codes).toContain("typed-captions");
    expect(codes).toContain("missing-list-of-figures");
    expect(codes).not.toContain("missing-list-of-tables");  // no tables → no list owed
    expect(v.total).toBe(v.issues.reduce((n, i) => n + i.count, 0));
  });

  it("a compliant document yields an empty verdict", () => {
    const v = buildVerdict({
      labels: [{ index: 0, textHead: "الفصل", role: "heading", level: 1, confidence: "high", source: "styled" }],
      detected: { font: "Traditional Arabic", fontSize: 16, spacing: 1.5 },
      expected: NORMS, hasRealToc: true, typedCaptionCount: 0,
      figureCount: 0, hasListOfFigures: false, tableCount: 0, hasListOfTables: false,
    });
    expect(v.issues).toEqual([]);
    expect(v.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-verdict.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/verdict.ts
// "مذكرتك بها N مخالفة لمعايير كليتك" — the free screen that sells the repair.
// Counts only what the plan will actually fix; formatting checks reuse
// analyzeFormatting so the verdict and the old import report can never disagree.
import type { NormFormatting } from "../db/norm-profiles";
import type { DetectedFormatting } from "../thesis-analysis";
import { analyzeFormatting } from "../thesis-analysis";
import type { BlockLabel, Verdict, VerdictIssue } from "./types";

export interface VerdictInput {
  labels: BlockLabel[];
  detected: DetectedFormatting;
  expected: NormFormatting;
  hasRealToc: boolean;
  typedCaptionCount: number;
  figureCount: number;
  hasListOfFigures: boolean;
  tableCount: number;
  hasListOfTables: boolean;
}

export function buildVerdict(input: VerdictInput): Verdict {
  const issues: VerdictIssue[] = [];
  const add = (code: string, severity: VerdictIssue["severity"], count: number, message: string) => {
    if (count > 0) issues.push({ code, severity, count, message });
  };

  const unrealHeadings = input.labels.filter((l) => l.role === "heading" && l.source !== "styled").length;
  add("headings-not-real", "error", unrealHeadings,
    `${unrealHeadings} chapter/section titles are not real Word headings — no TOC or numbering can see them.`);

  const noise = input.labels.filter((l) => l.role === "noise").length;
  add("noise-blocks", "warning", noise,
    `${noise} hand-typed page numbers or running heads must be deleted, not formatted.`);

  // Font / size / spacing: one issue per mismatch, same ids as the old report.
  for (const s of analyzeFormatting(input.detected, input.expected)) {
    add(s.id, s.severity, 1, s.message);
  }

  add("no-real-toc", "error", input.hasRealToc ? 0 : 1,
    "No real (field-based) table of contents.");
  add("typed-captions", "error", input.typedCaptionCount,
    `${input.typedCaptionCount} captions are typed text, invisible to any list of figures/tables.`);
  add("missing-list-of-figures", "warning", input.figureCount > 0 && !input.hasListOfFigures ? 1 : 0,
    "The thesis has figures but no list of figures.");
  add("missing-list-of-tables", "warning", input.tableCount > 0 && !input.hasListOfTables ? 1 : 0,
    "The thesis has tables but no list of tables.");

  return { issues, total: issues.reduce((n, i) => n + i.count, 0) };
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-verdict.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/verdict.ts src/__tests__/format-verdict.test.ts && git commit -m "feat(format): verdict — the free diagnosis, priced from the label map"
```

---

### Task 7: Plan builder

**Files:**
- Create: `src/lib/format/plan.ts`
- Test: `src/__tests__/format-plan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-plan.test.ts
import { describe, it, expect } from "vitest";
import { buildFormatPlan } from "../lib/format/plan";
import type { BlockLabel } from "../lib/format/types";

const h = (index: number, level: 1 | 2 | 3, text: string, source: BlockLabel["source"] = "ai"): BlockLabel =>
  ({ index, textHead: text, role: "heading", level, confidence: "high", source });

describe("buildFormatPlan", () => {
  const labels: BlockLabel[] = [
    { index: 2, textHead: "12", role: "noise", confidence: "high", source: "ai" },
    h(5, 1, "مقدمة عامة"),
    h(9, 1, "الفصل الأول"),
    { index: 30, textHead: "شكل 1", role: "figure", confidence: "high", source: "ai" },
  ];

  it("orders steps per STEP_ORDER, params carry the work, bodyStart = the intro heading", () => {
    const plan = buildFormatPlan({
      labels, questions: [], profileId: "p1", degraded: false,
      typedCaptionCount: 2, figureCount: 1, tableCount: 0, hasRealToc: false,
    });
    expect(plan.steps.map((s) => s.id)).toEqual([
      "snapshot", "clean", "structure", "norms",
      "sections-numbering", "pagination", "captions", "apparatus", "finish",
    ]);
    expect(plan.steps.find((s) => s.id === "clean")?.params).toMatchObject({ indices: [2] });
    // Promotions exclude styled headings — they are already real.
    expect((plan.steps.find((s) => s.id === "structure")?.params as any).promotions).toHaveLength(2);
    expect(plan.bodyStartIndex).toBe(5);
    expect((plan.steps.find((s) => s.id === "sections-numbering")?.params as any).bodyStart)
      .toMatchObject({ index: 5, textHead: "مقدمة عامة" });
    expect(plan.signals).toMatchObject({ typedCaptionCount: 2, figureCount: 1, tableCount: 0, hasRealToc: false });
    expect((plan.steps.find((s) => s.id === "apparatus")?.params as any)).toMatchObject({ toc: true, listOfFigures: true, listOfTables: false });
  });

  it("skips what there is nothing to do: no noise → clean skipped; no typed captions → captions skipped", () => {
    const plan = buildFormatPlan({
      labels: [h(0, 1, "الفصل الأول", "styled")], questions: [], profileId: "p1", degraded: false,
      typedCaptionCount: 0, figureCount: 0, tableCount: 0, hasRealToc: true,
    });
    expect(plan.steps.find((s) => s.id === "clean")?.status).toBe("skipped");
    expect(plan.steps.find((s) => s.id === "captions")?.status).toBe("skipped");
    expect(plan.steps.find((s) => s.id === "structure")?.status).toBe("skipped");
  });

  it("no level-1 heading at all → sections-numbering skipped, bodyStartIndex null", () => {
    const plan = buildFormatPlan({
      labels: [], questions: [], profileId: "p1", degraded: true,
      typedCaptionCount: 0, figureCount: 0, tableCount: 0, hasRealToc: false,
    });
    expect(plan.bodyStartIndex).toBeNull();
    expect(plan.steps.find((s) => s.id === "sections-numbering")?.status).toBe("skipped");
    expect(plan.degraded).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-plan.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/plan.ts
// The diagnosis IS the plan: ordered steps + per-step params, persisted and
// re-read by the runner (P2). Steps with nothing to do are born "skipped",
// so the progress UI and the conformity record never show phantom work.
import type { BlockLabel, FormatPlan, PlanStep, RescueQuestion } from "./types";
import { STEP_ORDER } from "./types";

/** Where does the BODY (arabic page numbers) begin? The intro heading, else the first level-1. */
const INTRO_RE = /^(مقدمة|المقدمة|introduction)/i;

export interface PlanInput {
  labels: BlockLabel[];
  questions: RescueQuestion[];
  profileId: string;
  degraded: boolean;
  typedCaptionCount: number;
  figureCount: number;
  tableCount: number;
  hasRealToc: boolean;
}

export function buildFormatPlan(input: PlanInput): FormatPlan {
  const headings = input.labels.filter((l) => l.role === "heading");
  const h1s = headings.filter((l) => l.level === 1);
  const intro = h1s.find((l) => INTRO_RE.test(l.textHead)) ?? h1s[0] ?? null;
  const bodyStartIndex = intro ? intro.index : null;

  const noiseIndices = input.labels.filter((l) => l.role === "noise").map((l) => l.index);
  const promotions = headings
    .filter((l) => l.source !== "styled")
    .map((l) => ({ index: l.index, level: l.level ?? 2, textHead: l.textHead }));

  const params: Partial<Record<PlanStep["id"], Record<string, unknown>>> = {
    clean: { indices: noiseIndices },
    structure: { promotions },
    norms: { profileId: input.profileId },
    // The ANCHOR, not a bare index: the runner re-resolves by textHead after
    // clean/structure shifted things.
    "sections-numbering": intro ? { bodyStart: { index: intro.index, textHead: intro.textHead } } : {},
    captions: {},
    apparatus: {
      toc: true, // even when hasRealToc: the policy replaces a stale/typed one
      listOfFigures: input.figureCount > 0,
      listOfTables: input.tableCount > 0,
    },
  };

  const skipped: Partial<Record<PlanStep["id"], boolean>> = {
    clean: noiseIndices.length === 0,
    structure: promotions.length === 0,
    "sections-numbering": bodyStartIndex === null,
    captions: input.typedCaptionCount === 0,
  };

  const steps: PlanStep[] = STEP_ORDER.map((id) => ({
    id,
    status: skipped[id] ? "skipped" : "pending",
    ...(params[id] ? { params: params[id] } : {}),
  }));

  return {
    steps, labels: input.labels, questions: input.questions, bodyStartIndex,
    degraded: input.degraded,
    signals: {
      typedCaptionCount: input.typedCaptionCount,
      figureCount: input.figureCount,
      tableCount: input.tableCount,
      hasRealToc: input.hasRealToc,
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-plan.test.ts`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati-server && git add src/lib/format/plan.ts src/__tests__/format-plan.test.ts && git commit -m "feat(format): plan builder — ordered steps, params, honest skips"
```

---

### Task 8: Verify — the conformity record

**Files:**
- Create: `src/lib/format/verify.ts`
- Test: `src/__tests__/format-verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/format-verify.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Mdocxengine, Doc } from "mdocxengine";
import { verifyDocument } from "../lib/format/verify";
import { applyNormProfileToDocument } from "../lib/thesis-formatting";
import type { NormFormatting } from "../db/norm-profiles";

const SAMPLE = new URL("../../assets/thesis-base.docx", import.meta.url).pathname;
const NORMS: NormFormatting = {
  font: "Traditional Arabic", fontSize: 16,
  headingSizes: { h1: 20, h2: 18, h3: 17 }, headingBold: true,
  margins: { binding: 3, opposite: 2, top: 2.5, bottom: 2.5 }, spacing: 1.5,
  footnoteFontSize: 12, alignment: "justify",
  pagination: { frontMatter: "roman", body: "arabic", position: "bottom-center" }, tocStyle: "dotted",
};

describe("verifyDocument", () => {
  it("fails font/size checks before norms are applied, passes after", async () => {
    const engine = await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE));
    const before = await verifyDocument(Doc.from(engine), NORMS, { degraded: false });
    expect(before.checks.find((c) => c.code === "font")?.ok).toBe(false);

    await applyNormProfileToDocument(engine as never, NORMS, "right");
    const after = await verifyDocument(Doc.from(engine), NORMS, { degraded: false });
    expect(after.checks.find((c) => c.code === "font")?.ok).toBe(true);
    expect(after.checks.find((c) => c.code === "font-size")?.ok).toBe(true);
  });

  it("reports a heading-coverage gap and surviving noise", async () => {
    const engine = await Mdocxengine.loadFromBuffer(readFileSync(SAMPLE));
    const doc = Doc.from(engine);
    for (let i = 0; i < 60; i++) await doc.addParagraph("نص من فقرة طويلة نسبيا هنا لملء المسافة بين العناوين");
    await doc.addParagraph("12");
    const rec = await verifyDocument(doc, NORMS, { degraded: false, maxGapBlocks: 40 });
    expect(rec.checks.find((c) => c.code === "heading-gap")?.ok).toBe(false);
    expect(rec.checks.find((c) => c.code === "noise-gone")?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/format-verify.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/format/verify.ts
// Re-read the document and assert the norms actually HOLD. Failures land in
// the conformity record — never swallowed. This is also the gap audit the
// candidate net is accountable to.
import type { Doc } from "mdocxengine";
import type { NormFormatting } from "../db/norm-profiles";
import { extractFormatting } from "../thesis-extractor";
import { collectFacts } from "./extract";
import { NOISE_RE } from "./candidates";
import type { ConformityCheck, ConformityRecord } from "./types";

/** A real TOC is a field: a TOC instruction inside the body XML. */
const TOC_FIELD_RE = /\bTOC\s+\\o\b|w:docPartGallery w:val="Table of Contents"/;

export interface VerifyOptions {
  degraded: boolean;
  /** A stretch of blocks this long with no heading = the net failed. */
  maxGapBlocks?: number;
}

export async function verifyDocument(doc: Doc, expected: NormFormatting, opts: VerifyOptions): Promise<ConformityRecord> {
  const { degraded, maxGapBlocks = 150 } = opts;
  const checks: ConformityCheck[] = [];
  const push = (code: string, ok: boolean, detail: string) => checks.push({ code, ok, detail });

  const xml = doc.engine.zip.readAsText("word/document.xml") ?? "";
  const detected = extractFormatting(xml);
  push("font", detected.font.toLowerCase() === expected.font.toLowerCase(),
    `dominant font ${detected.font}, expected ${expected.font}`);
  push("font-size", detected.fontSize === expected.fontSize,
    `dominant size ${detected.fontSize}pt, expected ${expected.fontSize}pt`);
  push("spacing", Math.abs(detected.spacing - expected.spacing) <= 0.05,
    `line spacing ${detected.spacing}, expected ${expected.spacing}`);

  push("toc", TOC_FIELD_RE.test(xml), "field-based table of contents present");

  const facts = await collectFacts(doc);
  let gap = 0, worstGap = 0;
  for (const f of facts) {
    if (f.kind !== "paragraph") continue;
    if (f.headingLevel > 0) gap = 0; else worstGap = Math.max(worstGap, ++gap);
  }
  push("heading-gap", worstGap <= maxGapBlocks,
    `longest heading-free stretch: ${worstGap} blocks (limit ${maxGapBlocks})`);

  const survivors = facts.filter((f) => f.kind === "paragraph" && NOISE_RE.test(f.text)).length;
  push("noise-gone", survivors === 0, `${survivors} bare page-number paragraphs remain`);

  return { checks, degraded };
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/format-verify.test.ts`

- [ ] **Step 5: Full-suite sanity + commit**

Run: `cd ~/modakerati-server && npx vitest run src/__tests__ --testTimeout=60000` — expect green (pre-existing failures, if any, must be listed in the commit message of the NEXT task, not silently absorbed).

```bash
cd ~/modakerati-server && git add src/lib/format/verify.ts src/__tests__/format-verify.test.ts && git commit -m "feat(format): verify — the conformity record and the net's gap audit"
```

---

## Done means

- `src/lib/format/{types,extract,candidates,classify,reconcile,verdict,plan,verify}.ts` exist, each with its own green vitest file under `src/__tests__/format-*.test.ts`, none of which calls a live model.
- `rescue.classify` appears in the FEATURES registry (visible in the dashboard's AI → Features tab on next deploy).
- Full `npx vitest run` is green.
- Nothing in this plan touches routes, the DB, MCP handlers, or the app.
