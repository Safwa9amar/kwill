# Kwill Web — Interactive Frames, Chat Modes, and Brand (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student on the web can choose how the assistant behaves (Ask / Plan / Assist / Agent), answer its questions and approval requests inline, execute a proposed plan and watch its steps tick off, stop a runaway reply, and see Kwill's real brand orange instead of the staff console's indigo.

**Architecture:** Four new control-frame kinds are added to the existing incremental parser and stream consumer, which every new endpoint reuses unchanged — `/confirm-action`, `/cancel-action`, and `/execute-plan` all return the identical chunked stream `/api/chat/stream` already returns. `ChatPanel` grows one shared `runTurn` helper that all four entry points (send, approve, cancel, execute-plan) drive, so streaming, error handling, and quota handling exist once. Plan cards are reconstructed from persisted message history by a new pure extractor; confirm and ask cards live only in live-stream state.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `lucide-react` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-kwill-web-interactive-frames-modes-design.md`

---

## Read this before Task 1

**Gate after every file you touch:**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

`npm test` after every TDD task (4, 6) and again at the very end (Task 16).

### Facts already verified against source — do not re-research, but do read a file before you modify it

**Server contracts (from `~/modakerati-server`):**

- Modes are `"ask" | "plan" | "assist" | "agent"`, default `"assist"`. There is **no** endpoint to set a mode. It is changed by including a `mode` field in the `POST /api/chat/stream` body; the server resolves it (request wins over stored) and writes it back to `chatThreads.mode` as a side effect. `ThreadSummary.mode` already carries the current value and is already in this repo's types.
- `[[MODK_CONFIRM]]` payload: `{kind:"confirmAction", actionId, toolName, preview:{kind, data, text}}`. **The turn ends at this frame.** Stripped before persistence — ephemeral.
- `POST /api/chat/confirm-action` body `{actionId}` and `POST /api/chat/cancel-action` body `{actionId}` (a *separate endpoint*, not an `approved:false` flag) both return the **same chunked stream** as `/api/chat/stream`. A double-tap returns `404 {"error":"Action not found or already handled"}`.
- `[[MODK_ASK]]` payload: `{question, options: string[], allowFreeText: boolean, previews?: {id,label,description,previewUrl}[]}`. **The turn ends at this frame.** Stripped before persistence — ephemeral. **Answering needs no endpoint** — it is an ordinary next message carrying the chosen label.
- `[[MODK_PLAN]]` payload: `{id, title, steps: {title, detail?}[]}`. **Persisted.**
- `[[MODK_PLAN_STEP]]` payload: `{planId, index (0-based), note?}`. **Persisted.** Ticks land in *different messages* than the card, correlate by `planId`, and are neither dense nor ordered.
- `POST /api/chat/execute-plan` body `{threadId, planId}` — **both** required — returns the same chunked stream. It **costs a message** and can return `402 {code:"quota_exhausted"}`.
- `POST /api/chat/stop` body `{threadId, turnId?}` returns `{ok:true, stopped:number}`; `stopped: 0` is normal, not an error.
- Server-side validation tolerance to mirror: a plan is valid iff `id` is a string and `Array.isArray(steps)`; a step is valid iff `planId` is a non-empty string and `Number.isInteger(index) && index >= 0`. Skip malformed frames, never throw.

**About the `MODK_PLAN` / `MODK_PLAN_STEP` prefix collision.** `[[MODK_PLAN]]` is a string prefix of `[[MODK_PLAN_STEP]]`, which broke a naive parser in the mobile app. Be precise about where the hazard actually applies:

- **The incremental `ControlFrameParser` is already immune.** It reads the whole opening tag up to `]]` and derives the close tag from it, so `MODK_PLAN_STEP` yields the frame name `MODK_PLAN_STEP` and never collides. No change needed for this.
- **The new regex-based extractor in Task 6 must include the literal `]]` in its opener.** `/\[\[MODK_PLAN\]\]/` cannot match `[[MODK_PLAN_STEP]]` because the character after `MODK_PLAN` is `_`, not `]`. That is what makes it safe — and Task 6 has an explicit test proving it.

**Repo facts:**

- `src/components/ui/icon.tsx` maps kebab-case names to `lucide-react` components in a hand-maintained `ICONS: Record<string, LucideIcon>` object. Three icons this plan needs are missing (`message-circle-question`, `clipboard-list`, `zap`), plus `square` for the stop button. An unknown name renders a neutral fallback dot rather than crashing, so a missed icon is a silent visual bug, not an error.
- `src/app/globals.css` defines the console palette on `:root, [data-theme="dark"]` and `[data-theme="light"]`, re-exposed to Tailwind via `@theme inline` (`--color-primary: var(--primary)`). Because `@theme inline` keeps the `var()` indirection, redefining `--primary` on a scoped ancestor cascades correctly — the `.landing` block already relies on exactly this to override `--border`.
- Existing chat components take translated strings as props (`ThreadHistory`). **This plan deviates for the new cards:** `ModeChip`, `ConfirmCard`, `AskCard`, and `PlanCard` call `useTranslations("chat")` themselves. They need 6–8 strings each, and prop-drilling ~25 label props through `MessageList` would be worse than a second consumer of a namespace `ChatPanel` already uses. This is a deliberate, contained exception.
- Translations are reused **verbatim** from the mobile app (`~/modakerati/locales/*.json`), which already ships every string this plan needs under `chatModes.*`, `confirmAction.*`, and `chat.*`. Do not invent new wording.

### Ephemeral cards are not a bug

`MODK_CONFIRM` and `MODK_ASK` are stripped by the server before a message is persisted. They exist only in the live stream, so **their cards legitimately disappear on page reload.** This is by design, is the same behaviour the mobile app has, and must not be "fixed". The pending action itself survives 30 minutes server-side, and approving after expiry degrades gracefully (the server re-proposes rather than erroring).

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/features/chat/lib/chat-modes.ts` | The `ChatMode` union and the four modes' metadata (value, icon name, i18n key). Pure data, no React. |
| `src/features/chat/lib/plan-frames.ts` | Extract plan and plan-step frames from persisted message content; fold ticks by `planId`. Pure. |
| `src/features/chat/lib/plan-frames.test.ts` | Its tests. |
| `src/features/chat/components/ModeChip.tsx` | Mode pill + popover. |
| `src/features/chat/components/ConfirmCard.tsx` | Approve / Cancel card for one pending destructive action. |
| `src/features/chat/components/AskCard.tsx` | Question, option chips, optional previews, dismiss. |
| `src/features/chat/components/PlanCard.tsx` | Plan title, steps with tick state, Execute or historical rendering. |

**Modified**

| Path | Change |
|---|---|
| `src/app/globals.css` | Add the `.workspace` scoped brand palette. |
| `src/app/app/(workspace)/layout.tsx` | Add the `workspace` class. |
| `src/components/ui/icon.tsx` | Add 4 icons. |
| `src/features/chat/lib/control-frames.ts` | 4 new recognized frame kinds + their payload types. |
| `src/features/chat/lib/control-frames.test.ts` | Tests for the new kinds. |
| `src/features/chat/lib/consume-chat-stream.ts` | 4 new handlers. |
| `src/lib/api/student-browser.ts` | `mode` + `AbortSignal` on `postChatStream`; 4 new endpoint callers. |
| `src/features/chat/locales/{en,fr,ar}.json` | New strings. |
| `src/features/chat/components/Composer.tsx` | Mode chip slot + stop button. |
| `src/features/chat/components/MessageList.tsx` | Pass plan data through. |
| `src/features/chat/components/MessageBubble.tsx` | Render plan cards for its message. |
| `src/features/chat/components/ChatPanel.tsx` | The `runTurn` helper and all new state. |
| `src/features/chat/index.ts` | Export `ChatMode`. |

---

### Task 1: Scoped brand palette for `/app`

The student-facing tree currently inherits the staff console's indigo. Give it Kwill's orange without touching `/d`.

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/app/(workspace)/layout.tsx`

- [ ] **Step 1: Add the scoped palette to `globals.css`**

Read the file first and find the `.landing` block (it begins with a `/* ===... Marketing landing page (/) — a SCOPED palette ... */` comment). Insert this **immediately before** that `.landing` comment block, so the two scoped-palette sections sit together:

```css
/* ============================================================================
   Student workspace (/app) — the console palette, rebranded.
   ----------------------------------------------------------------------------
   The staff console runs on indigo (--primary: #5C6BFF). The student-facing
   app is the same product a student knows from their phone, and must wear the
   same orange (#F59433 — see ~/modakerati/constants/colors.ts, `brand`).

   Only the two BRAND tokens are overridden. --accent and every semantic colour
   (--success #33D6A6, --warning #FF9933, --danger #FF5959) already match the
   mobile app's values exactly, and backgrounds/text/borders were derived from
   it too — so redefining them here would be a no-op that later drifts.

   This works because @theme inline keeps the var() indirection
   (--color-primary: var(--primary)), so a scoped redefinition cascades — the
   same mechanism .landing uses below to override --border.
   ========================================================================== */
.workspace {
  --primary: #F59433;
  --primary-light: #FFB166;
}

[data-theme="light"] .workspace {
  /* Light mode needs a DARKER hover/secondary, not a lighter one — the mobile
     app makes the same inversion (brandPrimaryLight is #FFB166 dark / #C2670C
     light), because a lighter orange on a white ground loses all contrast. */
  --primary-light: #C2670C;
}
```

- [ ] **Step 2: Apply the class in the workspace layout**

In `src/app/app/(workspace)/layout.tsx`, change the returned wrapper:

```tsx
  return <div className="workspace min-h-screen bg-background">{children}</div>;
```

- [ ] **Step 3: Verify it compiles and builds**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npm run build
```

Expected: both PASS. The build is the real gate for a CSS change — it confirms Tailwind still resolves every token.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css "src/app/app/(workspace)/layout.tsx"
git commit -m "feat(chat): brand the student workspace orange, scoped away from /d"
```

---

### Task 2: Add the four missing icons

**Files:**
- Modify: `src/components/ui/icon.tsx`

- [ ] **Step 1: Add the imports**

Read the file. It imports lucide components in one alphabetical-ish block ending with `X,` and `type LucideIcon,`. Add these four names into that import block:

```
  ClipboardList,
  MessageCircleQuestion,
  Square,
  Zap,
```

- [ ] **Step 2: Add the map entries**

In the `ICONS: Record<string, LucideIcon>` object, add these four entries (placing them next to the existing `sparkles: Sparkles,` entry keeps the mode icons together):

```ts
  "message-circle-question": MessageCircleQuestion,
  "clipboard-list": ClipboardList,
  zap: Zap,
  square: Square,
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS. If a name does not exist in this version of `lucide-react`, the import fails at build time — in that case check the installed version's exports and substitute the nearest real name rather than leaving a broken import.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/icon.tsx
git commit -m "feat(ui): add mode and stop icons to the icon map"
```

---

### Task 3: Chat-mode metadata

**Files:**
- Create: `src/features/chat/lib/chat-modes.ts`

- [ ] **Step 1: Read the mobile original**

```bash
cat ~/modakerati/lib/chat-modes.ts
```

This web file is a **port of that one**, keeping its exports and names so the two clients read alike. The only deliberate differences: icons are Icon-map **name strings** here (the web `Icon` component takes a kebab-case name) rather than imported `lucide-react-native` components, and the i18n key helpers return keys relative to the web bundle's `chat` namespace (`modes.ask.label`) rather than the mobile's top-level `chatModes.ask.label`.

- [ ] **Step 2: Write the module**

Pure data with no React import, so both client components and `src/lib/api/student-browser.ts` can import it freely.

```typescript
// src/features/chat/lib/chat-modes.ts

