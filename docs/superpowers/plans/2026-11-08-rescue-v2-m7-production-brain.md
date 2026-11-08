# Rescue v2 — M7: the production brain (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (D-21: a fresh implementer per task, a reviewer after each, Claude arbitrates). Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 16 to 19 spend real money or need Word and the owner's key: Claude runs those in the main session, never a subagent.

**Goal:** A model answers the seven brain tasks (`order_parts`, `map`, `ask`, `review`, `read_cover`, `read_guide`, `parse_note`) through the same `Brain` interface the session brain answers today, and the cheapest model that clears every bar on the corpus is pinned in settings. The bars (spec §12): structural roles ≥ 97%, 0 content lost, ≤ 5 questions and only on truly ambiguous blocks, Review finds Claude's defects, all Prove checks pass.

**Architecture:** Nothing new under `src/lib/rescue/` reaches a model: the task builders, validators and instructions stay where they are and stay the single source of each task's contract. A new folder `src/lib/rescue-run/model/` holds the model brain's logic with an injected transport (prompts, images, JSON reading, repair turns, timeouts, the per-version spend cap, a call limiter), and is model-free by construction. Exactly one file, `src/lib/rescue-run/model-brain.ts`, touches `lib/ai`: it builds the OpenRouter transport on the platform's own key, sends zero-retention routing, structured output and usage accounting, and logs every call to `ai_usage_log` under the version's turn id, which the existing `snapshotCost` already sums into the version's cost record. Chunking lives in the pipeline, where the validators' context lives: `mapDocument` takes a window size and `reviewRound` can split a look into page groups, both set only when the brain is the model. A pure scoring library (`src/lib/rescue-run/score/`) and one CLI (`scripts/rescue-lab/score-brain.ts`) run any model on the corpus against the answer keys from the cached `read/` outputs and review fixtures, with a spend cap, an estimate first, and a gold or replay transport for a run that costs nothing. Every rescue brain task is a feature in the existing registry (`rescue.brain.<task>`), pinned by settings rows, off until pinned.

**Tech stack:** Hono server, vitest (`src/**/*.test.ts` only), zod 4.4 (`z.toJSONSchema`), `openai` 6.44 against OpenRouter's OpenAI-compatible endpoint, `sharp` 0.35 (lazy import), the lab CLI under `tsx`, the Word converter for the end-to-end proof only.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md` §8 (the brain), §10 (lab and answer key), §11 (done when), §12 (M7 and the release), D-2, D-19, D-21, D-23, D-27, D-35. The runner rules come from the M4-M6 plan: P-5, P-33, P-37, P-61, P-71, P-73.

**Not in this plan:** the release itself (`docs/rescue-v2-release-checklist.md` in the server repo owns it; Task 20 adds this milestone's lines), M3's delayed reviews (P-73), the `:batch` model variants, a Cloudflare route for the rescue brain, BYOK.

---

## What exists (read before Task 1)

| Piece | Where | What M7 builds on |
|---|---|---|
| `Brain` interface | `src/lib/rescue/brain/brain.ts` | `name: "session" \| "model"`, `ask<T>(task, validate)`. Unchanged. |
| Task contracts | `brain/tasks.ts` (map, order_parts), `brain/ask-task.ts`, `brain/parse-note-task.ts`, `brain/read-guide-task.ts`, `cover/read-cover-task.ts`, `review/review-task.ts` | Each has `build…Task`, `validate…Answer`, `…_INSTRUCTIONS`. Every instruction block ends with the file-queue sentence "Write the JSON to <taskId>.answer.json.tmp … rename it to <taskId>.answer.json." The answer zod schemas are module-private today. |
| Session brain | `brain/session-brain.ts` | `BrainTimeoutError` lives here. |
| Factory | `src/lib/rescue-run/brain-factory.ts` | `createBrain(projectId)`, `brainName()`, `BrainUnavailableError`. `RESCUE_BRAIN=model` throws "no brain" today. |
| Runner | `src/lib/rescue-run/runner.ts` | Every stage runs inside `runWithAiContext({ feature: "rescue.<stage>", userId, thesisId, turnId: version.id ?? payload.turnId })`. `BrainTimeoutError` and `BrainUnavailableError` call `deferForBrain`: a timeout waits 60 s, unavailable waits 5 min, no attempt spent until the fourth timeout, `brain_failed` after `RESCUE_BRAIN_WAIT_HOURS` (default 6). `MapCoverageError` is a non-retriable `brain_failed`. |
| Stage context | `src/lib/rescue-run/stage-context.ts` | `ctx.brain` wraps every ask in `clock.wait`, so a brain wait is paused out of the stage budget. `stage_state.brainTasks` exists in the type and is never written. |
| Cost record | `src/lib/rescue-run/cost.ts` | `snapshotCost(version, brainName())` sums `ai_usage_log` by `turn_id` (the version id plus `settings.costTurnIds`), excludes BYOK rows, writes `rescue_versions.cost` (`RescueCost` in `pipeline/contract.ts`). `cost_usd` is filled only when the provider reports it (OpenRouter with `usage: { include: true }`). |
| Where tasks are asked | `pipeline/stages-free.ts` (`proposeOrder`, `mapDocument` with `Promise.all` over windows, `readCoverFields`), `rescue-run/stages/free.ts` (map, ask, read_cover), `stages/rescue.ts` (map_changed, ask_changed, review via `reviewRound`), `stages/side.ts` (parse_note, read_guide) | Map windows are 120 blocks (`buildMapTasks`), so a 3 300-block thesis is about 28 tasks at once. Review is one task per zoom step, up to 7 steps a round, each carrying every sheet. |
| Feature registry | `src/lib/ai/features.ts` `AI_FEATURES`, settings `ai.feature.<key>.provider` / `.model` / `.systemPrompt`, `resolveFeatureConfig`, dashboard AI → Features (`GET/PUT /admin/providers/api/features/:key`) | The pin mechanism. `resolveFeatureForCall` also applies BYOK and the per-account pin (`user-provider.ts`); the rescue must apply neither (P-33, B-9). Unpinned features fall back to the global default provider, so "off by default" needs its own check. `scripts/pin-feature-models.ts` repoints registry features in bulk and must skip these. |
| Providers | `src/lib/ai/index.ts` `getPlatformProvider`, `openrouter.ts` (`OpenRouterProvider(apiKey?)`, `getClient()`), `cloudflare.ts` | `AIProvider.chat` takes string content only, so images go through the raw client, as `ai/figure-caption.ts` does. The raw client does not log: the caller must `recordAiCall`. The live OpenRouter key is a sealed `app_settings` row (memory: `openrouter-key-lives-in-sealed-settings`). |
| Caching | `src/lib/ai/cache.ts` | `withPromptCaching`, `cacheBreakpointsActive`, `providerRoutingParam`. Breakpoints only for Claude on OpenRouter, at most 4. |
| Guards | `src/lib/rescue/__tests__/no-model-client.test.ts` (transitive, covers `src/lib/rescue` AND `scripts/rescue-lab`), `src/lib/rescue-run/__tests__/guard.test.ts` (direct imports and text; "M7 relaxes it for `rescue-run/model-brain.ts` only") | Task 10 relaxes each for exactly one file. |
| Answer keys (private, `lab/`) | `corpus/tNN/gold/map.json` (`keyVersion`, `inventoryHash`, `format`, `roles{key → i, role, confidence}`), `gold/diagnosis.json`, `gold/review.json` (`startRun`, `finalRun`, `rounds[]` of `{pagesShown, zoomed, issues[{page, kind, block, fix, note}]}`, `accepted`), `assembled/assembly.json` (split theses), `lab/defects.jsonl` (`thesis, run, look, page, kind, grave, fix, status`) | Measured 2026-11-08: map keys at key version 4 for t01–t20 (about 19 200 blocks, t11 alone about 3 300); `read/pages` for all but t17; review accepted for t01 t02 t03 t05 t06 t13 t15; 113 defects over 16 runs of those 7 theses, 12 of the 16 runs still hold `rescued.docx`, 3 still hold pages. No `read_cover`, `read_guide` or `parse_note` keys exist. t17–t20 are split. |
| Prune trap | `scripts/rescue-lab/rescue-run.ts` `pruneOlderRuns` | Every lab `rescue` deletes `pages/`, `overview/` and `rescued.pdf` of every other run of that thesis. That is why the review start runs lost their pages. The scorer passes `prune: false` and keeps its fixtures outside `rescue/`. |

---

## Decisions taken (B-n; the owner may overturn any in "Open questions")

| # | Decision | Why |
|---|---|---|
| B-1 | **OpenRouter only** for the rescue brain. A pin to any other provider is refused (`BrainUnavailableError`), so the job waits. | Only OpenRouter in this repo can (a) route per request to zero-retention endpoints, (b) report the real dollar cost (`usage.cost`), (c) address one exact model. Cloudflare's default is a `dynamic/<route>` that hides the model, logs request bodies unless told not to, and leaves `cost_usd` NULL, so the version's cost record would read $0. |
| B-2 | **Every request sends** `provider: { zdr: true, data_collection: "deny", require_parameters: true, allow_fallbacks: true }`, plus `providerRoutingParam`'s order when caching applies. A model with no zero-retention endpoint is not on the shortlist. | Corpus text and students' theses only ever reach an endpoint that keeps nothing (Privacy, below). `require_parameters` keeps a request off an endpoint that would ignore the JSON schema. |
| B-3 | **Seven features**, `rescue.brain.map`, `.review`, `.ask`, `.order_parts`, `.read_cover`, `.read_guide`, `.parse_note`, in `AI_FEATURES` (group "Rescue"). A feature is **pinned** only when both `ai.feature.<key>.provider` and `.model` are setting rows; anything else is **off**. | The registry's naming, its dashboard tab (with live usage per key) and its PUT route already exist. Per-task pins let a cheap model take the small tasks. The legacy fallback to the global default must not apply: a rescue must run on a scored model or not at all. |
| B-4 | **Prompts are code.** The system prompt is `MODEL_PREAMBLE` plus the task's own `…_INSTRUCTIONS` with the file-queue sentence removed. An operator's `ai.feature.rescue.brain.*.systemPrompt` is ignored and logged once. `PROMPT_VERSION` (12 hex of a sha256 over every instruction and the preamble) is in every score report and in `RescueCost`. | The instructions are the procedure Claude followed in the lab (M3 §5). One copy means the session brain and the model read the same rules, and a score holds only for the prompt it was measured on. |
| B-5 | **The model brain never repairs an answer.** It reads JSON, sets `taskId` to the task's own id, and runs the task's validator. A rejected answer goes back to the model with the validator's errors (they name fields and keys, never the student's words), at most `maxRepairs` (2) times, then once to `rescue.brain_escalate_model` when set, then `BrainAnswerInvalidError`. | The validators are the contract. `taskId` is plumbing, not judgement. |
| B-6 | **Every brain error is a wait (P-61).** `BrainAnswerInvalidError` and a 400 extend `BrainTimeoutError` (wait 60 s; the fourth spends attempts). Unpinned, wrong provider, no key, no credit, no zero-retention endpoint, 429, 5xx, network, and the per-version spend cap are `BrainUnavailableError` (wait 5 min). The runner ends the wait after `RESCUE_BRAIN_WAIT_HOURS`. No runner change. | A sleeping account, an exhausted credit or a mis-pin is fixed by staff while the job waits; the runner's existing clock ends it honestly with a refund. |
| B-7 | **Chunking lives in the pipeline.** `mapDocument` takes `windowSize` (`rescue.brain_map_window`, default 120); `reviewRound` takes `sheetsPerLook` (`rescue.brain_review_sheets`, default 6) and `preZoomFloats`. The stages set them only when `ctx.brain.name === "model"`; the session brain's tasks and ids are unchanged. | The validators need context only the caller has (`validateReviewAnswer` needs every block and the thesis text). Splitting inside the brain would duplicate it. A window or look the model can hold reliably is a setting the scorer measures. |
| B-8 | **Per-version spend cap** `rescue.brain_max_cents_per_version` (default 300). Checked before every call against `SUM(cost_usd)` of the turn in `ai_usage_log`. Reaching it is a wait (B-6), so staff can raise it while the job waits. | A runaway loop on a paid run must not bill without limit. Integer cents fit the existing `PUT /admin/rescue/settings` validation. |
| B-9 | **No BYOK, no per-account pin** on rescue calls. The edge resolves with `resolveFeatureConfig` and `getPlatformProvider("openrouter")`. | P-33 already keeps the request's ALS away from stages. A pin exists to try a chat provider on one device; a rescue is priced and scored on one model. |
| B-10 | **Images:** page PNGs go as JPEG, at most 1 000 px wide, quality 80, at most 1.5 MB each, as `data:` URLs (the `figure-caption.ts` pattern). Overview sheets are already 1 000 × 1 400 JPEG and go as they are. A missing image is named in the text ("page 3: no image"), never invented. | Vision cost scales with pixels; 900 px pages read fine. |
| B-11 | **Message layout for caching:** `[system: preamble + instructions] [user 1: the task's stable part + its images] [user 2: the volatile part (zoomed pages, repair errors)]`. On Claude-on-OpenRouter the edge adds a breakpoint on user 1 (3 breakpoints with system and last, under the cap of 4). | A review look re-sends every sheet on every zoom step; the stable prefix is then a cache read. OpenAI and Gemini cache a stable prefix implicitly. |
| B-12 | **The scorer is the only path from the corpus to a provider**, uses its own OpenRouter key (`RESCUE_SCORE_OPENROUTER_KEY`, env only, owner-created with a credit limit), writes nothing to any database (`AI_USAGE_LOG=0`), and keeps raw answers only under `lab/score/`. | Corpus privacy (D-11), a hard spend ceiling enforced by the provider, and no scoring noise in production's usage log. |

---

## Rules every task follows

**Repo.** `~/kwill-server`, branch `master`, `tsconfig` `strict: false` (never rely on narrowing a union; use flat interfaces and `x.ok === false`), relative imports without `.js`, tests only in `src/**/*.test.ts`.

**Git in a shared tree.** About 125 files carry another session's uncommitted engine rename. Never stage, revert or "fix" them.
- Before editing a file, `git diff --stat -- <file>`. If it already has someone else's hunk, commit only yours: `git hash-object -w` a blob built from `git show HEAD:<file>` plus your change, `git update-index --cacheinfo 100644,<sha>,<file>`, commit without paths.
- Stage new files with `git add -- <exact paths>`; commit with `git commit -m "…" -- <exact paths>`. Never `git add .`, `-A`, `stash` or `--amend`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No pushes, no deploys.

**Task protocol.** Write the listed tests; run them and see them fail for the right reason; implement; run them green; run the gate; a reviewer subagent reads the diff; Claude arbitrates; commit exact paths.

