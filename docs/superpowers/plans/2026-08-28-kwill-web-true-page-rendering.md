# Kwill Web — True-Page Rendering in the Editor (Plan 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The web editor's visible, editable surface renders the thesis at **its own** geometry and typography — page size and margins read per-section from the document, real point sizes, real line spacing, real space-before/after, real fonts, real indents — so what the student types on *is* the page. Plus a zoom control (fit-width default).

**Scope:** `~/modakerati-dashboard/src/features/editor` and the server's format resolver. **Web only** — the phone keeps its readable 15px reflow and its simulated page view, because a 390px screen cannot show a 794px sheet at true size without unusable zoom-out.

**Builds on:** Plan 4 (`2026-08-27-kwill-web-editor-port.md`), Plan 5 (tool parity).

---

## Read this before Task 1

### The one fact that shapes this whole plan

True-size rendering **already exists in this codebase** — it runs offscreen and throws the pixels away.

`core/measure.ts:100-112` renders every block at the document's real point size, real line rule and the true text column (~601.7px for A4 at 1"):

    clone.style.fontFamily = rtl ? "sans-serif" : '"Liberation Serif", Georgia, serif';
    clone.style.fontSize   = `${fmt.sizePt * PX_PER_PT}px`;
    clone.style.lineHeight = `${lineHeightPx(fmt, singleLinePx(host, fmt.sizePt, rtl))}px`;

…inside a `visibility:hidden` host, purely to learn each block's height, which feeds `paginate()`. Meanwhile the VISIBLE editor renders at `font-size: 15px; line-height: 1.7` (`core/styles/base.ts:71-72`).

The DTO says it outright (`lib/doc-types.ts:141-143`): *"what the MEASURING host paginates with. **Display typography is untouched.**"*

**So the page view today is a simulation:** correct break positions, fake page appearance. This plan stops rendering the truth offscreen and a lie onscreen.

Do NOT write a fresh measurement or typography layer. The rules already exist in `lib/page-layout.ts` (`geometryFromSection`, `lineHeightPx`, `PX_PER_PT`) and are verifiable off-device via `scripts/verify-page-layout.mjs`.

### What is already right, and must not be "fixed"

- `lib/page-layout.ts` `geometryFromSection()` already derives the true text column and content height from a section's twips, **including the binding gutter**. It is correct and pure. It is simply not wired to the visible sheet.
- `paginate()` / `numberPages()` are pure and tested. This plan changes what feeds them, never their rules.
- The sheet chrome already exists: `--lx-page-w/h`, `--lx-pad-*`, paper-on-desk shadow, page bands. Only the NUMBERS are hardcoded.

### Facts verified against source — do not re-research

**The server resolves exactly four fields.** `~/modakerati-server/src/lib/para-format.ts:28-34`:

    export type ParaFmt = { sizePt; line: {rule, value}; beforePt; afterPt }

Not resolved, and required for a truthful page: **font family** (`w:rFonts`) and **indentation** (`w:ind`). Both walk the same `basedOn` cascade the resolver already walks for spacing — `parseStyles` / `resolveChain` / `cascadeNumber` are reusable as-is.

**The bidi rule is established and load-bearing.** A paragraph with `<w:bidi/>` reads `w:szCs` at every cascade level, never `w:sz` (`para-format.ts` header; same `w:cs` rule as `thesis-rtl.ts`).

Fonts mirror that `cs`/`ascii` split — but UNLIKE size, the resolver emits **both** faces and the renderer orders them (Task 6). A mixed-script line (an Arabic sentence quoting a French term) needs the other face as its fallback, so collapsing to one at resolve time would lose it. Bidi ordering is the renderer's job, not the resolver's.

**Two `w:txbxContent` traps already handled — preserve them.** A paragraph's own `w:pPr` must be the first one AND precede any `<w:txbxContent`; the run scan must strip `<w:txbxContent>` blocks first. Any new run-level scan (fonts) inherits both traps.

⚠️ **Self-scheduling pagination KILLS AUTOSAVE.** The native side resets its serialize timer on every editor report, so a self-feeding measure→insert→measure loop holds it permanently reset and the student's writing is never saved. The `tags.has(PAGES_TAG)` early-return is what stops it. Do not add a re-measure loop.

---

## Task 1 — ✅ DONE — Server: resolve `w:rFonts` and `w:ind` through the cascade

- [x] Extend `ParaFmt` in `~/modakerati-server/src/lib/para-format.ts`:
      `font?: { ascii?: string; cs?: string }` and `ind?: { startTwips; endTwips; firstLineTwips }`.