// Ported from ~/modakerati/lib/chat-modes.ts, which is itself mirrored from the
// server registry (~/modakerati-server/src/lib/ai/chat-modes.ts). Data only —
// what a mode DOES is decided server-side; the client only shows it and sends
// it. Keep the four values in sync by hand.
export type ChatMode = "ask" | "plan" | "assist" | "agent";

/** Display order in the picker: least to most autonomous. */
export const CHAT_MODES: ChatMode[] = ["ask", "plan", "assist", "agent"];
export const DEFAULT_CHAT_MODE: ChatMode = "assist";

/** Names in the ui Icon map (src/components/ui/icon.tsx) — the web counterpart
 *  of the mobile file's CHAT_MODE_ICONS, which holds lucide-react-native
 *  components directly. Same four icons. */
export const CHAT_MODE_ICONS: Record<ChatMode, string> = {
  ask: "message-circle-question",
  plan: "clipboard-list",
  assist: "sparkles",
  agent: "zap",
};

/** i18n key for a mode's short label (the chip) and its one-line description
 *  (the picker). Relative to the `chat` namespace, unlike the mobile app's
 *  top-level `chatModes.*` — the web bundle nests everything under `chat`. */
export const chatModeLabelKey = (m: ChatMode) => `modes.${m}.label`;
export const chatModeHintKey = (m: ChatMode) => `modes.${m}.hint`;

export function isChatMode(v: unknown): v is ChatMode {
  return v === "ask" || v === "plan" || v === "assist" || v === "agent";
}

/** A thread's mode, tolerating a server that returns none or an unknown value —
 *  the same tolerance the server itself applies. */
export function chatModeOf(value: unknown): ChatMode {
  return isChatMode(value) ? value : DEFAULT_CHAT_MODE;
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/lib/chat-modes.ts
git commit -m "feat(chat): chat-mode union and picker metadata, ported from the app"
```

---

### Task 4: Teach the control-frame parser four new kinds (TDD)

**Files:**
- Modify: `src/features/chat/lib/control-frames.ts`
- Modify: `src/features/chat/lib/control-frames.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these to the existing `describe("ControlFrameParser", ...)` block in `src/features/chat/lib/control-frames.test.ts`, just before its closing `});`. Leave every existing test untouched.

```typescript
  it("parses a MODK_CONFIRM frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = {
      kind: "confirmAction",
      actionId: "a1",
      toolName: "replace_text",
      preview: { kind: "replace_text", data: { count: 12 }, text: "Replace 12 occurrences" },
    };
    expect(p.push(`[[MODK_CONFIRM]]${JSON.stringify(payload)}[[/MODK_CONFIRM]]`)).toEqual([
      { type: "confirm", payload },
    ]);
  });

  it("parses a MODK_ASK frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = { question: "Which style?", options: ["APA", "MLA"], allowFreeText: true };
    expect(p.push(`[[MODK_ASK]]${JSON.stringify(payload)}[[/MODK_ASK]]`)).toEqual([
      { type: "ask", payload },
    ]);
  });

  it("parses a MODK_PLAN frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = { id: "p1", title: "Fix chapter 2", steps: [{ title: "Rewrite intro" }] };
    expect(p.push(`[[MODK_PLAN]]${JSON.stringify(payload)}[[/MODK_PLAN]]`)).toEqual([
      { type: "plan", payload },
    ]);
  });

  it("parses a MODK_PLAN_STEP frame without confusing it for a MODK_PLAN frame", () => {
    // [[MODK_PLAN]] is a string prefix of [[MODK_PLAN_STEP]]. This parser reads
    // the whole tag up to "]]" so it is structurally immune, but the mobile
    // client was bitten by a naive prefix check — pin the behaviour here.
    const p = new ControlFrameParser();
    const payload = { planId: "p1", index: 0, note: "done" };
    expect(p.push(`[[MODK_PLAN_STEP]]${JSON.stringify(payload)}[[/MODK_PLAN_STEP]]`)).toEqual([
      { type: "planStep", payload },
    ]);
  });

  it("emits a plan and its step in order when both arrive in one chunk", () => {
    const p = new ControlFrameParser();
    const plan = { id: "p1", title: "T", steps: [{ title: "s" }] };
    const step = { planId: "p1", index: 0 };
    expect(
      p.push(
        `[[MODK_PLAN]]${JSON.stringify(plan)}[[/MODK_PLAN]]text[[MODK_PLAN_STEP]]${JSON.stringify(step)}[[/MODK_PLAN_STEP]]`,
      ),
    ).toEqual([
      { type: "plan", payload: plan },
      { type: "text", text: "text" },
      { type: "planStep", payload: step },
    ]);
  });

  it("still strips a genuinely unknown frame kind with no event", () => {
    const p = new ControlFrameParser();
    expect(p.push("x[[MODK_TOOL]]{}[[/MODK_TOOL]]y")).toEqual([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/control-frames.test.ts
```

Expected: FAIL — the 5 new frame tests get `[]` instead of an event (the frames are currently stripped as unknown). The "unknown frame kind" test passes already.

- [ ] **Step 3: Add the payload types and event variants**

In `src/features/chat/lib/control-frames.ts`, add these interfaces immediately after the existing `TitlePayload` interface:

```typescript
export interface ConfirmPreview {
  kind: string;
  /** Free-form per-tool detail. Rendered only via `text` — nothing reads
   *  individual keys, so it stays deliberately untyped. */
  data: Record<string, unknown>;
  /** Ready-to-display line, already scrubbed of block indices server-side. */
  text: string;
}

export interface ConfirmPayload {
  kind: "confirmAction";
  actionId: string;
  toolName: string;
  preview: ConfirmPreview;
}

export interface AskPreview {
  id: string;
  label: string;
  description: string;
  /** Server-relative path. Needs the access token appended as a query param
   *  before use in an <img src> — see AskCard. */
  previewUrl: string;
}

export interface AskPayload {
  question: string;
  options: string[];
  allowFreeText: boolean;
  previews?: AskPreview[];
}

export interface PlanStep {
  title: string;
  detail?: string;
}

export interface PlanPayload {
  id: string;
  title: string;
  steps: PlanStep[];
}

export interface PlanStepPayload {
  planId: string;
  /** 0-based. Ticks are neither dense nor ordered — look steps up by this
   *  index, never assume a completed prefix. */
  index: number;
  note?: string;
}
```

Then extend the `ControlFrameEvent` union to:

```typescript
export type ControlFrameEvent =
  | { type: "text"; text: string }
  | { type: "think"; text: string }
  | { type: "docChanges"; payload: DocChangesPayload }
  | { type: "title"; payload: TitlePayload }
  | { type: "confirm"; payload: ConfirmPayload }
  | { type: "ask"; payload: AskPayload }
  | { type: "plan"; payload: PlanPayload }
  | { type: "planStep"; payload: PlanStepPayload };
```

- [ ] **Step 4: Dispatch the new kinds**

Replace the `const RECOGNIZED = new Set(["THINK", "DOCCHANGES", "TITLE"]);` line with:

```typescript
// Frame kinds carrying a JSON payload, mapped to the event type each becomes.
// THINK is absent deliberately — it carries plain text, not JSON, and is
// handled separately below. Anything not listed here (MODK_TOOL, MODK_IMG, or
// a future kind) is stripped with no event.
// The value type deliberately excludes "text"/"think" — those two are not
// JSON frames, and narrowing here is what lets the `as ControlFrameEvent`
// cast below stay sound (every listed variant genuinely carries a `payload`).
const JSON_FRAME_EVENTS: Record<
  string,
  "docChanges" | "title" | "confirm" | "ask" | "plan" | "planStep"
> = {
  DOCCHANGES: "docChanges",
  TITLE: "title",
  CONFIRM: "confirm",
  ASK: "ask",
  PLAN: "plan",
  PLAN_STEP: "planStep",
};
```

Then replace the whole `if (kind === "THINK") { ... }` block — from `if (kind === "THINK") {` down to and including the closing `}` of the `else if (RECOGNIZED.has(kind))` branch, plus its trailing comment — with:

```typescript
      if (kind === "THINK") {
        events.push({ type: "think", text: unescapeStreamedSurrogates(rawContent) });
      } else {
        const eventType = JSON_FRAME_EVENTS[kind];
        if (eventType) {
          try {
            const payload = JSON.parse(rawContent);
            // The frame kind determines the payload type; the parser trusts the
            // server's shape rather than re-validating it here. Consumers that
            // need tolerance (plan-frames.ts) validate at their own boundary.
            events.push({ type: eventType, payload } as ControlFrameEvent);
          } catch {
            // Malformed JSON from a frame expected to be JSON — drop it
            // silently rather than throw and blank the panel.
          }
        }
        // Anything else (MODK_TOOL, MODK_IMG, a future kind) is stripped here
        // with no event.
      }
```

Finally, update the class docstring's stale paragraph. Replace:

```
 * Unrecognized frame kinds (MODK_ASK, MODK_CONFIRM, MODK_TOOL, and anything
 * this parser doesn't name) are stripped with no event — the safe default,
 * matching how the mobile client already treats an unknown frame.
```

with:

```
 * Unrecognized frame kinds (MODK_TOOL, MODK_IMG, and anything this parser
 * doesn't name) are stripped with no event — the safe default, matching how
 * the mobile client already treats an unknown frame.
 *
 * Note on MODK_PLAN vs MODK_PLAN_STEP: the former is a string prefix of the
 * latter, which broke a naive prefix check in the mobile client. This parser
 * is structurally immune because it reads the entire opening tag up to "]]"
 * and derives the close tag from it, so the two never collide.
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/control-frames.test.ts
```

Expected: PASS, 20/20 (14 existing + 6 new).

- [ ] **Step 6: Verify the whole suite and types**

```bash
cd ~/modakerati-dashboard && npm test && npx tsc --noEmit
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/chat/lib/control-frames.ts src/features/chat/lib/control-frames.test.ts
git commit -m "feat(chat): parse CONFIRM, ASK, PLAN and PLAN_STEP control frames"
```

---

### Task 5: Route the new frames through the stream consumer

**Files:**
- Modify: `src/features/chat/lib/consume-chat-stream.ts`

- [ ] **Step 1: Add the handlers**

Read the file. Change the import line to pull in the four new payload types:

```typescript
import {
  ControlFrameParser,
  type ControlFrameEvent,
  type DocChangesPayload,
  type TitlePayload,
  type ConfirmPayload,
  type AskPayload,
  type PlanPayload,
  type PlanStepPayload,
} from "./control-frames";
```

Add four optional handlers to `ChatStreamHandlers`, after the existing `onTitle`:

```typescript
  /** The turn ENDS at a confirm frame — the server is waiting for the student
   *  to approve or cancel via /confirm-action or /cancel-action. */
  onConfirm?: (payload: ConfirmPayload) => void;
  /** The turn ENDS at an ask frame. Answering is an ordinary next message
   *  carrying the chosen option's label — there is no ask endpoint. */
  onAsk?: (payload: AskPayload) => void;
  onPlan?: (payload: PlanPayload) => void;
  onPlanStep?: (payload: PlanStepPayload) => void;
```

Add four branches to `dispatchEvents`, after the existing `onTitle` branch:

```typescript
      else if (event.type === "confirm") handlers.onConfirm?.(event.payload);
      else if (event.type === "ask") handlers.onAsk?.(event.payload);
      else if (event.type === "plan") handlers.onPlan?.(event.payload);
      else if (event.type === "planStep") handlers.onPlanStep?.(event.payload);
```

Also update the stale docstring reference. Replace `(POST /stream today; Plan 2b's /confirm-action and /cancel-action reuse this unchanged)` with:

```
 * (POST /stream, /confirm-action, /cancel-action, and /execute-plan — all
 * four return the identical stream shape).
```

- [ ] **Step 2: Verify types and the existing consumer tests still pass**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npx vitest run src/features/chat/lib/consume-chat-stream.test.ts
```

Expected: both PASS, 8/8 tests. The new handlers are optional, so no existing caller breaks.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/lib/consume-chat-stream.ts
git commit -m "feat(chat): route confirm/ask/plan frames through the stream consumer"
```

---

### Task 6: Extract plan cards from persisted history (TDD)

Plan frames survive in `chat_messages.content`, so a reloaded thread must rebuild its cards from message text. This is the highest-risk pure logic in the plan.

**Files:**
- Create: `src/features/chat/lib/plan-frames.ts`
- Test: `src/features/chat/lib/plan-frames.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/chat/lib/plan-frames.test.ts
import { describe, it, expect } from "vitest";
import { parsePlanFrames, parsePlanStepFrames, extractPlanState, isPlanExecuted } from "./plan-frames";
import type { ChatMessage } from "../types";

function msg(id: string, content: string, role = "assistant"): ChatMessage {
  return { id, threadId: "t1", thesisId: null, role, content, searchText: null, createdAt: null };
}

const PLAN = { id: "p1", title: "Fix chapter 2", steps: [{ title: "Rewrite intro", detail: "Tighten it" }, { title: "Fix citations" }] };

describe("parsePlanFrames", () => {
  it("returns nothing for plain text", () => {
    expect(parsePlanFrames("just a normal reply")).toEqual([]);
  });

  it("extracts a plan frame's payload", () => {
    expect(parsePlanFrames(`here is the plan\n[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]]`)).toEqual([PLAN]);
  });

  it("does NOT mistake a MODK_PLAN_STEP frame for a plan", () => {
    // [[MODK_PLAN]] is a string prefix of [[MODK_PLAN_STEP]] — the regex is
    // only safe because its opener includes the literal "]]".
    const step = { planId: "p1", index: 0 };
    expect(parsePlanFrames(`[[MODK_PLAN_STEP]]${JSON.stringify(step)}[[/MODK_PLAN_STEP]]`)).toEqual([]);
  });

  it("skips a malformed plan instead of throwing", () => {
    expect(() => parsePlanFrames("[[MODK_PLAN]]not json[[/MODK_PLAN]]")).not.toThrow();
    expect(parsePlanFrames("[[MODK_PLAN]]not json[[/MODK_PLAN]]")).toEqual([]);
  });

  it("skips a plan missing its id or steps, mirroring the server's own tolerance", () => {
    expect(parsePlanFrames('[[MODK_PLAN]]{"title":"no id"}[[/MODK_PLAN]]')).toEqual([]);
    expect(parsePlanFrames('[[MODK_PLAN]]{"id":"p1","steps":"nope"}[[/MODK_PLAN]]')).toEqual([]);
  });

  it("defaults a missing title and missing steps entries rather than dropping the plan", () => {
    expect(parsePlanFrames('[[MODK_PLAN]]{"id":"p1","steps":[]}[[/MODK_PLAN]]')).toEqual([
      { id: "p1", title: "", steps: [] },
    ]);
  });
});

describe("parsePlanStepFrames", () => {
  it("extracts a step tick", () => {
    const step = { planId: "p1", index: 2, note: "done" };
    expect(parsePlanStepFrames(`[[MODK_PLAN_STEP]]${JSON.stringify(step)}[[/MODK_PLAN_STEP]]`)).toEqual([step]);
  });

  it("rejects a step with a non-integer or negative index", () => {
    expect(parsePlanStepFrames('[[MODK_PLAN_STEP]]{"planId":"p1","index":-1}[[/MODK_PLAN_STEP]]')).toEqual([]);
    expect(parsePlanStepFrames('[[MODK_PLAN_STEP]]{"planId":"p1","index":1.5}[[/MODK_PLAN_STEP]]')).toEqual([]);
  });

  it("rejects a step with an empty planId", () => {
    expect(parsePlanStepFrames('[[MODK_PLAN_STEP]]{"planId":"","index":0}[[/MODK_PLAN_STEP]]')).toEqual([]);
  });
});

describe("extractPlanState", () => {
  it("returns empty maps for a thread with no plans", () => {
    expect(extractPlanState([msg("m1", "hello")])).toEqual({ plansByMessageId: {}, ticksByPlanId: {} });
  });

  it("keys a plan by the message it came from", () => {
    const state = extractPlanState([msg("m1", `[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]]`)]);
    expect(state.plansByMessageId).toEqual({ m1: [PLAN] });
  });

  it("folds ticks that arrive in a LATER message than the plan card", () => {
    // The real shape of a thread: the card is in one assistant message, the
    // ticks land in subsequent ones. Correlation is by planId, never position.
    const state = extractPlanState([
      msg("m1", `[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]]`),
      msg("m2", '[[MODK_PLAN_STEP]]{"planId":"p1","index":0}[[/MODK_PLAN_STEP]]'),
      msg("m3", '[[MODK_PLAN_STEP]]{"planId":"p1","index":1}[[/MODK_PLAN_STEP]]'),
    ]);
    expect(state.plansByMessageId).toEqual({ m1: [PLAN] });
    expect(state.ticksByPlanId.p1.map((s) => s.index)).toEqual([0, 1]);
  });

  it("keeps out-of-order ticks without reordering or assuming a prefix", () => {
    const state = extractPlanState([
      msg("m1", `[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]]`),
      msg("m2", '[[MODK_PLAN_STEP]]{"planId":"p1","index":1}[[/MODK_PLAN_STEP]]'),
    ]);
    expect(state.ticksByPlanId.p1.map((s) => s.index)).toEqual([1]);
  });

  it("keeps two different plans' ticks apart", () => {
    const other = { id: "p2", title: "Other", steps: [{ title: "x" }] };
    const state = extractPlanState([
      msg("m1", `[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]]`),
      msg("m2", `[[MODK_PLAN]]${JSON.stringify(other)}[[/MODK_PLAN]]`),
      msg("m3", '[[MODK_PLAN_STEP]]{"planId":"p2","index":0}[[/MODK_PLAN_STEP]]'),
    ]);
    expect(state.ticksByPlanId.p1).toBeUndefined();
    expect(state.ticksByPlanId.p2.map((s) => s.index)).toEqual([0]);
  });

  it("handles a plan and its own tick inside one message", () => {
    const state = extractPlanState([
      msg("m1", `[[MODK_PLAN]]${JSON.stringify(PLAN)}[[/MODK_PLAN]][[MODK_PLAN_STEP]]{"planId":"p1","index":0}[[/MODK_PLAN_STEP]]`),
    ]);
    expect(state.plansByMessageId.m1).toEqual([PLAN]);
    expect(state.ticksByPlanId.p1.map((s) => s.index)).toEqual([0]);
  });
});

describe("isPlanExecuted", () => {
  it("is false when the plan has no ticks — an untouched card is an offer", () => {
    expect(isPlanExecuted("p1", {})).toBe(false);
    expect(isPlanExecuted("p1", { p1: [] })).toBe(false);
  });

  it("is true as soon as any tick names the plan", () => {
    expect(isPlanExecuted("p1", { p1: [{ planId: "p1", index: 0 }] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/plan-frames.test.ts
```