**Gate (every task).**
```bash
cd ~/kwill-server && npx tsc --noEmit 2>&1 | grep -E "src/lib/(rescue|rescue-run|ai/features|ai/openrouter-sdk)|scripts/(rescue-lab|pin-feature-models)" ; \
npx vitest run src/lib/rescue/__tests__/no-model-client.test.ts src/lib/rescue-run/__tests__/guard.test.ts
```
Expected: no tsc line for these paths; both guard files pass. Slow suites: re-run with `--testTimeout=60000` before calling a timeout a failure. Database tests follow P-37 (`describe.skipIf(!LOCAL)`, local stack from `./scripts/rescue-local-db.sh`).

**Privacy.** Tests use invented text only and never read `lab/`. Stdout, logs, reports and commits carry neutral ids (`t03`), counts, codes, pages and roles, never a student's words or a name. `read_cover` answers hold names: they stay in `lab/`, and the scorer prints field match booleans only. Error text sent to `recordAiCall` is a code and a status, never a provider message (a 400 can echo the input).

**No backticks** in `MODEL_PREAMBLE`, in any `…_INSTRUCTIONS`, or in a feature's `hint` (Task 3 and Task 7 test it). Nothing here is added to `src/lib/ai/types.ts`.

**Native modules.** `sharp` only through `await import("sharp")` (memory: `deploy-stage-boot-before-passenger`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/rescue/brain/answer-schemas.ts` (new) | The seven answer zod schemas by task kind, and `BRAIN_TASK_KINDS` | 1 |
| `src/lib/rescue/brain/tasks.ts`, `ask-task.ts`, `parse-note-task.ts`, `read-guide-task.ts`, `cover/read-cover-task.ts`, `review/review-task.ts` (modify) | Export each `…AnswerSchema` (rename of the private const; validators unchanged) | 1 |
| `src/lib/rescue-run/brain-errors.ts` (new) | `BrainUnavailableError` (moved from brain-factory, re-exported there), `BrainAnswerInvalidError extends BrainTimeoutError`, `TransportError` | 2 |
| `src/lib/rescue-run/model/json.ts` (new) | `readModelJson(text)`: fences, prose around one object | 2 |
| `src/lib/rescue-run/model/prompts.ts` (new) | `MODEL_PREAMBLE`, `stripQueueDirections`, `taskForModel`, `buildMessages`, `PROMPT_VERSION` | 3 |
| `src/lib/rescue-run/model/images.ts` (new) | `imagesOf(task)`, `loadImage(path)` | 4 |
| `src/lib/rescue-run/model/transport.ts` (new) | `ModelTransport`, `ModelRequest`, `ModelResponse`, `CallRecord` types | 5 |
| `src/lib/rescue-run/model/limiter.ts` (new) | Process-wide call limiter | 5 |
| `src/lib/rescue-run/model/brain.ts` (new) | `ModelBrain implements Brain` | 5 |
| `src/lib/rescue/pipeline/stages-free.ts`, `map/build-map-tasks.ts`, `review/round.ts`, `review/review-task.ts` (modify) | `windowSize`; `sheetsPerLook`, chunk ids, `preZoomFloats` | 6 |
| `src/lib/rescue-run/stages/free.ts`, `stages/rescue.ts` (modify) | Pass the shape settings when the brain is the model | 9 |
| `src/lib/ai/features.ts`, `scripts/pin-feature-models.ts` (modify) | Seven `rescue.brain.*` features; the bulk pinner skips them | 7 |
| `src/lib/rescue-run/model-brain.ts` (new, the one exempt file) | OpenRouter transport, pin resolution, `recordAiCall`, catalogue read | 8 |
| `src/lib/rescue-run/config.ts`, `brain-factory.ts`, `cost.ts`, `routes/admin-rescue.ts` (modify) | Brain limits; `RESCUE_BRAIN=model`; spend-so-far query; staff can edit the limits | 9 |
| `src/lib/rescue/__tests__/no-model-client.test.ts`, `src/lib/rescue-run/__tests__/guard.test.ts` (modify) | One exemption each | 10 |
| `src/lib/rescue/pipeline/contract.ts`, `rescue-run/stage-context.ts`, `rescue-run/runner.ts`, `rescue-run/cost.ts` (modify) | `brainTasks` counted; `RescueCost.models`, `costComplete`, `promptVersion` | 11 |
| `src/lib/rescue-run/score/metrics.ts`, `bars.ts` (new) | Scores and the bar check | 12 |
| `src/lib/rescue-run/score/estimate.ts`, `budget.ts`, `transports.ts` (new) | Estimate, spend cap, gold / record / replay transports | 13 |
| `src/lib/rescue/pipeline/stages-rescue.ts`, `scripts/rescue-lab/rescue-run.ts`, `scripts/rescue-lab/review.ts` (modify) | `unrenderedFinal`; `runRescue({ render: false })`; `reviewWithBrain` | 14 |
| `scripts/rescue-lab/score-brain.ts` (new), `scripts/rescue-lab/README.md` (modify) | The scorer CLI | 15 |
| `scripts/rescue-lab/score-fixtures/notes.json`, `guides.json` (new, invented) | Fixtures for `parse_note` and `read_guide` | 16 |
| `docs/rescue-v2-brain-scores.md` (new, counts only) | The scoring result and the pins | 17-18 |
| `docs/rescue-v2-release-checklist.md` (modify) | This milestone's lines | 20 |

---

## Task 1: export the answer schemas

**Files:**
- Create: `src/lib/rescue/brain/answer-schemas.ts`, `src/lib/rescue/__tests__/answer-schemas.test.ts`
- Modify: `src/lib/rescue/brain/tasks.ts` (`AnswerSchema` → `export const MapAnswerSchema`, `OrderPartsSchema` → `export const OrderPartsAnswerSchema`), `ask-task.ts`, `parse-note-task.ts`, `read-guide-task.ts`, `cover/read-cover-task.ts`, `review/review-task.ts` (each private `AnswerSchema` becomes an exported `…AnswerSchema`). Validators keep their bodies; only the names they read change.

```ts
// src/lib/rescue/brain/answer-schemas.ts
// The answer schema of every brain task, by kind: what the model brain sends as structured output. The validators stay
// the contract; a schema only tells a model the shape (B-5).
import type { z } from "zod";
import { MapAnswerSchema, OrderPartsAnswerSchema } from "./tasks";
import { AskAnswerSchema } from "./ask-task";
import { ParseNoteAnswerSchema } from "./parse-note-task";
import { ReadGuideAnswerSchema } from "./read-guide-task";
import { ReadCoverAnswerSchema } from "../cover/read-cover-task";
import { ReviewAnswerSchema } from "../review/review-task";

export const BRAIN_TASK_KINDS = ["order_parts", "map", "ask", "review", "read_cover", "read_guide", "parse_note"] as const;
export type BrainTaskKind = (typeof BRAIN_TASK_KINDS)[number];
export const isBrainTaskKind = (k: string): k is BrainTaskKind => (BRAIN_TASK_KINDS as readonly string[]).includes(k);

export const ANSWER_SCHEMAS: Record<BrainTaskKind, z.ZodType> = {
  order_parts: OrderPartsAnswerSchema, map: MapAnswerSchema, ask: AskAnswerSchema, review: ReviewAnswerSchema,
  read_cover: ReadCoverAnswerSchema, read_guide: ReadGuideAnswerSchema, parse_note: ParseNoteAnswerSchema,
};
```

- [ ] **Step 1: Write the failing test.**

```ts
// src/lib/rescue/__tests__/answer-schemas.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ANSWER_SCHEMAS, BRAIN_TASK_KINDS, isBrainTaskKind } from "../brain/answer-schemas";

describe("answer schemas by task kind (M7 Task 1)", () => {
  it("has one schema for each of the seven tasks", () => {
    expect(Object.keys(ANSWER_SCHEMAS).sort()).toEqual([...BRAIN_TASK_KINDS].sort());
    expect(BRAIN_TASK_KINDS).toHaveLength(7);
  });

  it("every schema converts to JSON Schema with taskId required", () => {
    for (const kind of BRAIN_TASK_KINDS) {
      const js = z.toJSONSchema(ANSWER_SCHEMAS[kind]) as { type: string; required?: string[] };
      expect(js.type, kind).toBe("object");
      expect(js.required, kind).toContain("taskId");
    }
  });

  it("knows its kinds", () => {
    expect(isBrainTaskKind("map")).toBe(true);
    expect(isBrainTaskKind("chat")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail** (`Cannot find module '../brain/answer-schemas'`): `npx vitest run src/lib/rescue/__tests__/answer-schemas.test.ts`
- [ ] **Step 3: Implement** the renames and the new file. If `z.toJSONSchema` throws on a schema (a `z.record` keyed by enum, a refine), fix the schema's shape only where it does not change what the validator accepts, or pass `{ unrepresentable: "any" }` and say so in the commit message.
- [ ] **Step 4: Run the task's tests and every existing validator test.**

```bash
npx vitest run src/lib/rescue/__tests__/answer-schemas.test.ts src/lib/rescue/__tests__/ask-task.test.ts src/lib/rescue/__tests__/parse-note-task.test.ts src/lib/rescue/__tests__/read-guide-task.test.ts src/lib/rescue/__tests__/cover-read-task.test.ts src/lib/rescue/__tests__/review-task.test.ts src/lib/rescue/__tests__/tasks.test.ts
```
Expected: all pass, the existing ones unchanged (if a file name differs, run `ls src/lib/rescue/__tests__ | grep -E "task|review"` and use what is there).

- [ ] **Step 5: Gate, review, commit.**

```bash
git add -- src/lib/rescue/brain/answer-schemas.ts src/lib/rescue/__tests__/answer-schemas.test.ts
git commit -m "feat(rescue): every brain task's answer schema, by kind, for the model brain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/brain/answer-schemas.ts src/lib/rescue/__tests__/answer-schemas.test.ts src/lib/rescue/brain/tasks.ts src/lib/rescue/brain/ask-task.ts src/lib/rescue/brain/parse-note-task.ts src/lib/rescue/brain/read-guide-task.ts src/lib/rescue/cover/read-cover-task.ts src/lib/rescue/review/review-task.ts
```

---

## Task 2: brain errors and reading a model's JSON

**Files:**
- Create: `src/lib/rescue-run/brain-errors.ts`, `src/lib/rescue-run/model/json.ts`, `src/lib/rescue-run/__tests__/brain-errors.test.ts`, `src/lib/rescue-run/__tests__/model-json.test.ts`
- Modify: `src/lib/rescue-run/brain-factory.ts` (move `BrainUnavailableError` out, `export { BrainUnavailableError } from "./brain-errors"`, so `runner.ts` and its tests keep their import)

```ts
// src/lib/rescue-run/brain-errors.ts
// What a brain error is to the runner (P-61, B-6). Every one of them is a wait: a timeout-class error waits a minute and
// spends attempts from the fourth; an unavailable brain waits five minutes. The runner ends the wait after
// RESCUE_BRAIN_WAIT_HOURS. Messages are codes and counts, never a student's words.
import { BrainTimeoutError } from "../rescue/brain/session-brain";

export class BrainUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "BrainUnavailableError"; }
}

/** The model's answers were rejected by the task's validator after every repair (B-5). A timeout to the runner. */
export class BrainAnswerInvalidError extends BrainTimeoutError {
  constructor(readonly kind: string, readonly errorCount: number, readonly model: string) {
    super(`${kind}: no valid answer from ${model} after repairs (${errorCount} validator errors on the last)`);
    this.name = "BrainAnswerInvalidError";
  }
}

export type TransportErrorCode =
  | "timeout" | "rate_limited" | "unavailable" | "auth" | "no_credit" | "no_endpoint" | "bad_request" | "refused";

/** What a transport throws. `status` is the HTTP status when there was one. Never carries the provider's message. */
export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly status?: number) {
    super(`transport ${code}${status ? ` ${status}` : ""}`);
    this.name = "TransportError";
  }
}
```

```ts
// src/lib/rescue-run/model/json.ts
/** The one JSON object a model answered: a whole-text parse, else inside a fence, else the first balanced object. */
export function readModelJson(text: string): { ok: boolean; value?: unknown; error?: string };
```

- [ ] **Step 1: Write the failing tests.**

```ts
// src/lib/rescue-run/__tests__/model-json.test.ts
import { describe, it, expect } from "vitest";
import { readModelJson } from "../model/json";

const FENCE = "`".repeat(3);

describe("readModelJson (M7 Task 2)", () => {
  it("reads a bare object", () => expect(readModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } }));
  it("reads inside a fence", () => expect(readModelJson(`${FENCE}json\n{"a":1}\n${FENCE}`).value).toEqual({ a: 1 }));
  it("reads the first balanced object around prose", () => expect(readModelJson('Here: {"a":{"b":"}"}} done').value).toEqual({ a: { b: "}" } }));
  it("refuses an array, a refusal and an empty text", () => {
    expect(readModelJson("[1,2]").ok).toBe(false);
    expect(readModelJson("I cannot help with that.").ok).toBe(false);
    expect(readModelJson("").ok).toBe(false);
  });
  it("names the problem without quoting the text", () => {
    const r = readModelJson('{"a": "secret words", }');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("secret");
  });
});
```

```ts
// src/lib/rescue-run/__tests__/brain-errors.test.ts
import { describe, it, expect } from "vitest";
import { BrainAnswerInvalidError, BrainUnavailableError, TransportError } from "../brain-errors";
import { BrainUnavailableError as FromFactory } from "../brain-factory";
import { BrainTimeoutError } from "../../rescue/brain/session-brain";
import { decideBrainDeferral } from "../runner";

describe("brain errors are waits (M7 Task 2, P-61)", () => {
  it("an invalid answer is a timeout to the runner: wait a minute, no attempt before the fourth", () => {
    const e = new BrainAnswerInvalidError("map", 3, "vendor/model-a");
    expect(e).toBeInstanceOf(BrainTimeoutError);
    const d = decideBrainDeferral({ timeouts: 0, waitingReason: null, waitingSince: null }, e, Date.now(), 6);
    expect(d).toEqual({ action: "requeue", timeout: true, delayMs: 60_000, spendAttempt: false });
  });
  it("unavailable waits five minutes", () => {
    const d = decideBrainDeferral({ timeouts: 0, waitingReason: null, waitingSince: null }, new BrainUnavailableError("budget"), Date.now(), 6);
    expect(d).toEqual({ action: "requeue", timeout: false, delayMs: 300_000, spendAttempt: false });
  });
  it("the factory re-exports the same class", () => expect(FromFactory).toBe(BrainUnavailableError));
  it("a transport error carries a code and a status, no provider text", () => {
    expect(new TransportError("rate_limited", 429).message).toBe("transport rate_limited 429");
  });
});
```

- [ ] **Step 2: Run and see them fail** (missing modules): `npx vitest run src/lib/rescue-run/__tests__/model-json.test.ts src/lib/rescue-run/__tests__/brain-errors.test.ts`
- [ ] **Step 3: Implement.** In `readModelJson`, report only `"not JSON"`, `"not an object"` or `"empty"`; never `JSON.parse`'s message (it quotes the input).
- [ ] **Step 4: Run them and `src/lib/rescue-run/__tests__/brain-factory.test.ts`, `runner.test.ts`.** Expected: green.
- [ ] **Step 5: Gate, review, commit** (`git add --` the four new files; commit them with `brain-factory.ts`): `feat(rescue-run): brain errors are waits; a model's JSON is read, never repaired`.

---

## Task 3: the model's prompt

**Files:**
- Create: `src/lib/rescue-run/model/prompts.ts`, `src/lib/rescue-run/__tests__/model-prompts.test.ts`

```ts
// src/lib/rescue-run/model/prompts.ts
// The model reads the same instructions Claude read in the lab (B-4): the task's own ..._INSTRUCTIONS, without the
// file-queue sentence, under a short preamble about answering. Nothing is added per model.
import type { BrainTaskBase } from "../../rescue/brain/session-brain";

export const MODEL_PREAMBLE = [
  "You are the reading step of a service that formats Algerian theses. You never change a word of the thesis.",
  "You receive one task as JSON, and sometimes page images. The task's own instructions follow; they are the whole contract.",
  "Answer with exactly one JSON object that follows the schema you were given, and nothing else: no prose, no fence.",
  "Every key you name must be a key from the task. Never invent a key, a page, a value or a role.",
  "When a previous answer was rejected, you are told why: answer again with the whole object, corrected.",
].join("\n");

/** The instructions without the session brain's file-queue directions ("Write the JSON to <taskId>.answer.json.tmp ..."). */
export function stripQueueDirections(instructions: string): string;

export interface ImageRef { label: string; path: string }
/** Task fields the model reads, split for caching (B-11). Paths, ids and instructions never go in. */
export function taskForModel(task: BrainTaskBase & Record<string, unknown>): { stable: object; volatile: object | null; images: ImageRef[]; volatileImages: ImageRef[] };

export type ModelPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ModelMessage { role: "system" | "user" | "assistant"; content: string | ModelPart[] }

/** [system, user stable (+images), user volatile (+images)?, ...repair turns]. `load` turns an ImageRef into a data URL or null. */
export function buildMessages(
  task: BrainTaskBase & Record<string, unknown>,
  load: (ref: ImageRef) => Promise<string | null>,
): Promise<ModelMessage[]>;

/** The repair turn: the validator's errors, at most 40, one per line. */
export function repairTurn(errors: string[]): ModelMessage;

/** 12 hex of sha256 over the preamble and every task's stripped instructions, in BRAIN_TASK_KINDS order. */
export const PROMPT_VERSION: string;
export function promptVersionOf(preamble: string, instructions: string[]): string;
```

`taskForModel` per kind (the only place that knows a task's fields):
- `map`: stable = `{ window, blocks, context, studentNote?, formatRequired? }`, images = `pages` in order, label `page N (blocks starting here: k1, k2 …)`.
- `review`: stable = `{ round, pageCount, scope, mustZoom, questions, blocks, proveFailed, refused, studentNote?, onlyPages? }` with sheets as images labelled `sheet: pages a to b`; volatile = `{ zoomed: [pages] }` with zoomed images labelled `page N, full size`. The task `id` and `step` never go in, so the stable part is identical across zoom steps.
- `read_cover`: stable = `{ coverText, thanksText }`, image = `coverPng` when set.
- `read_guide`: stable = `{ guideText, language, fields }`, images = `pages` (the guide's file name is not sent).
- `ask`, `order_parts`, `parse_note`: stable = the task minus `id`, `kind`, `runId`, `corpusId`, `instructions`.

- [ ] **Step 1: Write the failing test.**

```ts
// src/lib/rescue-run/__tests__/model-prompts.test.ts
import { describe, it, expect } from "vitest";
import { MAP_INSTRUCTIONS, ORDER_PARTS_INSTRUCTIONS } from "../../rescue/brain/tasks";
import { ASK_INSTRUCTIONS } from "../../rescue/brain/ask-task";
import { PARSE_NOTE_INSTRUCTIONS } from "../../rescue/brain/parse-note-task";
import { READ_GUIDE_INSTRUCTIONS } from "../../rescue/brain/read-guide-task";
import { READ_COVER_INSTRUCTIONS } from "../../rescue/cover/read-cover-task";
import { REVIEW_INSTRUCTIONS } from "../../rescue/review/review-task";
import { MODEL_PREAMBLE, PROMPT_VERSION, buildMessages, promptVersionOf, repairTurn, stripQueueDirections, taskForModel } from "../model/prompts";

const ALL = [MAP_INSTRUCTIONS, ORDER_PARTS_INSTRUCTIONS, ASK_INSTRUCTIONS, PARSE_NOTE_INSTRUCTIONS, READ_GUIDE_INSTRUCTIONS, READ_COVER_INSTRUCTIONS, REVIEW_INSTRUCTIONS];
const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

describe("the model's prompt (M7 Task 3)", () => {
  it("drops the file-queue sentence and keeps the answer shape", () => {
    for (const ins of ALL) {
      const s = stripQueueDirections(ins);
      expect(s).not.toMatch(/answer\.json|rename it/);
      expect(s).toMatch(/Answer as JSON: \{ taskId/);
      expect(ins.startsWith(s.split("\n")[0])).toBe(true);
    }
  });

  it("has no backtick anywhere", () => {
    for (const s of [MODEL_PREAMBLE, ...ALL]) expect(s.includes("`")).toBe(false);
  });

  it("never sends a path, an id or the instructions in the task part", async () => {
    const task = {
      id: "map-11111111-w0", kind: "map", runId: "11111111", corpusId: "p1", instructions: MAP_INSTRUCTIONS,
      window: { index: 0, count: 1, from: 0, to: 0, total: 1 },
      blocks: [{ key: "k1", i: 0, kind: "paragraph", text: "Invented heading", styleId: null, level: 0, align: null, bold: true, sizePt: 16, flags: [] }],
      context: { before: [], after: [] },
      pages: [{ page: 1, image: "/tmp/rescue-x/page-001.png", keys: ["k1"] }],
    };
    const msgs = await buildMessages(task, async () => "data:image/jpeg;base64,AAAA");
    const all = msgs.map(text).join("\n");
    expect(all).not.toContain("/tmp/rescue-x");
    expect(all).not.toContain("map-11111111-w0");
    expect(msgs[0].role).toBe("system");
    expect(text(msgs[0])).toContain(MODEL_PREAMBLE.split("\n")[0]);
    expect(all).toContain("page 1 (blocks starting here: k1)");
  });

  it("keeps a review look's stable part identical across zoom steps", () => {
    const base = { kind: "review", runId: "r", corpusId: "p", instructions: REVIEW_INSTRUCTIONS, round: 1, pageCount: 18, scope: [1, 2], sheets: [{ image: "/x/s1.jpg", pages: [1, 2] }], mustZoom: [2], questions: [], blocks: [], proveFailed: [], refused: [] };
    const a = taskForModel({ ...base, id: "review-r-r1-s1", zoomed: [] });
    const b = taskForModel({ ...base, id: "review-r-r1-s2", zoomed: [{ page: 2, image: "/x/p2.png" }] });
    expect(JSON.stringify(a.stable)).toBe(JSON.stringify(b.stable));
    expect(b.volatile).toEqual({ zoomed: [2] });
    expect(b.volatileImages.map((x) => x.label)).toEqual(["page 2, full size"]);
  });

  it("names a missing image instead of sending nothing silently", async () => {
    const task = { id: "read-cover-r", kind: "read_cover", runId: "r", corpusId: "p", instructions: READ_COVER_INSTRUCTIONS, coverText: "", thanksText: "", coverPng: "/x/missing.png" };
    const msgs = await buildMessages(task, async () => null);
    expect(msgs.map(text).join("\n")).toContain("no image");
  });

  it("repair turns list at most 40 errors", () => {
    const t = repairTurn(Array.from({ length: 60 }, (_, k) => `missing key k${k}`));
    expect(text(t).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(40);
  });

  it("the prompt version moves when any instruction moves", () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersionOf(MODEL_PREAMBLE, ["a"])).not.toBe(promptVersionOf(MODEL_PREAMBLE, ["b"]));
  });
});
```

- [ ] **Step 2: Run, see it fail.** `npx vitest run src/lib/rescue-run/__tests__/model-prompts.test.ts`
- [ ] **Step 3: Implement.** `stripQueueDirections` removes the sentence that starts `Write the JSON to <taskId>.answer.json.tmp` up to the end of its line, and nothing else; throw if an instruction block does not contain it (a changed instruction must be looked at, not silently sent with queue directions).
- [ ] **Step 4: Green, gate, review, commit:** `feat(rescue-run): the model reads Claude's own instructions, without the file queue`.

---

## Task 4: images

**Files:**
- Create: `src/lib/rescue-run/model/images.ts`, `src/lib/rescue-run/__tests__/model-images.test.ts`

```ts
// src/lib/rescue-run/model/images.ts
export const MAX_IMAGE_WIDTH = 1000;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** A page image as a JPEG data URL (B-10), or null when the path is empty, missing or unreadable. sharp is imported lazily. */
export async function loadImage(path: string): Promise<string | null>;
```

- [ ] **Step 1: Write the failing test.** Build a 1 800 × 2 400 PNG in `os.tmpdir()` with `(await import("sharp")).default({ create: { width: 1800, height: 2400, channels: 3, background: "#ffffff" } }).png().toFile(p)`.
  - `loadImage(p)` → starts with `data:image/jpeg;base64,`; decoded width ≤ 1 000 (read back with sharp `metadata()`); byte length ≤ `MAX_IMAGE_BYTES`.
  - An existing JPEG sheet of 1 000 × 1 400 is returned as JPEG with the same width.
  - `loadImage("")` and `loadImage("/nonexistent/x.png")` → `null`, no throw.
  - The module has no top-level `import sharp` (read the source text; `expect(src).not.toMatch(/^import .*sharp/m)`).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green.** `npx vitest run src/lib/rescue-run/__tests__/model-images.test.ts`
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): page images reach the model as small JPEGs, never paths`.

---

## Task 5: the model brain

**Files:**
- Create: `src/lib/rescue-run/model/transport.ts`, `src/lib/rescue-run/model/limiter.ts`, `src/lib/rescue-run/model/brain.ts`, `src/lib/rescue-run/__tests__/model-brain-core.test.ts`

```ts
// src/lib/rescue-run/model/transport.ts
import type { BrainTaskBase } from "../../rescue/brain/session-brain";
import type { BrainTaskKind } from "../../rescue/brain/answer-schemas";
import type { ModelMessage } from "./prompts";

