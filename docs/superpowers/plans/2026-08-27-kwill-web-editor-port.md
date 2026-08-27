# Kwill Web — Port the Thesis Editor (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student on the web gets **the same editor they have on the phone** — the same Lexical document surface, the same bubble and its eleven toolsets, the same inline AI suggestion / range rewrite / ghost completion / table proposal, the same search, insert menu, outline, pagination, reorder and select modes — rendered as HTML + Tailwind inside `~/modakerati-dashboard` at `/app/[thesisId]`.

**Architecture:** The mobile editor is **already browser code**. `LexicalDomEditor.tsx` is an Expo DOM component (`'use dom'`): today it renders Lexical, real DOM and a plain CSS stylesheet inside a WebView. So the document surface is a **lift**, not a rewrite — 7,506 lines move across nearly verbatim. What actually gets rewritten is the *chrome* (bubble, toolbars, ribbon, dock, sheets), which is React Native, and whose **logic layer is already RN-free** (`stores/toolbar-store.ts`, `lib/bubble-configs.ts`) and therefore also lifts. The `'use dom'` serializable-props bridge is deleted: in a browser, native ≡ web, so `{type,value,nonce}` command envelopes collapse into direct dispatch through a shared editor handle.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `lexical` ^0.48, `@lexical/{react,rich-text,list,selection,utils}`, `mathjax-full`, `zustand` (already a dep), `lucide-react` (already a dep), Vitest.

**Builds on:** Plan 1 (`2026-08-25-kwill-web-nextjs-foundation.md`), Plan 2 (chat panel core), Plan 3 (interactive frames, modes, brand).

---

## Read this before Task 1

### The one fact that shapes this whole plan

Open `~/modakerati/components/workspace/lexical/LexicalDomEditor.tsx`. Its first line is `'use dom'`. Everything it imports — `blockLexical.tsx` (2,939 lines), `editor-components/` (4,212 lines) — runs today **in a browser engine**, against real DOM APIs, styled by a plain CSS string. There is no React Native in any of it.

That means:

| Layer | Lines | Port cost |
|---|---|---|
| Document surface (`blockLexical` + `editor-components`) | 7,506 | **Lift** — copy, fix import paths, delete the bridge |
| Pure helper libs (`page-layout`, `thesis-ops`, `lexical-writeback`, `table-diff`, `word-diff`, `thinking`, `doc-ornament`, `section-chrome`, `bubble-configs`, `mathjax-web`) | 2,435 | **Lift** — verified RN-free (grep in Task 2) |
| Editor stores (Zustand) | 1,859 | **Lift** — Zustand is platform-neutral |
| Chrome (`BlockContextBar`, `bubble-tools/`, `ribbon/`, `ai-dock/`, `FloatingPill`) | 5,171 | **Rewrite render layer only**; logic lifts |
| Ancillary sheets (`SearchPanel`, `ThesisOutlinePanel`, `PictureCropModal`, `HistorySheet`, …) | 4,625 | **Rewrite render layer only** |

Do not "reimplement" anything in the first two rows. If you find yourself writing a fresh `$blocksToLexical`, stop — you are duplicating a file that already runs in a browser.

### The CSS split — read this before arguing with the brief

The brief says "html + tailwind css". That applies to the **chrome**, which is new code. It must **not** be applied to the editor's own stylesheet.

`editor-components/styles/index.ts` assembles ten CSS chunks into one string, and its header says, verbatim: *"⚠️ ORDER IS LOAD-BEARING… reordering it is a visual change, not a tidy-up."* Those rules style Lexical's generated class names (`lx-p`, `lx-h1`, `lx-bold`) and the decorator nodes' internal markup. Converting them to Tailwind utilities would mean re-deriving 10 files of cascade by hand and would guarantee visual drift from the phone.

**So:** inject `CSS` verbatim into a `<style>` tag scoped under the editor root. Tailwind styles the bubble, toolbars, panels, ribbon, dock and sheets. This is what "the same editor" actually requires — the document must render byte-identically to the phone.

### Facts verified against source — do not re-research

**Editor contract** (`editor-components/props.ts`, `types.ts`):
- `LexicalState` = `{bold, italic, underline, blockType, isRTL, alignment, index, text, blocks?, y?, canUndo?, canRedo?, userDriven?}`. `blocks[]` is the multi-block selection; `y` is the focused block's top in viewport px — **this is what anchors the bubble**, and it already exists.
- `LexicalCommand` = `{type, value?, nonce}`. Known types: `bold | italic | underline | undo | redo | align | heading | quote | list | color | clearFormatting | serialize | direction | blockFormat | patchBlocks | insert | blur`.
- `applyLexicalCommand(editor, command, onBlocks?)` (`plugins/editor-bridge/apply-command.ts`, 144 lines) is a **pure dispatch** with no component scope. Keep it verbatim — the toolbars' whole vocabulary is built on it.

**Write-back**: `lib/lexical-writeback.ts` `planOps(baseline, target)` → an LCS edit script of `ThesisOp[]` → `POST /api/thesis/:id/ops` (`~/modakerati-server/src/routes/thesis/blocks.ts:392-559`). `ThesisOp` is a 12-member union in `lib/thesis-ops.ts:69-144`.

⚠️ **The batch endpoint does NOT accept every op type — and it fails silently.** Verified, not assumed:

```bash
cd ~/modakerati-server && grep -oE 'type === "[a-zA-Z]+"' src/routes/thesis/blocks.ts | sort -u
```

returns exactly eight: `editText · splitParagraph · deleteBlocks · move · format · setList · tableOp · insertTable`. The handler `continue`s past anything else and reports it in a `skipped[]` array **alongside a 200 OK**, so a dropped edit looks like a success. The other four op types must go to their own endpoints, exactly as the app's own `executeOp` does:

| Op | Endpoint |
|---|---|
| `insertImage` | `POST /:id/blocks/image` |
| `replaceImage` | `POST /:id/blocks/:index/image` |
| `startOnNewPage` | `POST /:id/blocks/start-on-new-page` |
| `setCaption` | `POST /:id/blocks/:index/caption` |

`MAX_BATCH_OPS` is 1000 (`shared.ts:286`). A pure write-back only ever produces batchable ops, so the common case stays one request.

**AI streaming endpoints** (all `POST`, all chunked, all under `/api/thesis`):
| Endpoint | Surface |
|---|---|
| `/:id/paragraphs/:index/suggest/stream` | inline suggestion (rewrite / caption / insertTable / insertSourceImage / setChart) |
| `/:id/paragraphs/:index/fill/stream` | fill an empty paragraph (context-aware ✦ card) |
| `/:id/complete/stream` | ghost autocomplete |
| `/:id/blocks/rewrite-range/stream` | multi-block range rewrite |
| `/:id/table-suggest/stream` | table proposal |
| `/:id/blocks/:index/caption` | caption (non-stream) |

`lib/thesis-suggest.ts` (655 lines) is the client for these. Its **only** non-web import is `import { fetch as expoFetch } from "expo/fetch"` on line 1 — swap for the browser's native `fetch`. Per [[turn-survives-background]] `expo/fetch` can hang `reader.read()`; that hazard is native-only and disappears here.

**Browser-side auth**: `src/lib/api/student.ts` is `server-only`. The established browser pattern (Plan 2, `AskCard.tsx:9`, `src/lib/api/student-browser.ts:14`) is `NEXT_PUBLIC_MODAKERATI_SERVER_URL` + the `accessToken` prop the workspace page already fetches and passes down. Follow it — do not add route-handler proxies.

**Theme tokens**: `src/app/globals.css` defines the palette on `:root, [data-theme="dark"]` / `[data-theme="light"]` and re-exposes it via `@theme inline`. The `/app` segment already overrides the two brand tokens to Kwill orange (`#F59433`). Use `bg-card`, `text-text`, `text-subtext`, `border-border`, `bg-primary` — never a hex.

**Icons**: `src/components/ui/icon.tsx` maps kebab-case names to `lucide-react` in a hand-maintained `ICONS` record. **An unknown name renders a neutral fallback dot rather than crashing** — a missed icon is a silent visual bug. This plan needs ~40 icons that the mobile toolbars use; Task 11 adds them all in one pass.

### What is genuinely native-only — stated, not silently dropped

These have no desktop meaning and are **deliberately** not ported. Each is a deletion with a reason, and each is called out again in the task that touches it:

| Dropped | Why |
|---|---|
| `KeyboardModePlugin` | `inputmode="none"` exists to suppress a soft keyboard. Desktop has none. |
| `DrawerSwipePlugin` | A right→left fling opens the structure drawer. Replaced by a real sidebar toggle (Task 28). |
| `lib/haptics.ts` (`hSelection`, `hLight`, `hMedium`, `hWarn`, `hSelection`) | No browser equivalent. Every call site becomes a no-op shim so the port stays diff-clean. |
| `react-native-reanimated` springs | Replaced by CSS transitions (Task 11). Motion *timings* are preserved from `lib/motion.ts`. |
| `react-native-safe-area-context` insets | No notch. `bottomInset` becomes `0`. |
| The pill's **drag-to-dock-on-keyboard** behaviour | There is no keyboard to dock above. Drag-to-reposition is kept (Task 20). |