Expected: FAIL — `Cannot find module './plan-frames'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/chat/lib/plan-frames.ts
import type { PlanPayload, PlanStepPayload } from "./control-frames";
import type { ChatMessage } from "../types";

// MODK_PLAN and MODK_PLAN_STEP are the two frame kinds modakerati-server
// deliberately KEEPS in a persisted message's content (see plan-frames.ts
// there: "PERSISTED... do not add it to control-frames.ts stripOwnFrames").
// So a reloaded thread must rebuild its plan cards from message text, unlike
// MODK_CONFIRM/MODK_ASK which the server strips and which therefore only ever
// exist in a live stream.
//
// On the prefix hazard: "[[MODK_PLAN]]" is a string prefix of
// "[[MODK_PLAN_STEP]]", which broke a naive check in the mobile client. These
// regexes are safe because the opener includes the literal "]]" — the
// character after MODK_PLAN in a step frame is "_", not "]", so PLAN_RE
// cannot match a step frame. The test suite pins this.
const PLAN_RE = /\[\[MODK_PLAN\]\]([\s\S]*?)\[\[\/MODK_PLAN\]\]/g;
const PLAN_STEP_RE = /\[\[MODK_PLAN_STEP\]\]([\s\S]*?)\[\[\/MODK_PLAN_STEP\]\]/g;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extracts every well-formed plan card from one message's raw content.
 *  Validation mirrors the server's own tolerance exactly: a plan counts iff
 *  its `id` is a string and `steps` is an array. A malformed frame is skipped,
 *  never thrown — a half-streamed frame must not blank the panel. */
export function parsePlanFrames(content: string): PlanPayload[] {
  const plans: PlanPayload[] = [];
  for (const match of content.matchAll(PLAN_RE)) {
    const parsed = parseJson(match[1]) as Partial<PlanPayload> | null;
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.steps)) continue;
    plans.push({
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : "",
      steps: parsed.steps.map((step) => ({
        title: typeof step?.title === "string" ? step.title : "",
        ...(typeof step?.detail === "string" ? { detail: step.detail } : {}),
      })),
    });
  }
  return plans;
}

/** Extracts every well-formed step tick from one message's raw content.
 *  Validation mirrors the server: a non-empty string planId and a
 *  non-negative integer index. */
export function parsePlanStepFrames(content: string): PlanStepPayload[] {
  const steps: PlanStepPayload[] = [];
  for (const match of content.matchAll(PLAN_STEP_RE)) {
    const parsed = parseJson(match[1]) as Partial<PlanStepPayload> | null;
    if (!parsed) continue;
    if (typeof parsed.planId !== "string" || parsed.planId.length === 0) continue;
    if (!Number.isInteger(parsed.index) || (parsed.index as number) < 0) continue;
    steps.push({
      planId: parsed.planId,
      index: parsed.index as number,
      ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
    });
  }
  return steps;
}

export interface PlanState {
  /** Plans keyed by the message that carried them, so each card renders in
   *  its own place in the transcript. */
  plansByMessageId: Record<string, PlanPayload[]>;
  /** Ticks folded across the WHOLE thread by planId — a plan's ticks land in
   *  later messages than the card itself, so this cannot be per-message. */
  ticksByPlanId: Record<string, PlanStepPayload[]>;
}

/** Rebuilds all plan-card state for a thread from its raw (unstripped)
 *  messages. Must be called BEFORE stripPersistedFrames, which removes these
 *  frames from the markdown body for display — the two passes are
 *  complementary: strip for the body, extract for the cards. */
export function extractPlanState(messages: ChatMessage[]): PlanState {
  const plansByMessageId: Record<string, PlanPayload[]> = {};
  const ticksByPlanId: Record<string, PlanStepPayload[]> = {};

  for (const message of messages) {
    const plans = parsePlanFrames(message.content);
    if (plans.length > 0) plansByMessageId[message.id] = plans;

    for (const step of parsePlanStepFrames(message.content)) {
      (ticksByPlanId[step.planId] ??= []).push(step);
    }
  }

  return { plansByMessageId, ticksByPlanId };
}

/** The executed-vs-offered rule. There is NO server-side flag for this and no
 *  plan table — the one durable signal is whether any tick names the plan,
 *  which is the same inference modakerati-server itself uses in
 *  continue-turn.ts's findRunningPlan. A card with no ticks is an offer, not
 *  a job. (A plan executed but producing no ticks re-arms its button; that
 *  matches the mobile app and is accepted.) */
export function isPlanExecuted(
  planId: string,
  ticksByPlanId: Record<string, PlanStepPayload[]>,
): boolean {
  return (ticksByPlanId[planId]?.length ?? 0) > 0;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/plan-frames.test.ts
```

Expected: PASS, 17/17.

- [ ] **Step 5: Verify the whole suite and types**