export type ReasoningLevel = "off" | "low" | "medium" | "high";
export interface ModelRequest {
  kind: BrainTaskKind;
  model: string;
  reasoning: ReasoningLevel;
  messages: ModelMessage[];
  /** JSON Schema of the answer (z.toJSONSchema of ANSWER_SCHEMAS[kind]). */
  schema: object;
  timeoutMs: number;
  /** For fakes and the recorder only. The real transport never reads it. */
  task: BrainTaskBase;
}
export interface ModelResponse {
  text: string;
  /** The model that actually answered (OpenRouter reports it). */
  model: string;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number | null };
  ms: number;
}
export interface ModelTransport { readonly name: string; call(req: ModelRequest): Promise<ModelResponse> }

/** One call, as the scorer and the logs see it: no text, ever. */
export interface CallRecord {
  kind: BrainTaskKind; taskId: string; model: string; attempt: number; ok: boolean;
  promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number | null; ms: number;
  outcome: "valid" | "invalid" | "not-json" | "transport";
}
```

```ts
// src/lib/rescue-run/model/brain.ts
import type { Brain } from "../../rescue/brain/brain";
import type { BrainTaskBase } from "../../rescue/brain/session-brain";
import type { Validation } from "../../rescue/brain/tasks";

export interface BrainPin { model: string; reasoning: ReasoningLevel }
export interface BrainLimits {
  maxUsdPerVersion: number;     // rescue.brain_max_cents_per_version / 100 (B-8)
  callsInFlight: number;        // rescue.brain_calls_in_flight, default 6, process-wide
  escalateModel: string | null; // rescue.brain_escalate_model
  callTimeoutMs: number;        // rescue.brain_call_timeout_s, default 240
  askDeadlineMs: number;        // rescue.brain_ask_deadline_s, default 1200
  maxRepairs: number;           // 2
}
export interface ModelBrainDeps {
  transport: ModelTransport;
  /** The pinned model of a task kind; null when the task is off (B-3). The reason is logged by the caller. */
  pin(kind: BrainTaskKind): BrainPin | null;
  limits(): Promise<BrainLimits>;
  /** Dollars already spent on this turn (the version), read before every call. */
  spentUsd(): Promise<number>;
  loadImage(path: string): Promise<string | null>;
  onCall?(rec: CallRecord): void;
  now?(): number;
}

export class ModelBrain implements Brain {
  readonly name = "model" as const;
  constructor(private readonly deps: ModelBrainDeps) {}
  ask<T>(task: BrainTaskBase, validate: (raw: unknown) => Validation<T>): Promise<T>;
}
```

`ask` in order:
1. `isBrainTaskKind(task.kind)` else `BrainUnavailableError("no model task <kind>")`. `pin(kind)` null → `BrainUnavailableError("rescue.brain.<kind> is not pinned")`. Nothing is called.
2. `spentUsd() >= maxUsdPerVersion` → `BrainUnavailableError("budget: …")`.
3. `messages = await buildMessages(task, (ref) => deps.loadImage(ref.path))`; `schema = z.toJSONSchema(ANSWER_SCHEMAS[kind])`.
4. Loop over attempts `0..maxRepairs`, then one more with `escalateModel` when it is set and differs: check the ask deadline (`BrainTimeoutError` when spent); check the budget again; `limiter.run(() => transport.call({ … timeoutMs: min(callTimeoutMs, deadline - now) }))`; map a `TransportError`: `timeout` → `BrainTimeoutError`; `bad_request` and `refused` → `BrainAnswerInvalidError`; every other code → `BrainUnavailableError(code)`; `readModelJson`; on an object set `value.taskId = task.id`; run `validate`; valid → `onCall` and return; else append `{ role: "assistant", content: text.slice(0, 20000) }` and `repairTurn(errors)`.
5. Exhausted → `BrainAnswerInvalidError(kind, errors.length, model)`.
6. Every call, valid or not, goes to `onCall` with tokens, cost, ms and outcome; never text.

`limiter.ts`: one module-level semaphore. `limiter.resize(n)` is called with `callsInFlight` before each call; it never drops a call in flight.

- [ ] **Step 1: Write the failing test.**

```ts
// src/lib/rescue-run/__tests__/model-brain-core.test.ts
import { describe, it, expect } from "vitest";
import { ModelBrain, type ModelBrainDeps, type BrainLimits } from "../model/brain";
import type { ModelRequest, ModelResponse, ModelTransport, CallRecord } from "../model/transport";
import { BrainAnswerInvalidError, BrainUnavailableError, TransportError } from "../brain-errors";
import { BrainTimeoutError } from "../../rescue/brain/session-brain";
import { ASK_INSTRUCTIONS } from "../../rescue/brain/ask-task";