- [x] Add `extractFonts(xml)` reading `w:ascii` / `w:hAnsi` / `w:cs` off `<w:rFonts>`; add `extractIndent(xml)` reading `w:start`/`w:left`, `w:end`/`w:right`, `w:firstLine`, `w:hanging`.
- [x] `w:start`/`w:end` are the logical (2010+) spellings of `w:left`/`w:right` — prefer the logical when present, fall back to the physical.
- [x] Per ECMA-376 §17.3.1.12, when both `w:hanging` and `w:firstLine` are present, **hanging wins** and yields a NEGATIVE first-line indent.
- [x] Widen `StyleRecord` to carry both; extract them in `parseStyles` from the style's own `pPr` (indent) and `rPr` (fonts), using the SAME rPr-scope exclusion already there (a style's `w:rPr` is a sibling of its `w:pPr`, and a `w:pPr` can carry a paragraph-mark `w:rPr`).
- [x] Cascade both direct → style chain → docDefaults, per field, reusing `cascadeNumber` for the indent numbers.
- [x] Direct fonts come from the paragraph's OWN runs (first `<w:rFonts>`), stripping `<w:txbxContent>` first — same guard as `largestOwnRunSize`.
- [x] Both fields are OPTIONAL on the type: an older cached DTO has neither, and the web must render sensibly without them.

**Verify:** `cd ~/modakerati-server && npx vitest run src/__tests__/para-format.test.ts`

## Task 2 — ✅ DONE — Server: tests for the new cascade

- [x] Extend `src/__tests__/para-format.test.ts` (its `STYLES` fixture already has docDefaults + a `basedOn` chain + a cycle guard — add `w:rFonts` and `w:ind` to it rather than writing a second fixture).
- [x] Cover: docDefaults font reaches a bare paragraph · a `basedOn` child inherits the parent's font and overrides indent · direct `w:pPr` beats the chain · `w:hanging` beats `w:firstLine` and goes negative · a bidi paragraph reads `w:cs` not `w:ascii` · a nested `w:txbxContent` font does NOT leak into the host.
- [x] Confirm the existing four assertions still pass unchanged — `toEqual` on the whole object will now see the new keys, so update those to `toMatchObject` ONLY where the new fields are genuinely absent.

**Verify:** `npx vitest run src/__tests__/para-format.test.ts src/__tests__/doc-selection.test.ts`

## Task 3 — ✅ DONE — Web: mirror the widened type

- [x] Widen `fmt` in `src/features/editor/lib/doc-types.ts` to match `ParaFmt` exactly, keeping the "older cached DTOs predate it" note and marking the new members optional too.
- [x] Widen `BlockFmt` in `src/features/editor/lib/page-layout.ts` to carry them.
- [x] Add `TWIPS_TO_PX` as an exported helper there (the constant already exists privately) so the indent conversion has one home.

**Verify:** `cd ~/modakerati-dashboard && npx tsc --noEmit`

## Task 4 — ✅ DONE — Web: page geometry comes from the document, not from constants

- [x] `core/styles/base.ts` currently hardcodes `--lx-page-w: 794px`, `--lx-page-h: 1123px`, `--lx-pad-x/t/b: 96px`. Keep them as the A4 FALLBACK only.
- [x] Drive the live values from `geometryFromSection(section.page)` — the same function the measuring path already uses — set as inline custom properties on the editor root.
- [x] Geometry is PER SECTION (a landscape section is a different sheet). `PageSetup.sections[]` already carries per-section geometry; a page band is where a new section begins, so the band is where the vars change.
- [x] Honour the binding gutter, which `geometryFromSection` already subtracts.

## Task 5 — ✅ DONE — Web: apply `fmt` to the VISIBLE node (the actual change)

- [x] In the paragraph renderer, set `fontSize` from `fmt.sizePt * PX_PER_PT`, `lineHeight` from `lineHeightPx(fmt, singleLinePx(...))`, `marginTop` from `fmt.beforePt * PX_PER_PT`, `marginBottom` from `fmt.afterPt * PX_PER_PT` — the SAME four conversions `measure.ts` already performs on the clone.
- [x] Apply `fmt.ind` as `paddingInlineStart/End` + `textIndent` (logical props, so RTL mirrors without a second code path).
- [x] Drop the generic `font-size: 15px; line-height: 1.7` from `.lx-content` and the fixed `.lx-p/.lx-h1/.lx-h2/.lx-h3` sizes — those are exactly the "fixed sizes" this plan removes. Keep them as a fallback for blocks with no `fmt` (tables, images, stale caches).
- [x] ⚠️ Blocks with NO `fmt` must still render. Do not let a missing field collapse a paragraph to 0.