```bash
cd ~/modakerati-dashboard && npm test && npx tsc --noEmit
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/lib/plan-frames.ts src/features/chat/lib/plan-frames.test.ts
git commit -m "feat(chat): extract plan cards and step ticks from persisted history"
```

---

### Task 7: Browser API — mode, abort, and the four new endpoints

**Files:**
- Modify: `src/lib/api/student-browser.ts`

- [ ] **Step 1: Add the type import**

Read the file. Add to its imports:

```typescript
import type { ChatMode } from "@/features/chat/lib/chat-modes";
```

- [ ] **Step 2: Extend `postChatStream` with `mode` and an abort signal**

Replace the existing `postChatStream` function (keep its JSDoc block, appending the two new paragraphs shown below) with:

```typescript
/**
 * POSTs to /api/chat/stream and returns the raw Response — the caller must
 * check `response.ok` before reading `response.body` as a stream, since a
 * failure (402 quota_exhausted, 409 continue_instead, etc.) comes back as
 * plain JSON, not a stream.
 *
 * The ONE exception to "check response.ok, never a throw": a missing/expired
 * session throws ChatStreamError(401, "not_signed_in") directly, before any
 * request is even sent — there's no Response to return in that case. A
 * caller that wraps the whole send in try/catch (as ChatPanel does) handles
 * both paths uniformly regardless; a caller that only checked `.ok` without
 * a surrounding try/catch would miss this one case.
 *
 * `mode` is how a chat mode is changed — there is no mode endpoint. The server
 * resolves it (request value wins over the thread's stored value) and persists
 * it back to chatThreads.mode as a side effect of the turn.
 *
 * `signal` lets the caller abort a turn locally. Aborting is only half of a
 * real stop: see stopChatTurn below.
 */
export async function postChatStream(
  body: { message: string; threadId: string; mode?: ChatMode },
  signal?: AbortSignal,
): Promise<Response> {
  const token = await getBrowserAccessToken();
  if (!token) throw new ChatStreamError(401, "not_signed_in", "Not signed in");

  return fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}
```

- [ ] **Step 3: Add the streaming-action helper and the three stream endpoints**

Append to the end of the file:

```typescript
/** Shared POST for the three endpoints that answer with the SAME chunked
 *  stream /api/chat/stream returns, so ChatPanel can drive all of them through
 *  one consumeChatStream call. Same contract as postChatStream: returns the
 *  raw Response, the caller checks `.ok`. */
async function postStreamingAction(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await getBrowserAccessToken();
  if (!token) throw new ChatStreamError(401, "not_signed_in", "Not signed in");

  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** Approves a destructive action the server parked behind a MODK_CONFIRM
 *  frame. The pending row is consumed atomically, so a double-tap gets
 *  404 "Action not found or already handled" — treat that as already-handled,
 *  not as an error worth showing. */
export async function confirmActionStream(actionId: string, signal?: AbortSignal): Promise<Response> {
  return postStreamingAction("/api/chat/confirm-action", { actionId }, signal);
}

/** Rejects a parked action. A SEPARATE endpoint, not an {approved:false} flag
 *  on confirm — and it streams a real continuation too, since the model is
 *  told the student declined and responds to that. */
export async function cancelActionStream(actionId: string, signal?: AbortSignal): Promise<Response> {
  return postStreamingAction("/api/chat/cancel-action", { actionId }, signal);
}

/** Runs a plan the model proposed. BOTH ids are required — the server re-reads
 *  the plan out of this thread's own stored messages by id and 404s on an
 *  unknown one, with no newest-plan fallback. Unlike confirm/cancel this
 *  COSTS a message and can answer 402 quota_exhausted. */
export async function executePlanStream(
  threadId: string,
  planId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return postStreamingAction("/api/chat/execute-plan", { threadId, planId }, signal);
}

/**
 * Server half of a stop. The client MUST abort its own fetch first and
 * synchronously — this call is fire-and-forget on top of that, never awaited
 * before updating the UI (the mobile app learned this the hard way: a hung
 * reader could otherwise leave the composer stuck forever).
 *
 * `{ok:true, stopped:0}` is a normal answer, not a failure — it just means no
 * live turn matched. Note the server treats a dropped socket as "disconnected"
 * rather than "aborted", so an incidental stream error must NOT call this.
 */
export async function stopChatTurn(threadId: string): Promise<void> {
  const token = await getBrowserAccessToken();
  if (!token) return;

  await fetch(`${BASE}/api/chat/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ threadId }),
  });
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/student-browser.ts
git commit -m "feat(chat): browser callers for confirm, cancel, execute-plan and stop"
```

---

### Task 8: Chat strings for modes, cards, and stop

Every string below is copied **verbatim** from the mobile app's own locale files (`~/modakerati/locales/*.json`, keys `chatModes.*`, `confirmAction.*`, `chat.*`), so the two clients read identically. Do not reword them.

**Files:**
- Modify: `src/features/chat/locales/en.json`
- Modify: `src/features/chat/locales/fr.json`
- Modify: `src/features/chat/locales/ar.json`

- [ ] **Step 1: `en.json`**

Replace the whole file with:

```json
{
  "chat": {
    "placeholder": "Ask the AI about your thesis…",
    "newConversation": "New conversation",
    "untitledConversation": "Untitled conversation",
    "loadingThreads": "Loading…",
    "thinking": "Thinking…",
    "quotaExhausted": "You've used all your messages for now. Try again later, or upgrade from the Kwill app.",
    "sendFailed": "Message failed to send.",
    "switchThreadFailed": "Couldn't switch conversations. Try again.",
    "newThreadFailed": "Couldn't start a new conversation. Try again.",
    "retry": "Retry",
    "stop": "Stop generating",
    "send": "Send",
    "modes": {
      "title": "How should the assistant work?",
      "ask": { "label": "Ask", "hint": "Answers your questions. Never changes the document." },
      "plan": { "label": "Plan", "hint": "Works out what it would do and shows you, before anything changes." },
      "assist": { "label": "Assist", "hint": "Edits your thesis, and asks before anything it cannot take back." },
      "agent": { "label": "Agent", "hint": "Does the whole job without stopping to ask. Undo it all in one tap." }
    },
    "confirm": {
      "title": "Kwill is about to make a big change to your thesis",
      "approve": "Approve",
      "cancel": "Cancel",
      "undoNote": "You can undo this later from History.",
      "failed": "Couldn't send your answer. Try again.",
      "deleteBlock": "Remove this from your thesis: «{snippet}»",
      "replaceText": "Replace {count} occurrence(s) of «{find}» with «{replace}»",
      "overwriteHeader": "Overwrite the page header with «{next}»",
      "overwriteFooter": "Overwrite the page footer with «{next}»",
      "make_thesis_ready": "Apply full RTL/Word normalization across the whole document",
      "front_matter_numbering": "Renumber the front-matter pages across the document",
      "insert_table_of_contents": "Delete the table of contents you typed by hand and replace it with an automatic one",
      "remove_table_of_contents": "Delete the table of contents you typed by hand"
    },
    "ask": {
      "dismiss": "Dismiss question",
      "typeYourOwn": "Type your own…"
    },
    "plan": {
      "execute": "Execute",
      "running": "Working…",
      "done": "Done",
      "askChanges": "Ask for changes",
      "stepDone": "Done",
      "stepRunning": "In progress",
      "failed": "Couldn't run the plan. Try again."
    }
  }
}
```

- [ ] **Step 2: `fr.json`**

Replace the whole file with:

```json
{
  "chat": {
    "placeholder": "Posez une question à l'IA sur votre mémoire…",
    "newConversation": "Nouvelle conversation",
    "untitledConversation": "Conversation sans titre",
    "loadingThreads": "Chargement…",
    "thinking": "Réflexion en cours…",
    "quotaExhausted": "Vous avez utilisé tous vos messages pour le moment. Réessayez plus tard, ou passez à un forfait supérieur depuis l'application Kwill.",
    "sendFailed": "Échec de l'envoi du message.",
    "switchThreadFailed": "Impossible de changer de conversation. Réessayez.",
    "newThreadFailed": "Impossible de démarrer une nouvelle conversation. Réessayez.",
    "retry": "Réessayer",
    "stop": "Arrêter la génération",
    "send": "Envoyer",
    "modes": {
      "title": "Comment l'assistant doit-il travailler ?",
      "ask": { "label": "Question", "hint": "Répond à vos questions. Ne modifie jamais le document." },
      "plan": { "label": "Plan", "hint": "Prépare ce qu'il ferait et vous le montre, avant toute modification." },
      "assist": { "label": "Assistant", "hint": "Modifie votre mémoire et demande avant tout changement irréversible." },
      "agent": { "label": "Agent", "hint": "Fait tout le travail sans s'arrêter. Tout annuler en une seule fois." }
    },
    "confirm": {
      "title": "Kwill va apporter une modification importante à votre mémoire",
      "approve": "Approuver",
      "cancel": "Annuler",
      "undoNote": "Vous pourrez annuler cette action plus tard depuis l'historique.",
      "failed": "Impossible d'envoyer votre réponse. Réessayez.",
      "deleteBlock": "Retirer ceci de votre mémoire : « {snippet} »",
      "replaceText": "Remplacer {count} occurrence(s) de « {find} » par « {replace} »",
      "overwriteHeader": "Remplacer l'en-tête de page par « {next} »",
      "overwriteFooter": "Remplacer le pied de page par « {next} »",
      "make_thesis_ready": "Appliquer la normalisation RTL/Word complète à tout le document",
      "front_matter_numbering": "Renuméroter les pages liminaires dans tout le document",
      "insert_table_of_contents": "Supprimer la table des matières que vous avez saisie à la main et la remplacer par une table automatique",
      "remove_table_of_contents": "Supprimer la table des matières que vous avez saisie à la main"
    },
    "ask": {
      "dismiss": "Ignorer la question",
      "typeYourOwn": "Écrivez votre réponse…"
    },
    "plan": {
      "execute": "Exécuter",
      "running": "En cours…",
      "done": "Terminé",
      "askChanges": "Demander des modifications",
      "stepDone": "Terminé",
      "stepRunning": "En cours",
      "failed": "Impossible d'exécuter le plan. Réessayez."
    }
  }
}
```

- [ ] **Step 3: `ar.json`**

Replace the whole file with:

```json
{
  "chat": {
    "placeholder": "اسأل الذكاء الاصطناعي عن مذكرتك…",
    "newConversation": "محادثة جديدة",
    "untitledConversation": "محادثة بدون عنوان",
    "loadingThreads": "جارٍ التحميل…",
    "thinking": "جارٍ التفكير…",
    "quotaExhausted": "لقد استخدمت كل رسائلك المتاحة حاليًا. حاول مرة أخرى لاحقًا، أو قم بالترقية من تطبيق Kwill.",
    "sendFailed": "فشل إرسال الرسالة.",
    "switchThreadFailed": "تعذر تبديل المحادثة. حاول مرة أخرى.",
    "newThreadFailed": "تعذر بدء محادثة جديدة. حاول مرة أخرى.",
    "retry": "إعادة المحاولة",
    "stop": "إيقاف التوليد",
    "send": "إرسال",
    "modes": {
      "title": "كيف تريد أن يعمل المساعد؟",
      "ask": { "label": "سؤال", "hint": "يجيب عن أسئلتك ولا يعدّل المذكرة أبداً." },
      "plan": { "label": "خطة", "hint": "يُعدّ ما سيقوم به ويعرضه عليك قبل أي تعديل." },
      "assist": { "label": "مساعدة", "hint": "يعدّل مذكرتك ويستأذنك قبل أي تغيير لا يمكن التراجع عنه." },
      "agent": { "label": "تنفيذ", "hint": "ينجز العمل كاملاً دون توقّف. يمكنك التراجع عن كل شيء بضغطة واحدة." }
    },
    "confirm": {
      "title": "يوشك Kwill على إجراء تعديل مهم في مذكرتك",
      "approve": "موافقة",
      "cancel": "إلغاء",
      "undoNote": "يمكنك التراجع عن هذا لاحقًا من السجل.",
      "failed": "تعذر إرسال إجابتك. حاول مرة أخرى.",
      "deleteBlock": "حذف هذا من مذكرتك: «{snippet}»",
      "replaceText": "استبدال {count} من تكرارات «{find}» بـ «{replace}»",
      "overwriteHeader": "استبدال رأس الصفحة بـ «{next}»",
      "overwriteFooter": "استبدال تذييل الصفحة بـ «{next}»",
      "make_thesis_ready": "تطبيق التنسيق الكامل RTL/Word على المستند بأكمله",
      "front_matter_numbering": "إعادة ترقيم صفحات البداية في المستند بأكمله",
      "insert_table_of_contents": "حذف فهرس المحتويات الذي كتبته بنفسك واستبداله بفهرس تلقائي",
      "remove_table_of_contents": "حذف فهرس المحتويات الذي كتبته بنفسك"
    },
    "ask": {
      "dismiss": "تجاهل السؤال",
      "typeYourOwn": "اكتب إجابتك…"
    },
    "plan": {
      "execute": "نفّذ الخطة",
      "running": "جارٍ العمل…",
      "done": "تم",
      "askChanges": "اطلب تعديلات",
      "stepDone": "تم",
      "stepRunning": "قيد التنفيذ",
      "failed": "تعذر تنفيذ الخطة. حاول مرة أخرى."
    }
  }
}
```

- [ ] **Step 4: Confirm all three parse**

```bash
cd ~/modakerati-dashboard
for f in src/features/chat/locales/*.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f parses')"
done
```

Expected: 3 lines, each ending "parses".

- [ ] **Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: PASS. No `messages.ts` change is needed — the chat bundle is already registered there.

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/locales
git commit -m "i18n(chat): mode, confirm, ask, plan and stop strings"
```

---

### Task 9: `ModeChip`

**Files:**
- Create: `src/features/chat/components/ModeChip.tsx`

- [ ] **Step 1: Read the two mobile originals**

```bash
cat ~/modakerati/components/chat/ChatModeChip.tsx
cat ~/modakerati/components/chat/ChatModeSheet.tsx
```

This one web component is a port of **both**: the chip is `ChatModeChip`, and the popover is `ChatModeSheet`'s row list. Mirror the chip's rule that only `agent` is tinted ("no prompts, runs on its own is the state worth noticing before you press send"), and the sheet's row anatomy — a rounded-square icon well, label, one-line hint, and a check on the active mode.

The one deliberate divergence: a `@gorhom/bottom-sheet` modal has no meaning on a desktop web page, so the picker is an anchored popover. Everything the sheet's comments warn about (unmount-when-closed, `requestAnimationFrame` presenting, snap points) is native-sheet plumbing with no web equivalent, so none of it carries over. The popover instead needs the two things a web overlay needs and a native sheet gets for free: dismissal on an outside click and on Escape.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/ModeChip.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";
import {
  CHAT_MODES,
  CHAT_MODE_ICONS,
  chatModeLabelKey,
  chatModeHintKey,
  type ChatMode,
} from "../lib/chat-modes";

/**
 * What this conversation is FOR, sitting in the composer where the student can
 * see it while they type — which is the moment it matters. Ported from the
 * app's ChatModeChip + ChatModeSheet; the native bottom sheet becomes an
 * anchored popover here, since a sheet is meaningless on a desktop page.
 *
 * Agent is tinted and the others are not: "no prompts, runs on its own" is the
 * state worth noticing before you press send.
 *
 * Selecting a mode calls no endpoint — there is no mode API. The value rides
 * along on the next message, and the server persists it from there.
 */
