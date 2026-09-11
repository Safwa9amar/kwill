# Migrate the Writer from Lexical to the docx-editor (@docx-editor.dev)

**Date:** 2026-09-10
**Status:** Design approved for Phase 1; later phases re-planned at their start
**Repos touched:** `~/kwill` (app), `~/kwill-server` (two routes, one DTO field), `~/kwill-dashboard` (nothing — it already hosts the same editor at `/app/[id]/word`)
**Plan:** [2026-09-10-docx-editor-migration.md](../plans/2026-09-10-docx-editor-migration.md)

## Problem

The Writer is Lexical inside an Expo DOM component ([components/workspace/lexical/](../../../components/workspace/lexical/), 7,506 lines plus [lib/page-layout.ts](../../../lib/page-layout.ts) and the pagination plugin). It edits a **projection** of the .docx: the server flattens the document into `DocBlockDTO[]`, the app builds a Lexical tree from that, and every edit is diffed back into positional ops (`lib/lexical-writeback.ts` → `POST /:id/ops`). Pagination is DOM-measured against geometry the server computes (`fmt`, `PageSetup`), and it is documented as an approximation ([page-view spec](2026-08-12-page-view-in-writer-design.md), D1: "formatting truth, not precision").

The docx-editor trial ([kwill-dashboard `/app/[id]/word`](../../../../kwill-dashboard/src/features/editor/docx-editor/WordEditorTrial.tsx), and since 2026-09-10 the app's own `word-native` screen) lays the document out itself — HarfBuzz-shaped measurement from real font bytes, its own line breaker and paginator — and paints real pages with real running headers, footers, footnotes, equations and pictures. The question the trial was built to answer ("does this hold for OUR Arabic theses?") is now answered well enough to plan on, with one known limit (D9, fonts).

## Goal

The student edits the thesis in the docx-editor, inside the app, with **nothing the Lexical Writer offers lost**: the native bubble and its eleven toolsets, the ✦ dock, inline AI proposals, range rewrite, table proposals, completion, search, insert menu, outline navigation, `modk://` links, equation/caption/header-footer sheets, chart editing, undo/redo (local and AI), scroll restore, offline-safe saving.

## Non-goals

- Changing what the AI does or how it addresses the document. Tools stay server-side and index-addressed ([.docx is the only content model](../../../../kwill-server/); [AI never shows indices]).
- Two-way collaboration or a CRDT. One student, one device at a time, and the AI as a serialized second writer (D4).
- Porting this back to the web app in this plan. The DOM component is browser code; the dashboard hosts the same packages already. Reuse is a follow-up.

## Decisions

**D1 — The server stays the source of truth; the block model stays the AI's address space.** The editor is a new *surface* and a new *student-edit write path*, not a new content model. `GET /:id/document` (the DTO), every AI tool, every sheet endpoint and `modk://b/N` are unchanged.

**D2 — The student's edits travel as WHOLE BYTES, not ops.** `editor.save()` → `PUT /:id/docx` (exists: `persistThesisDocx` under the thesis lock, history snapshot, doctor repair). `lib/lexical-writeback.ts`'s LCS→ops planner is deleted with Lexical: the engine holds the real OOXML, so there is nothing to reconstruct. *Consequence:* the durable op queue is no longer the student's path; offline safety moves to D6.

**D3 — Every server-side mutation is followed by a RELOAD of the bytes into the editor.** AI turns, equation/caption/header-footer sheets, chart edits, table proposals, range rewrites, image insert/replace/crop/remove-bg, history undo/redo. One primitive — `reloadFromServer()` — replaces Lexical's `reseed`/`inPlacePatch`/`skipReseed`/`forceReseed` machinery. It is byte-exact by construction, and conditional (`If-None-Match` on the document hash) so a no-op is one 304.

**D4 — Saves carry `If-Match: <docHash>`; a stale save is refused (412), never merged.** The server already keeps `theses.docHash`. The AI is serialized against typing by the existing `flushEdits` contract (ai-service awaits it before a turn starts); a 412 therefore only arises from a second device or the web, and the answer is "reload, keep the student's unsaved bytes as a recovery copy, tell them" — not a silent overwrite. This closes the "last-writer-wins" caveat the trial route documents.

**D5 — The native chrome keeps its contract.** `BlockContextBar`, `FloatingPill`, `AIDock`, the ribbon, `BottomInsertDrawer`, `DockToolsSheet` and `ai-service` talk to the editor through `lexical-editor-store` (`dispatch({type,value,nonce})` in, `LexicalState` out, `flushEdits`, `canUndo/canRedo`). The docx surface speaks that same contract, so the twelve callers are untouched in Phase 1. The store is renamed in Phase 5, when only one surface is left.

**D6 — Offline safety lives in the WebView.** Pending bytes are written to IndexedDB inside the DOM component (`lib/idb.ts` exists on the web side; the WebView's storage survives an app kill) and replayed on the next open with the same `If-Match` rule. Simpler than the SQLite op queue, and the bytes are the truth rather than a replayable description of it.

**D7 — Index ↔ engine identity is PARSED, never constructed.** The engine stamps every node with `/word/document.xml#<doc>.<body>.<blockIndex>…`; the third segment is the body-child index, which is the DTO block index *as of the load* (verified in [ChartLayer.tsx](../../../../kwill-dashboard/src/features/editor/docx-editor/bubble/ChartLayer.tsx) against real theses). Engine → index is `blockIndexFromId()`. Index → engine goes through `findMatches(blockText)` filtered by parsed index, then `scrollToBlock`/`selectMatch`. After a save that changed paragraph structure (`DocumentChange.created/deleted` non-empty) the surface reloads, so the invariant is re-established rather than tracked.

**D8 — Text-level AI results apply LOCALLY; structural ones apply on the SERVER and reload.** Paragraph rewrite (inline suggestion) and completion accept → `replaceMatch`/`insertText` in the editor, then a normal save. Table proposals, range replace, chart, image, caption, equation, header/footer → the existing endpoints, then D3. Text edits are constant and must be instant; structural ones are rare and already have tested server paths.

**D9 — Arabic fidelity comes from BUNDLED font bytes, not Google Fonts.** `FontConfiguration.sources[].bytes` accepts our own faces with `substitutions` and `lineMetrics`. Ship OFL Naskh faces (Scheherazade New, Noto Naskh Arabic, Amiri) as `require()` assets — the form Expo documents as EAS-Update-safe for DOM components — and map Traditional Arabic / Sakkal Majalla / Simplified Arabic / Arabic Typesetting onto them. `loadDefaultFonts()` is never used (its `new URL(…, import.meta.url)` cannot resolve under Metro). Pagination will match Word only as closely as the substitute's metrics allow; that limit is stated in the UI's font notice, not hidden.

**D10 — Pagination, pages, running headers/footers, footnotes are the engine's.** `PaginationPlugin`, `build-bands`, `buildPageSetup`, `lib/page-layout.ts`, the chrome bands and `showPages` are deleted in Phase 5. The page view spec's D1–D6 are superseded: fidelity is now the engine's real layout.

**D11 — Two Lexical features are dropped, on purpose.** Gutter drag-to-reorder (the engine has no block move; the bubble's ▲▼ chips remain, via the server `move` op + reload) and the ghost-text completion *inside the paragraph* (it becomes a floating "continue…" chip under the caret; accept inserts at the caret). Both are recorded here so they are not re-litigated as regressions.

**D12 — Strangler rollout behind a flag.** `settings-store.writerEngine: "lexical" | "docx"` (Settings → Developer). Phases 1–4 ship both surfaces; Phase 5 flips the default, then deletes Lexical.

## Feature map — what each Lexical feature becomes

| Lexical feature (file) | docx-editor equivalent | Phase |
|---|---|---|
| `LexicalDomEditor` shell + `EditorBridge` (command in / state out) | `DocxEditorDom` + `bridge/` (same `LexicalCommand`/`LexicalState` contract) | 1 |
| `$blocksToLexical` / `$lexicalToBlocks` / `planOps` write-back | none — bytes in, bytes out (`save()` → `PUT /docx`) | 1 |
| `reseed` / `inPlacePatch` / `skipReseed` / `forceReseed` | `reloadFromServer()` (conditional on `docHash`) | 1 |
| `flushEdits` (awaited before an AI turn) | same registration; awaits the pending debounced `PUT` | 1 |
| `scrollToIndex` (outline drawer, `modk://` links, deep link) | `findMatches` by text filtered on `blockIndexFromId` → `scrollToBlock` | 1 |
| `onState.y` → pill anchor | `window.getSelection()` range rect → same `y` | 1 |
| Undo/redo (`HistoryPlugin` + `canUndo`) | `history.undo`/`history.redo` slots; `EditorSnapshot` availability | 1 |
| `PaginationPlugin`, page bands, `PageSetup`, `AnchorGeometry` | engine layout (pages, headers, footers, floating shapes) | 1 (inherent) |
| `SuggestionPlugin` (inline proposal card) | overlay card anchored on the paragraph rect; approve → `replaceMatch` | 2 |
| `RangeSuggestionPlugin` | overlay card over the range; approve → server `replace-range` → reload | 2 |
| `CompletionPlugin` (ghost text) | floating chip under caret; accept → `insertText` at caret (D11) | 2 |
| Table proposal diff (`TableProposalContext`) | overlay diff card on the table rect; approve → `/ops` tableOp batch → reload | 2 |
| `EquationTapPlugin` → EquationSheet | engine renders OMML; tap → `EquationSheet` → server → reload | 3 |
| Chrome bands → HeaderFooterSheet | `getHeaderFooterState()` tap → same sheet → `chromeOp` → reload | 3 |
| Chart placeholders | port web `ChartLayer` (SVG overlay from DTO) + existing `ChartToolbar` → server → reload | 3 |
| `SearchHighlightPlugin` + SearchPanel | `findMatches` / `selectMatch` / `replaceMatch`; semantic hits → scroll by index | 3 |
| `SlashPlugin` + `BottomInsertDrawer` | caret-text watcher in the DOM; text kinds → engine style/list; structural kinds → server op → reload | 3 |
| `PasteImagePlugin` | paste listener → native reads clipboard → server insertImage → reload | 3 |
| `SelectionHighlightPlugin` / `SelectPlugin` (checkbox mode) | overlay checkboxes on paragraph rects (same positioning as ChartLayer) | 4 |
| `ScrollSyncPlugin` + `editor-scroll-store` | anchor = `{index, text, delta}`; restore by match → `scrollToBlock` | 4 |
| `KeyboardModePlugin` (`inputmode`) | `contenteditable` `inputmode` toggle on the engine's content root | 4 |
| `DrawerSwipePlugin` | same touch heuristics on the viewport | 4 |
| `ReorderPlugin` | dropped (D11); ▲▼ chips stay | — |
| Durable SQLite op queue (for the student's edits) | IndexedDB pending-bytes queue in the WebView (D6) | 4 |
| Amiri-only Arabic | bundled Naskh faces with substitutions (D9) | 4 |
