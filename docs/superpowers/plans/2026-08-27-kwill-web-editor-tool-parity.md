# Kwill Web Editor — Tool Parity Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every tool the app's editor offers exists in the web editor. Nothing dropped, nothing silently "soon" that is wired on the phone.

**Companion to:** `2026-08-27-kwill-web-editor-port.md` (Plan 4), which ported the document surface, the eleven bubble toolsets, the four AI surfaces and the page view. This plan closes what Plan 4 left.

---

## The audit

Taken from the app's own sources, not from memory:

- `components/workspace/ribbon/ribbon-config.ts` — the declarative tool catalogue
- `components/workspace/insert/insert-blocks.ts` — the Insert palette
- `lib/ai-dock-scopes.ts` — the dock's scopes and actions
- `components/workspace/bubble-tools/*` — the eleven bubble toolsets
- `components/*Sheet.tsx`, `components/workspace/*Panel.tsx`

### ✅ Already at parity (Plan 4)

| Surface | Evidence |
|---|---|
| Document surface — every decorator node, 13 plugins, the stylesheet | lifted verbatim |
| The eleven bubble toolsets | chip-for-chip; counts verified against each app file |
| Inline suggestion · range rewrite · ghost completion · table proposals | `useAiSurfaces` + the three stores |
| Page view (Word-style sheets) | `buildPageSetup` ported verbatim |
| Write-back, autosave, doc ops | `planOps` → `/ops`, `doc-ops.ts` |
| Bubble host — follow-caret, drag, dismiss, brand | `BubbleBar` |

### ❌ The gap — 46 ribbon tools, 9 dock scopes, 22 insert kinds, 12 panels

**1. The ribbon — 46 tools across 7 tabs.** Not started.

| Tab | Tools | ids |
|---|---|---|
| layout | 8 | margins · orientation · size · columns · breaks · indent · spacing · lineNumbers |
| design | 7 | themes · fonts · paraSpacing · watermark · pageColor · pageBorders · thesisReady |
| insert | 11 | table · picture · shapes · chart · textBox · header · footer · pageNumber · pageBreak · symbol · footnote |
| references | 10 | toc · updateToc · footnote · endnote · citation · citationStyle · bibliography · caption · figuresList · crossRef |
| table *(contextual)* | 3 | insertRow · insertCol · headerRow |
| picture *(contextual)* | 5 | replace · crop · rotate · removeBg · caption |
| heading *(contextual)* | 2 | promote · demote |

⚠️ `ribbon-config.ts` carries a `status: "wired" | "soon"` per tool. **Port the status honestly** — a tool the app marks `soon` must not appear wired on the web, and one marked `wired` must not be dropped.

**2. The AI dock — 9 scopes.** `lib/ai-dock-scopes.ts` is already ported to `features/editor/lib/`; the UI is not.

Scopes: `chrome · memoir · table · image · chart · heading · emptyParagraph · paragraph · range · scattered`.
Actions: Rewrite · Improve · Shorten · Expand · Summarize · Translate · Recolour · Format · Review.
Components: `AIDock` (134) · `ScopeHeader` (68) · `ActionRow` (138) · `AskBar` (64) · `useDockSuggestions` · `send.ts`.

**3. The Insert menu — 22 block kinds.** `insert-blocks.ts` ports verbatim (pure data).

| Category | Kinds |
|---|---|
| text | h1–h6 · quote |
| styles | normal · title · subtitle · intenseQuote · noSpacing |
| lists | bullet · number |
| media | table *(soon)* · figure · pasteImage · divider *(soon)* |
| academic | equation · toc *(soon)* · footnote *(soon)* |
| layout | pageBreak |

UI: `BottomInsertDrawer` (520) + `BlockComposer` (293). `SlashPlugin` and `insert-menu-store` are already ported and wired.

**4. Panels and sheets — 12 surfaces, ~4,600 lines.**

| Surface | Lines | What it owns |
|---|---|---|
| `HeaderFooterSheet` | 733 | running header/footer editing, templates, the ✦ flow |
| `DockToolsSheet` | 738 | the dock's full tool sheet |
| `ThesisOutlinePanel` (+`OutlineChrome` 178, `OutlineReorderable` 305) | 830 | Structure / Tables / Figures |
| `CaptionSheet` | 669 | Word's Insert Caption — label, position, numbering |
| `EquationSheet` | 552 | OMML/LaTeX editing |
| `SearchPanel` | 398 | find/replace + semantic |
| `SourcesSheet` | 304 | attached sources |
| `AskBottomSheet` | 247 | the standalone ask |
| `PictureCropModal` | 229 | interactive crop |
| `PeekCard` | 184 | the before/after glance |
| `HistorySheet` | 148 | document history |
| `ProposalStepper` (103) · `MathPreview` (52) | 155 | proposal steps, math preview |

**5. Modes.** `ReorderPlugin` and `SelectPlugin` are ported and mounted but have **no toggle** — `reorderActive` / `selectActive` are never set true.

---

## Order of work

Sequenced by what a student loses most by not having.

### Phase 1 — Reach (the tools exist but cannot be opened)