## Task 6 — PARTIAL — Web: make the real fonts actually load

> **Partially delivered in Task 5.** `fmtToCss` already carries the Word→stack map
> (`FONT_STACKS` in `lib/page-layout.ts`) and emits it direction-ordered, so a machine
> that HAS the real face renders correctly today. What remains is SHIPPING the
> metric-compatible webfonts so a machine without them matches too, and the
> `--lx-leading` probe.

- [x] Map Word font names → loadable web faces (Times New Roman → Liberation Serif, which `measure.ts` already assumes; Arial → Liberation Sans; plus the Arabic faces a mémoire actually uses).
- [x] ⚠️ Per the app's WebView-font finding, a generic family (`sans-serif`) does NOT resolve Arabic correctly — the stack must name a CONCRETE family.
- [x] Compose the CSS stack in bidi order: `cs` family first for an RTL paragraph, `ascii` first otherwise, so a mixed-script line falls back correctly.
- [ ] ⚠️ `measure.ts` clears BOTH caches when fonts become ready — a measurement taken in the fallback face is poisoned. The visible render now shares that dependency: re-measure on `document.fonts.ready`, exactly once.

## Task 7 — ✅ DONE — Web: zoom control (fit-width default)

- [x] Add a zoom store + control: `fit-width` (default), `100%`, `page-width`, and 50–200%.
- [x] Apply as a CSS transform on the sheet. `#container { transform-origin: top center }` is the established pattern in `WordDocxView.tsx` — reuse the approach.
- [x] ⚠️ Caret placement, selection rects and the bubble's `y` anchor are all in VIEWPORT pixels. Under a scale transform they must be divided by the zoom factor or the bubble drifts further from the caret the further down the page it is. Verify at 50% and 200%, not just 100%.
- [x] Keep the existing responsive collapse (`max-width: 100%` below ~890px) as the floor.

## Task 8 — Web: pagination measures the live surface

- [ ] With the visible editor at true geometry, the offscreen `.lx-measure` host is measuring what the screen already shows. Read heights from the live DOM and delete the duplicate render.
- [ ] Keep `paginate()` and `numberPages()` untouched — pure, tested, off-device verifiable.
- [ ] ⚠️ Preserve the `tags.has(PAGES_TAG)` early-return and the debounced measure→insert cadence. Do NOT introduce a re-measure loop (see the autosave warning above).
- [ ] If live measurement proves unstable mid-edit, KEEP the offscreen host — but make it inherit the same computed typography, so the two can no longer disagree.

**Verify:** `node scripts/verify-page-layout.mjs` (server-side rules unchanged) and a real-document page-count comparison against the OnlyOffice PDF `/Count`, which is the existing oracle for true pagination.

---

## Definition of done

- [ ] `npx tsc --noEmit` clean in `~/modakerati-dashboard`; `npx vitest run` green in `~/modakerati-server`.
- [ ] A real Arabic thesis and a real French thesis both render at their own margins, fonts and point sizes, and their page COUNT matches the OnlyOffice PDF render.
- [ ] Bubble, insert menu, inline suggestion, range rewrite, table editing, undo/redo and search all still work — this plan changes rendering, not the editing model.
- [ ] Zoom verified at 50% / 100% / 200% with the caret and bubble landing correctly at each.

---

# Phase 2 — Word-exact pass (2026-08-28, after first on-device comparison)

Side-by-side screenshots of the same thesis in Word and the web editor showed four
concrete gaps. Each was traced to a root cause in code — none is cosmetic guesswork.

**Diagnosis:**
1. **Body renders sans-serif; Word shows Times New Roman.** The document names its
   fonts with THEME attributes (`w:asciiTheme="minorHAnsi"`, `w:cstheme="minorBidi"`),
   which `extractFonts` (literal `w:ascii`/`w:cs` only) never sees. The actual
   typefaces live in `word/theme/theme1.xml` (`a:fontScheme` → major/minor × latin/cs),
   a part the resolver never opens. Result: `fmt.font` is absent and the
   `.lx-root { font-family: sans-serif }` fallback wins the entire document.