Everything else in the mobile editor is in scope.

### Gate for every task

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Run it after every file you touch. `npm test` (== `vitest run`) after each TDD task (2, 3, 10, 21) and again at the very end (Task 37).

⚠️ **`npm test` was running every suite twice, against a tree nobody was looking at.** A git worktree at `.worktrees/feat-chat-batch-a/` holds a complete second copy of the repo on another branch, and vitest's default globs walk into it — 34 reported "test files" for 17 on disk, and a failure on that branch would have read as a failure here. `vitest.config.ts` excludes `**/.worktrees/**`. This is pre-existing and unrelated to the port; the worktree itself is left alone.

⚠️ **Vitest had no config file before this plan.** Every pre-existing test imports only relative paths, so the `@/*` alias `tsconfig.json` declares was never exercised by the test runner — the first ported lib that used it failed with `Cannot find package '@/…'`. Task 2 adds `vitest.config.ts` with that alias. It is kept in sync with `tsconfig.json`'s `paths` **by hand**; if that object ever grows a second entry, mirror it.

There is **no** `verify-use-dom.mjs` equivalent here and none is needed — the one-export rule is a `babel-preset-expo` constraint on `'use dom'` modules, and this port has no such module. That is one of the hazards the port *removes*.

---

## File Structure

Everything lands under `~/modakerati-dashboard/src/features/editor/`, mirroring the mobile layout so a future change can be diffed across the two repos.

**Created**

| Path | Responsibility | Source |
|---|---|---|
| `src/features/editor/nodes/blockLexical.tsx` | Every decorator node + `$blocksToLexical` / `$lexicalToBlocks` | lift `components/workspace/lexical/blockLexical.tsx` |
| `src/features/editor/core/{seed,theme,block-format,block-index,commands,lexical-updates,measure,scroll-anchor,types}.ts` | Editor internals | lift `editor-components/` |
| `src/features/editor/core/styles/*.ts` | The ten CSS chunks + barrel | lift `editor-components/styles/` |
| `src/features/editor/plugins/*` | 10 ported plugins + `editor-bridge/` + `pagination/` + `reorder/` | lift `editor-components/plugins/` |
| `src/features/editor/KwillEditor.tsx` | The composition shell (replaces `LexicalDomEditor`) | rewrite of a 207-line shell |
| `src/features/editor/lib/{page-layout,thesis-ops,lexical-writeback,table-diff,word-diff,thinking,doc-ornament,section-chrome,bubble-configs,mathjax-web,rtl,motion,haptics}.ts` | Pure helpers | lift from `~/modakerati/lib` |
| `src/features/editor/lib/thesis-suggest.ts` | Streaming AI client | lift, swap `expo/fetch` → `fetch` |
| `src/features/editor/lib/ops-client.ts` | `POST /ops` + media URLs, browser-side | new |
| `src/features/editor/stores/*.ts` | 12 Zustand stores | lift from `~/modakerati/stores` |
| `src/features/editor/chrome/BubbleBar.tsx` | The bubble shell | rewrite of `BlockContextBar.tsx` |
| `src/features/editor/chrome/toolbars/*.tsx` | The 11 toolsets + panels | rewrite of `bubble-tools/` |
| `src/features/editor/chrome/ribbon/*.tsx` | The ribbon | rewrite of `ribbon/` |
| `src/features/editor/chrome/dock/*.tsx` | The AI dock | rewrite of `ai-dock/` |
| `src/features/editor/chrome/{SearchPanel,OutlinePanel,InsertMenu,HeaderFooterSheet,EquationSheet,PictureCropModal,HistorySheet,PeekCard,ProposalStepper}.tsx` | Ancillary surfaces | rewrite |
| `src/features/editor/chrome/primitives/{Chip,Popover,Sheet,Toolstrip}.tsx` | The Tailwind chip/popover kit | new |
| `src/features/editor/locales/{en,fr,ar}.json` | Editor strings | copied verbatim from `~/modakerati/locales` |
| `src/features/editor/index.ts` | Barrel | new |

**Modified**

| Path | Change |
|---|---|
| `src/app/app/(workspace)/[thesisId]/page.tsx` | Render `<KwillEditor>` instead of read-only `<DocumentBlocks>` |
| `src/components/ui/icon.tsx` | Add ~40 toolbar icons |
| `src/i18n/messages.ts` | Register the editor locale bundle |
| `package.json` | Add `lexical`, `@lexical/*`, `mathjax-full` |