**Notes from execution:**
- Select mode must OWN the selection while it is on (`checkedIndices` in `useToolbarCtx`). The app's warning is worth repeating: a tap on a row still reaches the browser, Lexical turns it into an update, and the editor faithfully reports that ONE block — which replaces the whole pick. Every checkbox lands and is instantly undone, so the selection is always exactly one, always the last row touched.
- `computeMatches` caps at `MAX_MATCHES` and reports `capped` ITSELF — do not re-slice its result, or the "500+" ceiling gets decided in two places.
- The equation preview must come from the SERVER (`/equations/preview`). It is the same renderer that writes the OOXML, so what is previewed is what is saved; a client-side typeset would show a different equation from the one stored.
- A caption INSERT shifts every later block index by +1. The echoed `document` is the only trustworthy view afterwards, and it must drive a full RESEED — an in-place patch would leave the editor addressing blocks the server has already moved.

- [x] **Task 1: Mode toggles.** DONE — Wire `reorderActive` and `selectActive` to real controls beside the Pages toggle. Both plugins already work. ⚠️ The range rewrite is guarded on CONTIGUITY — keep that check when select mode builds a multi-block pick.
- [x] **Task 2: `CaptionSheet`.** DONE (as `CaptionPanel`) — The `onEditCaption` handler is already threaded through `ToolbarCtx`; three chips (paragraph, image, chart) render disabled without it.
- [x] **Task 3: `EquationSheet`.** DONE (as `EquationPanel`) — Same — `onEditEquation` is threaded and unbuilt. ⚠️ Per [[equations-omml-rendering]] the historical bug here was DATA LOSS; verify a round-trip preserves an equation before closing.
- [x] **Task 4: `SearchPanel`.** DONE — `openSearch` is threaded; `SearchHighlightPlugin` and `search-store` are ported. Panel only. Keep the offset-mapped Arabic normalisation.
- [ ] **Task 5: `HeaderFooterSheet`.** `onOpenHfBand` / `onAddHeaderFooter` are threaded. ⚠️ `SHOW_SECTION_MARKER` is currently `false` in `core/doc-sync.ts`, which is the only way IN to the section bubble — decide deliberately whether this sheet is that door instead.

### Phase 2 — The Insert menu

- [ ] **Task 6:** Port `insert-blocks.ts` verbatim (22 kinds, incl. their `status`).
- [ ] **Task 7:** Build the menu (compact + full, live filter, session recents). `SlashPlugin` already fires `onInsertTrigger`; `INSERT_BLOCK_COMMAND` round-trips the choice.

### Phase 3 — The ribbon

- [ ] **Task 8:** Port `ribbon-config.ts` (191 lines, pure data — no RN imports, validated in isolation) and `useContextualTab.ts`.
- [ ] **Task 9:** Build the shell: `RibbonTabBar`, `RibbonToolStrip`, `RibbonToolButton`, `RibbonSearch`, `RibbonFavorites`.
- [ ] **Task 10:** Build the four popover kinds the catalogue declares: `preset`, `segment`, `grid` (`GridSizePicker`), and the plain `action`. `PresetListPopover` + `SegmentPicker`.
- [ ] **Task 11:** Wire the dispatcher by `actionKey`. **A `soon` tool must read as soon** — the app routes those to the AI bridge rather than pretending.
- [ ] **Task 12:** Contextual tabs (table / picture / heading) driven by the live selection.

### Phase 4 — The AI dock

- [ ] **Task 13:** `ScopeHeader` + `ActionRow` + `AskBar` over the already-ported `resolveDockScope`. ⚠️ It is called PURE during render (its own doc comment) — a store round-trip shows one frame of the previous scope on every selection change.
- [ ] **Task 14:** `useDockSuggestions` + `send.ts`.
- [ ] **Task 15:** `DockToolsSheet`.

### Phase 5 — The rest

- [ ] **Task 16:** `ThesisOutlinePanel` — three tabs, as a real sidebar. This is what replaces the dropped `DrawerSwipePlugin`; `scrollToIndex` is already a prop.
- [ ] **Task 17:** `PictureCropModal` — `onRotateFlip` / `onRemoveBg` are threaded, crop is not.
- [ ] **Task 18:** `PeekCard` + `ProposalStepper` + `MathPreview`.
- [ ] **Task 19:** `SourcesSheet`, `HistorySheet`, `AskBottomSheet`.

### Phase 6 — Close it out

- [ ] **Task 20: The parity sweep.** Walk the app beside the browser and tick every row of the audit above. A tool that exists but is disabled counts as MISSING unless the app disables it too.
- [ ] **Task 21: i18n.** Copy the strings from `~/modakerati/locales/*.json` verbatim. ⚠️ Those files hold ~155 duplicate keys each and `JSON.parse`/`stringify` silently drops them — extract surgically, never round-trip.

---

## Rules that hold for every task

1. **Copy, do not reinvent.** Anything RN-free — configs, catalogues, stores, pure helpers — ports verbatim. Only the render layer is rewritten.
2. **Port the `status` honestly.** `soon` on the phone stays `soon` on the web.
3. **Optional handlers, not silent no-ops.** A chip whose handler is missing renders *disabled* — that is why the audit can tell "built" from "reachable".
4. **Gate:** `npx tsc --noEmit && npx vitest run && npx next build` after every task.
5. **Write files whole.** Scripted patching of the large chrome files has corrupted them twice, once to 880k lines. Rewrite rather than patch.
