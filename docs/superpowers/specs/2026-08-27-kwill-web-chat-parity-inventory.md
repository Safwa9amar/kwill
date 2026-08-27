# Kwill Web Chat — Full Parity Inventory

**Status:** Living tracker. Created 2026-08-27 after a full audit of the mobile chat surface (`~/modakerati/components/chat/`, `components/workspace/`, `app/(app)/chat.tsx`, `lib/ai-service.ts`) against the shipped web port (`~/modakerati-dashboard/src/features/chat/`).

**Why this exists:** the instruction was "copy all chat features, all of them, don't miss any one." This file is the checklist that makes that auditable. Nothing is done until it is ticked here.

## Already shipped on web

Foundation + Plan 2a + Plan 3, all merged to `master`:

- Streaming replies, batched at 90 ms
- Markdown rendering (content only — **not** styled, see D1)
- `modk://b/N` block links that scroll the document
- Thread history: list, switch, create
- Chat modes: Ask / Plan / Assist / Agent
- `MODK_CONFIRM` approval card (Approve / Cancel)
- `MODK_ASK` question card (chips, previews, free text)
- `MODK_PLAN` / `MODK_PLAN_STEP` plan card with live checklist
- Stop mid-generation
- Quota-exceeded banner (blocking only — see D19)
- "Thinking…" indicator (static label only — see B5)
- Brand palette scoped to `/app`

---

## Batch A — "it looks broken" ✅ SHIPPED 2026-08-27

Merged to `master` in `~/modakerati-dashboard`. Plan: `docs/superpowers/plans/2026-08-27-kwill-web-chat-batch-a.md`.

Also landed alongside it, from the "share the app's logic" directive: six pure-logic files copied **verbatim** from `~/modakerati/lib/` — `retry.ts`, `turn-work.ts`, `thread-groups.ts` (into `src/features/chat/lib/`) and `block-links.ts`, `search-match.ts`, `text-normalize.ts` (into `src/lib/doc/`). Each carries a "keep in sync by hand" header and is byte-identical below it. They are not wired up yet, but they hand Batch B its retry policy (B2) and continue-vs-regenerate logic (B3/B4) without re-deriving them.

- [x] **A1. Markdown styling.** Lists have no bullets, tables no borders, code no card, headings render at body size. The panel has *zero* chat CSS today. → `components/Markdown.tsx` (M)
- [x] **A2. File download cards.** `[[MODK_FILE]]` is stripped, so the assistant says "the download card should appear" and nothing does. Format badge, size, page count, Download. → `components/FileCard.tsx` (S)
- [x] **A3. Image rendering in replies.** `[[MODK_IMG]]` is stripped. Grid of thumbnails in the bubble. → `components/ChatImages.tsx` (M)
- [x] **A4. Live thinking trace.** `MODK_THINK` text is captured then discarded. Should stream in a fading window and collapse to "Thought for 45s". → `components/ThinkingTrace.tsx` (M)
- [x] **A5. AI working note.** Spinning mark + m:ss clock + escalating copy at 25 s / 90 s, so a three-minute tool run isn't mistaken for a hang. → `components/AiWorkingNote.tsx` (M)
- [x] **A6. Scroll pinning + scroll-to-latest.** The list currently yanks to the bottom every 90 ms while a reply streams, fighting anyone reading back. → `app/(app)/chat.tsx` `handleScroll` (S)
- [x] **A7. Long-answer collapse.** Clip at 1200 chars with a gradient fade, expand, full view. → `MessageBubble.tsx`, `MessageViewer.tsx` (S)
- [x] **A8. Welcome / empty state.** A blank pane today. Art plus two CTAs. → `ChatWelcome.tsx` (S)
- [x] **A9. Loading skeletons.** Layout-shaped placeholders, never a spinner (a standing product rule). → `ChatSkeleton.tsx` (S)
- [x] **A10. Time dividers.** "Today 3:51 PM" between sittings, on a 30-minute gap. → `TimeDivider.tsx` (S)

## Batch B — turn robustness

What keeps a turn from dead-ending.