export function ModeChip({
  mode,
  onChange,
  disabled,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled: boolean;
}) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // What a native sheet gets for free and a web popover does not: an outside
  // click and Escape both dismiss. A popover that can only be closed by picking
  // something is a trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isAgent = mode === "agent";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(chatModeLabelKey(mode))}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-full border bg-input px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
          isAgent ? "border-primary text-primary" : "border-border text-subtext"
        }`}
      >
        <Icon name={CHAT_MODE_ICONS[mode]} size={13} />
        <span className="truncate">{t(chatModeLabelKey(mode))}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full mb-2 start-0 z-20 w-80 rounded-xl border border-border bg-modal shadow-lg overflow-hidden"
        >
          <p className="px-5 pt-4 pb-2 text-[17px] font-semibold text-text">{t("modes.title")}</p>
          <div className="px-4 pb-4">
            {CHAT_MODES.map((m) => {
              const active = m === mode;
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitem"
                  aria-current={active}
                  onClick={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-3 border-b border-border-subtle px-1 py-3 text-start last:border-b-0 hover:bg-card-hover"
                >
                  {/* The 36px rounded icon well the sheet uses, so the four rows
                      line up regardless of icon width. */}
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-input">
                    <Icon
                      name={CHAT_MODE_ICONS[m]}
                      size={18}
                      className={active ? "text-primary" : "text-subtext"}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-text">{t(chatModeLabelKey(m))}</span>
                    <span className="block text-xs text-subtext leading-snug">{t(chatModeHintKey(m))}</span>
                  </span>
                  {active && <Icon name="check" size={18} className="shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
```

Note `bg-input`, `bg-modal`, and `border-border-subtle`: confirm these Tailwind tokens exist in `src/app/globals.css`'s `@theme inline` block (they map to `--input`, `--modal` and `--border-subtle`). If `--modal` is not exposed as a token, use `bg-card` instead and say so in your report — do not invent a token.

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ModeChip.tsx
git commit -m "feat(chat): mode picker chip and popover, ported from the app"
```

---

### Task 10: `ConfirmCard`

**Files:**
- Create: `src/features/chat/components/ConfirmCard.tsx`

- [ ] **Step 1: Read the mobile original**

```bash
cat ~/modakerati/components/workspace/ComposerConfirm.tsx
```

Port it. Two things there that a from-scratch version would miss, and that this task exists to carry over:

1. **The preview line is localized per tool kind**, not shown as the server's raw English. `previewText()` switches on `preview.kind` and interpolates from `preview.data`, falling back to `preview.text` for any kind it doesn't know. Without this, an Arabic student reads an English sentence. Note the mobile file's own remark on `delete_block`: the snippet identifies the target, never an index — the same no-index-leak rule the server enforces.
2. **It uses the error/danger colour, not warning** — a red triangle and a red Approve button. The card is about something irreversible.

Also keep its voice, which the mobile file calls out explicitly: Kwill says what *it* is about to do. Never "the AI wants to…".

The i18next `{{param}}` placeholders become next-intl `{param}` — Task 8 already writes them in that form.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/ConfirmCard.tsx
"use client";

import { useTranslations } from "next-intl";
import { Button, Icon } from "@/components/ui";
import { detectDir } from "@/features/workspace/lib/direction";
import type { ConfirmPayload } from "../lib/control-frames";

/**
 * A destructive action awaiting the student's approval, ported from the app's
 * ComposerConfirm. Approve executes the server-stored args (never a chat
 * message); Cancel discards the action. The turn has already ENDED by the time
 * this renders — the server is waiting on the student.
 *
 * Worded throughout as KWILL doing the thing, never as "the AI" wanting to: the
 * student asked Kwill, and Kwill is what answers for the change afterwards.
 *
 * Ephemeral by design: the server strips MODK_CONFIRM before persisting, so a
 * page reload loses the card. The pending action itself survives 30 minutes
 * server-side, and approving after that degrades gracefully.
 */
export function ConfirmCard({
  payload,
  busy,
  onApprove,
  onCancel,
}: {
  payload: ConfirmPayload;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("chat");

  // Localized preview line; falls back to the server-built English text for any
  // tool kind this switch doesn't name.
  const previewText = (): string => {
    const d = payload.preview.data as Record<string, string | number>;
    const fallback = payload.preview.text;
    switch (payload.preview.kind) {
      case "delete_block":
        // The snippet identifies it, not an index — the student never sees a
        // position (the server enforces the same rule in no-index-leak.ts).
        return t("confirm.deleteBlock", { snippet: String(d.snippet ?? "") });
      case "replace_text":
        return t("confirm.replaceText", {
          find: String(d.find ?? ""),
          replace: String(d.replace ?? ""),
          count: Number(d.count ?? 0),
        });
      case "set_header":
      case "set_section_header":
        return t("confirm.overwriteHeader", { next: String(d.next ?? "") });
      case "set_footer":
      case "set_section_footer":
        return t("confirm.overwriteFooter", { next: String(d.next ?? "") });
      case "make_thesis_ready":
        return t("confirm.make_thesis_ready");
      case "front_matter_numbering":
        return t("confirm.front_matter_numbering");
      case "insert_table_of_contents":
        return t("confirm.insert_table_of_contents");
      case "remove_table_of_contents":
        return t("confirm.remove_table_of_contents");
      default:
        return fallback;
    }
  };

  const line = previewText();

  return (
    <div className="mx-3 mb-2 rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-3">
      <div className="flex items-start gap-2">
        <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-text">{t("confirm.title")}</p>
          <p dir={detectDir(line)} className="mt-1 text-sm font-medium text-subtext">
            {line}
          </p>
          <p className="mt-1.5 text-xs text-placeholder">{t("confirm.undoNote")}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <Button type="button" variant="danger" disabled={busy} onClick={onApprove}>
          {t("confirm.approve")}
        </Button>
        <Button type="button" variant="muted" disabled={busy} onClick={onCancel}>
          {t("confirm.cancel")}
        </Button>
      </div>
    </div>
  );
}
```

