# Kwill Web — Interactive Frames, Chat Modes, and Brand (Plan 3) Design

**Status:** Approved, not yet planned. Follow-up to the shipped Plan 2a (chat panel core), which merged to `master` in `~/modakerati-dashboard` on 2026-08-27.

**Repo:** `~/modakerati-dashboard` (Next.js 16, App Router, React 19, Tailwind v4, TypeScript, Vitest).

**Prior art this builds on:** `docs/superpowers/specs/2026-08-26-kwill-web-chat-panel-design.md` (the chat panel design, whose "Plan 2b" section is superseded and absorbed by this document).

---

## Why this increment exists

Plan 2a's stream parser silently strips every control frame it does not recognize — a deliberate, safe default at the time. But three of those stripped frames are how the assistant *asks the student for something*, and one of them fires in the **default** chat mode:

- `assist` is the server's default mode for every thread (`chatThreads.mode` defaults to `"assist"`). In that mode, a destructive document tool does not execute — the server parks it and emits `[[MODK_CONFIRM]]`, ending the turn to await approval.
- Because the web client strips that frame, the turn currently ends with **nothing visible**: no prompt, no edit, no error. A student asking for a destructive change on the web today hits a silent dead end.

That makes this increment a live-bug fix, not only a feature port. The mode switcher, the plan card, and the brand-colour correction ride along because they are the same interaction layer and would otherwise each need their own cycle.

## Goal

A student on the web can choose how the assistant behaves (Ask / Plan / Assist / Agent), answer the assistant's questions and approval requests inline, execute a proposed plan and watch its steps tick off, stop a runaway reply, and see Kwill's real brand colour rather than the staff console's.

## Scope

**In:**

1. Brand palette correction, scoped to the `/app` route tree.
2. Chat-mode switcher (four modes) in the composer.
3. `MODK_CONFIRM` — approval card with Approve / Cancel.
4. `MODK_ASK` — question card with option chips and optional free text.
5. `MODK_PLAN` / `MODK_PLAN_STEP` — plan card with Execute and live step ticks, rendered from both the live stream and message history.
6. Stop-mid-generation button.

**Out (deferred, each its own later increment):**

- Chat attachments — image/file upload in the composer (Plan 4). Genuinely separate: needs upload endpoints, blob storage, and the mobile app's "an attached .docx becomes a *source* first" subsystem, which the web app has no equivalent of.
- Chat search and older-message pagination beyond the initial page (Plan 5).
- `POST /api/chat/continue-turn`. Research confirmed it is general-purpose turn resumption, **not** required for mode switching or plan execution.
- `error.tsx` route boundaries — the same consistently-accepted gap as Foundation and Plan 2a.

---

## 1. Brand palette

**Problem.** The mobile app's brand primary is `#F59433` (orange), defined once in `~/modakerati/constants/colors.ts` and consumed via `useThemeColors()`. The dashboard's `--primary` is `#5C6BFF` (indigo) in dark and `#4D5CEB` in light — the staff console's own palette, which the student-facing `/app` tree inherited by accident when Foundation reused `globals.css`.

**Constraint.** `src/app/globals.css` is imported once in the root layout and applies to **both** `/d` (staff console) and `/app` (student). Editing `--primary` globally would rebrand the staff console too.

**Decision.** Follow the precedent already established in that same file by `.landing`, `.guide`, and `.legal`, which each scope their own palette without touching `/d`: add a wrapper class on the `/app` workspace layout and override the brand tokens inside it.

| Token | Current (`/d` keeps) | `/app` becomes | Source |
|---|---|---|---|
| `--primary` | `#5C6BFF` dark / `#4D5CEB` light | `#F59433` (both themes) | `constants/colors.ts` `brandPrimary` |
| `--primary-light` | `#7A8CFF` / `#5C6BFF` | `#FFB166` dark / `#C2670C` light | `brandPrimaryLight` |
| `--accent` | `#33D6A6` / `#26B88C` | unchanged — already matches `brandAccent` | — |

Semantic colours (`--success`, `--warning`, `--danger`) already match the mobile app's `semanticSuccess`/`semanticWarning`/`semanticError` values exactly and need no change.