**Retained, not deleted:** `src/features/workspace/` (Plan 1's read-only renderer) stays. It is the SSR fallback rendered before the editor hydrates, and the skeleton the page shows while blocks load — see Task 35.

---

# Phase A — Foundations

### Task 1: Dependencies

**Files:** `package.json`

- [x] **Step 1: Install, pinned to the versions the app runs**

The mobile app is on `^0.48.0` across the Lexical family. A version skew between the two repos means a node type registered in one and unknown in the other — pin, don't float.

```bash
cd ~/modakerati-dashboard
npm i lexical@^0.48.0 @lexical/react@^0.48.0 @lexical/rich-text@^0.48.0 \
      @lexical/list@^0.48.0 @lexical/selection@^0.48.0 @lexical/utils@^0.48.0 \
      mathjax-full@^3.2.2
```

- [x] **Step 2: Confirm the app's versions actually match**

```bash
node -e "const a=require('$HOME/modakerati/package.json').dependencies, b=require('./package.json').dependencies; \
  ['lexical','@lexical/react','@lexical/rich-text','@lexical/list','@lexical/selection','@lexical/utils','mathjax-full'] \
  .forEach(k=>console.log(k, a[k], '→', b[k]))"
```

Every row must match. A mismatch here is the single cheapest bug to prevent and the most expensive to diagnose later.

- [x] **Step 3: Gate + commit**

```bash
npx tsc --noEmit
git add package.json package-lock.json
git commit -m "build(web-editor): add lexical + mathjax at the app's pinned versions"
```

---

### Task 2: Port the pure helper libs (TDD on the two that carry real logic)

Ten libraries, 2,435 lines, all verified RN-free except `rtl-layout.ts`.

**Files:**
- Create: `src/features/editor/lib/{word-diff,doc-ornament,thinking,page-layout,section-chrome,table-diff,thesis-ops,lexical-writeback,bubble-configs,mathjax-web}.ts`
- Create: `src/features/editor/lib/{rtl,motion,haptics}.ts` (the three that need adapting)
- Test: `src/features/editor/lib/lexical-writeback.test.ts`, `src/features/editor/lib/table-diff.test.ts`

- [x] **Step 1: Prove they are RN-free before copying**

```bash
cd ~/modakerati
for f in lib/word-diff.ts lib/doc-ornament.ts lib/thinking.ts lib/page-layout.ts \
         lib/section-chrome.ts lib/table-diff.ts lib/thesis-ops.ts \
         lib/lexical-writeback.ts lib/bubble-configs.ts lib/mathjax-web.ts; do
  echo -n "$f: "; grep -c "react-native\|expo-\|expo/" $f
done
```

Expected: `0` for all except `lib/bubble-configs.ts` (which imports icons from `lucide-react-native`) — that one gets its import line swapped to `lucide-react`, nothing else.

- [x] **Step 2: Copy the eight clean ones verbatim**

```bash
cd ~/modakerati-dashboard && mkdir -p src/features/editor/lib
for f in word-diff doc-ornament thinking page-layout section-chrome table-diff thesis-ops mathjax-web; do
  cp ~/modakerati/lib/$f.ts src/features/editor/lib/$f.ts
done
```

- [x] **Step 3: Copy the two that need a one-line edit**

`bubble-configs.ts` — swap the icon import:

```bash
cp ~/modakerati/lib/bubble-configs.ts src/features/editor/lib/bubble-configs.ts
sed -i '' 's|lucide-react-native|lucide-react|' src/features/editor/lib/bubble-configs.ts
```

`lexical-writeback.ts` — its only cross-import is `import { detectDir } from "@/components/workspace/DocBlock"`. Plan 1 already ported that exact function to `src/features/workspace/lib/direction.ts`. Repoint it:

```bash
cp ~/modakerati/lib/lexical-writeback.ts src/features/editor/lib/lexical-writeback.ts
sed -i '' 's|from "@/components/workspace/DocBlock"|from "@/features/workspace/lib/direction"|' \
  src/features/editor/lib/lexical-writeback.ts
```

- [x] **Step 3b: Create `doc-types.ts` — one source of truth for the DTO**

Plan 1's `src/features/workspace/types.ts` is a deliberate **subset** (enough to render blocks read-only) and had already drifted: it folded a few `TableStyleExtra` fields into the base `table` variant, and it lacks `runs`, `math`, `anchors`, `fmt`, `cellImages`, `cellLists`, `svg`, `ornament` and the whole of `DocSectionDTO` / `ChromeDrawingDTO` / `AnchoredShape`.

Rather than leave two partial views of one payload, create `src/features/editor/lib/doc-types.ts` as the **full mirror** (ported from `~/modakerati/lib/api.ts:1395-1650`) and reduce `workspace/types.ts` to a re-export of it. Plan 1-3's components keep importing `@/features/workspace/types` unchanged.

⚠️ Two deliberate reconciliations, both documented in the file:
- The `table` variant carries `align / direction / header / fills / textColors / spans / border`. The server really does send these (`parseTableStyle`), but the app's `lib/api.ts` omits them and `blockLexical.tsx` re-declares them locally as `TableStyleExtra`. Declared once, here, where they belong.
- `DocumentDTO`'s unavailable branch carries **no** `id`/`title`, matching the app exactly. (An earlier draft of this plan added them "because the web page reads the title" — it does not: `page.tsx` returns early on `!doc.available`, so `title` is only ever read where it exists. Adding them broke `thesis-doc-store`, which legitimately synthesises `{docMode:"legacy-db", available:false}` with neither field known.)

- [x] **Step 4: Write the three adapters**

`src/features/editor/lib/rtl.ts` — the mobile `rtl-layout.ts` reads `I18nManager.isRTL` (the OS-level flip that swaps physical `left`/`right`). The browser has no such global flip; direction is a DOM attribute. So the helpers reduce to reading the document's own direction:

```typescript
// src/features/editor/lib/rtl.ts
//
// The mobile lib/rtl-layout.ts exists because React Native's I18nManager PHYSICALLY
// swaps `left`/`right` styles when the app locale is RTL, so a component must ask
// which way round it currently is. The browser has no such global flip — `dir="rtl"`
// on an ancestor does the mirroring, and `flex-row-reverse` is a class. These are
// the same three helpers, resolved against content direction instead.

export type Dir = "rtl" | "ltr";

/** Word's `both` == CSS `justify`; everything else passes through. */
export function visualTextAlign(align: string | null | undefined): string | undefined {
  if (!align) return undefined;
  return align === "both" ? "justify" : align;
}

/** A row that reads in `dir`'s reading order. Mobile reverses the array; the web
 *  reverses the flex axis, which keeps DOM order (and therefore tab order) intact. */
export function visualRow(dir: Dir): string {
  return dir === "rtl" ? "flex-row-reverse" : "flex-row";
}

/** Physical side a fly-out should open on, given the reading direction. */
export function visualSide(dir: Dir): "left" | "right" {
  return dir === "rtl" ? "left" : "right";
}
```

`src/features/editor/lib/haptics.ts` — no-op shims, so every ported call site stays byte-identical to the phone:

```typescript
// src/features/editor/lib/haptics.ts
//
// The browser has no haptic engine. These exist ONLY so ported call sites keep the
// same shape as the mobile source — a diff between the two repos should show a
// changed render layer, not fifty deleted hSelection() lines. Do not "clean these
// up" by removing the calls; the parity is the point.
export const hSelection = (): void => {};
export const hLight = (): void => {};
export const hMedium = (): void => {};
export const hWarn = (): void => {};
```

`src/features/editor/lib/motion.ts` — the mobile `lib/motion.ts` (180 lines) exports Reanimated spring configs and entering/exiting animations. Port the **timings** as CSS transition tokens; the springs themselves cannot cross:

```typescript
// src/features/editor/lib/motion.ts
//
// Mobile lib/motion.ts hands Reanimated spring configs (damping/stiffness/mass) to
// Animated.View. CSS has no spring primitive, so what ports is the FEEL: the same
// durations and a cubic-bezier tuned to the same overshoot. Reanimated's SPRING_SOFT
// (damping 18, stiffness 180) settles in ~320ms with a light overshoot — that is the
// curve below. Keep these as the single source so a timing change lands everywhere.

export const EASE_SPRING = "cubic-bezier(0.34, 1.35, 0.64, 1)"; // light overshoot
export const EASE_OUT = "cubic-bezier(0.2, 0.6, 0.2, 1)";

export const DUR = { chip: 140, pill: 220, panel: 260, layout: 320, glow: 500 } as const;

/** Tailwind-ready transition for a chip press / active toggle. */
export const chipTransition = `all ${DUR.chip}ms ${EASE_OUT}`;
/** The bubble blooming in, and a category panel flying out. */
export const pillTransition = `all ${DUR.pill}ms ${EASE_SPRING}`;
export const panelTransition = `all ${DUR.panel}ms ${EASE_SPRING}`;
```

- [x] **Step 5: TDD the two libs that carry real, portable logic**

`planOps` and `diffGrids` are the two places a silent regression would corrupt a student's document rather than just look wrong. They are pure — test them.

Write `src/features/editor/lib/lexical-writeback.test.ts` covering, at minimum:
- an unchanged document produces `[]` ops;
- a single-paragraph text edit produces exactly one `editText` at the right index;
- a paragraph split produces one `splitParagraph`;
- a deleted block produces one `deleteBlocks` and does **not** cascade indices into the following ops (the LCS + `applyOpToBlocks` simulation is what prevents that — assert the second op's index directly);
- a format-only change produces a `format` op and **no** `editText` (this is what `tsig`'s text-only paragraph signature exists to guarantee).

Write `src/features/editor/lib/table-diff.test.ts` covering: an added row, a removed column, an in-cell edit, and `layoutDelta` reporting the right row/col deltas.

⚠️ The first run fails with `Cannot find package '@/features/workspace/lib/direction'` — vitest has no config in this repo and therefore no `@/*` alias. Add `vitest.config.ts` mapping `@` → `./src` (see the gate note above), then:

```bash
npx vitest run src/features/editor/lib/
```

- [x] **Step 6: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/features/editor/lib
git commit -m "feat(web-editor): port the editor's pure helper libs from the app"
```

---

### Task 3: The browser API clients

**Files:**
- Create: `src/features/editor/lib/thesis-suggest.ts` (lift), `src/features/editor/lib/ops-client.ts` (new)

- [ ] **Step 1: Lift the streaming client** — DEFERRED to Phase D. Nothing in Phase A/B needs it: `thesis-ops.ts`'s only reference (`setThesisFigureCaption`) left with the transport half, and the AI surfaces that consume the streams are Tasks 21-24.

```bash
cp ~/modakerati/lib/thesis-suggest.ts src/features/editor/lib/thesis-suggest.ts
```

Then make exactly two edits:

1. Line 1 — delete `import { fetch as expoFetch } from "expo/fetch";` and replace every `expoFetch(` call with `fetch(`. The browser's `fetch` returns a real `ReadableStream` on `res.body`, which is what the file's reader loop already expects.
2. Auth — the mobile file gets its header from `getAuthHeader()` in `lib/api.ts`. Replace with an explicit `accessToken` parameter threaded from the caller, matching Plan 2's browser pattern.

Add this header to the file explaining the change, so the next reader does not "restore" the expo import:

```typescript
// Ported from ~/modakerati/lib/thesis-suggest.ts. Two deliberate differences:
//   • expo/fetch → the browser's native fetch. expo/fetch exists on native because
//     RN's XHR-backed fetch cannot stream; in a browser, native fetch streams and
//     the expo shim's reader.read() hang (see the app's turn-survives-background
//     notes) cannot occur.
//   • getAuthHeader() → an explicit accessToken parameter. This module runs in the
//     BROWSER, where there is no server-only Supabase client; the workspace page
//     already resolves the token server-side and passes it down (Plan 2's pattern).
```

- [x] **Step 2: Write the ops client**

Create `src/features/editor/lib/ops-client.ts`. It must express the batchable/single split from the facts section — a client that posts everything to `/ops` gets a 200 and silently loses image inserts, caption sets and page breaks.

Required surface:

- `BATCHABLE` — the set of eight op types the batch endpoint implements, and `isBatchable(op)`.
- `applyThesisOps(thesisId, ops, token)` — the batch call. **Throws** if handed an unbatchable op rather than letting the server skip it.
- `executeOps(thesisId, ops, token)` — the one callers use. Collapses runs of batchable ops into single requests and sends each unbatchable op in place, **preserving order** (op indices are positional; a reordered batch corrupts the document). Returns the LAST echoed document — each request re-reads the engine, so only the final echo reflects the whole list.
- `OpsResult.skipped[]` — surfaced, never ignored. It arrives with a 200.
- `isRetryableError(e)` — ported from the app. Its `TypeError` clause carries over unchanged: the browser's `fetch` throws `TypeError` when offline just as RN's does.
- `blockMediaUrl` / `cellMediaUrl` — `?token=` query auth, because `<img src>` cannot send a header.

⚠️ **Trim the transport half out of the ported `thesis-ops.ts`.** The app's copy ends with `executeOp()` (fanning out to nine single-op endpoints) and `isRetryableError()`. Both belong in `ops-client.ts` here, because the transport genuinely differs. Delete them from `thesis-ops.ts`, drop the now-unused runtime imports, and leave a comment saying where they went — everything above that line is pure and stays identical to the app's.

- [x] **Step 3: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/lib/thesis-suggest.ts src/features/editor/lib/ops-client.ts
git commit -m "feat(web-editor): browser-side ops + AI streaming clients"
```

---

### Task 4: Port the stores

Zustand is platform-neutral, so these lift — but **only nine of the twelve belong in Phase B.**

**Files:** Create `src/features/editor/stores/*.ts`

- [x] **Step 1: Copy all twelve, then split by what Phase B can actually build**

```bash
cd ~/modakerati-dashboard && mkdir -p src/features/editor/stores
for s in lexical-editor thesis-doc toolbar suggestion completion table-suggestion \
         search insert-menu editor-scroll equation-sheet hf-sheet floating-pill dock-tools; do
  cp ~/modakerati/stores/$s-store.ts src/features/editor/stores/$s-store.ts
done
```

⚠️ **Correction to this plan's original Task 4.** Three of these are inseparable from `lib/thesis-suggest.ts` (the streaming AI client) and from a `lib/api.ts` subset — `chromeOp`, `generateChromeModel`, `fetchThesisSourceImage`, `suggestThesisChart`, `updateThesisChart` — that has no consumer until the AI surfaces exist. Chasing those imports means porting Phase D early and badly. Instead they are staged, excluded from the build, and wired by the task that needs them:

| Staged in `src/features/editor/_phase-d/` | Wired by |
|---|---|
| `suggestion-store.ts` | Task 21 + Task 22 |
| `completion-store.ts` | Task 23 |
| `autocomplete-policy.ts` (its gate; also needs `settings-store`, `billing-store`) | Task 23 |
| `table-suggestion-store.ts` | Task 24 |
| `tasks-api.ts` (`suggestion-store`'s `decideProposal`) | Task 21 |

Add `"src/features/editor/_phase-d"` to `tsconfig.json`'s `exclude` **and** to `vitest.config.ts`'s `test.exclude`. Moving a file out of that directory is part of the Phase D task that wires it.

- [x] **Step 2: Repoint imports**

`@/lib/…` → `@/features/editor/lib/…`, `@/stores/…` → `@/features/editor/stores/…`.

- [x] **Step 3: Port the five transitive libs the nine remaining stores pull in**

`thesis-op-queue.ts`, `thesis-doc-cache.ts`, `search-match.ts`, `text-normalize.ts`, and a new `doc-api.ts`.

⚠️ **The two SQLite-backed libs must use IndexedDB, not `localStorage`.** `thesis-doc-cache.ts` explains its own choice — *"SQLite (not AsyncStorage) so a large document — hundreds of blocks, inline figure data URIs — isn't capped by the key-value store's size limit"* — and that reasoning transfers exactly: `localStorage` is ~5MB and stores UTF-16, so a base64 figure costs double. An `insertImage` op carries raw bytes; a cached `DocumentDTO` carries every inlined figure. A `QuotaExceededError` mid-edit is the precise failure the durable queue exists to prevent. Write a small `lib/idb.ts` wrapper; the ported APIs are already async, so they map one-to-one.

Keep `clearQueuedOps` dropping the **whole** queue — op indices are positional, so a rejected op poisons everything behind it. That is a safety property, not a rough edge.

- [x] **Step 4: The three native couplings**

| Store | Was | Now |
|---|---|---|
| `editor-scroll-store` | `AsyncStorage` via `createJSONStorage` | `localStorage` — scroll anchors are three numbers per thesis, so the cap is irrelevant here |
| `suggestion-store`, `thesis-doc-store` | `import i18n from "@/lib/i18n"` | `lib/i18n-shim.ts` — a drop-in with the same `i18n.t(key, {defaultValue})` signature, so all nine call sites stay byte-identical. A client component installs the dictionary; until then every call falls back to the English `defaultValue` it already passes |
| `thesis-doc-store` | `NetInfo` / `AppState` / `Alert` | `lib/platform.ts` — `onReconnect` (`online`), `onBackground` (`visibilitychange` **and** `pagehide`), `notify` (a subscribable notice, **not** `window.alert`) |

Two deliberate divergences, both documented in `platform.ts`:
- `onBackground` reports `"unload"` as well as `"hidden"`. A browser tab can be **closed outright**; a phone app gets backgrounded first. The flush timeout drops to 2s on unload, since the page may not survive a normal fetch.
- `notify` is not `window.alert`. Its one call site fires *while the student is typing*; a blocking modal would freeze the editor, swallow keystrokes, and cannot be styled or translated. On a phone the OS alert is the native idiom — in a browser it is not.

- [x] **Step 5: `doc-api.ts` — the ambient-token facade**

The ported stores call `getThesisDocument(id)` and `executeOp(thesisId, op)` with no credential, because the app reads one from a global auth singleton. Mirror that with a module-level token holder rather than threading a token through every call site. `ops-client.ts` keeps its **explicit** token parameters — it is the layer worth unit-testing — and `doc-api.ts` is the thin ambient wrapper over it.

⚠️ A Supabase access token expires (1h default). A long editing session outlives it. The workspace must re-install a refreshed token; `doc-api` deliberately does not refresh itself, having no Supabase client of its own.

- [x] **Step 6: Verify nothing native survived, and gate**

```bash
grep -rnE '^\s*import\b.*(react-native|expo-|expo/)' src/features/editor/ --exclude-dir=_phase-d || echo "NONE"
npx tsc --noEmit && npx vitest run
```

Grep for `import` lines specifically, not the bare words — several ported files *mention* `expo-sqlite` and `react-native` in comments explaining what they replaced, and a naive `grep -c` counts those.

---

# Phase B — The document surface

### Task 5: Lift `blockLexical.tsx`

The 2,939-line heart of the editor: every decorator node, the two conversions, the four contexts.

**Files:** Create `src/features/editor/nodes/blockLexical.tsx`

- [x] **Step 1: Copy it**

```bash
mkdir -p src/features/editor/nodes
cp ~/modakerati/components/workspace/lexical/blockLexical.tsx src/features/editor/nodes/blockLexical.tsx
```

⚠️ **`lib/rtl-layout.ts`'s real signature is `visualTextAlign(rtl: boolean): "left" | "right"`** — it answers "which physical side is the reading start", compensating for I18nManager's global flip. An earlier draft of Task 2 replaced it with an invented `visualTextAlign(align: string)`, which typechecked in isolation and broke the moment `blockLexical` called it. Port the app's real API — `visualRow`, `LTR_ROW`, `visualTextAlign`, `visualTextAlignEnd` — with the same parameter, so ported call sites need no edits. On the web each collapses to the plain answer for the content's own direction.

- [x] **Step 2: Repoint its ten imports**

| Was | Becomes |
|---|---|
| `@/lib/word-diff`, `@/lib/doc-ornament`, `@/lib/thinking`, `@/lib/mathjax-web`, `@/lib/page-layout`, `@/lib/table-diff` (type-only), `@/constants/colors` | `@/features/editor/lib/…` |
| `@/lib/rtl-layout` (`visualTextAlign`) | `@/features/editor/lib/rtl` |
| `@/hooks/useWorkingClock` | `@/features/editor/hooks/useWorkingClock` — copy the 71-line hook, it is RN-free |
| `@/lib/api` (types: `AnchoredShape`, `CellImageDTO`, `DocBlockDTO`, `DocListKind`, `InlineMathDTO`, `TextBoxLine`) | `@/features/editor/lib/doc-types` — see the note below |
| `@/constants/colors` (`brand`) | `@/features/editor/lib/colors` — copy the 92-line constants file |

- [x] **Step 3: Delete `"use dom"`-era comments that no longer describe reality**

The file header says *"This file runs in the WEB bundle only — it is imported EXCLUSIVELY by LexicalDomEditor.tsx (a 'use dom' component). Never import it from a native (non-dom) file."* That warning is about the **mobile** bundle and is now false here. Replace with:

```typescript
// DocBlockDTO ⇄ Lexical conversions and every decorator node the editor renders.
//
// Ported verbatim from ~/modakerati/components/workspace/lexical/blockLexical.tsx.
// On mobile that file is loaded by a 'use dom' Expo component and runs inside a
// WebView; here it runs directly. The code is identical because it was always
// browser code — only the host changed. Keep the two in sync: a fix to a decorator
// node belongs in BOTH repos.
//
// Text blocks (paragraph/heading + alignment + direction + inline runs) map to
// editable Lexical nodes; structural blocks (table/image/textbox/other) are carried
// OPAQUE in a BlockDataNode so they round-trip verbatim instead of being dropped.
```

- [x] **Step 4: Mark the client boundary**

Add `"use client";` as the first line. Every decorator node uses hooks and DOM.

- [x] **Step 5: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/nodes src/features/editor/hooks src/features/editor/lib/colors.ts
git commit -m "feat(web-editor): lift blockLexical — decorator nodes and block conversions"
```

**Checkpoint — what you just gained.** These node classes are the whole document surface: `BlockDataNode` (tables, figures, charts, textboxes, `other`), `ChromeNode` (header/footer/section bands), `PageBreakNode` (page view + page artwork), `SuggestionNode` (the **inline suggestion** card, with word diff, streamed reasoning and approve/reject/again/edit), `RangeSuggestionNode` (multi-block rewrite), `GhostCompletionNode` (autocomplete ghost text), `EquationNode` (OMML → MathJax SVG). None of it was rewritten.

---

### Task 6: Lift `editor-components/` — core, styles, plugins

**Files:** Create `src/features/editor/core/**`, `src/features/editor/plugins/**`

⚠️ **`styles/base.ts` `require()`s two .ttf files, and that is Metro-only.** Liberation Serif is the metric twin of Times New Roman used by the offscreen `.lx-measure` host so block heights match where Word actually wraps. Webpack does not resolve a font that way — and the failure is the worst kind: the `@font-face` silently never loads, the measure host falls back to some other serif, and **every page break lands somewhere Word would not have put it**, with nothing logged. Copy both files (and `LICENSE-Liberation`) into `public/fonts/` and reference them by URL.

`tsc` cannot see this — the first thing that caught it was importing the stylesheet from a test.

- [x] **Step 1: Copy the core and the stylesheet**

```bash
mkdir -p src/features/editor/core/styles src/features/editor/plugins
SRC=~/modakerati/components/workspace/lexical/editor-components
cp $SRC/{block-format,block-index,commands,lexical-updates,measure,scroll-anchor,seed,theme,types}.ts src/features/editor/core/
cp $SRC/styles/*.ts src/features/editor/core/styles/
```

⚠️ Do not touch the order of the array in `styles/index.ts`. Its header states the order is load-bearing and that the joined output was byte-verified against the pre-split literal.

- [x] **Step 2: Copy the plugins that port unchanged**

```bash
cp -r $SRC/plugins/{editor-bridge,pagination,reorder} src/features/editor/plugins/
cp $SRC/plugins/{CompletionPlugin,EquationTapPlugin,PasteImagePlugin,RangeSuggestionPlugin,\
ScrollSyncPlugin,SearchHighlightPlugin,SelectPlugin,SelectionHighlightPlugin,SlashPlugin,\
SuggestionPlugin}.tsx src/features/editor/plugins/
```

That is **ten** plugins plus the three plugin packages. Do **not** copy `KeyboardModePlugin.tsx` or `DrawerSwipePlugin.tsx` — see the native-only table above.

- [x] **Step 3: Repoint imports**

`../../blockLexical` → `@/features/editor/nodes/blockLexical`; `@/lib/api` → `@/features/workspace/types`; `../../` core paths → `@/features/editor/core/…`.

- [x] **Step 4: Adapt `PasteImagePlugin`**

On mobile, `onPasteImage(index)` fires and **native** reads the system clipboard (`lib/paste-image.ts`, 120 lines) because a WebView cannot. In a browser the paste event carries the bytes directly. Read them in the plugin:

```typescript
// The mobile plugin can only REPORT a paste — a WebView has no clipboard read, so
// native took over from here. In a browser the ClipboardEvent carries the file, so
// this handler does the whole job and hands the caller real bytes.
const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
if (!item) return false;
const file = item.getAsFile();
if (file) void onPasteImage(index, file);
return true;
```

- [x] **Step 5: Adapt `ReorderPlugin`**

The gesture is a one-finger hold-then-drag on a gutter grip. `plugins/reorder/geometry.ts` (the drop-target maths) ports unchanged; only the event source changes — `touchstart/touchmove/touchend` → **Pointer Events**, which cover mouse, touch and pen in one path. The hold-to-arm delay stays; on desktop it also arms immediately on a grip mousedown, because a mouse has no accidental-touch problem to guard against.

- [x] **Step 6: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/core src/features/editor/plugins
git commit -m "feat(web-editor): lift editor core, stylesheet and ten plugins"
```

---

### Task 7: The editor shell — `KwillEditor`

Replaces `LexicalDomEditor.tsx`. Same composition, no bridge.

**Files:** Create `src/features/editor/KwillEditor.tsx`

- [x] **Step 1: Write the shell**

```tsx
"use client";

// The thesis editor. Mirrors ~/modakerati/components/workspace/lexical/LexicalDomEditor.tsx
// — same LexicalComposer, same node registry, same plugin stack — with the Expo DOM
// bridge removed.
//
// What the bridge was, and why it is gone: on mobile this component is loaded by the
// 'use dom' directive and runs inside a WebView, so React Native could only reach it
// through SERIALIZABLE props — hence `command: {type, value, nonce}` envelopes, where
// the nonce existed purely to force a re-apply when the same command repeated. In a
// browser there is no process boundary: the chrome calls the editor directly through
// the handle in ./core/handle. Commands keep their {type, value} vocabulary because
// applyLexicalCommand (ported verbatim) is built on it and the toolbars speak it.
//
// The single-default-export rule that governs the mobile file does NOT apply here —
// that was a babel-preset-expo constraint on 'use dom' modules. Named exports are fine.

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";

import {
  AnchorGeometryContext, BlockDataNode, ChromeNode, EditCellContext, EquationNode,
  GhostCompletionNode, MediaContext, PageBreakNode, RangeSuggestionNode, SuggestionNode,
  TableProposalContext, WorkingLabelsContext,
} from "./nodes/blockLexical";
import { CSS } from "./core/styles";
import { theme } from "./core/theme";
import { seed } from "./core/seed";
/* …the ten plugins… */

const NODES = [
  HeadingNode, QuoteNode, ListNode, ListItemNode,
  BlockDataNode, ChromeNode, PageBreakNode, SuggestionNode,
  RangeSuggestionNode, GhostCompletionNode, EquationNode,
];

export function KwillEditor(props: KwillEditorProps) {
  return (
    <LexicalComposer initialConfig={{ namespace: "kwill", theme, nodes: NODES, onError: (e) => { throw e; }, editorState: seed }}>
      {/* The editor's own stylesheet, verbatim from the app. NOT Tailwind on purpose:
          these rules style Lexical's generated class names and the decorator nodes'
          internal markup, and ./core/styles documents that their ORDER is load-bearing.
          Tailwind styles the chrome around this surface, not the document inside it. */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {/* …contexts, RichTextPlugin, plugin stack… */}
    </LexicalComposer>
  );
}
```

- [x] **Step 2: Convert the prop contract**

Every prop in `editor-components/props.ts` maps across. The ones that change shape:

| Mobile prop | Web |
|---|---|
| `command: {type,value,nonce}` | gone — the handle dispatches directly (Task 8) |
| `onState`, `onBlocks`, `onScroll`, `onEditCell`, … (async function props) | ordinary callbacks |
| `reseed: {blocks, chrome, nonce}` | keep the nonce — it is a genuine "re-apply even if identical" signal, not a bridge artifact |
| `media: {base, token, thesisId, version}` | unchanged; `MediaContext` already consumes it |
| `keyboardActive` | dropped |
| `onSwipeOpenDrawer`, `appRtl` | dropped (drawer gets a real toggle) |
| `dom?: DOMProps` | dropped |

- [x] **Step 3: Scope the stylesheet**

Wrap the injected CSS so it cannot leak into the dashboard's Tailwind surfaces. Prefix every rule with the editor root's class in a build-free way: render the `<style>` inside a `<div className="kwill-editor-root">` and add a single `@scope (.kwill-editor-root)` wrapper, with a plain descendant-prefix fallback for engines without `@scope`.

- [x] **Step 4: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/KwillEditor.tsx
git commit -m "feat(web-editor): the editor shell, with the Expo DOM bridge removed"
```

---

### Task 8: The editor handle

The chrome needs to command the editor and read its state. On mobile that was the nonce bridge; here it is a ref.

**Files:** Create `src/features/editor/core/handle.ts`

- [x] **Step 1: Write it**

```typescript
// The chrome ⇄ editor channel. On mobile this was a serializable {type,value,nonce}
// prop crossing a WebView boundary; here it is a direct call.
//
// applyLexicalCommand is kept VERBATIM from the app (plugins/editor-bridge/apply-command.ts)
// — it is a pure dispatch with no component scope, and every toolbar chip in
// Phase C speaks its vocabulary. Rewriting it would mean rewriting them too.

export interface EditorHandle {
  command(type: string, value?: string): void;
  /** Serialize the tree back to blocks — the write-back path's input. */
  serialize(): DocBlockDTO[];
  /** The live format snapshot the bubble mirrors. */
  state(): LexicalState;
  focus(): void;
}
```

`EditorBridge` (ported in Task 6) already owns both directions — it applies commands and reports `LexicalState` through `onState`. Have it publish a handle into `useLexicalEditorStore` on mount, exactly where the mobile host kept the same state.

- [x] **Step 2: Confirm `onState` still gates on `userDriven`**

`LexicalState.userDriven` is `false` when focus has left the editor, and the mobile host uses it to **refuse a report that would shrink a multi-block selection**. Desktop makes this more common, not less — clicking a toolbar button blurs the content-editable. Keep the guard and verify it survived the port.

- [x] **Step 3: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/core/handle.ts src/features/editor/plugins/editor-bridge
git commit -m "feat(web-editor): direct editor handle replacing the nonce bridge"
```

---

### Task 9: Seed, reseed, and the in-place patch

**Files:** Create `src/features/editor/core/doc-sync.ts`

- [x] **Step 1: Port `buildChrome`, `stripMedia` and `inPlacePatch`**

All three live in `WorkspaceLexicalView.tsx` (lines ~40-150) and all three are pure. Port them verbatim, with two changes:

- **`stripMedia`'s budget.** The mobile `INLINE_MEDIA_BUDGET` (4MB) exists because base64 has to cross a WebView bridge. There is no bridge here. But do **not** simply remove the cap: it is also what makes the save baseline and the editor seed use *identical* blocks, so images never produce spurious ops. Keep the function and the determinism; raise the budget to 16MB with a comment saying why the number moved and why the function stayed.
- **`buildChrome`'s labels** come from i18next natively. Pass them in from `useTranslations("editor")`.

⚠️ Keep `MAX_INPLACE_PATCH = 12` and the reseed rules exactly. Per [[writer-reseed-is-the-latency]], a reseed rebuilds **every** node plus a repagination from scratch and a history clear — on a real thesis that is seconds. `inPlacePatch` is what stops a table restyle paying it twice.

- [x] **Step 2: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/core/doc-sync.ts
git commit -m "feat(web-editor): seed/reseed and the reseed-free in-place patch"
```

---

### Task 10: Write-back and autosave (TDD)

**Files:** Create `src/features/editor/core/writeback.ts`, `src/features/editor/core/writeback.test.ts`

- [x] **Step 1: Write the failing test**

The unit under test is the **decision**, not the fetch: given a baseline and a serialized tree, does the module emit the right op batch, and does it correctly emit *nothing* when they match? Mock `applyThesisOps`.

Cover: no-change → no call; a text edit → one call with one `editText`; two rapid edits inside the debounce window → **one** call carrying both; a failed call → the baseline is **not** advanced (so the next save retries the same delta rather than losing it).

That last case is the one that costs a student their work if it regresses. Assert it explicitly.

- [x] **Step 2: Implement**

```typescript
// Lexical → blocks → ops → POST /ops, debounced.
//
// The baseline is the blocks the editor was last known to agree with the server
// about. planOps diffs against it, and it advances ONLY on a successful round-trip
// — a failed save leaves it alone so the next attempt re-derives the same delta
// instead of silently dropping it.
//
// The endpoint echoes the mutated document; that echo is server truth and feeds
// straight back into the doc store (optimistic-editing contract).
```

Debounce at **1200ms** of idle, plus an immediate flush on blur, on an AI turn starting, and on `beforeunload` — mirroring the mobile flush points (blur / AI-turn), with `beforeunload` added because a browser tab can close mid-edit and a phone screen cannot.

- [x] **Step 3: Wire undo/redo**

`LexicalState.canUndo` / `canRedo` already report Lexical's own `HistoryPlugin` availability. The mobile rule is: **step Lexical's history first** (instant, offline) before falling back to the op queue / server snapshots. Keep it. Per [[local-undo-redo]], **undo is never gated** by the destructive-tool confirm — do not add a confirm to it.

- [x] **Step 4: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run src/features/editor/core/writeback.test.ts
git add src/features/editor/core/writeback.ts src/features/editor/core/writeback.test.ts
git commit -m "feat(web-editor): debounced write-back through planOps → /ops"
```

**Checkpoint.** At the end of Phase B the document is editable end-to-end: it renders exactly as on the phone, accepts typing, and saves. Everything after this is chrome and AI surfaces.

---

# Phase C — The chrome, in HTML + Tailwind

The mechanical translation, applied consistently across Tasks 11-20:

| React Native | Web |
|---|---|
| `<View>` | `<div>` |
| `<Text>` | `<span>` / `<p>` |
| `<Pressable onPress>` | `<button onClick>` (real button — keyboard + a11y for free) |
| `StyleSheet.create` | Tailwind classes |
| `useThemeColors()` | Tailwind tokens (`bg-card`, `text-text`, `border-border`, `bg-primary`) |
| `lucide-react-native` | `lucide-react` via `src/components/ui/icon.tsx` |
| `react-native-reanimated` | CSS transitions from `lib/motion.ts` |
| `<ScrollView horizontal>` | `overflow-x-auto` |
| `Dimensions.get("window")` | a `useViewport()` hook over `window.innerWidth/Height` |
| `I18nManager.isRTL` | `dir` attribute + `visualRow()` |
| `useTranslation()` (react-i18next) | `useTranslations()` (next-intl) |

### Task 11: The primitive kit + icons

**Files:** Create `src/features/editor/chrome/primitives/{Chip,Popover,Sheet,ToolStrip,Divider}.tsx`; modify `src/components/ui/icon.tsx`

- [x] **Step 1: `Chip` — the atom every toolbar is built from**

Port `AnimatedChip.tsx` + `bubble-tools/styles.ts`. Keep `CHIP = 40` (the geometry constant the vertical pill's width maths depends on). Active state is `bg-primary text-white`; inactive `bg-card text-text border-border`; disabled `opacity-40 pointer-events-none`; `dim` `opacity-60`.

- [x] **Step 2: `Popover` — the category fly-out**

Replaces the mobile panel positioning. Anchor to the chip, flip to the opposite side when it would overflow the viewport, close on outside-click and `Escape`. Honour `isWidePanel(category)` from the ported `toolbar-store` — `hfLink`, `chartLegend` and `chartLabels` carry worded options and get the wide variant.

- [x] **Step 3: Add the icons — all of them, in one pass**

`icon.tsx` renders a **neutral dot** for an unknown name rather than crashing (line ~147), so a missing icon is invisible to `tsc` and to tests.

⚠️ **The two lucide packages are at different versions and names have drifted between them.** The app is on `lucide-react-native@^1.21.0`; the dashboard on `lucide-react@^1.25.0`. `icon.tsx` already carries the scar: `// lucide-react 1.x renamed MessageCircleQuestion -> MessageCircleQuestionMark`. So a name copied straight out of a mobile toolbar can import as `undefined`, which React renders as nothing — not an error. Import every icon **by name at the top of `icon.tsx`** (never dynamically), so a drifted name is a `tsc` failure instead of a blank chip.

Enumerate the real list from the source rather than guessing:

```bash
cd ~/modakerati
grep -rho "from \"lucide-react-native\"" -B40 components/workspace/bubble-tools components/workspace/ribbon components/workspace/ai-dock components/workspace/BlockContextBar.tsx \
  | grep -oE "^\s+[A-Z][A-Za-z0-9]+," | tr -d ' ,' | sort -u
```

Add every name that list produces to `ICONS`. Then prove none is missing:

```bash
cd ~/modakerati-dashboard
node -e "const s=require('fs').readFileSync('src/components/ui/icon.tsx','utf8'); \
  const have=new Set([...s.matchAll(/\"([a-z0-9-]+)\":/g)].map(m=>m[1])); \
  const want=require('./scripts/editor-icons.json'); \
  const miss=want.filter(n=>!have.has(n)); console.log(miss.length?('MISSING: '+miss):'ALL PRESENT')"
```

- [x] **Step 4: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/chrome/primitives src/components/ui/icon.tsx
git commit -m "feat(web-editor): chip/popover primitives and the toolbar icon set"
```

---

⚠️ **Use the toolbar store's REAL API, not an invented one.** `syncTarget({kind, key})` already does everything the shell needs and is documented as idempotent and safe to call every render: it re-runs the entry rule only on a KIND change, keeps a category the new kind still owns, drops one it does not, and exits the table delete-pick mode. Likewise `expanded` / `openMore` / `closeMore` own the (+) toggle — deliberately NOT component state, because the app keeps it open as the student moves block to block, and it carries a subtle rule (collapsing a heading takes its Style panel with it, since a compact heading's H1…Hn chips ARE its toolset).

⚠️ **Move and delete are DOCUMENT ops, not editor commands.** `applyLexicalCommand` has cases for `align · blockFormat · blur · bold · clearFormatting · color · heading · insert · italic · list · patchBlocks · quote · redo · serialize · underline · undo` — and nothing else. It could not have a `move` or `deleteBlocks` case: Lexical has no notion of a block index to reorder or remove by. Both go to the host, which owns the op queue. Same for table structure, chart patches and picture bytes — see `lib/doc-ops.ts`.

### Task 12: `BubbleBar` — the bubble shell

Rewrite of `BlockContextBar.tsx` (844 lines). This is the "bubble" the brief asks for.

**Files:** Create `src/features/editor/chrome/BubbleBar.tsx`, `src/features/editor/chrome/toolbars/context.tsx`

- [x] **Step 1: Port `ToolbarCtx` verbatim**

`bubble-tools/context.tsx` defines the 30-field `ToolbarCtx` every toolbar reads through `useTools()`. Its *shape* is pure data + callbacks and ports unchanged; only `useChipKit`'s render changes. Keep `useTools()` throwing outside a provider — that can only ever be a wiring mistake.

- [x] **Step 2: Build the shell**

The shell resolves the toolbar module and renders it:

```tsx
const kind = resolveToolbarKind({ block: selectedBlock, listType: lexFmt.blockType, chrome, count });
const { Tools, Panel } = TOOLBARS[kind];
```

`resolveToolbarKind` and `TOOLBARS` both port from the app. Per the app's list-bubble rule, `listType` comes from the **live Lexical format**, not the DTO — the DTO lags the editor and only round-trips bullets.

Key the panel by target so a panel holding a draft starts clean on a new selection, and drop any open category the incoming kind does not own (`ownsCategory` — ported).

- [x] **Step 3: Three forms, two of which survive**

Mobile has horizontal-floating, vertical-column and docked-above-keyboard. The keyboard form is dropped (no keyboard). Keep **horizontal** (default) and **vertical** (the column, still a real preference for a narrow window), sized from the ported `VERTICAL_PILL_W` / `VERTICAL_PILL_MAX_H` geometry.

- [x] **Step 4: Gate + commit**

```bash
npx tsc --noEmit
git add src/features/editor/chrome/BubbleBar.tsx src/features/editor/chrome/toolbars/context.tsx
git commit -m "feat(web-editor): the bubble shell and its toolbar context"
```

---

### Tasks 13-17: The eleven toolsets

One task per family. Every one follows the same recipe: copy the mobile file, replace the render layer per the table above, keep the logic and the disabled/active predicates exactly.

- [x] **Task 13 — Text & heading.** `ParagraphToolbar.tsx` (193) → `ParagraphTools` + `HeadingTools`; `FormatPanel.tsx` (237) → the shared `style` / `align` / `direction` / `list` / `color` panels. The colour swatches are the six from `LexicalBubble`'s `COLORS` plus the eraser sending `color:"clear"`.
- [x] **Task 14 — List.** `ListToolbar.tsx` (80) → bullet / number / check / indent / outdent. Indent and outdent dispatch `INDENT_CONTENT_COMMAND` / `OUTDENT_CONTENT_COMMAND` — Lexical owns the nesting and renumbering.
- [x] **Task 15 — Table.** `TableToolbar.tsx` (280) → `TableTools` + `TablePanel`: rows, cols, layout, shade, borders. ⚠️ In-cell editing already works — `EditCellContext` and `onEditCell` are wired in the lifted nodes. Keep the `planOps` structural-delete guard on the table path.
- [x] **Task 16 — Image, chart, other.** `ImageToolbar.tsx` (176) → `ImageTools` + `MinimalTools`; `ChartToolbar.tsx` (260) → `ChartTools` + `ChartPanel` (type / legend / labels / colour). A `svg`-bearing image block is a **native Word chart** and is genuinely editable; bytes are a picture; neither is `other`. `resolveBubbleKind` already encodes this — do not re-derive it.
- [x] **Task 17 — Header/footer & section.** `HeaderFooterToolbar.tsx` (39) → `HeaderFooterTools`; `SectionToolbar.tsx` (143) → `SectionTools` + `SectionPanel` (the `hfLink` wide panel). Note the mobile comment: `hfTop`/`hfBottom` have **no Panel** — tapping one opens the header/footer sheet (Task 29).

Each task ends with:

```bash
npx tsc --noEmit
git commit -m "feat(web-editor): <family> toolbar in html + tailwind"
```

---

### Task 18: The ribbon

**Files:** Create `src/features/editor/chrome/ribbon/*` (9 components + `ribbon-config.ts` + `useContextualTab.ts`)

- [ ] **Step 1:** `ribbon-config.ts` (191) and `useContextualTab.ts` (20) are pure data + logic — copy them.
- [ ] **Step 2:** Rewrite `ComposerRibbon`, `RibbonTabBar`, `RibbonToolStrip`, `RibbonToolButton`, `RibbonPopover`, `RibbonSearch`, `RibbonFavorites`, `GridSizePicker`, `PresetListPopover`, `SegmentPicker`.
- [ ] **Step 3:** On desktop the ribbon has room to be **persistent** rather than a composer accessory. Render it as a top bar above the document, with the contextual tab still driven by `useContextualTab`. Commit.

---

### Task 19: The AI dock

**Files:** Create `src/features/editor/chrome/dock/*`, `src/features/editor/lib/ai-dock-scopes.ts`

- [ ] **Step 1:** Port `lib/ai-dock-scopes.ts` (575 lines — `resolveDockScope`, `fillGaps`, the nine `DockScopeKind`s). Its **only** non-web import is the `lucide-react-native` icon line — same one-line swap as `bubble-configs.ts`. Also port `useDockSuggestions.ts` and `send.ts`.
- [ ] **Step 2:** Rewrite `AIDock`, `ScopeHeader`, `ActionRow`, `AskBar`.
- [ ] **Step 3:** Keep all nine scopes and the ✦ always-on assistant bubble. ⚠️ `resolveDockScope` is called **PURE, during render** (see its own doc comment) — a store round-trip would show one frame of the previous scope on every selection change. Keep that call site shape. Commit.

---

### Task 20: The pill host

Rewrite of `FloatingPill.tsx` (1,045) + `DismissTarget.tsx` (83).

**Files:** Create `src/features/editor/chrome/PillHost.tsx`

- [ ] **Step 1: Anchor it**

`LexicalState.y` is already the focused block's top in viewport px — that is the anchor, and it needs no new plumbing.

- [ ] **Step 2: Keep the drag, drop the dock**

Drag-to-reposition ports to Pointer Events and stays. Drag-to-dock-above-the-keyboard goes. The dismiss target stays (drag the pill onto it to hide it).

- [ ] **Step 3: Collapsed ↔ expanded**

The collapsed circle's glyph is `BUBBLE_ICONS[kind]` — ported in Task 2, so the glyph and the toolset can never disagree. Commit.

---

# Phase D — The AI surfaces

The nodes are already lifted (Task 5). These tasks wire the stores, the streams and the cards.

⚠️ **Task 3 Step 1 is a PREREQUISITE for this whole phase, not deferrable past it.** `thesis-suggest.ts` is what all four surfaces stream through, and the three AI stores do not compile without it. Port it first: three mechanical substitutions (`expo/fetch` → `fetch`, `getAuthHeader()` → a module-local token, `EXPO_PUBLIC_API_URL` → `NEXT_PUBLIC_MODAKERATI_SERVER_URL`), plus five endpoints and their types out of `lib/api.ts` (`chromeOp`, `generateChromeModel`, `fetchThesisSourceImage`, `suggestThesisChart`, `updateThesisChart`) and two small stores (`settings-store` for the autocomplete preference, `billing-store` for the plan). `__DEV__` becomes `process.env.NODE_ENV !== "production"`.

### Task 21: Inline suggestion (TDD on the stream parser)

The single-block AI proposal: ask for a rewrite, the card appears **on** that block with a word diff, streamed reasoning, and approve / reject / again / edit.

**Files:** Modify `src/features/editor/stores/suggestion-store.ts`; create `src/features/editor/chrome/SuggestionCard.tsx` (only if the node needs host chrome), `src/features/editor/lib/thesis-suggest.test.ts`

- [x] **Step 1: Confirm what is already done**

`SuggestionNode` (`blockLexical.tsx:2258`) renders the card, `SuggestionPlugin` mounts it, `SUGGEST_APPROVE/REJECT/AGAIN/EDIT_COMMAND` dispatch it, `diffWords` colours it, `useWorkingClock` drives the live m:ss clock. All lifted. **Do not rewrite any of it.**

- [x] **Step 2: TDD the stream parser**

`thesis-suggest.ts` reads a chunked stream carrying `[[MODK_ACTION]]` headers, reasoning deltas and proposed-text deltas. Test with a synthetic `ReadableStream`: a header split across two chunks is still recognised; reasoning and proposed deltas route to the right callbacks; a truncated stream resolves rather than hanging.

- [x] **Step 3: Wire the five actions**

`request` (rewrite / caption / insertTable / insertSourceImage / setChart — the server's `[[MODK_ACTION]]` header confirms which), `requestFill`, `approve`, `reject`, `again`, `setProposed` (the edit path). Approve routes through the op queue; **reject rebuilds the original node** via the ported `rebuildOriginal`.

- [x] **Step 4: The empty-paragraph ✦ card**

Per the app's context-suggestions behaviour, an empty paragraph shows an inline ✦ card that is a **PREVIEW** until approved, and **every AI question is dismissible**. Both hold here.

- [x] **Step 5:** Gate, test, commit.

---

### Task 22: Range rewrite

Multi-block dynamic rewrite: 2+ paragraphs collapse into **one** suggestion.

- [x] `RangeSuggestionNode` + `RangeSuggestionPlugin` + the four `RANGE_*` commands are lifted. Wire `requestRange` / `approveRange` / `rejectRange` / `againRange` / `setRangeProposed` against `/blocks/rewrite-range/stream`, and `applyThesisRangeReplace` on approve. Commit.

---

### Task 23: Ghost completion

- [x] `GhostCompletionNode` + `CompletionPlugin` + `ACCEPT_COMPLETION_COMMAND` are lifted. Wire `completionEnabled` (the setting), the request/commit/cancel triad against `/complete/stream`, and the `useAutocompleteAllowed` policy hook (port it — it is RN-free). Tab accepts, Escape dismisses. Commit.

---

### Task 24: Table proposals

- [x] `TableProposalContext` + `TABLE_AI_LABELS_EN` are lifted; the targeted table renders the diff in place, dims while the model thinks, streams reasoning underneath, and shows an inline error + retry strip on failure. Wire `table-suggestion-store` against `/table-suggest/stream`, and `diffToOps` / `layoutDelta` on approve. Supply localized `tableLabels` and `workingLabels` from `useTranslations` — the mobile code passes these in because the DOM bundle has no i18n instance; here they come from next-intl, and the English defaults remain the fallback. Commit.

---

### Task 25: Peek card and proposal stepper

- [ ] Rewrite `PeekCard.tsx` (184) and `ProposalStepper.tsx` (103) in Tailwind. The peek is the before/after glance on a pending proposal; the stepper walks a multi-step one. Commit.

---

# Phase E — The remaining surfaces

### Task 26: Search panel

- [ ] Rewrite `SearchPanel.tsx` (398). Find/replace plus semantic search with the offset-mapped Arabic normalisation (that logic is in the store — port it, don't re-derive it). `SearchHighlightPlugin` and `search-store` are already lifted; this is the panel only. Commit.

### Task 27: Insert menu

- [ ] `SlashPlugin` fires `onInsertTrigger({active, index, query})` on a `/query` at the caret; `insert-menu-store` and `insert/insert-blocks.ts` are lifted. Rewrite `BottomInsertDrawer` + `BlockComposer` (293) as a Notion-style anchored menu with compact and full modes, live filter, and session recents. `INSERT_BLOCK_COMMAND` round-trips the choice back. Commit.

### Task 28: Outline drawer

- [ ] Rewrite `ThesisOutlinePanel.tsx` (830) + `OutlineChrome.tsx` (178) + `OutlineReorderable.tsx` as a real left sidebar with the three tabs (Structure / Tables / Figures). This is what replaces the dropped `DrawerSwipePlugin` — a persistent, toggleable sidebar instead of a fling. `scrollToIndex` is already a prop. Commit.

### Task 29: Header/footer sheet

- [ ] Rewrite `HeaderFooterSheet` as a right-side panel (not a bottom sheet — desktop has width, not a thumb). `scrollToChrome` scrolls the band into view; `chromePreview` renders a template or AI proposal **on** the real band, display-only, reverted on clear. Both props are already wired. Commit.

### Task 30: Equation sheet + math preview

- [ ] `EquationNode` + `EquationTapPlugin` + `$equationTarget` are lifted; MathJax typesetting is in the ported `mathjax-web.ts`. Rewrite the equation sheet and `MathPreview.tsx` (52). ⚠️ Per [[equations-omml-rendering]] the real historical bug here was **data loss** — `EMBED_RE` missed math. Verify a round-trip preserves an equation before closing this task. Commit.

### Task 31: Picture crop

- [ ] Rewrite `PictureCropModal.tsx` (229). Rotate/crop go through the server (rembg), not client-side. Commit.

### Task 32: History sheet

- [ ] Rewrite `HistorySheet.tsx` (148) — the document-history snapshot ring and the destructive-tool confirm gate. ⚠️ Undo is **never** gated. Commit.

### Task 33: Pagination / page view

- [ ] `PaginationPlugin` + `PageBreakNode` + page artwork are lifted whole. Add the page-view toggle. ⚠️ Per [[page-view-in-writer]], **self-scheduling pagination kills autosave** — keep the ported measure-then-insert cadence exactly as it is and do not add a re-measure loop. Commit.

### Task 34: Reorder and select modes

- [ ] Wire `reorderActive` (gutter-handle drag, Pointer Events per Task 6) and `selectActive` / `selectedForCheck` / `onToggleSelect` (checkbox select — every block grows a checkbox, the editor goes read-only, tapping builds a multi-block selection). ⚠️ The range rewrite is guarded on **contiguity** — keep that check. Commit.

---

# Phase F — Integration

### Task 35: Wire it into the workspace page

**Files:** Modify `src/app/app/(workspace)/[thesisId]/page.tsx`

- [ ] **Step 1: Keep the server component as the shell**

The page stays a server component: it fetches the document, the token and the chat thread as it does today, then renders the editor as a client island. Plan 1's `<DocumentBlocks>` is **not** deleted — it renders first, server-side, so the student sees their real document before ~200KB of Lexical hydrates, and it is what shows if the editor island fails to mount.

- [ ] **Step 2: Three columns**

Outline sidebar (Task 28) | editor + ribbon + bubble | chat panel (Plans 2-3, unchanged). The chat panel already takes `accessToken`; the editor takes the same one.

- [ ] **Step 3: `modk://b/N` links become taps**

Plan 2 renders the AI's block links. Now that an editor exists, a click must scroll the block into view — wire it to `scrollToIndex`, which the editor already accepts. ⚠️ Per [[ai-block-links]] there is **no stable block id**: trust the index while its text still matches, otherwise re-find by label. `lib/block-links.ts` holds that pattern — port it.

- [ ] **Step 4: The AI turn must revalidate**

Per [[chat-turn-must-revalidate-doc]], a turn once synced the outline but not the document. When a chat turn ends, reseed the editor from the echoed document. Commit.

---

### Task 36: i18n

**Files:** Create `src/features/editor/locales/{en,fr,ar}.json`; modify `src/i18n/messages.ts`

- [ ] **Step 1: Copy the strings verbatim from `~/modakerati/locales/*.json`**

Every string this port needs already exists there under `workspace.*`, `suggestion.*`, `toolbar.*`, `ribbon.*`, `insert.*`, `search.*`. **Do not invent wording** — Plan 3 set this precedent and it holds.

- [ ] **Step 2: ⚠️ Extract surgically**

The app's locale JSONs contain **~155 duplicate keys each**, and `json.load` / `json.dump` (and `JSON.parse`/`JSON.stringify`) **silently drop them**. Do not round-trip those files. Read the values you need with a targeted `grep`/`sed` and hand-write the new bundle:

```bash
cd ~/modakerati && grep -n '"workspace\.\|"suggestion\.\|"toolbar\.' locales/en.json | head -50
```

- [ ] **Step 3:** Register the bundle in `src/i18n/messages.ts`. Commit.

---

### Task 37: Final gate

- [ ] **Step 1: The automated checks**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npx vitest run && npx next build
```

`next build` matters here specifically: it is the only check that catches a server/client boundary mistake, and this port adds a large client island to a mostly-server route tree.

- [ ] **Step 2: Confirm no React Native crossed the boundary**

```bash
grep -rn "react-native\|expo-\|expo/\|reanimated\|gesture-handler" src/features/editor/ || echo "CLEAN"
```

Must print `CLEAN`.

- [ ] **Step 3: The manual parity pass — every feature, phone beside browser**

There is no automated way to prove "the same editor". Open the same thesis on both and walk this list. Each row is a feature this plan promised:

**Document surface:** paragraphs & headings · inline runs (bold/italic/underline/colour) · lists incl. checklists & nesting · tables (fills, text colours, merged cells, borders, RTL) · in-cell editing · figures (inline + lazy authed) · native Word charts · textboxes / cover shapes · `other` blocks · equations · floating anchored shapes · page ornaments · header/footer/section bands · page view & page artwork.

**Editing:** typing · undo/redo · scroll-position restore · search highlight · selection highlight · checkbox select · drag reorder · slash menu · paste image · autosave.

**Bubble:** all eleven kinds resolve to the right toolset · every panel opens and applies · the collapsed glyph matches the toolset · drag to reposition · dismiss.

**AI:** inline suggestion (rewrite / caption / insert table / insert source image / edit chart) with word diff, streamed reasoning, live clock, and approve / reject / again / edit · empty-paragraph ✦ preview card · range rewrite across 2+ blocks · ghost completion (Tab accepts, Esc dismisses) · table proposal with in-place diff, thinking, error + retry.

**Surfaces:** search panel · insert menu · outline drawer (3 tabs) · header/footer panel · equation editor · picture crop · history · ribbon · AI dock.

**Trilingual:** load an Arabic thesis in an English UI and confirm the document stays RTL — direction is **content-driven, not locale-driven**, and this is where a port most often quietly breaks it.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web-editor): the app's thesis editor, ported to the web"
```

---

## Two things worth saying plainly before you start

**The scope is real but the shape is favourable.** ~20,000 lines are involved, but roughly 12,000 of them are a copy: the document surface was browser code from the day it was written. The genuine engineering is Phase C (translating a React Native render layer) and Phase D (rewiring streams that already have a working client). Resist the pull to "improve" the lifted code — a divergence between the two repos costs more than any tidy-up saves.

**Where this plan deliberately departs from the phone**, and why, in one place so it is easy to challenge: no soft-keyboard mode, no swipe-to-open-drawer (a real sidebar instead), no haptics, no Reanimated springs (CSS transitions at the same timings), no bottom sheets (side panels — desktop has width, not a thumb), and the ribbon is persistent rather than a composer accessory. Everything else is intended to be indistinguishable. If any of those five is wrong for your product, they are all localized to Phase C and cheap to change now — much less so after Task 20.