Note `text-placeholder`: confirm that token exists (it maps to `--placeholder`). If it does not, use `text-subtext` and say so in your report.

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ConfirmCard.tsx
git commit -m "feat(chat): approval card with localized previews, ported from the app"
```

---

### Task 11: `AskCard`

**Files:**
- Create: `src/features/chat/components/AskCard.tsx`

- [ ] **Step 1: Read the mobile original**

```bash
cat ~/modakerati/components/workspace/ComposerAsk.tsx
```

Port it. The thing a from-scratch version gets wrong: when `allowFreeText` is true the card carries a **real text input with its own Send button**, not a hint telling the student to type somewhere else. Mirror that, plus the dismiss × in the header (the product rule that a student may always wave a question away) and the option chips' semi-transparent brand border.

One addition beyond the mobile file: `previews`. `ComposerAsk` doesn't render them, but the payload carries them for the `ask_user_with_previews` tool, and a web panel has the room to show thumbnails where a composer sheet did not. When `previews` is present it replaces the plain chips; each tile answers with its own `label`, exactly as a chip would.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/AskCard.tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, fInput } from "@/components/ui";
import { detectDir } from "@/features/workspace/lib/direction";
import type { AskPayload } from "../lib/control-frames";

const BASE = process.env.NEXT_PUBLIC_MODAKERATI_SERVER_URL ?? "http://localhost:3000";

/** A plain <img> can't carry an Authorization header, so the token travels as
 *  a query param — the server's auth middleware accepts this fallback for
 *  non-fetch loads. Same pattern as the workspace's ImageBlock. */
function previewSrc(previewUrl: string, accessToken: string | null): string | null {
  if (!accessToken) return null;
  return `${BASE}${previewUrl}?token=${encodeURIComponent(accessToken)}`;
}

/**
 * The model's clarifying question, ported from the app's ComposerAsk. Tapping
 * an option answers immediately; the free-text row (when allowed) submits typed
 * answers. The turn has already ENDED — the server is waiting for the student's
 * answer, which is just an ordinary next message carrying the chosen label.
 * There is no ask endpoint, so every path here routes back through normal send.
 *
 * Ephemeral by design: the server strips MODK_ASK before persisting, so this
 * card does not survive a reload. Always dismissible — the student has the
 * right to leave a question unanswered.
 */
export function AskCard({
  payload,
  accessToken,
  busy,
  onAnswer,
  onDismiss,
}: {
  payload: AskPayload;
  accessToken: string | null;
  busy: boolean;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("chat");
  const [text, setText] = useState("");
  const previews = payload.previews ?? [];

  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (trimmed && !busy) onAnswer(trimmed);
  };

  return (
    <div className="mx-3 mb-2 rounded-[10px] border border-border bg-card px-3.5 py-3">
      <div className="flex items-start gap-2">
        <Icon name="message-circle-question" size={16} className="mt-0.5 shrink-0 text-primary" />
        <p
          dir={detectDir(payload.question)}
          className="min-w-0 flex-1 text-[15px] font-semibold text-text"
        >
          {payload.question}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("ask.dismiss")}
          className="shrink-0 text-subtext hover:text-text"
        >
          <Icon name="x" size={18} />
        </button>
      </div>

      {previews.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {previews.map((preview) => {
            const src = previewSrc(preview.previewUrl, accessToken);
            return (
              <button
                key={preview.id}
                type="button"
                disabled={busy}
                onClick={() => submit(preview.label)}
                className="rounded-lg border border-primary/30 bg-card p-2 text-start hover:border-primary disabled:opacity-50"
              >
                {src && (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated URL, not a static asset next/image can optimize
                  <img src={src} alt={preview.label} className="mb-1.5 w-full rounded h-auto" />
                )}
                <span dir={detectDir(preview.label)} className="block text-[13px] font-medium text-text">
                  {preview.label}
                </span>
                {preview.description && (
                  <span dir={detectDir(preview.description)} className="block text-xs text-subtext">
                    {preview.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        payload.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {payload.options.map((option) => (
              <button
                key={option}
                type="button"
                disabled={busy}
                dir={detectDir(option)}
                onClick={() => submit(option)}
                className="rounded-2xl border border-primary/30 bg-card px-3.5 py-2 text-[13px] font-medium text-text hover:border-primary disabled:opacity-50"
              >
                {option}
              </button>
            ))}
          </div>
        )
      )}

      {payload.allowFreeText && (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
            disabled={busy}
            placeholder={t("ask.typeYourOwn")}
            aria-label={t("ask.typeYourOwn")}
            dir={detectDir(payload.question)}
            rows={1}
            // Wraps rather than scrolling the start of the answer out of view —
            // a typed Arabic sentence outgrew one line in the app and only its
            // tail stayed readable — and follows the question's direction so the
            // caret starts on the correct side in RTL.
            className={`${fInput} max-h-26 resize-none`}
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => submit(text)}
          >
            {t("send")}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/AskCard.tsx
git commit -m "feat(chat): question card with chips, previews and free text, ported from the app"
```

---

### Task 12: `PlanCard`

**Files:**
- Create: `src/features/chat/components/PlanCard.tsx`

- [ ] **Step 1: Read the mobile original**

```bash
cat ~/modakerati/components/chat/PlanCard.tsx
```

Port it carefully — this is the richest of the three cards, and four of its behaviours are load-bearing:

1. **The double-execute latch (`fired` ref).** Its comment is explicit that `disabled` alone cannot stop a double tap: `disabled` only goes true once the *caller* has re-rendered with `running=true`, and any caller that awaits something first leaves the button live for those frames. Executing a plan twice applies every edit in it twice. The latch closes in the same tick as the press and reopens only when a run ends without finishing. A dead button is the cheap failure here; a thesis edited twice is not.
2. **The step badge carries three states** in one fixed-size circle so the list never reflows as a run walks down it: a tick when done, a spinner on the step being worked on, its plain 1-based number until then.
3. **`activeIndex`** is the first step with no tick *while running* — and `-1` both when idle and when every step is ticked, so a run whose last frame has landed but whose prose is still streaming doesn't spin on a step that doesn't exist.
4. **`tick.note`** renders under its step in the success colour — "the only line on the card written after the fact". A from-scratch version drops this and loses what was actually done.

Also port the **"Ask for changes"** secondary button. It only calls back; the caller decides what it means (focusing the composer), because the student answering in their own words *is* the revision — there is no edit-the-plan mode. Note the mobile file's remark that the actions row must wrap: "Demander des modifications" beside "Exécuter" is wider than a card.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/PlanCard.tsx
"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@/components/ui";
import { detectDir } from "@/features/workspace/lib/direction";
import type { PlanPayload, PlanStepPayload } from "../lib/control-frames";

/** The same small spinner the ui Button uses for its loading state, inline so a
 *  step badge can host it without pulling in a button. */
function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin h-3.5 w-3.5 ${className}`} viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/**
 * A plan the assistant proposed in Plan mode: its title, its steps in order,
 * and the decision. Ported from the app's PlanCard.
 *
 * Unlike the confirm and ask cards this one PERSISTS — the server keeps
 * MODK_PLAN frames in message content, so it comes back after a reload, rebuilt
 * by plan-frames.ts.
 *
 * Once a run starts the steps become a live CHECKLIST. The ticks are not
 * derived here and cannot be: they are streamed (and persisted) on the message
 * that EXECUTES the plan, while this card belongs to the message that PROPOSED
 * it. They arrive as `ticks`, folded across the thread by planId.
 *
 * ⚠️ Executing twice would apply every edit in the plan twice, so the button is
 * latched as well as disabled — see `fired` below.
 */
export function PlanCard({
  plan,
  ticks,
  running,
  done,
  disabled,
  onExecute,
  onAskChanges,
}: {
  plan: PlanPayload;
  /** Which steps are ticked off. Live during a run, and rebuilt from the stored
   *  frames on a reload, so the card reads the same either way. */
  ticks: PlanStepPayload[];
  /** The plan is executing right now — Execute is a spinner and refuses taps. */
  running: boolean;
  /** The run finished. The card stays as the record of what was done. */
  done: boolean;
  disabled: boolean;
  onExecute: () => void;
  onAskChanges: () => void;
}) {
  const t = useTranslations("chat");

  // `disabled` alone cannot stop a double tap: it only goes true once the CALLER
  // has re-rendered with running=true, and a caller that awaits anything before
  // flipping it leaves the button live for those frames. The latch closes on the
  // press itself, in the same tick, and reopens only when a run has ended
  // without finishing (a failure the student may retry).
  const fired = useRef(false);
  useEffect(() => {
    if (!running) fired.current = false;
  }, [running]);

  const press = () => {
    if (running || done || fired.current) return;
    fired.current = true;
    onExecute();
  };

  const busy = running || done;

  // `ticks` is not dense — the assistant can finish step 3 before step 2 — so
  // look each step up rather than assuming a prefix is done.
  const tickAt = (i: number) => ticks.find((tick) => tick.index === i);
  // While a run is in flight, the first step with no tick is the one being
  // worked on. -1 when idle, and -1 once every step is ticked (a run whose last
  // frame has landed but whose prose is still streaming must not spin on a step
  // that does not exist).
  const activeIndex = running ? plan.steps.findIndex((_, i) => !tickAt(i)) : -1;

  return (
    <div className="my-2 rounded-[14px] border border-border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <Icon name="clipboard-list" size={16} className="shrink-0 text-primary" />
        <p dir={detectDir(plan.title)} className="min-w-0 flex-1 text-[15px] font-semibold text-text">
          {plan.title}
        </p>
      </div>

      <ol className="mt-3 space-y-2.5">
        {plan.steps.map((step, i) => {
          const tick = tickAt(i);
          const isDone = !!tick;
          const isActive = i === activeIndex;
          return (
            <li key={`${plan.id}-${i}`} className="flex items-start gap-2.5">
              {/* The badge carries the state: a tick when the step is done, a
                  spinner on the one being worked on, its plain number until
                  then. Same 22px circle in all three so the list never reflows
                  as a run walks down it. */}
              <span className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-input">
                {isDone ? (
                  <Icon name="check" size={13} className="text-success" />
                ) : isActive ? (
                  <Spinner className="text-primary" />
                ) : (
                  <span className="text-xs font-semibold text-subtext">{i + 1}</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                {/* Struck AND dimmed: the strike is what reads as "done" at a
                    glance, and dropping to subtext keeps it comfortably legible
                    rather than fading it out. */}
                <span
                  dir={detectDir(step.title)}
                  className={`block text-sm font-medium ${isDone ? "text-subtext line-through" : "text-text"}`}
                >
                  {step.title}
                </span>
                {step.detail && (
                  <span dir={detectDir(step.detail)} className="block text-xs text-subtext">
                    {step.detail}
                  </span>
                )}
                {/* What was actually done, in the student's own language. Sits
                    under the step it belongs to and takes the success colour —
                    it is the only line on the card written after the fact. */}
                {tick?.note && (
                  <span dir={detectDir(tick.note)} className="block text-xs text-success">
                    {tick.note}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {done ? (
        <div className="mt-3 flex items-center gap-1.5">
          <Icon name="check" size={15} className="text-success" />
          <span className="text-[13px] font-semibold text-success">{t("plan.done")}</span>
        </div>
      ) : (
        // Wraps because the secondary label is long in the languages that
        // matter: "Demander des modifications" beside "Exécuter" is wider than
        // the card. A second line beats a clipped button.
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Button type="button" loading={running} disabled={busy || disabled} onClick={press}>
            {running ? t("plan.running") : t("plan.execute")}
          </Button>
          <Button type="button" variant="muted" disabled={running || disabled} onClick={onAskChanges}>
            {t("plan.askChanges")}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/PlanCard.tsx
git commit -m "feat(chat): plan card with live checklist and execute latch, ported from the app"
```

---

### Task 13: Composer gains the mode chip and a stop button

**Files:**
- Modify: `src/features/chat/components/Composer.tsx`

- [ ] **Step 1: Rewrite the component**

Replace the whole file with:

```tsx
// src/features/chat/components/Composer.tsx
"use client";

import { useState, type KeyboardEvent, type RefObject } from "react";
import { Button, fInput } from "@/components/ui";
import { ModeChip } from "./ModeChip";
import type { ChatMode } from "../lib/chat-modes";

export function Composer({
  onSend,
  disabled,
  placeholder,
  mode,
  onModeChange,
  streaming,
  onStop,
  stopLabel,
  inputRef,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder: string;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  /** True while a turn is in flight — swaps Send for Stop. */
  streaming: boolean;
  onStop: () => void;
  stopLabel: string;
  /** Owned by ChatPanel so a plan card's "Ask for changes" can focus the
   *  composer — the student answering in their own words IS the revision. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border p-3">
      <div className="mb-2">
        <ModeChip mode={mode} onChange={onModeChange} disabled={streaming} />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={2}
          className={`${fInput} resize-none`}
        />
        {streaming ? (
          <Button
            type="button"
            icon="square"
            size="sm"
            variant="muted"
            aria-label={stopLabel}
            title={stopLabel}
            onClick={onStop}
          />
        ) : (
          <Button
            type="button"
            icon="send"
            size="sm"
            aria-label="Send"
            onClick={submit}
            disabled={disabled || !value.trim()}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: **FAIL**, with an error on `src/features/chat/components/ChatPanel.tsx` — it renders `<Composer>` without the five new required props. That is expected at this step; Task 15 supplies them. Confirm the ONLY errors are that missing-prop error on ChatPanel, then continue.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/components/Composer.tsx
git commit -m "feat(chat): composer gains the mode chip and a stop button"
```

---

### Task 14: Render plan cards inside the transcript

**Files:**
- Modify: `src/features/chat/components/MessageBubble.tsx`
- Modify: `src/features/chat/components/MessageList.tsx`

- [ ] **Step 1: Extend `MessageBubble`**