- [ ] **B1. Failed-send handling.** Web *deletes* the student's message and shows a global banner. Mobile keeps the message with "Not sent" + Try again. → `MessageBubble.tsx`, `ai-service.ts` (M)
- [ ] **B2. Auto-retry, 4 attempts** with backoff, gated on `!docChanged && !producedOutput` so a turn that already edited the document is never re-run. → `lib/retry.ts` (M)
- [ ] **B3. Regenerate.** Re-run a bad answer; truncates locally and tells the server to drop the reply. → `ai-service.ts` (M)
- [ ] **B4. Continue-turn.** *Finish* a half-done turn instead of re-applying its edits. Never offered alongside Regenerate. → `lib/turn-work.ts`, `POST /api/chat/continue-turn` (M)
- [ ] **B5. Turn survives backgrounding.** Close the tab, come back to the finished answer. `markTurnInterrupted` + a `[0, 1.5 s, 4 s, 8 s]` resume poll that never retries and never marks failed. → `ai-service.ts` `resumeInterruptedTurns` (M)
- [ ] **B6. 409 `continue_instead`** silently becomes a continuation rather than an error. → `ai-service.ts` (S)

## Batch C — message actions and attachments (C2, C3, C5 ✅ SHIPPED 2026-08-27)

Plan: `docs/superpowers/plans/2026-08-27-kwill-web-chat-batch-c.md`. C1 deferred until Batch B lands its turn-work logic (its Regenerate/Continue entries depend on it); C4 still open.

Web-only deviations, recorded so they are not mistaken for gaps: no Camera button (meaningless on a desktop panel) and no Paste button (Ctrl/Cmd+V is handled natively by the composer instead).

- [ ] **C1. Message actions row.** Nothing sits under an answer today. Destination chips (Writer, Library) plus an overflow with Share, View full, View PDF, Download Word / PDF, Tasks. LaTeX shows disabled "soon". → `MessageActions.tsx` (L)
- [x] **C2. Image attachments.** Attach / paste / camera, up to 4, thumbnails in the bubble, full-screen viewer. → `lib/chat-images.ts` (L)
- [x] **C3. Document attach → source.** Attaching a .docx or PDF uploads it to the thesis's **sources** first, so the AI can actually read it. → `app/(app)/chat.tsx` `uploadAttachmentAsSource` (M)
- [ ] **C4. In-chat PDF preview.** Full-screen viewer with an honest progress bar. → `ChatPdfViewer.tsx` (M)
- [x] **C5. Voice dictation.** Mic appends a transcript to the composer. Web equivalent is the Web Speech API. → `lib/voice.ts` (S)

## Batch D — threads, history, quota

- [ ] **D1. Load older messages.** Web shows the last 5 **forever** — no pagination at all. → `ai-service.ts` `loadOlderMessages` (M)
- [ ] **D2. Thread search.** Server-side full-text search with match snippets. → `ChatHistoryPanel.tsx` (M)
- [ ] **D3. Thread rename / pin / archive / delete.** None of it exists on web. → `ChatHistoryPanel.tsx` (M)
- [ ] **D4. Thread grouping + timestamps.** Pinned / per-thesis / unattached sections, relative times, attach badge. → `lib/thread-groups.ts` (S)
- [ ] **D5. Suggestion chips.** AI quick-actions that *fill* the composer, never send it. → `hooks/useComposerSuggestions.ts` (S)
- [ ] **D6. Quota banner recovery + upgrade link.** Web's block is unrecoverable for the session and offers no way out. Mobile distinguishes blocked from low, makes low dismissible, and links to `/subscription`. → `QuotaNotice.tsx` (S)
- [ ] **D7. Thesis attach flow.** An unattached conversation plus one-tap attach. Web is always thesis-scoped, so this may be **N/A** — decide before building. → `ThesisAttachSheet.tsx` (M)

## Judged not applicable to web

Recorded so they are not mistaken for oversights:

- **Chat head / overlay panel** (`components/ChatHead.tsx`, `ChatOverlayPanel.tsx`) — a draggable floating bubble that expands chat over any screen. A mobile paradigm; the web has a docked panel.
- **Copy and read-aloud** on messages — deliberately removed from the mobile app, not missing from it.
- **`maintainVisibleContentPosition`** — a React Native FlatList primitive; the web needs its own scroll-anchoring approach (folded into A6 / D1).

---

## Sequencing

Batch A first: it is what makes the panel read as broken today, and every item is small or medium. Then B (a turn that dead-ends loses work), then C, then D.

Each batch gets its own plan under `docs/superpowers/plans/`, and its items are ticked here on merge.