2. **Headings render as big black `.lx-h*` defaults; Word shows blue bold ~13pt.**
   A heading's color and weight come from its STYLE's `rPr` (`w:color`, `w:b`) —
   the DTO's `runs[]` carry only DIRECT run props, so style-derived appearance
   never reaches the client. (`w:color` conveniently writes the computed hex in
   `w:val` even when `themeColor` is set, so no theme color math is needed.)
3. **Line spacing looser than Word.** The `--lx-leading` probe was never built
   (Task 6 leftover) so `auto` spacing multiplies the 1.15 guess; AND the offscreen
   measurer hardcodes Liberation Serif / generic sans — different metrics than the
   visible node now that it renders the real face → pagination drifts.
4. **The section-header band** ('Introduction') renders as bold dark UI chrome;
   Word shows a small, muted running head.

## Task 9 — ✅ Server: theme font resolution
- [x] `buildFormatResolver(stylesXml, themeXml?)` — parse `a:fontScheme` once:
      majorFont/minorFont × latin/cs typefaces (empty `typeface=""` → undefined).
- [x] `extractFonts` resolves theme slots: `minorHAnsi|minorAscii` → minor latin,
      `majorHAnsi|majorAscii` → major latin, `minorBidi` → minor cs, `majorBidi` → major cs.
      Literal attributes still win over theme attributes at the same level.
- [x] `resolverFor` (thesis-doc.ts) reads `word/theme/theme1.xml` via the same
      `zip.readAsText` mechanism as styles (getFileAsString is broken live).

## Task 10 — ✅ Server: style-cascade run appearance
- [x] `ParaFmt` gains `color?` (6-hex, `auto` skipped), `bold?`, `italic?` — resolved
      from the STYLE chain's rPr + docDefaults only, never from direct runs (those
      already ride per-run on `runs[]` and would fight per-run rendering).
- [x] Tri-state toggles: `<w:b/>` = on, `<w:b w:val="0|false"/>` = OFF (must emit
      `false`, not undefined — it has to override the `.lx-h*` 700 fallback).
- [x] Bidi reads `w:bCs`/`w:iCs` first, per level, falling back to `w:b`/`w:i`.

## Task 11 — ✅ Server: tests for both

## Task 12 — ✅ Web: mirror + emit appearance
- [x] Types mirrored (`doc-types.ts`, `BlockFmt`).
- [x] `fmtToCss` emits `color`, `font-weight` (700/400 — 400 matters, see toggles),
      `font-style`. `fontStackFor(fmt, rtl)` extracted as its own export.

## Task 13 — ✅ Web: document-wide font + real leading
- [x] `--lx-doc-font`: the document's majority body face, computed from the blocks,
      set on `.lx-root` (which now uses `var(--lx-doc-font, sans-serif)`) — so
      tables/captions/chrome (no fmt of their own) inherit the document's face.
- [x] `--lx-leading`: runtime probe of the doc font's natural leading (line-height
      normal at 100px), re-probed once on `document.fonts.ready`.

## Task 14 — ✅ Web: measurer uses the same face as the visible node
- [x] `measure.ts` fmt-branch fontFamily comes from `fontStackFor` (fallbacks keep
      the old behaviour); the single-line probe is keyed per family too.

## Task 15 — ✅ Web: section band reads as a running head, not UI chrome
- [x] `.lx-chrome-hdr-seg` toned to small/muted/inherit-face.

## Task 16 — ✅ Web: dark mode (user request, same pass)
- [x] Paper and ink became tokens on `.lx-root` (`--lx-paper`, `--lx-ink`); base
      values are the light sheet, so nothing changed for light.
- [x] New `CSS_DARK` chunk, appended LAST (order-is-load-bearing rule satisfied —
      theme overrides must lose to nothing). Answers both dashboard spellings:
      bare `:root` (no attribute = dark) via `:root:not([data-theme="light"])`,
      and explicit `[data-theme="dark"]`. Flips paper, ink, placeholder, page bands.
- [x] Document-authored text colors (heading blue, colored runs) are designed
      against WHITE paper — on dark they'd sit too close to the ground. The
      `[style*="color:#"]` selector catches exactly the elements fmtToCss /
      appendRuns gave an inline color and lifts them with
      `filter: brightness(1.6) saturate(.85)` — no per-color map to maintain.
- [x] The desk already followed `--surface`; untouched. The offscreen measure
      host is untouched — color has no metrics.

**Not code, but required to SEE any of it:** restart `modakerati-server` (the new
fmt fields exist only in the new process) and reload the dashboard. If sizes fix
but fonts don't, the DTO came from a stale cache predating the fields.

---

# Phase 3 — REMOVED (user decision, same day): the real Word view on the web