Read the file. Add these imports at the top, after the existing ones:

```tsx
import { PlanCard } from "./PlanCard";
import type { PlanPayload, PlanStepPayload } from "../lib/control-frames";
```

Then replace the exported `MessageBubble` function (everything from `export function MessageBubble(` to the end of the file) with:

```tsx
export function MessageBubble({
  role,
  content,
  plans = [],
  ticksByPlanId = {},
  runningPlanId = null,
  plansDisabled = false,
  onExecutePlan,
  onAskPlanChanges,
}: {
  role: "user" | "assistant";
  content: string;
  /** Plan cards carried by THIS message (extracted from its raw content
   *  before the frames were stripped for display). */
  plans?: PlanPayload[];
  /** Thread-wide tick fold — a plan's ticks arrive in LATER messages than the
   *  card, so this cannot be scoped per message. */
  ticksByPlanId?: Record<string, PlanStepPayload[]>;
  runningPlanId?: string | null;
  plansDisabled?: boolean;
  onExecutePlan?: (planId: string) => void;
  onAskPlanChanges?: () => void;
}) {
  const dir = detectDir(content);
  const isUser = role === "user";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {content && (
        <div
          dir={dir}
          className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser ? "bg-primary text-white" : "bg-card border border-border text-text"
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </ReactMarkdown>
        </div>
      )}

      {plans.map((plan) => {
        const ticks = ticksByPlanId[plan.id] ?? [];
        const running = runningPlanId === plan.id;
        return (
          <div key={plan.id} className="w-full max-w-[85%]">
            <PlanCard
              plan={plan}
              ticks={ticks}
              running={running}
              // No server flag records "this plan ran". The one durable signal
              // is a tick naming it — the same inference the server itself
              // uses. Not `done` while it is still running, or the card would
              // drop its live checklist mid-run.
              done={!running && ticks.length > 0}
              disabled={plansDisabled}
              onExecute={() => onExecutePlan?.(plan.id)}
              onAskChanges={() => onAskPlanChanges?.()}
            />
          </div>
        );
      })}
    </div>
  );
}
```

Note the `{content && ...}` guard: a message that carried nothing but a plan frame has an empty body once stripped, and an empty bubble would render as a stray blank pill.

- [ ] **Step 2: Extend `MessageList` to pass the plan data through**

Replace the whole file with:

```tsx
// src/features/chat/components/MessageList.tsx
"use client";

import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../types";
import type { PlanPayload, PlanStepPayload } from "../lib/control-frames";

export function MessageList({
  messages,
  plansByMessageId,
  ticksByPlanId,
  runningPlanId,
  plansDisabled,
  onExecutePlan,
  onAskPlanChanges,
}: {
  messages: ChatMessage[];
  plansByMessageId: Record<string, PlanPayload[]>;
  ticksByPlanId: Record<string, PlanStepPayload[]>;
  runningPlanId: string | null;
  plansDisabled: boolean;
  onExecutePlan: (planId: string) => void;
  onAskPlanChanges: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          role={message.role === "user" ? "user" : "assistant"}
          content={message.content}
          plans={plansByMessageId[message.id]}
          ticksByPlanId={ticksByPlanId}
          runningPlanId={runningPlanId}
          plansDisabled={plansDisabled}
          onExecutePlan={onExecutePlan}
          onAskPlanChanges={onAskPlanChanges}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: **FAIL**, with errors only on `ChatPanel.tsx` — it now renders both `<Composer>` and `<MessageList>` without their new required props. Task 15 fixes this. Confirm no other file errors, then continue.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/MessageBubble.tsx src/features/chat/components/MessageList.tsx
git commit -m "feat(chat): render plan cards inline in the transcript"
```

---

### Task 15: Wire it all together in `ChatPanel`

The orchestrator gains a single `runTurn` helper that every streaming entry point drives, so send, approve, cancel, and execute-plan share one code path for streaming, quota, errors, and cleanup.

**Files:**
- Modify: `src/features/chat/components/ChatPanel.tsx`
- Modify: `src/features/chat/index.ts`

- [ ] **Step 1: Rewrite `ChatPanel.tsx`**

Replace the whole file with:

```tsx
// src/features/chat/components/ChatPanel.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";
import {
  postChatStream,
  parseChatStreamError,
  ChatStreamError,
  listThreadsForThesisBrowser,
  getThreadMessagesBrowser,
  createThreadBrowser,
  confirmActionStream,
  cancelActionStream,
  executePlanStream,
  stopChatTurn,
} from "@/lib/api/student-browser";
import { consumeChatStream } from "../lib/consume-chat-stream";
import { stripPersistedFrames } from "../lib/strip-persisted-frames";
import { extractPlanState } from "../lib/plan-frames";
import { chatModeOf, type ChatMode } from "../lib/chat-modes";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ThreadHistory } from "./ThreadHistory";
import { ConfirmCard } from "./ConfirmCard";
import { AskCard } from "./AskCard";
import type { ChatMessage, ThreadSummary } from "../types";
import type { AskPayload, ConfirmPayload, PlanPayload, PlanStepPayload } from "../lib/control-frames";

const FLUSH_MS = 90;
/** How long a new turn waits for an in-flight /stop to settle. POST /stop
 *  cancels whatever is live on the THREAD, so a stop that overtakes the next
 *  send would kill the new turn instead of the old one. Mirrors the mobile
 *  app's STOP_SETTLE_MS. */
const STOP_SETTLE_MS = 1500;

let localIdSeq = 0;
function localId(): string {
  localIdSeq += 1;
  return `local-${Date.now()}-${localIdSeq}`;
}

function stripAll(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, content: stripPersistedFrames(m.content) }));
}

export function ChatPanel({
  thesisId,
  initialThread,
  initialMessages,
  accessToken,
}: {
  thesisId: string;
  initialThread: ThreadSummary;
  initialMessages: ChatMessage[];
  /** Only used to authenticate MODK_ASK preview images, which a plain <img>
   *  can't fetch with a header. Null just means those thumbnails don't load. */
  accessToken: string | null;
}) {
  const t = useTranslations("chat");
  const router = useRouter();

  const initialPlanState = extractPlanState(initialMessages);

  const [thread, setThread] = useState(initialThread);
  const [mode, setMode] = useState<ChatMode>(chatModeOf(initialThread.mode));
  const [messages, setMessages] = useState<ChatMessage[]>(stripAll(initialMessages));
  const [plansByMessageId, setPlansByMessageId] = useState(initialPlanState.plansByMessageId);
  const [ticksByPlanId, setTicksByPlanId] = useState(initialPlanState.ticksByPlanId);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [switchingThread, setSwitchingThread] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmPayload | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskPayload | null>(null);
  const [runningPlanId, setRunningPlanId] = useState<string | null>(null);

  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const pendingStopRef = useRef<Promise<void> | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      // A turn still streaming after unmount would keep the connection open
      // and keep firing handlers into a component React no longer renders.
      abortRef.current?.abort();
    };
  }, []);

  const appendToLastAssistant = (assistantId: string, textToAdd: string) => {
    if (!mountedRef.current) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + textToAdd } : m)),
    );
  };

  const startFlushLoop = (assistantId: string) => {
    flushTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      if (!pendingTextRef.current) return;
      const text = pendingTextRef.current;
      pendingTextRef.current = "";
      appendToLastAssistant(assistantId, text);
    }, FLUSH_MS);
  };

  const stopFlushLoop = (assistantId: string) => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    flushTimerRef.current = null;
    if (!mountedRef.current) return;
    if (pendingTextRef.current) {
      const text = pendingTextRef.current;
      pendingTextRef.current = "";
      appendToLastAssistant(assistantId, text);
    }
  };

  /**
   * The one streaming code path. /stream, /confirm-action, /cancel-action and
   * /execute-plan all answer with the identical chunked-text protocol, so they
   * differ only in which Response they produce and whether a user message is
   * shown first — everything after that (placeholder, flush loop, frame
   * handling, quota, errors, cleanup) is shared here.
   *
   * `onFailure` runs INSTEAD of the default error handling when the failure is
   * not a quota exhaustion, letting each caller word its own message and
   * restore its own state.
   */
  const runTurn = useCallback(
    async (options: {
      userText: string | null;
      openStream: (signal: AbortSignal) => Promise<Response>;
      failureMessage: string;
      onRetry: () => void;
    }) => {
      if (sending) return;
      setSendError(null);
      setRetryAction(null);
      setPendingConfirm(null);
      setPendingAsk(null);

      // POST /stop cancels whatever is live on the thread, so let any in-flight
      // stop land before opening a new turn it would otherwise kill.
      if (pendingStopRef.current) {
        await Promise.race([
          pendingStopRef.current,
          new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS)),
        ]);
        pendingStopRef.current = null;
      }
      if (!mountedRef.current) return;

      const newMessages: ChatMessage[] = [];
      let userMessageId: string | null = null;
      if (options.userText !== null) {
        userMessageId = localId();
        newMessages.push({
          id: userMessageId,
          threadId: thread.id,
          thesisId,
          role: "user",
          content: options.userText,
          searchText: null,
          createdAt: new Date().toISOString(),
        });
      }
      const assistantId = localId();
      newMessages.push({
        id: assistantId,
        threadId: thread.id,
        thesisId,
        role: "assistant",
        content: "",
        searchText: null,
        createdAt: new Date().toISOString(),
      });

      setMessages((prev) => [...prev, ...newMessages]);
      setSending(true);
      setThinking(null);

      let docChanged = false;
      const controller = new AbortController();
      abortRef.current = controller;
      startFlushLoop(assistantId);

      try {
        const response = await options.openStream(controller.signal);
        if (!response.ok) throw await parseChatStreamError(response);

        await consumeChatStream(response, {
          onText: (delta) => {
            pendingTextRef.current += delta;
          },
          onThink: (delta) => {
            if (!mountedRef.current) return;
            setThinking((prev) => (prev ?? "") + delta);
          },
          onDocChanges: () => {
            docChanged = true;
          },
          onTitle: (payload) => {
            if (!mountedRef.current) return;
            setThread((prev) => (prev.id === payload.threadId ? { ...prev, title: payload.title } : prev));
          },
          onConfirm: (payload) => {
            if (!mountedRef.current) return;
            setPendingConfirm(payload);
          },
          onAsk: (payload) => {
            if (!mountedRef.current) return;
            setPendingAsk(payload);
          },
          onPlan: (payload: PlanPayload) => {
            if (!mountedRef.current) return;
            setPlansByMessageId((prev) => ({
              ...prev,
              [assistantId]: [...(prev[assistantId] ?? []), payload],
            }));
          },
          onPlanStep: (payload: PlanStepPayload) => {
            if (!mountedRef.current) return;
            setTicksByPlanId((prev) => ({
              ...prev,
              [payload.planId]: [...(prev[payload.planId] ?? []), payload],
            }));
          },
        });

        stopFlushLoop(assistantId);
        if (!mountedRef.current) return;
        setThinking(null);
        setSendError(null);
        setRetryAction(null);
        if (docChanged) router.refresh();
      } catch (err) {
        stopFlushLoop(assistantId);
        if (!mountedRef.current) return;
        setThinking(null);

        // An aborted turn is a deliberate stop, not a failure — the partial
        // reply stays on screen exactly as the server persisted it.
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof ChatStreamError && err.code === "quota_exhausted") {
          setQuotaExhausted(true);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }

        // A 404 from confirm/cancel means the action was already handled —
        // there is nothing wrong to report, just a card to clear.
        if (err instanceof ChatStreamError && err.status === 404) {
          setMessages((prev) =>
            prev.filter((m) => m.id !== assistantId && m.id !== userMessageId),
          );
          return;
        }

        setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== userMessageId));
        setSendError(options.failureMessage);
        setRetryAction(() => options.onRetry);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current) {
          setSending(false);
          setRunningPlanId(null);
        }
      }
    },
    [sending, thread.id, thesisId, router],
  );

  const send = useCallback(
    (text: string) => {
      void runTurn({
        userText: text,
        openStream: (signal) => postChatStream({ message: text, threadId: thread.id, mode }, signal),
        failureMessage: t("sendFailed"),
        onRetry: () => send(text),
      });
    },
    [runTurn, thread.id, mode, t],
  );

  const answerAsk = useCallback(
    (answer: string) => {
      setPendingAsk(null);
      send(answer);
    },
    [send],
  );

  const respondToConfirm = useCallback(
    (approve: boolean) => {
      const payload = pendingConfirm;
      // Guard BEFORE clearing the card: runTurn also refuses while a turn is
      // live, and clearing first would lose the card with nothing started.
      if (!payload || sending) return;
      setPendingConfirm(null);
      void runTurn({
        userText: null,
        openStream: (signal) =>
          approve
            ? confirmActionStream(payload.actionId, signal)
            : cancelActionStream(payload.actionId, signal),
        failureMessage: t("confirm.failed"),
        onRetry: () => {
          setPendingConfirm(payload);
        },
      });
    },
    [pendingConfirm, sending, runTurn, t],
  );

  const executePlan = useCallback(
    (planId: string) => {
      // Same reason as respondToConfirm: don't arm the "running" flag for a
      // turn runTurn is about to refuse, or the card spins forever.
      if (sending) return;
      setRunningPlanId(planId);
      void runTurn({
        userText: null,
        openStream: (signal) => executePlanStream(thread.id, planId, signal),
        failureMessage: t("plan.failed"),
        onRetry: () => executePlan(planId),
      });
    },
    [sending, runTurn, thread.id, t],
  );

  /** A plan card's "Ask for changes" only calls back — the caller decides what
   *  it means. Here, as on mobile, it means put the cursor in the composer:
   *  the student answering in their own words IS the revision, and there is no
   *  separate edit-the-plan mode. */
  const askPlanChanges = useCallback(() => {
    composerInputRef.current?.focus();
  }, []);

  /** Abort locally FIRST and synchronously so the UI never waits on the
   *  network (a hung reader would otherwise strand the composer), then tell
   *  the server fire-and-forget. Only ever called from the Stop button — an
   *  incidental stream error must NOT call /stop, since the server treats a
   *  dropped socket as "disconnected", not "aborted". */
  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingStopRef.current = stopChatTurn(thread.id).catch((err) => {
      console.error("[chat] stop request failed", err);
    });
  }, [thread.id]);

  const loadThreadState = (target: ThreadSummary, msgs: ChatMessage[]) => {
    const planState = extractPlanState(msgs);
    setThread(target);
    setMode(chatModeOf(target.mode));
    setMessages(stripAll(msgs));
    setPlansByMessageId(planState.plansByMessageId);
    setTicksByPlanId(planState.ticksByPlanId);
    setPendingConfirm(null);
    setPendingAsk(null);
    setSendError(null);
    setRetryAction(null);
  };

  const expandHistory = useCallback(() => {
    if (threads !== null) return;
    listThreadsForThesisBrowser(thesisId)
      .then((result) => {
        if (!mountedRef.current) return;
        setThreads(result);
      })
      .catch((err) => {
        console.error("[chat] failed to list threads", err);
        if (!mountedRef.current) return;
        setThreads([]);
      });
  }, [thesisId, threads]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (sending || threadId === thread.id) return;
      const target = threads?.find((th) => th.id === threadId);
      if (!target) return;
      setSendError(null);
      setRetryAction(null);
      setSwitchingThread(true);
      getThreadMessagesBrowser(threadId)
        .then((msgs) => {
          if (!mountedRef.current) return;
          loadThreadState(target, msgs);
        })
        .catch((err) => {
          console.error("[chat] failed to switch thread", err);
          if (!mountedRef.current) return;
          setSendError(t("switchThreadFailed"));
          setRetryAction(() => () => selectThread(threadId));
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setSwitchingThread(false);
        });
    },
    [sending, thread.id, threads, t],
  );

  const newThread = useCallback(() => {
    if (sending) return;
    setSendError(null);
    setRetryAction(null);
    setSwitchingThread(true);
    createThreadBrowser(thesisId)
      .then((created) => {
        if (!mountedRef.current) return;
        loadThreadState(created, []);
        setThreads((prev) => (prev ? [created, ...prev] : prev));
      })
      .catch((err) => {
        console.error("[chat] failed to create new thread", err);
        if (!mountedRef.current) return;
        setSendError(t("newThreadFailed"));
        setRetryAction(() => () => newThread());
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setSwitchingThread(false);
      });
  }, [sending, thesisId, t]);

  return (
    <div className="flex flex-col h-full w-full max-w-md border-s border-border">
      <ThreadHistory
        activeTitle={thread.title || t("untitledConversation")}
        activeThreadId={thread.id}
        threads={threads}
        onExpand={expandHistory}
        onSelect={selectThread}
        onNewThread={newThread}
        newConversationLabel={t("newConversation")}
        loadingLabel={t("loadingThreads")}
        untitledLabel={t("untitledConversation")}
      />

      <MessageList
        messages={messages}
        plansByMessageId={plansByMessageId}
        ticksByPlanId={ticksByPlanId}
        runningPlanId={runningPlanId}
        plansDisabled={sending || quotaExhausted || switchingThread}
        onExecutePlan={executePlan}
        onAskPlanChanges={askPlanChanges}
      />

      {switchingThread && (
        <div className="px-4 pb-2 text-xs text-subtext italic">{t("loadingThreads")}</div>
      )}

      {thinking && <div className="px-4 pb-2 text-xs text-subtext italic">{t("thinking")}</div>}

      {pendingConfirm && (
        <ConfirmCard
          payload={pendingConfirm}
          busy={sending}
          onApprove={() => respondToConfirm(true)}
          onCancel={() => respondToConfirm(false)}
        />
      )}

      {pendingAsk && (
        <AskCard
          payload={pendingAsk}
          accessToken={accessToken}
          busy={sending}
          onAnswer={answerAsk}
          onDismiss={() => setPendingAsk(null)}
        />
      )}

      {quotaExhausted && (
        <div className="mx-3 mb-2 px-3.5 py-2.5 bg-warning/10 border border-warning/20 rounded-[10px]">
          <p className="text-warning text-sm">{t("quotaExhausted")}</p>
        </div>
      )}

      {sendError && (
        <div className="mx-3 mb-2 flex items-center justify-between px-3.5 py-2.5 bg-danger/10 border border-danger/20 rounded-[10px]">
          <p className="text-danger text-sm">{sendError}</p>
          <Button
            type="button"
            onClick={() => {
              const action = retryAction;
              setSendError(null);
              setRetryAction(null);
              action?.();
            }}
          >
            {t("retry")}
          </Button>
        </div>
      )}

      <Composer
        onSend={send}
        disabled={sending || quotaExhausted || switchingThread}
        placeholder={t("placeholder")}
        mode={mode}
        onModeChange={setMode}
        streaming={sending}
        onStop={stopTurn}
        stopLabel={t("stop")}
        inputRef={composerInputRef}
      />
    </div>
  );
}
```