Only the brand tokens are overridden. Backgrounds, surfaces, text, and borders already match the mobile app's values and stay as they are.

## 2. Chat-mode switcher

### What a mode actually does (server-confirmed)

`ChatMode = "ask" | "plan" | "assist" | "agent"`. Each mode changes tool visibility, an approval gate, a system-prompt suffix, and a step budget:

| Mode | Write tools | Destructive gate | Max steps | Behaviour |
|---|---|---|---|---|
| `ask` | hidden | n/a | 8 | Read-only. Answers questions, cannot edit. |
| `plan` | hidden | n/a | 16 | Read-only, but prompted to call `propose_plan` instead of editing. |
| `assist` | visible | **gated** | 32 | **Default.** Edits freely; destructive tools park for approval via `MODK_CONFIRM`. |
| `agent` | visible | ungated | 64 | Edits immediately, no approval prompts. |

### How mode is read and changed

- **Read:** `ThreadSummary.mode` is already on the wire and already in the web client's types from Plan 2a. No new fetch is needed to know the current mode.
- **Change:** there is **no** mode endpoint. `PATCH /api/threads/:id` whitelists only `title`/`pinned`/`archived`/`thesisId`. Mode is changed by sending a `mode` field in the body of the next `POST /api/chat/stream` call; the server resolves it (request value wins over stored value) *and* writes it back to `chatThreads.mode` as a side effect. Unrecognized values fall back silently rather than erroring.

This means the switcher is pure local state until the student's next message — which is the correct and only available semantics, not a compromise.

### UI