type Step = string | TransportError | ((r: ModelRequest) => Promise<string> | string);
class ScriptedTransport implements ModelTransport {
  readonly name = "scripted";
  readonly calls: ModelRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly script: Step[], private readonly delayMs = 0) {}
  async call(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const next = this.script.shift();
      if (next === undefined) throw new Error("script ran out");
      if (next instanceof TransportError) throw next;
      const text = typeof next === "function" ? await next(req) : next;
      return { text, model: req.model, usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, costUsd: 0.001 }, ms: 5 };
    } finally {
      this.inFlight--;
    }
  }
}

const LIMITS: BrainLimits = { maxUsdPerVersion: 5, callsInFlight: 2, escalateModel: null, callTimeoutMs: 1000, askDeadlineMs: 10_000, maxRepairs: 2 };
function deps(t: ModelTransport, o: Partial<ModelBrainDeps> & { limits?: Partial<BrainLimits> } = {}): ModelBrainDeps & { records: CallRecord[] } {
  const records: CallRecord[] = [];
  const { limits, ...rest } = o;
  return {
    transport: t,
    pin: () => ({ model: "vendor/model-a", reasoning: "off" }),
    limits: async () => ({ ...LIMITS, ...(limits ?? {}) }),
    spentUsd: async () => 0,
    loadImage: async () => null,
    onCall: (r) => records.push(r),
    records,
    ...rest,
  };
}

// An invented ask task: the core is the same for every kind; the validator decides.
const TASK = { id: "ask-v1", kind: "ask", runId: "v1", corpusId: "p1", uiLanguage: "fr", candidates: [], instructions: ASK_INSTRUCTIONS };
const validate = (raw: unknown) =>
  (raw as { ok?: number })?.ok === 1 ? { ok: true, value: raw as { ok: number; taskId: string } } : { ok: false, errors: ["ok: expected 1"] };
const FENCE = "`".repeat(3);