- [ ] **Step 2: Export the mode type from the barrel**

In `src/features/chat/index.ts`, add a line so the workspace page and any future consumer can import the type from the feature root:

```typescript
export type { ChatMode } from "./lib/chat-modes";
```

- [ ] **Step 3: Pass `accessToken` from the workspace page**

`ChatPanel` now needs the access token for ask-preview images. The page already computes `accessToken`. In `src/app/app/(workspace)/[thesisId]/page.tsx`, change the `<ChatPanel …>` element to:

```tsx
        <ChatPanel
          thesisId={thesisId}
          initialThread={chatData.thread}
          initialMessages={chatData.initialMessages}
          accessToken={accessToken}
        />
```

- [ ] **Step 4: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS, zero errors — this resolves the missing-prop errors deliberately left by Tasks 13 and 14.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/components/ChatPanel.tsx src/features/chat/index.ts "src/app/app/(workspace)/[thesisId]/page.tsx"
git commit -m "feat(chat): wire modes, confirm/ask/plan cards and stop into ChatPanel"
```

---

### Task 16: Full verification pass

**Files:** none

- [ ] **Step 1: Full type check**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS, zero errors.

- [ ] **Step 2: Full test suite**

```bash
cd ~/modakerati-dashboard && npm test
```

Expected: PASS. Plan 3 adds 6 control-frame tests and 15 plan-frame tests to the suite that was green before it started.

- [ ] **Step 3: Production build**

```bash
cd ~/modakerati-dashboard && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke pass**

Run `npm run dev`, sign in as a student with an existing thesis, and walk through in order. **Note before starting:** the confirm and ask cards vanish on page reload by design — the server strips those frames before persisting them. That is expected behaviour, not a bug to file.

- [ ] `/app` renders in Kwill orange — the send button, links, and the active mode accent. Open `/d` in another tab and confirm the staff console is still indigo.
- [ ] The mode chip shows the thread's current mode (`Assist` on a fresh thread) and opens a popover listing all four with hints. Only `Agent` is accented.
- [ ] **Ask mode:** switch to Ask, request a document edit — the assistant answers without editing.
- [ ] **Assist mode (the live-bug fix):** switch to Assist and request something destructive (e.g. "delete the acknowledgements section"). An approval card appears instead of a silent dead end. Click **Approve** — a continuation streams and the document updates.
- [ ] Repeat the destructive request and click **Cancel** — a continuation streams acknowledging the refusal, and the document is unchanged.
- [ ] Click Approve twice quickly on one card — the second tap must not surface an error banner (the server returns 404 already-handled, which the panel swallows).
- [ ] **Ask card:** trigger a question from the assistant (e.g. ask it to add divider pages, which asks you to choose a style). Option chips appear; clicking one sends it as your next message. If the question carries previews, thumbnails render. Dismiss (×) clears the card without sending.
- [ ] **Plan mode:** switch to Plan and ask for a multi-step improvement. A plan card renders with its steps and an Execute button. Click Execute — steps tick off live as the work streams, and the document updates.
- [ ] Reload the page — the plan card is still there, now rendered as completed (ticks preserved, no Execute button).
- [ ] **Agent mode:** switch to Agent and request a destructive change — it executes immediately, with no approval card.
- [ ] **Stop:** send a request that produces a long reply and click Stop mid-stream. The reply halts immediately, the partial text remains, and the composer returns to normal. Immediately send another message — it must stream normally and not be killed by the late stop.
- [ ] Repeat the whole pass once with an Arabic thesis in an Arabic UI — the panel docks on the correct side, cards and their text render RTL, and the mode popover opens aligned to the correct edge.

- [ ] **Step 5: Record results**

Note any failures for follow-up rather than fixing inline — this plan's definition of done is the checklist above passing, not the code merely compiling.

---

## Definition of done

- `npx tsc --noEmit`, `npm test`, and `npm run build` all exit 0 in `~/modakerati-dashboard`.
- A student can switch modes and see the choice take effect on the next message.
- In `assist` mode, a destructive request produces a visible approval card, and both Approve and Cancel stream a real continuation. **The silent dead end is gone.**
- The assistant's questions render as answerable cards.
- In `plan` mode, a proposed plan renders as a card, Execute streams the work, steps tick live, and the card returns as historical after a reload.
- Stop halts a reply immediately without stranding the next send.
- `/app` shows Kwill orange; `/d` is visually unchanged.

## Explicitly not done here

- Chat attachments — image/file upload in the composer (Plan 4).
- Chat search and older-message pagination (Plan 5).
- `POST /api/chat/continue-turn` — general-purpose turn resumption, not required by anything in this plan.
- `error.tsx` route boundaries — the same consistently-accepted gap as Foundation and Plan 2a.