**Research first** (user asked): Google Docs abandoned DOM rendering for canvas in
2021 precisely because a word processor cannot trust a foreign layout engine —
they lay text out themselves and paint it. Word for the web renders HTML and
accepts the fidelity gap (its own support docs list the differences; printing
detours through a PDF). The 2026 open-source ceiling for HTML docx rendering is
still docx-preview; the higher-fidelity options are commercial SDKs, Microsoft's
hosted viewer (public URLs only — unusable for a private thesis), or OnlyOffice.
**Conclusion: the phone's architecture is already correct** — own editor for
editing (our measured pagination is the "own the layout" move), real-bytes layer
for truth. The web was missing the second layer.

> **REVERTED in full, same day.** The user's call: one surface — all investment
> goes into the native editor, no second read-layer to maintain. `word-view/`
> deleted, ThesisEditor/page.tsx wiring reverted, `docx-preview` restored to the
> `^0.4.0` the STAFF console's DocxPreviewModal already depended on (⚠️ it was a
> pre-existing dependency — an uninstall breaks `/d` template previews). The
> research stands: it is why the native editor owns its own measured layout.

## Task 17 — ❌ REVERTED — Web: WordView (docx-preview, lifted properly)
- [x] `word-view/match.ts` — the tap→block text-matching rules extracted from the
      app's injected-string script into pure, unit-tested functions (`normText`,
      `blockTapText`, `matchIndex` strict-before-loose, `highlightBudget`).
- [x] `word-view/WordView.tsx` — renderAsync over the signed `downloadUrl` with
      the app's exact RENDER_OPTS; double-buffered silent refresh keyed on the
      store's `tick` (whose own comment names this layer as its consumer);
      scroll preserved across swaps; white paper on the themed desk (the real
      bytes as printed — dark mode flips the desk, never the paper).
- [x] Better than the phone edition: npm deps instead of CDN `<script>` tags, real
      React instead of string injection, no WebView bridge, testable matching.
- [x] ThesisEditor: "Word" toggle beside the pages toggle. The Lexical editor
      HIDES but never unmounts (reseed cost); the bubble is gated off while the
      Word view is up; clicking a block in the Word view sets the editor's
      scroll target so toggling back lands where the student was looking.
- [x] `page.tsx` passes `doc.downloadUrl`; prop optional — no URL, no button.
- [x] Verified: tsc clean, 256/256 dashboard tests, production `next build` clean.

## Task 18 — ❌ DROPPED (same decision) — OnlyOffice viewer embed
- [ ] `GET /api/thesis/:id/editor-config` already returns the signed DocEditor
      config; a web embed needs the DS's `api.js` script and a reachable
      Document Server (LAN Docker, DHCP-fragile — see memory). Prefer it over
      docx-preview when enabled, exactly as the phone does.

---

# Phase 4 — Precision pass on the native editor (2026-08-28, "make it more precise")

## Task 19 — ✅ Word-parity defects that move line and page breaks
- [x] **Additive paragraph spacing.** Word ADDS space-after(¶A) + space-before(¶B);
      CSS COLLAPSES adjacent margins to the larger. Every 12pt-before heading after
      an 8pt-after body rendered 12pt where Word shows 20pt. Fix: fmtToCss emits
      space-before as `padding-top` (padding never collapses) + `margin-top:0`;
      measure.ts zeroes the clone's paddingTop (space-before still travels
      separately in `spaceBefore[]` for rule F3).
- [x] **Word's typographic defaults, stated explicitly.** Browsers kern and ligate
      by default; Word ships kerning OFF, no auto-hyphenation, no common ligatures —
      browser text runs a hair narrower, so lines (then pages) break elsewhere.
      `hyphens:none; font-kerning:none; font-variant-ligatures:no-common-ligatures`
      on BOTH `.lx-content` and `.lx-measure` (measured = visible = Word).

## Task 20 — Known precision limits, in priority order (not started)
- [ ] **Run-level sizes**: `ParaRun` has no size field — the server never extracts
      per-run `w:sz`. Line height is already right (paragraph sized by its largest
      run), but a mixed-size line renders visually uniform. Server DTO change.