A pill chip in the composer (mirroring mobile's placement) showing the active mode's icon and label. Clicking opens a popover listing all four with icon, label, and a one-line hint. The chip is disabled while a turn is streaming.

Icons follow the mobile app's choices via `lucide-react`: `ask` → `MessageCircleQuestion`, `plan` → `ClipboardList`, `assist` → `Sparkles`, `agent` → `Zap`. Mobile gives only `agent` a brand-colour accent — the deliberate signal that "runs on its own, no prompts" is the state worth noticing. Web mirrors that.

Labels and hints are trilingual, reusing the mobile app's own wording where a translation already exists (`chatModes.*` keys in `~/modakerati/locales/`).

## 3. The two frame families

The single most important structural fact for this design:

**`MODK_CONFIRM` and `MODK_ASK` are ephemeral.** The server's `stripOwnFrames` removes both before a message is persisted. They exist only in the live stream.

**`MODK_PLAN` and `MODK_PLAN_STEP` persist.** They are deliberately *not* stripped, so they survive in `chat_messages.content` and come back raw from `GET /api/threads/:id/messages`.

Consequences:

- Confirm and ask cards are rendered from live-stream state only, and legitimately disappear on page reload. Accepted, not worked around: the pending action itself survives 30 minutes server-side, and approving after expiry degrades gracefully (the server streams a continuation asking the model to re-read and re-propose, rather than erroring).
- Plan cards must be parsed out of **message history** as well as the live stream, and their display state reconstructed across messages.

### 3a. `MODK_CONFIRM`

Payload:

```json
{
  "kind": "confirmAction",
  "actionId": "3f0a…-uuid",
  "toolName": "replace_text",
  "preview": {
    "kind": "replace_text",
    "data": { "find": "methodologie", "replace": "méthodologie", "count": 12 },
    "text": "Replace «methodologie» with «méthodologie» (12 occurrences)"
  }
}
```

`preview.data` is a free-form per-tool record. `preview.text` is a ready-to-display English fallback line, already scrubbed of block indices server-side.

The turn **ends** at this frame. The server first yields `preview.text` as ordinary stream text, so the student sees a prose description even before the card renders.

**Rendering:** a card below the message list showing `preview.text` and two buttons.

- **Approve** → `POST /api/chat/confirm-action` with `{ actionId }`.
- **Cancel** → `POST /api/chat/cancel-action` with `{ actionId }` — a *separate endpoint*, not an `{approved:false}` flag.

Both return the **identical chunked plain-text stream** as `/api/chat/stream`, same frame protocol and same surrogate escaping — so `consumeChatStream` is reused verbatim. This is exactly the reuse Plan 2a's Task 7 was designed for.

The pending action is a DB row consumed atomically on first response; a double-tap returns `404 {"error":"Action not found or already handled"}`, which the client treats as "already handled" and dismisses the card rather than showing an error.

### 3b. `MODK_ASK`

Payload:

```json
{
  "question": "أي شكل تفضل لصفحات الفواصل؟",
  "options": ["خاتم ثماني", "أرابيسك"],
  "allowFreeText": false,
  "previews": [
    {
      "id": "tpl_octagon",
      "label": "خاتم ثماني",
      "description": "إطار هندسي",
      "previewUrl": "/api/divider-templates/tpl_octagon/preview"
    }
  ]
}
```

`options` and `allowFreeText` are always present; `previews` appears only for the richer `ask_user_with_previews` tool. `previewUrl` is a server-relative path the client fetches with its own auth — the same problem Foundation already solved for document images by appending the access token as a query parameter, and the same solution applies.

The turn **ends** at this frame, and the server also yields the question as ordinary text first. A `MODK_ASK` frame is always the last bytes on the wire.

**Answering requires no endpoint.** The student's answer is an ordinary next message on `/api/chat/stream` carrying the chosen option's label (or free text). Option chips therefore just call the existing send path with the label as the message.

**Rendering:** the question with its options as chips. With previews, each chip carries its thumbnail and description. `allowFreeText: false` disables the composer while the card is live, since a typed answer would not be understood; `true` leaves it enabled alongside the chips.

Per the established product rule that every AI question is dismissible, the card carries a dismiss affordance that clears it locally without sending anything.

### 3c. `MODK_PLAN` and `MODK_PLAN_STEP`

Plan payload:

```json
{
  "id": "3f2c…-9ab1",
  "title": "تحسين الفصل الثاني",
  "steps": [
    { "title": "Rewrite the intro paragraph", "detail": "Tighten the research question" },
    { "title": "Fix the citation style" }
  ]
}
```

`detail` is omitted when blank. There is no status field and no timestamps. The id is server-minted.

Step payload:

```json
{ "planId": "3f2c…-9ab1", "index": 0, "note": "Rewrote the opening paragraph" }
```

Three non-obvious facts that shape the implementation:

1. **Step ticks land in different messages than the card they belong to.** Correlation is by `planId`, never by position, and the client must fold ticks across the whole thread into a `Record<planId, PlanStepProgress[]>`.
2. **Ticks are neither dense nor ordered.** Step 3 can tick before step 2. Look each step up by its `index`; never assume a completed prefix.
3. **`[[MODK_PLAN]]` is a string prefix of `[[MODK_PLAN_STEP]]`.** Step frames must be matched first or a naive parser mis-splits them. The mobile app hit this and handles it explicitly.

The server's own parser validates only `id: string` plus `Array.isArray(steps)` for plans, and `planId` non-empty plus `Number.isInteger(index) && index >= 0` for steps, skipping malformed frames rather than throwing. The web parser mirrors that tolerance — a half-streamed frame must never crash the panel.

**Executing:** `POST /api/chat/execute-plan` with `{ threadId, planId }` — **both** ids required; the server re-reads the plan out of the thread's own stored messages and 404s on an unknown id with no newest-plan fallback. The response is again the same chunked stream, reusing `consumeChatStream`.

Unlike confirm/cancel, executing a plan **costs a message** and can return `402 { code: "quota_exhausted" }` — so it reuses Plan 2a's existing quota-banner handling.

There is no cancel-plan endpoint. Dismissal is cosmetic; "ask for changes" simply focuses the composer, matching mobile.

**Executed-vs-offered state.** No server flag exists, no plan table exists, and mobile's own tracking is in-memory (a reloaded mobile app re-arms the Execute button too). The one durable signal is whether any step-tick names that `planId` — the inference the server itself uses internally to detect a running plan. Web adopts the same rule: **ticks present ⇒ render as executed/historical; no ticks ⇒ render as an actionable offer.** A plan that was executed but produced no ticks will re-arm; that matches mobile's behaviour and is accepted.

**Interaction with Plan 2a's frame stripping.** Plan 2a's final review added `MODK_PLAN`/`MODK_PLAN_STEP` to `stripPersistedFrames` so raw JSON would not leak into the chat as literal text. That stays — the frames are still stripped from the *markdown body*. This increment adds a separate extraction pass that pulls the same frames out as structured card data before the body is stripped. Strip for display, extract for rendering; the two are complementary, not contradictory.

## 4. Stop mid-generation

`POST /api/chat/stop` with `{ threadId, turnId? }`. Response is always `{ ok: true, stopped: number }`; `stopped: 0` is normal, not an error. Omitting `turnId` aborts every live turn on the thread. Partial text is **persisted**, not discarded, and a turn stopped before producing output is not billed.

**The web client mirrors mobile's deliberate two-half pattern**, for a documented reason: abort the local fetch **first and synchronously**, so the UI never waits on the network, then fire the endpoint fire-and-forget with both rejection branches swallowed. Mobile adopted this because a hung reader could otherwise leave the UI stuck forever.

Two behaviours to carry over:

- A **dropped socket is not a stop.** The server treats a disconnect as "disconnected", not "aborted" — only this endpoint aborts the turn. The client must not call `/stop` on an incidental stream error.
- Because `/stop` cancels whatever is live on the thread, **the next send must briefly wait for a pending stop to settle** (mobile allows up to 1.5 s), or a late-arriving stop can kill the *new* turn instead of the old one.

This requires threading an `AbortController` through `postChatStream`, which Plan 2a did not have. That same controller is what an unmount can use to cancel an in-flight turn — closing a gap Plan 2a's own review flagged, where a stream kept running after navigation.

## 5. Component architecture

New, under `src/features/chat/`:

| Unit | Responsibility |
|---|---|
| `lib/plan-frames.ts` | Parse `MODK_PLAN`/`MODK_PLAN_STEP` out of persisted content; fold ticks by `planId`. Pure, unit-tested. |
| `components/ConfirmCard.tsx` | Approve/Cancel card for one pending action. |
| `components/AskCard.tsx` | Question, option chips, optional previews, dismiss. |
| `components/PlanCard.tsx` | Plan title, steps with tick state, Execute or historical rendering. |
| `components/ModeChip.tsx` | Mode pill plus its popover. |
| `lib/chat-modes.ts` | The four modes, their labels/icons/hints, and the `ChatMode` union. |

Modified: the control-frame parser gains four recognized kinds; `ChatPanel` owns the new card state and the abort controller; `Composer` gains the mode chip and the stop button; `student-browser.ts` gains the four new endpoint callers.

The existing `consumeChatStream` is **unchanged** — every new endpoint returns the same stream shape it already handles. That was the explicit design intent when it was built, and this increment is its first real test.

## 6. Error handling

Consistent with Plan 2a's established behaviour:

- Endpoint failures surface through the existing `sendError` banner with a real, operation-specific retry action.
- A `404` on confirm/cancel means "already handled" — dismiss the card silently rather than showing an error.
- A `402` on execute-plan reuses the existing quota banner.
- Malformed frame payloads are skipped, never thrown, matching the server's own tolerance.

## 7. Testing

Unit tests (Vitest) for the pure logic, which is where the real risk lives:

- Plan/step frame extraction: the prefix-collision hazard, out-of-order ticks, ticks split across messages, malformed payload tolerance.
- The executed-vs-offered inference.
- The extended control-frame parser: the four new kinds parse; unknown kinds still strip safely.

Component rendering and the endpoint callers are covered by the existing `tsc` + build gate plus a manual smoke pass, matching how Plan 2a's UI layer was verified. This repo has no component-test harness, and this increment does not add one.

## 8. Definition of done

- `npx tsc --noEmit`, `npm test`, and `npm run build` all exit 0.
- A student can switch modes and see the choice take effect on the next message.
- In `assist` mode, a destructive request produces a visible approval card; Approve and Cancel each stream a real continuation. **The silent dead end is gone.**
- The assistant's questions render as answerable cards.
- In `plan` mode, a proposed plan renders as a card, Execute streams the work, steps tick live, and the card returns as historical after reload.
- Stop halts a reply immediately without stranding the next send.
- `/app` shows Kwill orange; `/d` is visually unchanged.

## Open questions

None. Every contract in this document was read from `~/modakerati-server` and `~/modakerati` source during design, not inferred.
