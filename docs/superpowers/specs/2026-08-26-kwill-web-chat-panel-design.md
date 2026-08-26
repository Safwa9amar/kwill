# Kwill web chat panel — Plan 2 of the Next.js web app

**Date:** 2026-08-26
**Status:** design approved, not yet planned
**Builds on:** `2026-08-25-kwill-web-nextjs-design.md` (spec) / `2026-08-25-kwill-web-nextjs-foundation.md` (plan) — the Foundation, merged to `master` and deployed to production in `~/modakerati-dashboard`.
**Ships as two plans:** Plan 2a (chat core) lands first as a complete, independently useful chat experience; Plan 2b (interactive frames) builds on it. Both are described here since they share one architecture — see "Two-plan split" below for exactly where the seam is.

## What ships

The docked AI chat panel on the workspace page (`/app/[thesisId]`), so a student can talk to the AI about their thesis the same way the mobile app does, and see the document update as the AI edits it — the single biggest gap left after the Foundation (which could only *view* a thesis, never *work on* it). Full parity with the app's control-frame vocabulary except `MODK_TOOL`.

**In scope:**
- A two-column workspace layout: the existing document renderer stays, a new chat panel docks beside it (RTL-aware — the correct side in Arabic, via CSS logical properties and the page's own `dir`, not hardcoded left/right).
- Sending a message and streaming the reply, parsing: `MODK_THINK` (reasoning trace, shown collapsed), `MODK_DOCCHANGES` (triggers a document refresh), `MODK_TITLE` (updates the thread's title live).
- Markdown-rendered replies (via `react-markdown` + `remark-gfm`), with `modk://b/N` links intercepted and wired to scroll the document panel to that block.
- Thread history: a collapsed-by-default strip above the chat showing the current thread's title; expanding it lists past threads for this thesis (most-recent first), letting the student switch or start a new one.
- The message-quota 402 (`code: "quota_exhausted"`) surfaced as an inline banner, same treatment as the Foundation's thesis-limit 402.
- `MODK_ASK`: the AI's clarifying question, rendered as option chips or (when the payload carries `previews`) a grid of preview cards, optionally with a free-text answer field.
- `MODK_CONFIRM`: the AI's destructive-action confirmation, rendered as an Approve/Cancel card, wired to the real `confirm-action`/`cancel-action` endpoints including consuming the continuation stream each one returns.

**Two-plan split:**
- **Plan 2a — chat core:** everything above except the last two bullets. This alone is a complete, working chat: a student can converse, watch the AI think, see edits land, retitle threads, and switch between past conversations. It also builds the one piece Plan 2b depends on: a shared, reusable "consume a chat-stream response" function (see Architecture).
- **Plan 2b — interactive frames:** `MODK_ASK` and `MODK_CONFIRM`, reusing Plan 2a's stream consumer against two additional endpoints.

**Explicitly deferred** (unchanged from the original spec, still out of scope here):
- Manual in-browser block editing.
- `MODK_TOOL` (dev-only tool-call tracing, gated server-side by `AI_SHOW_TOOLS` — no student-facing purpose).
- `POST /api/chat/continue-turn` (resuming a turn interrupted by a dropped connection) — a reliability feature, not a core interaction; a dropped stream in this plan just shows the retry affordance described under Error handling.
- Chat attachments (image/file upload into a message).
- Chat search (`GET /api/threads/search`).
- Payments/upgrade UI, the university/template onboarding wizard.
- Cross-thesis thread views ("unattached" threads, threads for a different thesis) — this plan only ever shows threads scoped to the current thesis, matching `GET /api/threads?thesisId=`.
- Per-tool localized confirmation templates — `ActionPreview.text` (the model's own description, explicitly documented server-side as "also what the model's bubble shows") is rendered directly; the app's separate per-tool-name localized-template layer on top of that fallback is not ported.

## Architecture

Everything the Foundation built was a Server Component with no client-side interactivity — the whole `/app` tree issues its API calls from the server, using the student's session cookie to mint a bearer token per request (`src/lib/api/student.ts`). Chat breaks that pattern deliberately, because streaming a reply into a live-updating UI is not something a Server Component can do:

- The workspace page (`src/app/app/(workspace)/[thesisId]/page.tsx`) stays a Server Component. It gains two more server-side calls — `getOrCreateThread(thesisId)` (`POST /api/threads/for-thesis`) and `getThreadMessages(threadId)` (`GET /api/threads/:id/messages`, first page only: `since`/`before`/`limit` per the server's pagination, mirroring the app's own `INITIAL_PAGE_SIZE=5`) — added to `src/lib/api/student.ts` alongside the existing `getThesisDocument`/`createThesis`/etc. Both results are passed as initial props into a new client component, so the chat has its history the instant the page paints, no loading spinner for the common case.
- A new Client Component, `ChatPanel` (`src/features/chat/components/ChatPanel.tsx`), owns everything interactive: the message list, the composer, streaming state, and thread switching. It is the first Client Component boundary anywhere in this route tree.
- `ChatPanel` talks to `modakerati-server` directly from the browser — not through a Next.js Server Action or API route. It reads the Supabase session via the existing browser client (`src/lib/supabase/client.ts`, already used nowhere yet outside auth) to get an access token, then does a plain `fetch("<server>/api/chat/stream", { method: "POST", body: ... })`. The response body is a real `ReadableStream` (unlike the mobile app's default RN `fetch`, which the app had to route around via `expo/fetch` — no such workaround exists or is needed here). A new client-safe helper, `src/lib/api/student-browser.ts`, wraps the token read; it does **not** import `"server-only"` and must never be imported from a Server Component.
- **The shared stream consumer (built in Plan 2a, reused by Plan 2b):** `POST /api/chat/stream`, `POST /api/chat/confirm-action`, and `POST /api/chat/cancel-action` all return the *identical* response shape — a chunked text stream carrying interleaved answer text and control frames. One function, `consumeChatStream(response, handlers)`, reads the body, decodes it incrementally, and drives the same set of callbacks regardless of which of the three endpoints produced it. Plan 2a only ever calls it after `/stream`; Plan 2b calls the same function after `/confirm-action`/`/cancel-action`. This is why 2b doesn't need its own stream-parsing logic — it needs new UI (the cards) and two new fetch call sites, nothing else at the transport layer.
- `src/features/chat/lib/control-frames.ts` is a pure, unit-testable parser: given a chunk of streamed text, it extracts `[[MODK_X]]...[[/MODK_X]]` spans for the frames this plan handles, and strips (never displays) anything else, including `MODK_TOOL` and any future frame this plan doesn't know about — an unrecognized frame degrading to "stripped" rather than "shown as raw brackets" is the safe default, mirroring how the mobile client already treats it. `MODK_THINK` carries plain text (raw reasoning tokens); `MODK_DOCCHANGES`, `MODK_TITLE`, `MODK_ASK`, and `MODK_CONFIRM` all carry a JSON payload between their open/close markers (`JSON.parse` the captured span) — `MODK_DOCCHANGES` is `{kind, turnId, checkpointSeq, tools}`, `MODK_TITLE` is `{threadId, title}` (not a bare title string).
- Replies render through `react-markdown` (new dependency) with `remark-gfm` for tables/strikethrough/etc., and a custom `a` renderer: a normal `https://` link renders normally; an `modk://b/N` href is intercepted and calls `document.getElementById(`block-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" })` — this works with zero new plumbing because every block component the Foundation built already carries `id="block-{index}"`, added specifically to make this possible later. A range href (`modk://b/11-20`) scrolls to the first index in the range.
- On `MODK_DOCCHANGES`, or when a turn completes normally, `ChatPanel` calls `router.refresh()` (`next/navigation`). This re-runs the Server Component tree for the current route — re-fetching the document via the existing `getThesisDocument` call — without a full page reload and without `ChatPanel` losing its own client-side state (message list, scroll position, open/closed thread history), since a refresh doesn't remount a Client Component whose position in the tree and props identity haven't changed.
- Thread history: `ChatPanel` fetches the full thread list for this thesis (`GET /api/threads?thesisId=`) lazily, only when the collapsed strip is expanded — not on initial page load, since the common case (the one active thread) is already in the initial props.

## Data flow — a normal message turn (Plan 2a)

1. Student types and submits. `ChatPanel` optimistically appends the user's message to its local list and opens a streaming request to `POST /api/chat/stream` with `{ message, threadId }`, consumed via `consumeChatStream`.
2. Plain text deltas are appended to a pending assistant message; `MODK_THINK`/`MODK_TITLE`/`MODK_DOCCHANGES` update dedicated state (a collapsed reasoning block, the live thread title, a "doc changed" flag) as they're parsed out of the stream.
3. Batching: exactly like the mobile app's `createStreamPump`, raw chunks are NOT applied to React state on every read — they're buffered and flushed on a fixed interval (matching the app's `FLUSH_MS = 90`) so a fast stream doesn't thrash re-renders.
4. On stream end: if the "doc changed" flag was set, or the turn completed without error, call `router.refresh()`.
5. A 402 response (checked before attempting to read a stream body) with `code: "quota_exhausted"` renders as a banner in place of the composer, not a crash — same pattern as the Foundation's thesis-limit handling.

## Data flow — MODK_ASK (Plan 2b)

`AskPayload`: `{ question: string, options: string[], allowFreeText: boolean, previews?: { id, label, description?, previewUrl }[] }`. This is stateless on the server — there is no parked row and no dedicated endpoint:

1. `consumeChatStream` hands the parsed payload to a handler; `ChatPanel` disables the composer and renders the question in its place: option chips from `options`, or — when `previews` is present — a card grid instead, each card's image loaded from `previewUrl` (an app-relative path) using the same authenticated-media-URL pattern the Foundation's `ImageBlock` already established (`?token=<access token>` query param, since these are plain `<img>` tags that can't carry an `Authorization` header).
2. If `allowFreeText` is true, a text field is also available.
3. Whatever the student picks or types is sent as an entirely ordinary next message — `POST /api/chat/stream` with that text as `message` — exactly step 1 of the normal turn above. No new endpoint, no payload shape beyond what Plan 2a already sends.

## Data flow — MODK_CONFIRM (Plan 2b)

`ConfirmPayload`: `{ kind: "confirmAction", actionId: string, toolName: string, preview: { kind: string, data: Record<string, unknown>, text: string } }`, backed server-side by a parked row with a 30-minute expiry.

1. `ChatPanel` disables the composer and renders `preview.text` with Approve/Cancel buttons in its place.
2. **Approve** → `POST /api/chat/confirm-action` with `{ actionId }`. **Cancel** → `POST /api/chat/cancel-action` with `{ actionId }`. (`provider`/`model`/`reasoning` are accepted by both routes but optional server-side; v1 omits them, letting the server fall back to the thread's own settings.)
3. Both routes return another full streamed reply — same shape as `/stream` — consumed by the same `consumeChatStream` function and appended to the same message list. This is not a fire-and-forget action button: the UI must show the AI "typing" again immediately after the tap.
4. No special client handling for an expired action: past the 30-minute TTL, `/confirm-action` transparently streams back a note asking the assistant to re-read the document and re-propose with fresh block indices, which flows through the consumer exactly like any other reply — the student sees the AI reconsider, not an error.

## Error handling

Consistent with the Foundation's accepted, not-yet-closed gap: there is still no `error.tsx` anywhere in this route tree, and this plan does not add one. A network failure *mid-stream* is a new failure shape the Foundation never had to handle (a Server Component either succeeds or throws before rendering; a stream can fail *after* partial content is already shown) — `ChatPanel` catches a stream read failure and renders a "message failed, retry" affordance inline in the chat list rather than letting a client-side exception blank the panel, since a client-side throw inside a mounted component is a materially worse failure mode (a broken panel that stays broken) than a Server Component throw (a full-page error at least reloads cleanly on retry). The same affordance covers a failed Approve/Cancel tap in Plan 2b.

## Testing

`control-frames.ts` is pure and gets real unit tests in both plans: Plan 2a covers `MODK_THINK`/`MODK_DOCCHANGES`/`MODK_TITLE` parsing, stripping unknown frames (including `MODK_TOOL`), and a frame split across two stream chunks — a real scenario given arbitrary chunk boundaries. Plan 2b adds JSON-payload parsing for `MODK_ASK`/`MODK_CONFIRM`, including a malformed-JSON payload (must degrade to "frame stripped," never throw and blank the panel). The block-link scroll behavior and the streaming fetch itself are not meaningfully unit-testable (they need a real DOM and a real stream) and get a manual smoke pass instead, same convention as the Foundation.

## Housekeeping

`react-markdown` and `remark-gfm` are new dependencies — the first added to `modakerati-dashboard` by this whole web-app initiative. No existing code in this repo uses either, so there's no compatibility surface to check beyond a clean install and build.