- [ ] **Task 7 zoom** and **Task 8 live-surface measurement** still stand from Phase 1.
- [ ] Justification engine differences (Word's algorithm vs CSS `text-align:justify`)
      are not closable from CSS — accepted, this is why Word-web itself differs from
      desktop Word.

---

# Phase 5 — Zoom + tables like Word (2026-08-28)

## Task 21 — ✅ Zoom control (closes Task 7)
- [x] CSS `zoom`, NOT `transform: scale` — zoom participates in LAYOUT
      (standardized 2024), so the scrollbar, sheet centering and click targets
      stay honest. The measure host attaches to `document.body`, OUTSIDE the
      zoomed subtree, so pagination's numbers cannot be contaminated; rects read
      inside are viewport values, which is what the bubble (outside, unzoomed)
      wants — no divide-by-zoom anywhere.
- [x] Modes: `fit` (default — tracks the column via ResizeObserver on the
      scroller, clamped 50–200%) or a fixed percent. Toolbar: − / label / +;
      the label toggles fit ↔ 100%; steps leave fit from wherever fit sits.
- [x] UI chrome (bubble, panels) lives outside the zoom wrapper and stays
      UI-sized at any zoom — the same split Word makes.
- [ ] Verify on device: caret rendering at fractional zooms; reorder-drag delta
      math under zoom ≠ 1 (pointer deltas are visual px, HandlePlugin may apply
      them as layout px).

## Task 22 — ✅ Tables AutoFit to Window (user screenshot: sideways scrollbar)
- [x] The phone pattern (`width: max-content` in an `overflow-x` scroller) was
      right on a 390px phone and wrong on a true-size sheet. Word AutoFits: the
      table caps at the text column and cells WRAP.
- [x] Pure CSS in tables.ts: `.lx-tblscroll table { max-width: 100% }` +
      `td, th { overflow-wrap: anywhere }` (lowers the min-content floor so a
      long unbroken token — a `#N_Exp`-style key list — can break). Covers BOTH
      table builders; inline `width:max-content` stays load-bearing for narrow
      aligned tables (autofit-to-contents, never wider than the page). The
      scroller remains as a last resort only.
- [x] **FOUND AND FIXED — it was DATA LOSS, not render.** The missing spaces
      ("اسمالجدول") traced to mdocxengine's `parseXml` (`trim: true`) through
      `Table.fromXml`. TWO xml2js behaviours compound: trim deletes run-edge
      spaces, and whitespace-only text in an ATTRIBUTED node — Word's
      `<w:t xml:space="preserve"> </w:t>` — is dropped regardless of
      `includeWhiteChars`, unrecoverably. Because `mutateTable` round-trips
      fromXml → buildXml → SAVE, every table edit wrote the glued text back
      into the stored .docx — permanent loss, one table op at a time. Fix:
      `parseXml` gained `{trim:false}` (opt-in, other managers untouched);
      `Table.fromXml` sentinel-encodes each space of a space-only `<w:t>` body
      (U+E000, survives the parse) and restores real spaces in the parsed
      object — correct for every reader and for the save path, no decode at
      any exit. 3 new engine tests incl. the save round-trip; 860 engine tests
      green; engine rebuilt (`npm run build` — mandatory per memory).
      ⚠️ Already-glued documents are NOT healed — the spaces are gone from
      those files; the fix stops further loss. ⚠️ Server must be RESTARTED
      manually: mdocxengine is a `file:` symlink dep and tsx watch does not
      watch node_modules.

---

# Phase 6 — TOC renders like Word, navigates on click (2026-08-28)

Screenshot: every TOC line glued as "مقدمة5". A Word TOC entry is
`label<w:tab/>page` under `pStyle TOC1..TOC9`, with a `w:val="right"
w:leader="dot"` tab stop (the engine's own TableOfContentsManager writes exactly
this). BOTH text extractors read only `<w:t>`, so the tab vanished.

## Task 23 — ✅ Tabs reach the DTO
- [x] mdocxengine `paragraphText`: a run's `<w:tab/>` → "\t". ⚠️ `<w:pPr><w:tabs>`
      holds tab-stop DEFINITIONS (geometry, not characters) — the regex skips pPr
      spans WHOLESALE via alternation order, or every stop would read as a phantom
      tab. 2 engine tests; engine rebuilt.
- [x] server `runVisibleText` mirrors it (no pPr guard needed inside a run), so
      the runs===text invariant holds and `runs[]` carries the tab-only run.

## Task 24 — ✅ TocEntryNode (web)
- [x] `lib/toc-entry.ts` `tocEntryOf(styleId, text)` — TOC1..9 + split at the LAST
      tab (a numbered heading's own tab stays in the label). No tab (old cached
      DTO) → null → plain paragraph. 5 tests.
- [x] `TocEntryNode` DecoratorNode: label · dot leader (a flex-grow span with a
      dotted bottom border IS the tab — grows to push the number to the far stop,
      currentColor for dark) · page. `fmtToCss` on the host div so TOC1..9 sizes
      and indents come through. Atomic/non-editable ON PURPOSE: a TOC is a
      generated field Word overwrites on update; and a leadered right tab is not
      expressible inside a contenteditable flow. Serializes the ORIGINAL DTO
      verbatim (SuggestionNode/BlockDataNode precedent) → zero write-back diff.
- [x] Navigation: `TocNavigateContext` → KwillEditor `onTocNavigate` prop →
      ThesisEditor resolves label → heading (exact level>0, then any exact, then
      prefix; block-links rule: re-resolve by text, never trust an index) →
      `setScrollTo` with nonce.
- [x] **Number column ("always justify it").** TOC2 entries had their page
      number pushed in: the style's 220-twip start indent landed on the LEFT.
      `margin-inline-start` resolves against the element's OWN direction, and a
      decorator host has no `dir` (Lexical sets it on real paragraphs only) →
      `el.dir = b.direction` on the host. Also `align-items: last baseline`, so a
      wrapping label keeps its number on its LAST line, as Word does.
- [x] **Edit / delete.** Click = navigate; hover reveals ✎ ✕ (absolute on the
      host, outside the leader geometry, so the number column never moves);
      double-click also edits. Inline label + page inputs; Enter commits, Esc
      cancels. Both are PLAIN TREE MUTATIONS — `setPara` (text) / `remove()` —
      which the existing write-back diffs into `editText` / `deleteBlocks`. No new
      op plumbing; both undoable via Lexical history.
- [x] **Engine writes real tabs back.** `makeParagraphXmlLike` /
      `makeStyledParagraphXml` now emit `<w:tab/>` for "\t" (`runContentXml`),
      mirroring paragraphText's reading — an edited entry keeps its tab STOP
      working instead of a literal U+0009 in `<w:t>`. Round-trip tests. Engine
      rebuilt → manual server restart.
- [ ] Not done: the phone still renders "label\tpage" as a plain paragraph
      (improved from glued: the tab now shows as a gap). Port TocEntryNode there
      if wanted.

---

# Phase 7 — docx-editor TRIAL (2026-08-28, user: "I want to use their editor")

Evidence before commitment: eigenpal/docx-editor (Apache-2.0 core, ProseMirror
inside, DOM-free layout with HarfBuzz-shaped measurement from real font bytes)
mounted on the student's REAL thesis, inside our save pipeline, as its own route.

## Task 25 — ✅ Trial route, end to end
- [x] `npm i @docx-editor.dev/{react,core,fonts}` (2.12.0). `harfbuzz.wasm` copied
      from `@docx-editor.dev/core/harfbuzz.wasm` to `public/` and wired with
      `setHarfBuzzWasmUrl("/harfbuzz.wasm")` from `@docx-editor.dev/core/layout`
      BEFORE the first editor — without it the editor "reports wasmUnavailable and
      uses fixed measurement", which would make the trial measure nothing.
- [x] `src/features/editor/docx-editor/WordEditorTrial.tsx` — fetches `downloadUrl`
      bytes, `<DocxEditor document mode="edit" fonts colorMode zoomMode="auto">`,
      status strip (its own page count, font substitutions, save state).
      `WordEditorIsland.tsx` is the `dynamic(ssr:false)` boundary (App Router rule).
      Page: `/app/[thesisId]/word`. Entry: "Word · trial" link in the toolbar.
- [x] Fonts: `loadDefaultFonts()` (Carlito/Caladea/Liberation) merged with
      `googleFonts({ substitute: { Traditional Arabic|Simplified Arabic|Arabic
      Typesetting|Sakkal Majalla → Amiri } })` in one FontResolver.
      ⚠️ Amiri is the ONLY Arabic family in their catalog and is NOT
      metric-compatible with any of those — an Arabic thesis paginates like
      Amiri, not like Word. Known limit of the trial.
- [x] Server: `PUT /api/thesis/:id/docx` — whole-bytes save under `withThesisLock`
      via `persistThesisDocx({source:"manual"})` (history, doctor, storage, RAG,
      engine cache — same path as every mutation). Zip-magic + 60MB guard.
      ⚠️ LAST-WRITER-WINS: no merge against an AI turn that landed since load.
- [x] Client autosave: 1.5s debounce after `onChange` → `ref.save()` → PUT; Cmd+S
      via `onSave`. No reload-on-tick yet (the AI/editor race is by design
      unsolved in the trial).
- [x] Verified: tsc clean, 254/254 tests, production `next build` clean. One
      webpack WARNING: core's layout chunk uses top-level await and the build
      target "does not appear to support async/await" — cosmetic on modern
      browsers; a `browserslist` bump silences it if adopted.

## What the trial cannot answer, and what adoption would still cost
- Runtime fidelity on OUR docs is for the user's eyes: Arabic shaping via
  Amiri, equations (OMML: "layout and editing not built"), charts (placeholder),
  chapter dividers (`vAlign center` unsupported), cover-page shapes (placeholder).
- Adoption = the client owns the document. Every AI tool today mutates server
  bytes by block index; the student's open editor would need `ref.load(bytes)`
  after each AI op (losing caret/undo) or the AI would need their proprietary
  editor-api ($500/mo Pro). Bubbles, inline suggestions, range rewrite, ghost
  completion, table proposals, `modk://b/N` links, the op queue: none exist on
  that surface.

## Task 26 — ✅ VERIFIED: `w14:paraId` survives our engine — the integration is viable

The go/no-go check for injecting our tools onto docx-editor: caret restore after
an AI turn (`ref.load(bytes)` + `setSelection({paragraphId, offset})`) needs the
ids of UNTOUCHED paragraphs to be stable across mdocxengine's save.

Experiment (`scratchpad/paraid-survival.mjs`) on the real Arabic mémoire
`samples/مذكرة فتيحة حساني.docx` (805 paraId occurrences, 797 unique):
- `editParagraphText` (string-surgery path): the edited paragraph even KEPT its
  own paraId; zero others lost.
- `Doc.editTableCell` (the xml2js mutateTable path — the attribute-loss risk):
  exactly ONE id lost, and it is the edited cell's own paragraph (row 1 cell 1)
  — the same "edited content gets new identity" semantics Word itself has.
- The production doctor (`repairDocxBuffer`): zero ids lost.
- `xmlns:w14` declaration intact throughout.

**Verdict: untouched content is 100% id-stable through both edit paths and the
doctor.** The reload-with-caret-kept design works for imported (Word-authored)
theses.

⚠️ Caveat for the record: ENGINE-BORN documents have ZERO paraIds
(`assets/thesis-base.docx` counts 0) — a thesis created in Kwill rather than
imported gives docx-editor nothing to re-match after a reload. Follow-up if
adoption proceeds: stamp `w14:paraId` (random 8-hex, unique per doc) on every
paragraph the engine creates — Word-compatible and cheap — so Kwill-born docs
become id-stable too.

## Task 27 — ✅ (2026-08-29) The bubble, injected onto docx-editor

First of our tools on their surface, along the verified map — `TrialBubble.tsx`,
mounted as a CHILD of `<DocxEditor>` (their composition model provides the
editor context to children; the Pro review UI mounts the same way).

- [x] **Anchor**: the painted pages hold a REAL browser selection → viewport rect
      rebased against a `relative` host around the editor — the same trick the
      Lexical bubble uses. Shown on a non-collapsed selection in edit mode.
- [x] **State**: `useEditorState(selector)` — bold/italic/underline/alignment
      from `snapshot.formatting`, canUndo/canRedo; re-renders only on slice change.
- [x] **Chips → public commands**: `toggleMark {mark:"bold"|"italic"|"underline"}`
      (mark names read out of their built JS), `setAlignment`, `toggleList`,
      `clearFormatting`, `undo`, `redo`. `onMouseDown preventDefault` everywhere —
      a chip must never steal the document selection.
- [x] **✦ Ask-AI**: paragraph under caret from `[data-paragraph-id]` DOM →
      resolved to OUR block index BY TEXT (block-links rule) against `paraBlocks`
      (paragraph index+text, passed from the page's DTO) → the native editor's own
      `proposeBlockEdit` endpoint (`POST /paragraphs/:index/suggest`; token via
      `setSuggestToken`, same singleton the workspace installs) → preview card →
      **Apply = `useDocumentSearch` + `exec replaceMatch`** (match filtered by
      text equality, disambiguated by the caret paragraph's blockId; ambiguous →
      refused with a message, never a wrong-paragraph write). Card warns while
      unsaved changes exist (the AI reads the last SAVED bytes).
- [x] Verified: tsc clean, 254/254, production build clean.
- [ ] Untested at runtime (browser): selection-rect anchoring at their zoom
      levels; the search-debounce Apply latency (~300ms); RTL bubble position on
      Arabic selections.