describe("ModelBrain (M7 Task 5)", () => {
  it("returns a valid first answer, under the task's own id", async () => {
    const t = new ScriptedTransport(['{"ok":1,"taskId":"something-else"}']);
    const v = await new ModelBrain(deps(t)).ask(TASK, validate);
    expect(v).toEqual({ ok: 1, taskId: "ask-v1" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].model).toBe("vendor/model-a");
  });

  it("reads an answer inside a fence", async () => {
    const t = new ScriptedTransport([`${FENCE}json\n{"ok":1}\n${FENCE}`]);
    expect(await new ModelBrain(deps(t)).ask(TASK, validate)).toEqual({ ok: 1, taskId: "ask-v1" });
  });

  it("sends a rejected answer back with the validator's errors, and takes the repair", async () => {
    const t = new ScriptedTransport(['{"ok":2}', '{"ok":1}']);
    const d = deps(t);
    await new ModelBrain(d).ask(TASK, validate);
    expect(t.calls).toHaveLength(2);
    const last = t.calls[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("ok: expected 1");
    expect(t.calls[1].messages.at(-2)).toEqual({ role: "assistant", content: '{"ok":2}' });
    expect(d.records.map((r) => r.outcome)).toEqual(["invalid", "valid"]);
  });

  it("ends in BrainAnswerInvalidError after the repairs, which the runner treats as a timeout", async () => {
    const t = new ScriptedTransport(["{}", "{}", "{}"]);
    const p = new ModelBrain(deps(t)).ask(TASK, validate);
    await expect(p).rejects.toBeInstanceOf(BrainAnswerInvalidError);
    await expect(p).rejects.toBeInstanceOf(BrainTimeoutError);
    expect(t.calls).toHaveLength(3);
  });

  it("asks the escalation model once when the pinned one fails", async () => {
    const t = new ScriptedTransport(["{}", "{}", "{}", '{"ok":1}']);
    await new ModelBrain(deps(t, { limits: { escalateModel: "vendor/model-b" } })).ask(TASK, validate);
    expect(t.calls.map((c) => c.model)).toEqual(["vendor/model-a", "vendor/model-a", "vendor/model-a", "vendor/model-b"]);
  });

  it("is off when the task is not pinned: unavailable, and nothing is called", async () => {
    const t = new ScriptedTransport([]);
    await expect(new ModelBrain(deps(t, { pin: () => null })).ask(TASK, validate)).rejects.toBeInstanceOf(BrainUnavailableError);
    expect(t.calls).toHaveLength(0);
  });

  it("stops at the version's spend cap before calling", async () => {
    const t = new ScriptedTransport([]);
    await expect(new ModelBrain(deps(t, { spentUsd: async () => 5 })).ask(TASK, validate)).rejects.toThrow(/budget/);
    expect(t.calls).toHaveLength(0);
  });

  it("maps transport failures to waits", async () => {
    const cases: [TransportError, unknown][] = [
      [new TransportError("timeout"), BrainTimeoutError],
      [new TransportError("rate_limited", 429), BrainUnavailableError],
      [new TransportError("unavailable", 503), BrainUnavailableError],
      [new TransportError("no_credit", 402), BrainUnavailableError],
      [new TransportError("no_endpoint", 404), BrainUnavailableError],
      [new TransportError("bad_request", 400), BrainAnswerInvalidError],
    ];
    for (const [err, cls] of cases) {
      await expect(new ModelBrain(deps(new ScriptedTransport([err]))).ask(TASK, validate), err.code).rejects.toBeInstanceOf(cls as never);
    }
  });

  it("ends a slow ask at its deadline as a timeout", async () => {
    let now = 0;
    const t = new ScriptedTransport([() => { now += 11_000; return "{}"; }, '{"ok":1}']);
    await expect(new ModelBrain(deps(t, { now: () => now })).ask(TASK, validate)).rejects.toBeInstanceOf(BrainTimeoutError);
    expect(t.calls).toHaveLength(1);
  });

  it("never has more calls in flight than the limit", async () => {
    const t = new ScriptedTransport(Array.from({ length: 6 }, () => '{"ok":1}'), 20);
    const b = new ModelBrain(deps(t));
    await Promise.all(Array.from({ length: 6 }, (_, k) => b.ask({ ...TASK, id: `ask-${k}` }, validate)));
    expect(t.maxInFlight).toBe(2);
  });

  it("reports tokens and cost per call, never text", async () => {
    const d = deps(new ScriptedTransport(['{"ok":1}']));
    await new ModelBrain(d).ask(TASK, validate);
    expect(d.records).toEqual([expect.objectContaining({ kind: "ask", taskId: "ask-v1", model: "vendor/model-a", attempt: 0, promptTokens: 100, completionTokens: 20, costUsd: 0.001, outcome: "valid" })]);
    expect(JSON.stringify(d.records)).not.toContain('"ok"');
  });
});
```

- [ ] **Step 2: Run, see it fail.** `npx vitest run src/lib/rescue-run/__tests__/model-brain-core.test.ts`
- [ ] **Step 3: Implement** `transport.ts`, `limiter.ts`, `brain.ts`. No import from `lib/ai`, no `fetch`, no `openai`.
- [ ] **Step 4: Green; rescue-run guard green.**
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): the model brain: validate, repair, escalate, wait, never guess`.

---

## Task 6: chunking in the pipeline (map windows, review looks)

**Files:**
- Modify: `src/lib/rescue/pipeline/stages-free.ts` (`MapDocumentInput.windowSize?: number`, passed to `buildMapTasks`), `src/lib/rescue/review/review-task.ts` (`buildReviewTask` input `chunk?: number` → id `review-${runId}-r${round}-c${chunk}-s${step}`; absent → today's id), `src/lib/rescue/review/round.ts` (`ReviewRoundInput.sheetsPerLook?: number`, `preZoomFloats?: boolean`)
- Test: `src/lib/rescue/__tests__/build-map-tasks.test.ts`, `src/lib/rescue/__tests__/review-round-chunks.test.ts` (new)
- The stages pass these only once the settings exist: that wiring is Task 9.

`reviewRound` with `sheetsPerLook = n`: the scope is cut into consecutive page groups of `n × OVERVIEW_MAX` pages. Each group runs today's look with `onlyPages` = the group and `chunk` = its number (1-based), so `validateReviewAnswer` holds the answer to the group's pages with the full context. Results merge: issues and fixes concatenated in group order, `zoomed` and `pagesToRerender` unioned and sorted, `exemptPages` concatenated, notes joined with `"; "` and cut to `MOST_NOTE_CHARS`. One group (or `sheetsPerLook` absent) is exactly today's behaviour and today's ids. `preZoomFloats: true` starts a look with `zoomed` = the group's `mustZoom` pages, which saves the step every look spends asking for them.

- [ ] **Step 1: Write the failing tests.**
  - `build-map-tasks.test.ts`: an invented 5-block inventory with `windowSize: 2` gives 3 tasks, ids `-w0`, `-w1`, `-w2`, and `mapDocument` with a table brain answers all 5 keys.
  - `review-round-chunks.test.ts` (invented `ReviewView` of 30 pages, `sheets()` returning one fake sheet per 9 pages, a table brain that answers each task with `looked` all empty unless told): with `sheetsPerLook: 1` the brain sees 4 tasks with ids `review-r-r1-c1-s1` … `-c4-s1` and `onlyPages` `[1..9]`, `[10..18]`, `[19..27]`, `[28..30]`; an issue the brain reports on page 12 in group 2 is in the merged result; with `preZoomFloats` and `floatPages: [5]`, group 1's first task already has `zoomed` page 5 and no zoom step follows; with no options, one task with today's id `review-r-r1-s1` and no `onlyPages`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green**, then every rescue unit test: `npx vitest run src/lib/rescue/__tests__ src/lib/rescue-run/__tests__/stages-free.test.ts src/lib/rescue-run/__tests__/stages-rescue.test.ts`.
- [ ] **Step 5: Corpus replay unchanged** (the session brain's tasks did not move): `npx tsx scripts/rescue-lab/replay.ts t03` → same line as before the change (`replay t03: ok`).
- [ ] **Step 6: Gate, review, commit:** `feat(rescue): map windows and review looks sized for the model brain; the session brain's tasks unchanged`.

---

## Task 7: the seven features in the registry

**Files:**
- Modify: `src/lib/ai/features.ts` (seven entries, group `"Rescue"`, after `rescue.classify`), `scripts/pin-feature-models.ts` (skip keys starting `rescue.brain.`, with a line in its report: `rescue.brain.* are pinned by the rescue scorer, never in bulk`)
- Test: `src/lib/ai/__tests__/features-rescue-brain.test.ts` (new)

Each entry: `key`, `label` ("Rescue brain · map" …), `group: "Rescue"`, `volume: "low"`, no `defaultProvider`, no `defaultSystemPrompt`, and a hint written without backticks that says: what the task reads; whether it needs vision (map, review, read_cover, read_guide: yes); "Off until pinned: both provider and model must be set, provider openrouter. Pin only a model the rescue scorer passed (docs/rescue-v2-brain-scores.md)."

- [ ] **Step 1: Failing test:** the seven keys exist in `AI_FEATURES`; four say vision in their hint; no hint has a backtick; `resolveFeatureConfig("rescue.brain.map")` with no settings has `providerSource: "default"` (which Task 8 reads as off).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4:** `npx vitest run src/lib/ai/__tests__/features-rescue-brain.test.ts src/lib/ai/__tests__` green; `npx tsx scripts/pin-feature-models.ts` (dry run, writes nothing; needs the DB the `.env` names, skip if none) lists no `rescue.brain.*` key with an arrow.
- [ ] **Step 5: Gate, review, commit:** `feat(ai): rescue brain features, off until pinned`.

---

## Task 8: the provider edge (`model-brain.ts`, the one exempt file)

**Files:**
- Create: `src/lib/rescue-run/model-brain.ts`, `src/lib/rescue-run/__tests__/model-brain-edge.test.ts`

```ts
// src/lib/rescue-run/model-brain.ts
// The only rescue-run file that may reach lib/ai (guard: Task 10). It turns a ModelRequest into one OpenRouter call on the
// platform's key (never BYOK, never a per-account pin: B-9), with zero-retention routing (B-2), the answer schema, usage
// accounting, and one ai_usage_log row per call under the stage's turn id.
import OpenAI from "openai";
import { resolveFeatureConfig } from "../ai/features";
import { getPlatformProvider, OpenRouterProvider } from "../ai/index";
import { cacheBreakpointsActive, providerRoutingParam, withPromptCaching } from "../ai/cache";
import { recordAiCall } from "../ai/usage-log";

export const RESCUE_FEATURE = (kind: BrainTaskKind) => `rescue.brain.${kind}`;

/** B-3: pinned only when provider AND model are setting rows, and the provider is openrouter. */
export function resolveRescuePin(kind: BrainTaskKind, reasoning: ReasoningLevel): { pin: BrainPin | null; reason: string | null };

export interface OpenRouterTransportOptions {
  /** Absent: the platform's own instance (production). The scorer passes its own key (B-12). */
  apiKey?: string;
  /** False in the scorer: nothing is written to ai_usage_log. */
  record?: boolean;
}
export function openRouterTransport(o?: OpenRouterTransportOptions): ModelTransport;

/** The live catalogue for the scorer's shortlist: id, prices per token, context, input modalities, structured outputs. */
export async function openRouterCatalogue(): Promise<CatalogueRow[]>;
/** Model ids with at least one zero-retention endpoint. */
export async function openRouterZdrModels(): Promise<Set<string>>;
```

The request body (`client.chat.completions.create(body, { timeout, maxRetries: 2 })`):

```ts
{
  model: req.model,
  messages: withPromptCaching(withStableBreakpoint(req.messages, req.model), req.model, "openrouter"),
  temperature: 0,
  max_tokens: MAX_OUT[req.kind],                      // map 12000, review 8000, others 3000
  response_format: { type: "json_schema", json_schema: { name: `${req.kind}_answer`, schema: req.schema, strict: false } },
  usage: { include: true },
  provider: { zdr: true, data_collection: "deny", require_parameters: true, allow_fallbacks: true, ...orderOf(providerRoutingParam(req.model, "openrouter")) },
  ...(req.reasoning === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: req.reasoning } }),
}
```

- `withStableBreakpoint`: only when `cacheBreakpointsActive(model, "openrouter")`, mark the last text part of the first user message with `cache_control: { type: "ephemeral" }` (B-11).
- A 400 whose error type names `response_format` or `json_schema`: retry once with `response_format: { type: "json_object" }`, remember it per model for this process.
- Errors to `TransportError`: `APIConnectionTimeoutError` → `timeout`; `APIConnectionError` → `unavailable`; 401, 403 → `auth`; 402 → `no_credit`; 404 → `no_endpoint` (OpenRouter's answer when no endpoint meets the data policy); 408 → `timeout`; 429 → `rate_limited`; 5xx → `unavailable`; other 4xx → `bad_request`; a 200 with no choice or `finish_reason: "content_filter"` → `refused`.
- `recordAiCall({ provider: "openrouter", model: res.model || req.model, kind: "chat", latencyMs, usage: res.usage, feature: RESCUE_FEATURE(kind) })`; on failure `{ ok: false, error: "<code>:<status>" }`. The turn id comes from the runner's ALS (P-33). Nothing else is logged; no `console.*` with message content.
- `text` = `choices[0].message.content` (a string; an object from a gateway is stringified, as `cloudflare.ts` does). Reasoning fields are not read.

- [ ] **Step 1: Write the failing test.** Mock `../ai/usage-log` (`recordAiCall: vi.fn()`), `../ai/features` (`resolveFeatureConfig` from a table), and inject a fake client: add an internal `openRouterTransportWith(client, o)` that `openRouterTransport` wraps, so the test passes `{ chat: { completions: { create: vi.fn() } } }`.

```ts
// src/lib/rescue-run/__tests__/model-brain-edge.test.ts (excerpt; one `it` per bullet below)
import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
vi.mock("../../ai/usage-log", () => ({ recordAiCall: vi.fn(), runWithAiContext: (_c: unknown, f: () => unknown) => f(), currentAiContext: () => ({}) }));
const settings = new Map<string, string>();
vi.mock("../../ai/features", () => ({
  resolveFeatureConfig: (key: string) => {
    const p = settings.get(`ai.feature.${key}.provider`);
    const m = settings.get(`ai.feature.${key}.model`);
    return { key, provider: p ?? "cloudflare", model: m, providerSource: p ? "setting" : "default", modelSource: m ? "setting" : "default", systemPromptSource: "default" };
  },
}));
const { openRouterTransportWith, resolveRescuePin } = await import("../model-brain");
const { recordAiCall } = await import("../../ai/usage-log");
const { TransportError } = await import("../brain-errors");

const okResponse = { model: "vendor/model-a", choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0004, prompt_tokens_details: { cached_tokens: 0 } } };
const REQ = { kind: "ask", model: "vendor/model-a", reasoning: "off", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], schema: { type: "object" }, timeoutMs: 1000, task: { id: "ask-v1", kind: "ask" } } as const;

beforeEach(() => { settings.clear(); vi.mocked(recordAiCall).mockClear(); });

describe("the OpenRouter edge (M7 Task 8)", () => {
  it("sends zero retention, no data collection, the schema and usage accounting", async () => {
    const create = vi.fn(async () => okResponse);
    const r = await openRouterTransportWith({ chat: { completions: { create } } } as never, {}).call(REQ as never);
    const [body, opts] = create.mock.calls[0] as [Record<string, any>, Record<string, any>];
    expect(body.provider).toMatchObject({ zdr: true, data_collection: "deny", require_parameters: true });
    expect(body.usage).toEqual({ include: true });
    expect(body.response_format.type).toBe("json_schema");
    expect(body.reasoning).toEqual({ enabled: false });
    expect(opts).toMatchObject({ timeout: 1000, maxRetries: 2 });
    expect(r).toMatchObject({ text: '{"ok":1}', usage: { promptTokens: 120, completionTokens: 30, costUsd: 0.0004 } });
  });

  it("logs one usage row under the task's feature, with the cost, and never the text", async () => {
    await openRouterTransportWith({ chat: { completions: { create: async () => okResponse } } } as never, {}).call(REQ as never);
    expect(recordAiCall).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter", feature: "rescue.brain.ask", usage: okResponse.usage }));
    expect(JSON.stringify(vi.mocked(recordAiCall).mock.calls)).not.toContain('{\\"ok\\":1}');
  });

  it("logs nothing when record is false (the scorer)", async () => {
    await openRouterTransportWith({ chat: { completions: { create: async () => okResponse } } } as never, { record: false }).call(REQ as never);
    expect(recordAiCall).not.toHaveBeenCalled();
  });

  it("maps provider errors to codes, and logs the code, never the message", async () => {
    const table: [unknown, string][] = [
      [OpenAI.APIError.generate(429, { message: "invented words" }, "invented words", new Headers()), "rate_limited"],
      [OpenAI.APIError.generate(402, { message: "x" }, "x", new Headers()), "no_credit"],
      [OpenAI.APIError.generate(404, { message: "No endpoints found matching your data policy" }, "x", new Headers()), "no_endpoint"],
      [OpenAI.APIError.generate(503, { message: "x" }, "x", new Headers()), "unavailable"],
      [new OpenAI.APIConnectionTimeoutError(), "timeout"],
    ];
    for (const [err, code] of table) {
      const create = async () => { throw err; };
      await expect(openRouterTransportWith({ chat: { completions: { create } } } as never, {}).call(REQ as never)).rejects.toMatchObject({ code });
    }
    expect(JSON.stringify(vi.mocked(recordAiCall).mock.calls)).not.toContain("invented words");
  });

  it("falls back to json_object once when the endpoint refuses the schema", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(OpenAI.APIError.generate(400, { message: "response_format json_schema not supported" }, "x", new Headers()))
      .mockResolvedValueOnce(okResponse);
    await openRouterTransportWith({ chat: { completions: { create } } } as never, {}).call(REQ as never);
    expect((create.mock.calls[1][0] as any).response_format).toEqual({ type: "json_object" });
  });

  it("is pinned only by setting rows naming openrouter", () => {
    expect(resolveRescuePin("map", "off").pin).toBeNull();
    settings.set("ai.feature.rescue.brain.map.provider", "cloudflare");
    settings.set("ai.feature.rescue.brain.map.model", "dynamic/route");
    expect(resolveRescuePin("map", "off")).toEqual({ pin: null, reason: "provider cloudflare is not supported for the rescue brain" });
    settings.set("ai.feature.rescue.brain.map.provider", "openrouter");
    settings.set("ai.feature.rescue.brain.map.model", "vendor/model-a");
    expect(resolveRescuePin("map", "low").pin).toEqual({ model: "vendor/model-a", reasoning: "low" });
  });
});
```

- [ ] **Step 2: Fail. Step 3: Implement.** `openRouterCatalogue` reads the public `models` endpoint (no key needed) and keeps `id`, `pricing.prompt`, `pricing.completion`, `pricing.image`, `pricing.input_cache_read`, `context_length`, `architecture.input_modalities`, `supported_parameters`. `openRouterZdrModels` reads the public `endpoints/zdr` list (it was 1.1 MB on 2026-11-08: stream it with a 90 s timeout).
- [ ] **Step 4: Green. The guard is red until Task 10:** `guard.test.ts` reports `model-brain.ts`; that is expected and is the only line it reports. Do Task 10 next, before committing either.
- [ ] **Step 5: Review, then commit with Task 10.**

---

## Task 9: settings, the factory, and the spend so far

**Files:**
- Modify: `src/lib/rescue-run/config.ts` (`RescueLimits` + `RESCUE_LIMIT_DEFAULTS` + `rescueLimits()`), `src/lib/rescue-run/brain-factory.ts`, `src/lib/rescue-run/cost.ts` (`turnSpendUsd`), `src/routes/admin-rescue.ts` (`LIMIT_FIELDS` gains the integer brain limits), `src/lib/rescue-run/stages/free.ts` (map: both `buildMapTasks` calls, the one that collects page numbers and `mapDocument`, get the same `windowSize`), `src/lib/rescue-run/stages/rescue.ts` (`map_changed`'s `mapDocument` and the review stage's `reviewRound`)
- Test: `src/lib/rescue-run/__tests__/config.test.ts`, `brain-factory.test.ts`, `cost.test.ts`, `stages-free.test.ts`, `stages-rescue.test.ts`, `src/__tests__/admin-rescue*.test.ts` (whichever file holds the settings route tests today)

**Stage wiring (B-7).** The stages read `rescueLimits()` (already in `ctx.reads.limits` where a stage has it) and pass `windowSize: limits.brainMapWindow`, `sheetsPerLook: limits.brainReviewSheets` and `preZoomFloats: true` only when `ctx.brain.name === "model"`. The session brain gets none of them, so its tasks and ids stay as they are.

| Setting (`app_settings`) | Default | Bounds | Read as |
|---|---|---|---|
| `rescue.brain_max_cents_per_version` | 300 | 10 to 5 000 | `brainMaxUsdPerVersion` (B-8) |
| `rescue.brain_calls_in_flight` | 6 | 1 to 32 | process-wide model calls (not `RESCUE_BRAIN_CONCURRENCY`, which counts brain-lane jobs, P-5) |
| `rescue.brain_call_timeout_s` | 240 | 30 to 900 | per call |
| `rescue.brain_ask_deadline_s` | 1200 | 60 to 3 600 | per ask, repairs included |
| `rescue.brain_map_window` | 120 | 20 to 200 | B-7 |
| `rescue.brain_review_sheets` | 6 | 1 to 40 | B-7 |
| `rescue.brain_escalate_model` | unset | an OpenRouter id | B-5 |
| `rescue.brain_reasoning_<task>` | `off` | off, low, medium, high | per task |

`createBrain(projectId)` with `RESCUE_BRAIN=model` returns:

```ts
new ModelBrain({
  transport: openRouterTransport(),
  pin: (kind) => {
    const r = resolveRescuePin(kind, reasoningSetting(kind));
    if (!r.pin) logOnce(`[rescue-brain] ${kind} off: ${r.reason}`);
    return r.pin;
  },
  limits: async () => brainLimitsFrom(await rescueLimits()),
  spentUsd: async () => turnSpendUsd(currentAiContext().turnId),
  loadImage,
});
```

`model` is allowed in production; the session brain's refusals are unchanged. `brainName()` is unchanged. `turnSpendUsd(turnId)` sums `cost_usd` (BYOK excluded) where `turn_id = $1`; no turn id or a query error → 0 and one log line (the cap is a backstop; a failed read must not stop a paid run).

- [ ] **Step 1: Failing tests.**
  - `config.test.ts`: defaults when no row; a row out of bounds falls back to the default; `rescue.brain_escalate_model` unset → null.
  - `brain-factory.test.ts`: change the existing "model throws until M7" case: `RESCUE_BRAIN=model` → an instance of `ModelBrain` with `name === "model"`, also with `NODE_ENV=production` and a cloud `DATABASE_URL`; the session cases stay as they are.
  - `cost.test.ts` (local DB): `turnSpendUsd` sums two rows of one turn, ignores a BYOK row and another turn's row; an unknown turn → 0.
  - Route test: `PUT /admin/rescue/settings { brainMaxCentsPerVersion: 500 }` saves; `5 001` → 400 `invalid_setting`; `GET` returns the brain limits.
  - `stages-free.test.ts`: the map stage with a fake brain named `"model"` and `rescue.brain_map_window` at 60 asks tasks of at most 60 blocks, and the page images it copied are exactly the pages those tasks name; with the session brain, 120 as today.
  - `stages-rescue.test.ts`: the review stage with a brain named `"model"` and `rescue.brain_review_sheets` at 1 on a 30-page fake view asks 4 chunk tasks; with the session brain, one task with today's id.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green** (`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/config.test.ts src/lib/rescue-run/__tests__/brain-factory.test.ts src/lib/rescue-run/__tests__/cost.test.ts src/lib/rescue-run/__tests__/stages-free.test.ts src/lib/rescue-run/__tests__/stages-rescue.test.ts`).
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): RESCUE_BRAIN=model builds the model brain; brain limits are settings; the stages size map and review for it`.

---

## Task 10: the guards, relaxed for exactly one file each

**Files:**
- Modify: `src/lib/rescue-run/__tests__/guard.test.ts`, `src/lib/rescue/__tests__/no-model-client.test.ts`

`guard.test.ts`:
- `const EXEMPT = join(RUN_DIR, "model-brain.ts");` The lib/ai and text checks skip that file. It may import `lib/ai/*` and the package `openai`; still no `@openrouter/sdk`, `@anthropic-ai/sdk`, `@google/*` (the edge uses the OpenAI-compatible client only).
- New `it`: "the exemption is one file and it exists" (`existsSync(EXEMPT)`).
- New `it`: "only brain-factory.ts imports model-brain" (scan every other `rescue-run` file and both routes for a specifier resolving to `model-brain`; the scorer is outside this scan).
- Rename the `describe` to "rescue-run reaches a model client only through model-brain.ts".

`no-model-client.test.ts`:
- `const EXEMPT_ENTRY = join(REPO, "scripts/rescue-lab/score-brain.ts");` removed from `files` (and so from esbuild's entry points). Everything else under `scripts/rescue-lab` stays scanned transitively.
- New `it`: "no scanned file imports score-brain.ts" (text scan for a specifier ending `score-brain`).
- New `it`: "the scorer's pure library stays pure": esbuild-bundle `src/lib/rescue-run/score/*.ts` (Tasks 12-13) and assert it reaches no forbidden file or package (the same check as the main one).
- Rename the `describe`: "rescue code stays model-free and DB-free; the scorer's entry is the one door".

- [ ] **Step 1: Write the new `it`s first** and see them fail for the right reason (the exemption constants do not exist; `score/` does not exist yet, so the third `it` is `it.skipIf(!existsSync(scoreDir))` until Task 12, then plain).
- [ ] **Step 2: Implement. Step 3: Run both guard files green**, with `model-brain.ts` from Task 8 in the tree.
- [ ] **Step 4: Commit Tasks 8 and 10 together.**

```bash
git add -- src/lib/rescue-run/model-brain.ts src/lib/rescue-run/__tests__/model-brain-edge.test.ts
git commit -m "feat(rescue-run): the OpenRouter edge of the model brain, the one file the guards let through

Zero retention, no data collection, the answer schema, usage accounting, one ai_usage_log row per call
under the version's turn. The rescue-run guard exempts model-brain.ts only; the rescue guard exempts the
scorer's entry only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/model-brain.ts src/lib/rescue-run/__tests__/model-brain-edge.test.ts src/lib/rescue-run/__tests__/guard.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
```

---

## Task 11: the cost record names the brain's work

**Files:**
- Modify: `src/lib/rescue/pipeline/contract.ts` (`RescueCost.models: string[]`, `costComplete: boolean`, `promptVersion: string | null`), `src/lib/rescue-run/stage-context.ts` (`readonly brainAsks: number` on `StageContext`; the brain wrapper increments it), `src/lib/rescue-run/runner.ts` (`withTimings` adds `brainTasks: (prev.brainTasks ?? 0) + ctx.brainAsks`), `src/lib/rescue-run/cost.ts`
- Test: `stage-context.test.ts`, `runner.test.ts`, `cost.test.ts`, `dto.test.ts` (if the dashboard DTO maps `cost`)

`snapshotCost` SQL gains `array_remove(array_agg(DISTINCT model), NULL) AS models` and `COALESCE(bool_and(cost_usd IS NOT NULL) FILTER (WHERE NOT byok), true) AS complete`. `promptVersion` is `PROMPT_VERSION` when `brain === "model"`, else null. A session version stays `models: []`, `costComplete: true`. Old rows without the fields read as `[]`, `true`, `null`.

- [ ] **Step 1: Failing tests:** two asks in one stage → `stage_state.brainTasks` 2 after the commit (fake brain); `snapshotCost` over rows of two models → `models` both, sorted; one row with `cost_usd` NULL → `costComplete: false`; a session version → `models: []`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green** on the local DB.
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): a version's cost names its models, its brain tasks and whether every dollar was reported`.

---

## Task 12: scoring metrics and the bars (pure)

**Files:**
- Create: `src/lib/rescue-run/score/metrics.ts`, `src/lib/rescue-run/score/bars.ts`, `src/lib/rescue-run/__tests__/score-metrics.test.ts`, `src/lib/rescue-run/__tests__/score-bars.test.ts`

```ts
// src/lib/rescue-run/score/metrics.ts
import type { Role } from "../../rescue/brain/tasks";

/** Roles whose mistake changes the thesis's skeleton: what the 97% bar is measured on. */
export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  "cover", "dedication", "thanks", "basmala", "abbreviations", "abstract-ar", "abstract-fr", "abstract-en",
  "typed-toc", "typed-list", "toc-field", "list-field", "divider-page", "part", "h1", "h2", "h3", "h4", "h5",
  "caption-figure", "caption-table", "bibliography-heading", "annex-heading", "junk",
]);
/** A wrong one of these removes the student's lines: Regenerate deletes a typed contents or list, and junk is removed. */
export const DESTRUCTIVE_ROLES: ReadonlySet<string> = new Set(["typed-toc", "typed-list", "junk"]);

type Roles = Record<string, { role: string; confidence: number }>;
export interface RoleScore {
  blocks: number; overall: number;
  /** Over every block whose gold OR model role is structural, so a body line made a heading counts. */
  structuralN: number; structuralErrors: number; structural: number;
  destructive: number; formatOk: boolean;
  /** gold role → model role → count, errors only. */
  confusion: Record<string, Record<string, number>>;
  missing: number;
}
export function scoreRoles(gold: Roles, got: Roles, format: { gold?: string; got?: string }): RoleScore;

export interface QuestionScore { asked: number; justified: number; unjustified: number; silentStructuralErrors: number }
/** A question is justified when the model's role on that block is wrong, or Claude was unsure too (confidence below 0.7). */
export function scoreQuestions(asked: string[], gold: Roles, got: Roles): QuestionScore;

export interface ExpectedDefect { page: number; kind: string; must: boolean; fix: string | null }
export interface FoundIssue { page: number; kind: string; fix?: { name: string } }
/** Kinds whose defect sits across a page turn: a hit may be one page off. */
export const SPAN_KINDS: ReadonlySet<string> = new Set(["caption-apart", "heading-stranded", "table-split", "page-nearly-empty"]);
export interface ReviewScore {
  expected: number; hits: number; recall: number;
  mustExpected: number; mustHits: number; mustRecall: number;
  unmatched: number; unmatchedPer100Pages: number;
  fixCompared: number; fixAgree: number;
}
export function scoreReview(expected: ExpectedDefect[], found: FoundIssue[], pageCount: number): ReviewScore;

export interface CoverScore { goldFields: number; found: number; wrong: number; extra: number }
/** Values compared after normalizeValue (cover/fields.ts). A field the gold lacks and the model gives is extra, and wrong (D-23). */
export function scoreCover(gold: Record<string, unknown>, got: Record<string, unknown>): CoverScore;

export function scoreOrder(gold: { order: number[]; roles: { index: number; role: string }[]; continuesPrevious: number[] }, got: typeof gold): { exact: boolean; orderOk: boolean; rolesOk: number; continuesOk: boolean };

/** Prove's docx checks that mean words or objects were lost (spec §3 invariants 1-3). */
export const CONTENT_CHECKS = ["words", "blocks-removed", "counts", "notes", "bibliography", "junk-only-empty", "moves-declared"] as const;
export function contentLost(checks: { id: string; ok: boolean }[]): string[];
```

```ts
// src/lib/rescue-run/score/bars.ts — spec §12, with the reading of each bar this plan proposes (Open questions 3 to 5).
export const BARS = {
  structuralPerThesis: 0.97,
  /** A thesis with fewer structural blocks than this may have one structural error instead (one error in 33 is 97%). */
  smallThesisStructuralN: 34,
  structuralPooled: 0.97,
  destructive: 0,
  contentLost: 0,
  formatWrongMax: 0,
  questionsMax: 5,
  unjustifiedMax: 1,
  reviewMustRecall: 1,
  reviewRecallPooled: 0.85,
  coverWrong: 0,
  coverRecall: 0.9,
  orderExact: true,
  proveAllPass: true,
} as const;

export interface ThesisResult { id: string; map?: RoleScore; questions?: QuestionScore; contentLost?: string[]; review?: ReviewScore; cover?: CoverScore; order?: ReturnType<typeof scoreOrder>; prove?: { ok: boolean; failed: string[] }; usd: number; ms: number }
export interface BarCheck { pass: boolean; failed: string[] }
/** Per task group: map (map + content + format), ask, review, read_cover, order_parts, prove. A group with no result is "not run", never a pass. */
export function checkBars(results: ThesisResult[]): Record<"map" | "ask" | "review" | "read_cover" | "order_parts" | "prove", BarCheck | "not run">;
```

- [ ] **Step 1: Write the failing tests** (invented keys only).

```ts
// src/lib/rescue-run/__tests__/score-metrics.test.ts (excerpt)
import { describe, it, expect } from "vitest";
import { scoreRoles, scoreQuestions, scoreReview, scoreCover, contentLost } from "../score/metrics";

const r = (role: string, confidence = 0.9) => ({ role, confidence });
const GOLD = { a: r("h1"), b: r("body"), c: r("body"), d: r("h2"), e: r("caption-table"), f: r("body", 0.5) };

describe("scoring (M7 Task 12)", () => {
  it("counts a body line made a heading as a structural error", () => {
    const s = scoreRoles(GOLD, { ...GOLD, b: r("h2") }, { gold: "classic", got: "classic" });
    expect(s.structuralN).toBe(4); // a, b (model says h2), d, e
    expect(s.structuralErrors).toBe(1);
    expect(s.structural).toBeCloseTo(0.75);
    expect(s.overall).toBeCloseTo(5 / 6);
    expect(s.confusion).toEqual({ body: { h2: 1 } });
  });
  it("counts a typed contents the gold does not have as destructive", () => {
    expect(scoreRoles(GOLD, { ...GOLD, c: r("typed-toc") }, {}).destructive).toBe(1);
  });
  it("a missing key is an error, never skipped", () => {
    const { a, ...rest } = GOLD;
    const s = scoreRoles(GOLD, rest, {});
    expect(s.missing).toBe(1);
    expect(s.structuralErrors).toBe(1);
  });
  it("a question is justified on a wrong role or where Claude was unsure", () => {
    const got = { ...GOLD, d: r("h3", 0.4) };
    expect(scoreQuestions(["d", "f", "b"], GOLD, got)).toEqual({ asked: 3, justified: 2, unjustified: 1, silentStructuralErrors: 0 });
    expect(scoreQuestions([], GOLD, got).silentStructuralErrors).toBe(1);
  });
  it("review: exact page and kind, one page off for span kinds, must kinds apart", () => {
    const expected = [
      { page: 4, kind: "words-under-float", must: true, fix: null },
      { page: 9, kind: "caption-apart", must: false, fix: "keep_with_next" },
      { page: 12, kind: "spacing-wrong", must: false, fix: null },
    ];
    const found = [{ page: 4, kind: "words-under-float" }, { page: 10, kind: "caption-apart", fix: { name: "keep_with_next" } }, { page: 13, kind: "spacing-wrong" }, { page: 20, kind: "other" }];
    expect(scoreReview(expected, found, 40)).toEqual({
      expected: 3, hits: 2, recall: 2 / 3, mustExpected: 1, mustHits: 1, mustRecall: 1,
      unmatched: 2, unmatchedPer100Pages: 5, fixCompared: 1, fixAgree: 1,
    });
  });
  it("cover: a value the gold lacks is wrong, a missing one is only missed", () => {
    expect(scoreCover({ title: "Invented title", supervisor: "Invented Name" }, { title: "Invented  title", academicYear: "2025/2026" }))
      .toEqual({ goldFields: 2, found: 1, wrong: 1, extra: 1 });
  });
  it("content lost reads only the content checks", () => {
    expect(contentLost([{ id: "words", ok: false }, { id: "doctor", ok: false }, { id: "counts", ok: true }])).toEqual(["words"]);
  });
});
```

  `score-bars.test.ts`: a thesis at 96.9% with 200 structural blocks fails map; at 31/32 with 32 structural blocks passes; pooled under 97% fails even when every thesis passes; one destructive error fails; 6 questions fail; 2 unjustified fail; a missed must defect fails review; a group with no results is `"not run"`.

- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green; the scorer-purity `it` of Task 10 now runs unskipped and passes.**
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): how a brain is scored against Claude's answer keys`.

---

## Task 13: estimate, spend cap, scoring transports (pure)

**Files:**
- Create: `src/lib/rescue-run/score/estimate.ts`, `src/lib/rescue-run/score/budget.ts`, `src/lib/rescue-run/score/transports.ts`, `src/lib/rescue-run/__tests__/score-budget.test.ts`, `src/lib/rescue-run/__tests__/score-transports.test.ts`

```ts
// estimate.ts — an estimate before any money is spent. A guess, printed as one; a calibrated run replaces the guesses.
export interface PriceRow { id: string; promptUsd: number; completionUsd: number; imageUsd: number; cacheReadUsd: number | null }
export const BYTES_PER_TOKEN = 3.2;              // UTF-8 bytes; Arabic text is about 2 bytes a letter
export const IMAGE_TOKENS = { anthropic: 1900, openai: 1100, google: 1100, other: 1300 } as const; // per 1000 x 1400 JPEG
export const OUT_TOKENS = { map: 30, review: 2500, ask: 600, read_cover: 400, read_guide: 800, parse_note: 500, order_parts: 300 } as const; // map: per block; others per call
export function estimateCall(req: { kind: BrainTaskKind; textBytes: number; images: number; blocks?: number }, model: string, price: PriceRow, calib?: { inScale: number; outScale: number }): { inTokens: number; outTokens: number; usd: number };

// budget.ts — the scorer's hard stop (B-12). In-flight calls may overshoot by at most callsInFlight x the largest call's estimate.
export class BudgetStop extends Error {}
export class SpendCap {
  constructor(readonly capUsd: number);
  /** Throws BudgetStop when spent + reserved + est would pass the cap. */
  reserve(estUsd: number): number;           // returns a ticket
  settle(ticket: number, actualUsd: number | null): void; // null: the estimate stands
  get spentUsd(): number;
}

// transports.ts
/** Answers from a function of the task (the gold transport): what tests and the corpus dry run use. Costs nothing. */
export class TableTransport implements ModelTransport { constructor(answer: (task: BrainTaskBase, req: ModelRequest) => object | string) }
/** Wraps a transport: reserves the estimate on the cap before each call, settles with the reported cost. */
export class CappedTransport implements ModelTransport { constructor(inner: ModelTransport, cap: SpendCap, estimate: (req: ModelRequest) => number) }
/** Saves every raw response under dir/<key>.json, key = requestKey(req). Lab-only (B-12). */
export class RecordingTransport implements ModelTransport { constructor(inner: ModelTransport, dir: string) }
/** Answers only from what was recorded; a request never recorded throws TransportError("unavailable"). */
export class ReplayTransport implements ModelTransport { constructor(dir: string) }
/** sha256 of model, reasoning, PROMPT_VERSION and the messages with each image replaced by its own sha256. */
export function requestKey(req: ModelRequest): string;
```

- [ ] **Step 1: Failing tests.**
  - Budget: cap 1.00; reserve 0.4, 0.4 → ok; a third 0.4 → `BudgetStop`; settle the first at 0.1 → a 0.4 reserve now passes; `settle(t, null)` keeps the estimate.
  - Capped transport over a table transport: with a cap of 0 and an estimate of 0 every call passes (the dry run); with an estimate of 1 and a cap of 0.5 the first call throws `BudgetStop` before the inner transport is called.
  - Record then replay: one call through `RecordingTransport` into a `mkdtemp` folder, the same request through `ReplayTransport` returns the same text and usage; a request with one image byte changed is "not recorded".
  - `requestKey` ignores `task` and `timeoutMs`, and moves when the model or a message moves.
  - `estimateCall`: 32 000 bytes, 4 images, an anthropic id at $1/M in and $5/M out → `inTokens` 10 000 + 7 600, and the dollars from those.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Green.**
- [ ] **Step 5: Gate, review, commit:** `feat(rescue-run): scoring estimate, spend cap, and gold, record and replay transports`.

---

## Task 14: a docx-only Prove for "content lost", and Review with any brain

**Files:**
- Modify: `src/lib/rescue/pipeline/stages-rescue.ts` (export `unrenderedFinal(regen, layout, reason)`; `renderFinal`'s refusal branch returns it), `scripts/rescue-lab/rescue-run.ts` (`RescueOpts.render?: boolean`, default true; false → `unrenderedFinal(regen, composed.layout, "skipped: score")`, no `rescued.pdf`, no `pages/`, no deposit, and the caller reads `prove.docx` only), `scripts/rescue-lab/review.ts` (export `reviewWithBrain(id, args, brain, o: { writeGold: boolean; prune: boolean })`; `reviewCmd` calls it with the `SessionBrain` and `{ writeGold: true, prune: true }`)
- Test: `src/lib/rescue/__tests__/unrendered-final.test.ts` (new)

- [ ] **Step 1: Failing test:** `renderFinal` with a fake renderer that throws `WordRefusedError("refused")` returns an object deep-equal to `unrenderedFinal(regen, layout, "refused")` except `renderError`; `proveAll` over `unrenderedFinal(…)` on an invented 3-paragraph docx (built with the engine, as the other prove tests do) gives a `docx` group whose `words` and `counts` checks pass, and a `render` check that fails.
- [ ] **Step 2: Fail. Step 3: Implement.** `review.ts` stays model-free: `reviewWithBrain` takes a `ReviewBrain`.
- [ ] **Step 4: Green; the rescue guard green** (the lab still imports no `rescue-run`).
- [ ] **Step 5: Lab check, no Word:** `npx tsx scripts/rescue-lab/cli.ts rescue t05 --map-run <none>` is unchanged (it renders). There is no CLI flag for `render: false`; only the scorer passes it.
- [ ] **Step 6: Gate, review, commit:** `feat(rescue-lab): a rescue that stops at the docx Prove, and Review with any brain`.

---

## Task 15: the scorer CLI

**Files:**
- Create: `scripts/rescue-lab/score-brain.ts`
- Modify: `scripts/rescue-lab/README.md` (a "Scoring a model brain (M7)" section), `.gitignore` (nothing: `lab/score/` is under the ignored `lab/`)

```text
npx tsx scripts/rescue-lab/score-brain.ts models
    The shortlist from the live catalogue: id, $/M in, $/M out, $/image, context, vision, structured outputs,
    zero-retention endpoints (yes/no). Vision and zero retention filter; cheapest input price first.

npx tsx scripts/rescue-lab/score-brain.ts estimate --model <id> [--tasks map,ask,review,read_cover,order_parts,read_guide,parse_note]
        [--corpus all|accepted|t01,t03] [--calibrate <scoreRunId>]
    Builds every task offline (no call) and prints the estimate per thesis and in all. Exit 0.

npx tsx scripts/rescue-lab/score-brain.ts run --model <id>|--transport gold|replay:<scoreRunId>
        --max-usd <n> [--tasks …] [--corpus …] [--reasoning off|low|medium|high] [--map-window 120]
        [--review-sheets 6] [--calls-in-flight 6] [--record] [--yes]
    Prints the estimate first; without --yes it stops there when the estimate passes the cap. Live runs need
    RESCUE_SCORE_OPENROUTER_KEY (B-12). Writes lab/score/<scoreRunId>/ (results.json, calls.jsonl, maps/,
    review-unmatched.jsonl, record/ with --record). Stdout: one line per thesis, counts only.

npx tsx scripts/rescue-lab/score-brain.ts report <scoreRunId>... [--markdown]
    The table per model (below) and the bar check per task group. --markdown writes lab/score/summary.md.

npx tsx scripts/rescue-lab/score-brain.ts prepare-review [all|t01,…]
    Review fixtures (Task 16). Word only for a run that kept neither pages nor its PDF.

npx tsx scripts/rescue-lab/score-brain.ts gold-cover all|t01,…
    Writes a read_cover task per thesis to the session queue; on acceptance, corpus/<id>/gold/cover.json (Task 16).

npx tsx scripts/rescue-lab/score-brain.ts prove --map <id> --review <id> --small <id> --max-usd <n> [--corpus accepted]
    The end-to-end rescue with the model brain, Word included (Task 18).

npx tsx scripts/rescue-lab/score-brain.ts pin --map <id> --review <id> --small <id> [--reasoning-map off …]
    Prints the PUT calls for the dashboard's admin API (Task 19). Writes nothing.
```

Per thesis, `run` does, for each requested task:
- **map**: `mapDocument({ inv, runId, corpusId: id, pageOf, pageImage, windowSize }, brain)` from `read/inventory.json`, `read/page-map.json`, `read/pages/` (no Word). Refuses a thesis whose `gold/map.json` `inventoryHash` differs from the read's (`re-key first`). Applies `relabelAnnouncingPages` to the model's roles and to gold's before comparing, as `prepare()` does. Writes `lab/runs/<scoreRunId>-<id>/run.json` and `map.json` in the lab's own format (`keyVersion`, `inventoryHash`, `format`, `roles`), so `cli.ts rescue <id> --map-run <that>` accepts it. Then **content lost**: `runRescue([id, "--map-run", runId], { render: false, prune: false, deposit: false })`, `contentLost(prove.docx.checks)`; the scorer then removes that `rescue/<runId>/` folder (it is its own, and holds nothing the score needs once read), so the accepted runs' folders are never crowded or pruned.
- **ask**: `diagnoseDocument` with the model's roles (PDF text from `read/document.pdf`), `buildAskTask` with the diagnosis's candidates (`uiLanguage` `fr`), `brain.ask`, `scoreQuestions`.
- **order_parts** (split theses only): `proposeOrder` on `original/*.docx` in filename order; gold is `assembled/assembly.json`.
- **read_cover**: the cover page from the model's roles (or gold's when map was not run in this score run), `readCoverFields`; gold is `gold/cover.json`.
- **review**: for each fixture, `viewOfRun(fixtureDir)`, one `reviewRound` (round 1, every page, `sheetsPerLook`, `preZoomFloats`), `scoreReview` against the fixture's expected defects. The model's unmatched issues go to `review-unmatched.jsonl` (page, kind, fix name, note) for Claude to look at (Task 17).
- **read_guide**, **parse_note**: over `scripts/rescue-lab/score-fixtures/*.json` (Task 16).

The scorer sets `process.env.AI_USAGE_LOG = "0"` before any import that could log, builds `ModelBrain` with `pin` from the flags (never from settings), `limits` from the flags, `spentUsd: async () => 0` (the cap is the transport's), `loadImage`, and `onCall` writing `calls.jsonl` (no text). The transport is `CappedTransport(Recording?(openRouterTransport({ apiKey: process.env.RESCUE_SCORE_OPENROUTER_KEY, record: false })))`, or a `TableTransport` from the answer keys for `--transport gold`, or `ReplayTransport`. A `BudgetStop` ends the run: the thesis in progress is `stopped: budget`, the rest `not run`, the report is still written, exit code 3.

The report table (one row per model and reasoning level; per-thesis rows with `--per-thesis`):

```text
model                      reas  map: struct min/pooled  destr  fmt  lost | ask: max unjust | review: must  all   unmatched/100p | cover: wrong recall | order | $/thesis mean max | s/thesis p50 max | repairs | bars
vendor/model-a             off      96.1% / 98.4%          0    20/20  0  |       3    1     |       9/9   88.1%      2.4        |        0    93%     | 4/4   | 0.041  0.170       |   38    211       |   2     | FAIL map(t05)
```

- [ ] **Step 1: The dry run is the test of the plumbing:**

```bash
cd ~/kwill-server
npx tsx scripts/rescue-lab/score-brain.ts run --transport gold --tasks map,ask,order_parts --corpus all --max-usd 0
```
Expected: one line per thesis t01–t20, each `map struct 100.0% destr 0 fmt ok · lost 0 · questions 0 · $0.0000`, t17–t20 also `order exact`; then `bars: map PASS, ask PASS, order_parts PASS, review not run, read_cover not run, prove not run`; exit 0. t17 has no `read/pages`: its map runs without images and its line says `no images`. A non-zero `lost` here is a pipeline defect on Claude's own map, not a scoring bug: stop and report it.

- [ ] **Step 2: Replay round trip:** `run --transport gold --record …` then `run --transport replay:<thatRunId> …` → identical `results.json` except timings.
- [ ] **Step 3: Estimate prints without a key:** `estimate --model anthropic/claude-haiku-5.5 --tasks map --corpus all` → a total in dollars and the per-thesis lines; exit 0.
- [ ] **Step 4: Guards green** (the scorer's entry is exempt; its library is pure).
- [ ] **Step 5: Review, commit:** `feat(rescue-lab): score a model brain against Claude's answer keys, capped and estimated first`.

---

## Task 16: the answer keys the scorer still lacks

Claude runs this in the main session (D-21, D-27: subagents may answer the session tasks, Claude arbitrates).

**A. Review fixtures** (`prepare-review`). The answer key for Review is `lab/defects.jsonl`: Claude's defects, per thesis, run and page. For each `(thesis, run)` in it whose `rescue/<run>/rescued.docx` still exists (12 of 16 on 2026-11-08):
1. Copy `rescued.docx`, `page-map.json`, `final-roles.json`, `prove.json` into `lab/score/fixtures/review/<thesis>/<run>/` (outside `rescue/`, so `pruneOlderRuns` cannot reach them).
2. Pages: from `rescue/<run>/pages` when present; else rasterise `rescue/<run>/rescued.pdf` at 900 px (`pdftoppm`, already on this Mac); else convert `rescued.docx` once through the Word converter (`WORD_CONVERTER_URL=http://localhost:8093`, the lab's instance), then rasterise.
3. Refuse a fixture whose page count differs from its `page-map.json` (`drifted`); list it, do not score it.
4. `expected.json`: the run's defects as `{ page, kind, must: isMustKind(kind), fix }`. The legacy kind `blank-page` maps to `page-nearly-empty`. Status `open` and `fixed` both count: the defect was in that file.
Expected stdout: `fixtures: 12 runs over 7 theses, N pages, M expected defects (K must), D drifted`.

**B. Cover key** (`gold-cover`). For each thesis whose gold map has a `cover` block: a `read_cover` task in `lab/tasks/score-cover-<id>/` with the cover page image; Claude (or a subagent) answers under the D-23 rules; on acceptance `corpus/<id>/gold/cover.json` (`fields`, `keyVersion`, `inventoryHash`, `at`). Stdout: field counts only.

**C. Note and guide fixtures** (tracked, invented, no real university or person):
- `scripts/rescue-lab/score-fixtures/notes.json`: 12 notes (6 Arabic, 5 French, 1 English), each `{ id, noteKind, language, text, expect: { chips: [{ kind, path?, value? }], refusedReasons: [] } }`, covering: a font wish a field can hold; a size out of range; "keep my tables as they are"; a structure hint; a request to change words (refused `changes-words`); a request to skip the contents (refused `skips-checks`); a request to move a section (refused `not-supported`); a clash with the department rule.
- `scripts/rescue-lab/score-fixtures/guides.json`: 3 invented guides as text (`guideText`) with expected rules; one also as a page image generated with sharp from SVG text in the lab (`lab/score/fixtures/guides/`), so the vision path is exercised. Arabic in SVG may not shape: if it renders wrong, keep the Arabic guide text-only and say so in the README.
- Scoring: a chip or rule counts when `path` and `value` match; a refusal when its reason matches. Bar (proposed): ≥ 90% matched and 0 rule chips for a refusal case.

- [ ] **Step 1:** `npx tsx scripts/rescue-lab/score-brain.ts prepare-review all` → the line above.
- [ ] **Step 2:** `gold-cover all`, answer the tasks, accept; `ls lab/corpus/*/gold/cover.json | wc -l` equals the number of theses with a cover block.
- [ ] **Step 3:** Write the two fixture files; `run --transport gold --tasks read_guide,parse_note` → 100%.
- [ ] **Step 4: Commit the fixtures only** (nothing under `lab/`): `test(rescue-lab): invented note and guide fixtures for scoring the brain`.

---

## Task 17: score the shortlist (live, the owner's key and budget)

Claude runs this in the main session. Requires `RESCUE_SCORE_OPENROUTER_KEY` (a dedicated key with a credit limit, Open question 12) and its balance checked first: `curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $RESCUE_SCORE_OPENROUTER_KEY"` (shows `limit` and `usage`; never paste the key anywhere).

**Order: cheapest first, per task group; stop early.** For each model in the shortlist (below), in order:
1. `estimate --model <id> --tasks map,ask --corpus all`. If the estimate is over the remaining budget, stop and ask the owner.
2. `run --model <id> --tasks map,ask --corpus all --max-usd <remaining for this step> --record --yes`.
3. `report <runId>`. If `map` and `ask` pass, this model is the map candidate; models after it are not scored on map, except the reference ceiling once.
4. The same for `review` (`--corpus accepted`, fixtures), then for the small tasks (`read_cover`, `order_parts`, `read_guide`, `parse_note`).
5. A model that fails `map` by a small margin gets one more run with `--map-window 60` and one with `--reasoning low` before it is dropped (each is a separate row in the table).

**Adjudicate the unmatched review issues.** For every line of `review-unmatched.jsonl`, Claude looks at that fixture page full size: a real defect is appended to `lab/defects.jsonl` with `status: "found-by-model"`, and the fixtures' `expected.json` is rebuilt. Then `report` again (recall can only drop, and a model that found real defects Claude missed is not penalised for them).

**Write the result** to `docs/rescue-v2-brain-scores.md` (server repo, tracked): per model and reasoning level the aggregate row of the table; per thesis only neutral ids and numbers; `PROMPT_VERSION`; the date; the catalogue prices used. No text, no names.

- [ ] **Step 1:** the runs above.
- [ ] **Step 2:** `report <all run ids> --markdown`, copied into `docs/rescue-v2-brain-scores.md` with a short reading of it.
- [ ] **Step 3: Commit:** `docs(rescue-v2): brain scores on the corpus (counts only)`.

---

## Task 18: the end-to-end proof, with Word

Claude, main session. Word converter on :8093.

```bash
npx tsx scripts/rescue-lab/score-brain.ts prove --map <map winner> --review <review winner> --small <small winner> --corpus accepted --max-usd 10 --yes
```

Per thesis: the model maps (`windowSize` from the winner's row), `runRescue([id, "--map-run", <model map>], { prune: false })`, then `reviewWithBrain(id, args, modelBrain, { writeGold: false, prune: false })` with the real rebuild (fixes applied by code, Word re-render, Prove), at most 3 rounds. Compared with `gold/review.json`'s accepted output through `replay-compare.ts`: pages ±1, the same headings on the same pages.

Expected stdout, one line per accepted thesis, of this shape (numbers invented): `t03 prove N/N ok · pages A → B (accepted B) · headings same · review 1 round, 0 fixes · $0.03 · 212 s`; then `prove: PASS 7/7`; exit 0. Any Prove failure, any page outside ±1, or a different heading is a FAIL with the check's id; it goes to `lab/defects.jsonl` as a model defect, and Task 17 resumes with the next model for the group that caused it (map or review).

- [ ] **Step 1:** run it; **Step 2:** add the result to `docs/rescue-v2-brain-scores.md`; **Step 3:** commit `docs(rescue-v2): end-to-end proof of the pinned brain on the accepted theses`.

When more corpus theses are accepted (M3 resumes, P-73), rerun Tasks 17 (their maps are already scored; only review is new) and 18 on them before the release: "a model passes on every corpus thesis" (spec §12) is checked again then.

---

## Task 19: pin, then a localhost walk with the model brain

Claude, main session, local database (P-37), server on this Mac.

1. **Pins are settings rows, not code.** `score-brain.ts pin …` prints, and Claude runs against the local server:
```bash
curl -s -X PUT localhost:3000/admin/providers/api/features/rescue.brain.map -H "x-admin-token: $ADMIN_API_TOKEN" -H "content-type: application/json" -d '{"provider":"openrouter","model":"<map winner>"}'
# the same for review, ask, order_parts, read_cover, read_guide, parse_note
curl -s -X PUT localhost:3000/admin/rescue/settings -H "x-admin-token: $ADMIN_API_TOKEN" -H "content-type: application/json" -d '{"brainMaxCentsPerVersion":<3 x p95 cents>,"brainMapWindow":<winner's>}'
```
   Then `RESCUE_BRAIN=model` in the local server's environment and a restart. `GET /admin/providers/api/features` shows the seven with `providerSource: "setting"`.
2. **Walk** (S22 steps 2-6 on t03 and t19): upload → diagnosis → payment as staff → repair → done, with the model brain. Assert: the version is `done`; `rescue_versions.cost` has `brain: "model"`, `tokensIn > 0`, `costUsd > 0`, `costComplete: true`, `models` = the pinned ids, `brainTasks > 0`, `promptVersion` = `PROMPT_VERSION`; `SELECT feature, count(*) FROM ai_usage_log WHERE turn_id = '<version id>' GROUP BY 1` lists `rescue.brain.*` rows only; no row has a non-null `error` with words in it.
3. **Waits** (B-6): set `ai.feature.rescue.brain.map.model` to an id with no zero-retention endpoint and start a diagnosis: the job shows `waiting_reason='brain'`, no attempt spent, the student sees the calm line; restore the pin; the job finishes on its next claim. Then the same with `rescue.brain_max_cents_per_version=10` on a large thesis: it waits at the cap; raising the cap resumes it.
4. **Never the session brain in production**: `NODE_ENV=production RESCUE_BRAIN=session` still refuses (the existing test, re-run).

- [ ] Record the walk in `docs/rescue-v2-brain-scores.md` (one paragraph, ids and numbers). Commit.

---

## Task 20: the release checklist and the docs

**Files:** `docs/rescue-v2-release-checklist.md`, `scripts/rescue-lab/README.md`, this plan's "As built" notes.

Replace item 1 and item 2's brain questions with what was decided, and add these lines in section F (owner, before item 47):
- `[owner]` In `app_settings` on cloud, pin the seven features: `ai.feature.rescue.brain.{map,review,ask,order_parts,read_cover,read_guide,parse_note}.provider = openrouter` and `.model = <ids in docs/rescue-v2-brain-scores.md>`, through the dashboard's AI → Features tab or `PUT /admin/providers/api/features/<key>`. Check with `GET /admin/providers/api/features` that each shows `providerSource: "setting"`.
- `[owner]` Set the brain limits from the scores: `rescue.brain_max_cents_per_version`, `rescue.brain_map_window`, `rescue.brain_review_sheets`, and `rescue.brain_reasoning_<task>` where the winner's row used one (`PUT /admin/rescue/settings`). Leave `rescue.brain_escalate_model` unset unless the scores say otherwise.
- `[owner]` Set `env.RESCUE_BRAIN=model` (an `app_settings` row; `deploy.mjs` does not sync `.env`; read at boot by `applyEnvOverrides`, so restart after).
- `[owner]` OpenRouter account: confirm credit for launch (about 3 × the expected month at the scored $/thesis), that the platform key's own limit is above it, and in the account's privacy settings that prompt logging is off. The per-request `zdr` routing holds regardless.
- `[agent]` After the host trial (item 48), compare the host's `rescue_versions.cost` of the two trial theses with the scored $/thesis; a gap over 50% stops the switch until explained.

Done when the checklist names every key above and nothing in it says "M7" as future work.

---

## The model shortlist (from the live catalogue, 2026-11-08)

Read from OpenRouter's public `models` list and `endpoints/zdr` list on 2026-11-08. Every row takes images and structured outputs and has at least one zero-retention endpoint. Prices are per million tokens and move; `score-brain.ts models` re-reads them before every run. Arabic quality and JSON discipline are unknown until scored.

| # | Model | $ in / out | Zero-retention endpoints | Note |
|---|---|---|---|---|
| 1 | `deepseek/deepseek-v4.1-flash` | 0.051 / 0.567 | many | Cheapest. Its image input is listed but untested here. |
| 2 | `mistralai/mistral-small-3.2-24b-instruct` | 0.075 / 0.20 | Mistral, DeepInfra, Parasail, Venice | Small; likely only the small tasks. |
| 3 | `meta-llama/llama-4-scout` | 0.10 / 0.30 | DeepInfra, Google | The chips' model on Workers AI (good Arabic there), but it wrote JS-style objects for the chips: watch `not-json`. |
| 4 | `anthropic/claude-haiku-5.5` | 0.10 / 0.50 | Google, Amazon Bedrock | Explicit prompt caching already works in this repo for Claude on OpenRouter. |
| 5 | `openai/gpt-5.6-luna` | 0.20 / 1.20 | Azure | The repo's current OpenRouter default. |
| 6 | `qwen/qwen3-vl-235b-a22b-instruct` | 0.21 / 1.90 | DeepInfra, Parasail, Venice | A strong open vision model. |
| 7 | `google/gemini-3.1-flash-lite` | 0.25 / 1.50 | Google | |
| 8 | `openai/gpt-5-mini` | 0.25 / 2.00 | Azure | Reasons by default: output tokens include reasoning; score with `--reasoning low`. |
| 9 | `google/gemini-3.5-flash-lite` | 0.30 / 2.50 | Google | |
| ref | `anthropic/claude-sonnet-5.5` | 2.00 / 10.00 | Amazon Bedrock, Google | The ceiling: scored once on the accepted theses to show the bars are reachable by a model at all. Never the default pick. |

Left out: `google/gemini-2.5-flash-lite` (the composer chips' model) and `google/gemini-2.5-flash`, `qwen/qwen3.5-flash`, `qwen/qwen3.8-flash`: no zero-retention endpoint on 2026-11-08. The `:batch` variants (about half price) are left out of v1 (Open question 13).

**Rough cost per thesis**, for a typical thesis of about 950 blocks and 150 pages: map about 200 k tokens in and 28 k out, Review about 250 k in per round, the small tasks about 10 k. That is roughly $0.05 to $0.10 on rows 1 to 4, $0.15 to $0.30 on rows 5 to 9, and about $1.50 to $2 on the reference, before caching. The `estimate` command replaces these with the corpus's real sizes.

---

## Privacy (what the repo supports, honestly)

- **What exists today:** nothing in `src/lib/ai/` asks a provider for zero retention or no training. `providerRoutingParam` only orders upstreams for caching. The Cloudflare gateway logs request bodies by default and the code sends no header to stop it. OpenRouter's account-level privacy settings are not read or set by code.
- **What M7 adds, for the rescue brain only:** every request carries `provider.zdr: true` and `provider.data_collection: "deny"` (B-2). OpenRouter then routes only to endpoints that keep no prompt and do not train, and answers 404 when none serves the model, which the brain turns into a wait (B-6) and the scorer into a refused model. Task 8 tests that the fields are sent; Task 19 step 3 shows the 404 path. Whether a given upstream honours its policy is OpenRouter's and the upstream's word, not something this repo can verify.
- **Corpus text reaches a provider only through `score-brain.ts`**, on its own key, from this Mac. No other script or test does: tests use invented text, and the guard keeps every other lab file model-free.
- **Never logged:** thesis text, answers' text, provider error messages. `calls.jsonl`, `ai_usage_log` and stdout carry ids, kinds, models, tokens, dollars, milliseconds and outcome codes. Raw responses (`--record`) and `gold/cover.json` hold names and stay under the gitignored `lab/`.
- **Images:** pages are sent as data URLs inside the request (no upload, no URL a provider could fetch later).
- **Production:** a student's thesis goes to the pinned model under the same routing. Nothing else in the rescue path changes. The Support and dashboard views already carry counts only.

---

## Budget

- **The scorer's cap** is `--max-usd`, required for live runs, enforced before every call on estimates and settled on OpenRouter's reported cost (Task 13). In-flight calls can pass it by at most `callsInFlight` × the largest call (about $0.20 on the reference model). The real ceiling is the scoring key's own credit limit on OpenRouter (B-12).
- **An estimate before every run** (`estimate`, and `run` prints it first and stops without `--yes` when it passes the cap).
- **Proposed M7 budget:** $40 in all, at most $10 per `run`. Rough sizing from the shortlist's prices and the corpus's size (about 19 200 blocks for map, 12 review fixtures): one full pass of map, ask and review costs about $1 to $5 per model for rows 1 to 9, and about $27 for the reference; the reference is therefore run on the 7 accepted theses only (about $10). Early stopping (Task 17) means most models are never scored on every group.
- **In production**, the per-version cap (B-8) bounds any single version; the scored p95 sets its value.

---

## Bar check and pinning

1. `report` prints `bars:` per task group for each model row. A group is pinned to the **cheapest row that passes it** (mean $/thesis on the corpus it ran). Map and ask are one group decision: map's model also answers ask unless a cheaper model passes ask alone with map's roles as input.
2. Task 18 checks the combination end to end; "all Prove checks pass" is only ever checked there.
3. The pins are seven pairs of settings rows plus the `rescue.brain_*` limits (Task 19 locally, Task 20's checklist lines on cloud). No model id is written in code. Changing a pin later means re-running Tasks 17 and 18 for the groups it touches; the scores document is updated in the same commit as any note about it.

---

## Done when

| Must hold | Checked by |
|---|---|
| `RESCUE_BRAIN=model` answers every brain task through the `Brain` interface; nothing under `src/lib/rescue/` reaches a model | Tasks 5, 8, 9; both guards |
| An unpinned task, a missing key, no credit, no zero-retention endpoint, a provider outage, an invalid answer and the spend cap all make the job wait; the runner ends the wait | Tasks 2, 5, 8; Task 19 step 3 |
| Every model call is in `ai_usage_log` under the version's turn, and the version's cost names tokens, dollars, models, brain tasks and the prompt version | Tasks 8, 11; Task 19 step 2 |
| The scorer's gold dry run gives 100% and $0 on the whole corpus; replay reproduces a recorded run | Task 15 |
| A pinned model clears every bar on every thesis that has a key, and the end-to-end proof passes on the accepted theses | Tasks 17, 18; `docs/rescue-v2-brain-scores.md` |
| `npx tsc --noEmit` and `npx vitest run --testTimeout=60000` green in `~/kwill-server` (local DB) | gate |

---

## Open questions (the owner delegated; each has a recommendation)

1. **Which provider?** Recommendation: **OpenRouter only** (B-1). Cloudflare can follow later with `cf-aig-collect-log: false`, an exact model id instead of a dynamic route, and a price table for the cost record.
2. **Zero retention required, or only "no training"?** Recommendation: **require zero retention** (`zdr: true` and `data_collection: "deny"`). It drops the 2.5-generation Gemini flash models and two Qwen flash models; nine candidates remain.
3. **The 97% bar on small theses.** One structural error in a thesis with 20 structural blocks is 95%. Recommendation: per thesis ≥ 97% **or** at most one structural error when it has fewer than 34 structural blocks; pooled ≥ 97% over the corpus; **zero destructive errors** anywhere (a wrong typed contents or junk deletes the student's lines) and the format right on every thesis.
4. **"Only on truly ambiguous blocks".** Recommendation: a question is justified when the model's role on that block is wrong or Claude's own confidence there was below 0.7; at most 5 questions and at most 1 unjustified per thesis. The report also counts structural errors nobody asked about; they are what the student never gets a chance to fix.
5. **"Review finds Claude's defects".** Recommendation: **100% of the grave kinds** (words under a float, text over text, off the page, unreadable, missing object, damaged cover) and **≥ 85% of all defects pooled**, same page and kind (one page off for the four span kinds). Extra issues are adjudicated by Claude and never fail a model; real ones join the key.
6. **One model or one per task?** Recommendation: **per task group** (7 features), expecting two models in the end: a vision model for map, review, read_cover and read_guide, and the cheapest model that passes for ask, order_parts and parse_note.
7. **Escalate to a stronger model after failed repairs?** Recommendation: **build it, leave it unset**; set it only if the scored `repairs` column shows failures the pinned model cannot fix in two turns.
8. **Per-version spend cap.** Recommendation: **3 × the scored p95 $/thesis**, rounded up to the next 50 cents; 300 cents until scored.
9. **Does a per-account provider pin (`user-provider.ts`) apply to rescue calls?** (checklist item 2) Recommendation: **no** (B-9).
10. **May staff override the rescue prompts from the dashboard?** Recommendation: **no**; the system-prompt setting is ignored for `rescue.brain.*` (B-4). A prompt change is a code change, re-scored.
11. **A partial map answer: `brain_failed` or a spent attempt?** (checklist item 2) Recommendation: **neither at first**: a repair turn naming the missing keys, then an invalid-answer wait (B-5, B-6), and a smaller `rescue.brain_map_window` if the scores show it. Only the runner's existing limits ever fail it.
12. **The scoring key.** Recommendation: the owner creates a **dedicated OpenRouter key with a $40 credit limit**, kept in the shell environment as `RESCUE_SCORE_OPENROUTER_KEY`, never in `app_settings` or `.env`.
13. **`:batch` variants** (about half price, slower, unknown latency). Recommendation: **not in v1**; the brain-wait limit is 6 h and a student waits on map. Revisit with real latency data after launch.
14. **Seeded synthetic defects for Review** (break a clean rescued file on purpose, render it, check the model finds it). Recommendation: **not now**: `defects.jsonl` already gives 113 real defects over 12 usable runs. Revisit if the review set stays under 100 defects after M3 resumes.
15. **Map windows see 120 blocks and 3 neighbours; Claude kept the whole thesis in mind across windows.** Recommendation: add an outline digest to each map window (one line per likely heading of the whole thesis) **only if** the scores show heading-level errors across window edges; it changes the task for both brains and needs its own replay check.
16. **Should the free diagnosis use a cheaper map model than the paid repair?** Recommendation: **no**; the diagnosis is built on the map, and a different map after payment would change what the student was shown.
