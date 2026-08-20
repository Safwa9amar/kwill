# Kwill Web — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx expo export --platform web` succeed and deploy an authenticated Kwill SPA to Vercel, where a student can sign in, see their library, open a thesis and edit it.

**Architecture:** One codebase on Expo's web target (`output: "single"`). The four native seams named in the spec are severed with `.web.ts` platform twins so no call site learns which platform it is on. The Lexical writer needs no work — `'use dom'` components render as plain React DOM on web.

**Tech Stack:** Expo SDK 56, Expo Router, react-native-web, Metro, Vercel (static + SPA rewrite), Hono (server-side CORS).

**Spec:** `docs/superpowers/specs/2026-08-20-web-version-design.md`

---

## Read this before Task 1

**There is no JS test runner in this repo and this plan does not add one.** Every
"write the failing test" instinct maps instead onto one command:

```bash
npx expo export --platform web
```

That export is a real, binary, reproducible gate. It already fails today — the
comment in `scripts/publish-update.sh` records why: `expo-sqlite`'s web build
imports `./wa-sqlite/wa-sqlite.wasm`, a file absent from the published package,
and Metro fails the whole export over it. So the rhythm for every task is:

1. run the gate,
2. read the *actual* error,
3. fix exactly that,
4. run the gate again,
5. commit.

Do not batch fixes ahead of the errors that justify them. If the export fails
with something this plan did not predict, that is information — record it in the
task and fix what it actually says, not what the plan guessed.

**Scope of this plan (Foundation only).** It ends with a working, deployed,
authenticated web app in the *mobile* layout. It is **not student-ready**: the
desktop layout and the durable IndexedDB caches are Plans 2 and 3. Do not
announce this to students at the end of this plan.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `scripts/verify-web.sh` | The gate. tsc + use-dom check + web export. |
| `scripts/build-web.sh` | Production web build with the `.env.production` swap. |
| `lib/thesis-op-queue.web.ts` | Durable op queue on `localStorage`. Load-bearing. |
| `lib/thesis-doc-cache.web.ts` | No-op twin (pure perf cache). |
| `lib/outline-cache.web.ts` | No-op twin (pure perf cache). |
| `lib/chat-cache.web.ts` | No-op twin (pure perf cache). |
| `lib/download-export.web.ts` | Blob → object URL → anchor download. |
| `components/RenderHtml.web.tsx` | `srcDoc` iframe. |
| `components/workspace/PdfView.web.tsx` | `<iframe src={url}>`. |
| `components/workspace/OnlyOfficeView.web.tsx` | `<iframe>` on the OnlyOffice URL. |
| `components/workspace/WordDocxView.web.tsx` | "Open in the app" placeholder. |
| `components/workspace/WordDocxView.types.ts` | Shared prop types for both twins. |
| `vercel.json` | SPA rewrite. Without it, refresh 404s. |

**Modified**

| Path | Change |
|---|---|
| `app.json` | Add the `web` block. **Moves the native fingerprint.** |
| `lib/i18n.ts` | `restartApp` gets a web branch. |
| `lib/push-notifications.ts` | Web returns the same no-op as Expo Go. |
| `scripts/publish-update.sh` | Update the now-stale expo-sqlite comment. |

---

### Task 1: Record the baseline native fingerprint

Nothing is changed here. This is a measurement taken *before* `app.json` moves,
so the move in Task 2 is observed rather than discovered months later when an
OTA silently reaches nobody.

**Files:** none (read-only)

- [ ] **Step 1: Resolve and record the current runtime version**

```bash
npx expo-updates runtimeversion:resolve --platform android
npx expo-updates runtimeversion:resolve --platform ios
```

Expected: two JSON objects, each with a `runtimeVersion` string (a hash).
Write both values down — paste them into the Task 2 commit message.

- [ ] **Step 2: Confirm there is no web config yet**

```bash
node -e 'console.log(JSON.stringify(require("./app.json").expo.web ?? null))'
```

Expected output: `null`

---

### Task 2: Add the web target to app.json

**This is a native-affecting commit.** `app.json` is a fingerprint input and
`fingerprint.config.js` ignores only Gradle build output, so both native runtime
versions change. Every installed binary stops being offered OTA updates until a
new APK is built. That is accepted (see the spec), but it must be *known*.

**Files:**
- Modify: `app.json`

- [ ] **Step 1: Add the `web` block**

Insert after the `"android"` block, before `"plugins"`. Colors are the existing
brand values already in this file (`splash.backgroundColor` and the
`expo-notifications` colour), not new ones:

```json
    "web": {
      "bundler": "metro",
      "output": "single",
      "favicon": "./assets/icon.png",
      "name": "Kwill",
      "shortName": "Kwill",
      "lang": "ar",
      "backgroundColor": "#121220",
      "themeColor": "#F59433"
    },
```

- [ ] **Step 2: Verify the JSON still parses**

```bash
node -e 'console.log(require("./app.json").expo.web.output)'
```

Expected output: `single`

- [ ] **Step 3: Observe the fingerprint move**

```bash
npx expo-updates runtimeversion:resolve --platform android
npx expo-updates runtimeversion:resolve --platform ios
```

Expected: both hashes DIFFER from the Task 1 values. If they are identical,
stop — either the config did not take effect or fingerprinting is misconfigured,
and shipping on a false assumption here breaks OTA for real users.

- [ ] **Step 4: Commit, recording both fingerprints**

```bash
git add app.json
git commit -m "feat(web): add the web target to app.json

NATIVE-AFFECTING: app.json is a fingerprint input, so this moves the Android
and iOS runtime versions. Installed binaries will not be offered OTA updates
until a new APK ships at the new fingerprint.

android before: <PASTE> after: <PASTE>
ios     before: <PASTE> after: <PASTE>"
```

---

### Task 3: Create the gate script

**Files:**
- Create: `scripts/verify-web.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# The web gate. `tsc --noEmit` is the only automated check this repo has, and it
# is PROVABLY blind to the two failure classes that matter on web:
#
#   1. a native-only module reaching a web-reachable import path (types are fine;
#      Metro dies), and
#   2. a `use dom` file with a named export, which breaks a whole screen at
#      BUNDLE time while tsc stays green.
#
# So the export is the gate, not the types. Run this before every web commit.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ types"
npx tsc --noEmit

echo "▸ use dom single-export check"
node scripts/verify-use-dom.mjs

echo "▸ web export (the real gate)"
rm -rf dist-web
npx expo export --platform web --output-dir dist-web

echo "✓ web export succeeded → dist-web/"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/verify-web.sh
```

- [ ] **Step 3: Ignore the build output**

Append to `.gitignore`:

```
dist-web/
```

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-web.sh .gitignore
git commit -m "chore(web): add the web export gate

tsc is blind to native imports and use-dom violations; the export is not."
```

---

### Task 4: Run the gate and watch it fail

This is the failing-test step. Do not fix anything yet.

**Files:** none

- [ ] **Step 1: Run the gate**

```bash
./scripts/verify-web.sh
```

Expected: FAIL. The predicted first error is Metro failing to resolve
`./wa-sqlite/wa-sqlite.wasm` from `expo-sqlite`'s web build — the exact failure
already documented in `scripts/publish-update.sh`.

- [ ] **Step 2: Record the real error**

Copy the actual failing module and message into a scratch note. If it is *not*
the expo-sqlite wasm error, the plan's ordering assumption is wrong: fix what
the error actually says, and note the divergence for the remaining tasks.

---

### Task 5: Sever the SQLite seam — the op queue (durable)

Three of the four SQLite modules are pure performance caches whose absence costs
only a network fetch. `thesis-op-queue.ts` is not: it is the durable record of
optimistic edits that have not yet been confirmed by the server. On web it gets
a real `localStorage` implementation, because losing it means losing a student's
unsent edits on refresh.

`localStorage` is chosen over IndexedDB here deliberately — the queue holds a
handful of small JSON ops, and a synchronous store behind an async interface is
the simplest thing that is actually durable. Plan 2 moves all four to IndexedDB
together.

**Files:**
- Create: `lib/thesis-op-queue.web.ts`

- [ ] **Step 1: Write the web twin**

Every export must match `lib/thesis-op-queue.ts` exactly: `QueuedOp`,
`newOpId`, `enqueueOp`, `confirmOp`, `bumpOpAttempts`, `listQueuedOps`,
`clearQueuedOps`.

```ts
import type { ThesisOp } from "@/lib/thesis-ops";

// Web twin of the durable op queue. Same contract as the native SQLite version:
// every optimistic edit is persisted BEFORE its server call and deleted only on
// confirmation, so edits survive a reload and replay in order.
//
// localStorage rather than IndexedDB on purpose. The queue holds a few small
// JSON ops, never a document; a synchronous store behind this async interface is
// the simplest thing that is genuinely durable. (Plan 2 moves all four caches to
// IndexedDB together — this one is here early because it is the only one whose
// absence loses a student's work rather than costing a fetch.)
//
// Failures are swallowed exactly as the native version swallows them:
// persistence is a reliability net, and a full disk quota must never break live
// editing. The in-memory chain still works.

const KEY = "kwill.thesis_ops";

export interface QueuedOp {
  id: string;
  thesisId: string;
  op: ThesisOp;
  createdAt: string;
  attempts: number;
}

function readAll(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(ops: QueuedOp[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ops));
  } catch {
    // Quota exceeded or storage disabled (private mode). Non-fatal by design.
  }
}

let seq = 0;
/** Sortable unique id: enqueue order == replay order even within one ms. */
export function newOpId(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueOp(id: string, thesisId: string, op: ThesisOp): Promise<void> {
  const ops = readAll();
  ops.push({ id, thesisId, op, createdAt: new Date().toISOString(), attempts: 0 });
  writeAll(ops);
}

export async function confirmOp(id: string): Promise<void> {
  writeAll(readAll().filter((o) => o.id !== id));
}

export async function bumpOpAttempts(id: string): Promise<void> {
  writeAll(readAll().map((o) => (o.id === id ? { ...o, attempts: o.attempts + 1 } : o)));
}

export async function listQueuedOps(thesisId: string): Promise<QueuedOp[]> {
  return readAll()
    .filter((o) => o.thesisId === thesisId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export async function clearQueuedOps(thesisId: string): Promise<void> {
  writeAll(readAll().filter((o) => o.thesisId !== thesisId));
}
```

- [ ] **Step 2: Confirm the two modules export the same names**

```bash
diff <(grep -o "^export \(async function\|function\|interface\) [A-Za-z]*" lib/thesis-op-queue.ts | sort) \
     <(grep -o "^export \(async function\|function\|interface\) [A-Za-z]*" lib/thesis-op-queue.web.ts | sort)
```

Expected: no output. Any difference is a signature drift bug — fix it now, not
at runtime on a student's machine.

- [ ] **Step 3: Commit**

```bash
git add lib/thesis-op-queue.web.ts
git commit -m "feat(web): durable op queue on localStorage

The one SQLite module whose absence loses work rather than costing a fetch."
```

---

### Task 6: Sever the SQLite seam — the three perf caches

**Files:**
- Create: `lib/thesis-doc-cache.web.ts`
- Create: `lib/outline-cache.web.ts`
- Create: `lib/chat-cache.web.ts`

- [ ] **Step 1: Write `lib/thesis-doc-cache.web.ts`**

```ts
import type { DocumentDTO } from "@/lib/api";

// Web twin of the document cache. A no-op for now, and safe as one: this cache
// exists so a thesis appears instantly on open, and its absence costs exactly
// one network fetch — never correctness. The server is the source of truth.
//
// Plan 2 replaces this with IndexedDB. It is a stub rather than localStorage
// because a DocumentDTO is far too large for a 5MB synchronous store.

export async function getDocCache(_thesisId: string): Promise<DocumentDTO | null> {
  return null;
}

export async function setDocCache(_thesisId: string, _doc: DocumentDTO): Promise<void> {}

export async function clearDocCache(_thesisId: string): Promise<void> {}
```

- [ ] **Step 2: Write `lib/outline-cache.web.ts`**

```ts
import type { OutlineDTO } from "@/lib/api";

// Web twin of the outline cache. No-op for the same reason as the document
// cache: a miss costs one fetch, never correctness. Replaced by IndexedDB in
// Plan 2.

export async function getCachedOutline(_thesisId: string): Promise<OutlineDTO | null> {
  return null;
}

export async function setCachedOutline(_thesisId: string, _outline: OutlineDTO): Promise<void> {}

export async function clearOutlineCache(_thesisId: string): Promise<void> {}
```

- [ ] **Step 3: Write `lib/chat-cache.web.ts`**

`hasMore: false` is the correct empty answer — it tells the infinite-scroller
there is no older history *in the cache*, which is true, and leaves the server
as the only source. Returning `true` would make it page against nothing.

```ts
import type { ChatMessage } from "@/types/chat";

// Web twin of the chat cache. No-op: the cache makes a thread appear instantly
// and readable offline, and the server remains the source of truth either way.
// On web, a cold thread costs one fetch. Replaced by IndexedDB in Plan 2.

export interface CachePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

const EMPTY: CachePage = { messages: [], hasMore: false };

export async function getLatestMessages(_threadId: string, _limit: number): Promise<CachePage> {
  return EMPTY;
}

export async function getOlderMessages(
  _threadId: string,
  _before: string,
  _limit: number,
): Promise<CachePage> {
  return EMPTY;
}

export async function upsertMessages(_threadId: string, _messages: ChatMessage[]): Promise<void> {}

export async function deletePending(_threadId: string): Promise<void> {}

export async function deleteStalePending(_threadId: string, _maxAgeMs: number): Promise<number> {
  return 0;
}

export async function getLastSyncedAt(_threadId: string): Promise<string | null> {
  return null;
}

export async function setLastSyncedAt(
  _threadId: string,
  _lastSyncedAt: string | null,
): Promise<void> {}

export async function clearCache(_threadId: string): Promise<void> {}
```

- [ ] **Step 4: Verify the `DocumentDTO` / `OutlineDTO` import paths are right**

```bash
grep -n "OutlineDTO\|DocumentDTO" lib/outline-cache.ts lib/thesis-doc-cache.ts | head -4
```

Expected: the native files import these from the same module the twins do. If
they import from somewhere else, match them exactly.

- [ ] **Step 5: Run the gate**

```bash
./scripts/verify-web.sh
```

Expected: the expo-sqlite wasm error is GONE (no web-reachable module imports
`expo-sqlite` any more). A new, different error is the expected outcome —
most likely `expo-file-system`.

- [ ] **Step 6: Commit**

```bash
git add lib/thesis-doc-cache.web.ts lib/outline-cache.web.ts lib/chat-cache.web.ts
git commit -m "feat(web): no-op twins for the three perf caches

A miss costs one fetch, never correctness — the server is the source of truth.
This removes the last web-reachable expo-sqlite import, which is what actually
killed the web export (see scripts/publish-update.sh)."
```

---

### Task 7: Sever the filesystem seam

`expo-file-system` has **no web build at all** in SDK 56. The rule from the spec:
no web-reachable module may import it at module scope. `lib/download-export.ts`
is web-reachable — `app/(app)/chat.tsx` and `app/(app)/export.tsx` both use it.

The native version deliberately fetches the signed URL rather than opening it in
a browser, because the URL carries a JWT in its query string. The web twin keeps
that property: it fetches to a Blob in-page and downloads from an object URL, so
the token never reaches the address bar or browser history.

**Files:**
- Create: `lib/download-export.web.ts`

- [ ] **Step 1: Write the web twin**

```ts
import type { FilePayload } from "@/types/chat";

// Web twin of the export download. Must export exactly `DownloadableExport` and
// `downloadExport`, matching lib/download-export.ts.
//
// The native version is deliberately NOT a browser hand-off: the export URL is a
// signed Supabase link whose query string carries a JWT, and opening it
// externally would put that token in browser history and the address bar. That
// reasoning applies with more force on the web, so this fetches the bytes
// in-page and hands the student a Blob. The signed URL is never navigated to.

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  latex: "application/x-tex",
  tex: "application/x-tex",
};

/** A filename the browser's download attribute will accept. Mirrors the native
 *  version: thesis titles are frequently Arabic and carry invisible bidi control
 *  characters that are legal in a title and a menace in a filename. */
function safeFilename(name: string, format: string): string {
  const cleaned = name
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || "thesis";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${format || "docx"}`;
}

export type DownloadableExport = Pick<FilePayload, "url" | "filename" | "format" | "title">;

export async function downloadExport(file: DownloadableExport): Promise<void> {
  const res = await fetch(file.url);
  if (!res.ok) {
    // Most likely an expired link — these are signed for one hour, so a card
    // from an older conversation will refuse. Throw so the caller can say so.
    throw new Error(`export-fetch-failed-${res.status}`);
  }

  const format = (file.format || "docx").toLowerCase();
  const bytes = await res.arrayBuffer();
  const blob = new Blob([bytes], { type: MIME[format] ?? "application/octet-stream" });

  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = safeFilename(file.title?.trim() || file.filename, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}
```

- [ ] **Step 2: Confirm no OTHER web-reachable module imports expo-file-system**

```bash
grep -rln "expo-file-system" app components lib stores hooks
```

Expected list, and every entry must be justified: files reachable from the
day-one routes need a `.web.ts` twin; files reachable only from out-of-scope
routes (`rescue-store`, `combine-store`, `import-store`) are fine ONLY if no
in-scope module imports them at module scope. Verify each with:

```bash
grep -rn "rescue-store\|combine-store\|import-store" app/\(app\)/chat.tsx app/\(app\)/thesis-workspace.tsx app/\(app\)/library.tsx
```

If an in-scope screen imports one of those stores at module scope, it pulls
`expo-file-system` into the web bundle and the export will fail. Record which,
and give that store a `.web.ts` twin too.

- [ ] **Step 3: Run the gate**

```bash
./scripts/verify-web.sh
```

Expected: the `expo-file-system` resolution error is gone. Next predicted
failure: `react-native-webview`.

- [ ] **Step 4: Commit**

```bash
git add lib/download-export.web.ts
git commit -m "feat(web): download exports as a Blob, never a navigation

Keeps the native version's property that the signed URL's JWT never reaches
the address bar or browser history."
```

---

### Task 8: Sever the WebView seam

Four components import `react-native-webview`, which has no web build. Three
become iframes. `WordDocxView` does not: its value is a tap-to-target protocol
over `postMessage` with an offscreen double-buffered re-render, and a
half-working version would be worse than an honest placeholder. It is also not
the primary writer — `WorkspaceLexicalView` is, and that is `'use dom'` and
already works on web.

**Files:**
- Create: `components/workspace/WordDocxView.types.ts`
- Modify: `components/workspace/WordDocxView.tsx`
- Create: `components/workspace/WordDocxView.web.tsx`
- Create: `components/workspace/PdfView.web.tsx`
- Create: `components/workspace/OnlyOfficeView.web.tsx`
- Create: `components/RenderHtml.web.tsx`

- [ ] **Step 1: Extract the shared prop type**

Create `components/workspace/WordDocxView.types.ts` with exactly this content.
It is lifted from the inline annotation on `WordDocxViewInner`, comments
included — those comments encode protocol decisions (nonce semantics, why `rtl`
is content-derived) that are not recoverable from the types alone:

```ts
export interface DocTapBlock {
  index: number;
  text: string;
}

export interface WordDocxViewProps {
  url: string;
  blocks: DocTapBlock[];
  // A normal tap selects/toggles one block; a long-press (>=500ms) starts/extends a
  // multi-selection. The parent decides single-vs-toggle from the store's mode.
  onSelect: (index: number, text: string) => void;
  onLongPress: (index: number, text: string) => void;
  // Scroll request from the outline navigator (and cold deep-links): bring this
  // engine block into view. `nonce` bumps per request so re-tapping the same
  // heading re-scrolls; a request that arrives before the shell is ready is
  // applied once "ready" fires. Applied at most once per nonce, so a shell
  // rebuild (rtl flip) doesn't yank the reader back to the last target.
  scrollTarget?: { index: number; nonce: number } | null;
  // Base page direction. docx-preview renders Arabic runs RTL via bidi, but the
  // block-level layout (indents, justification anchor, header tab stops, table
  // column order) stays LTR unless the container is dir="rtl". True for Arabic
  // theses (detected from content, since the thesis language field is unreliable).
  rtl?: boolean;
  // When set, subscribes to this thesis's optimistic edit ops (thesis-doc-store)
  // and patches the rendered DOM in place for instant feedback.
  thesisId?: string;
  // When false (an AI turn is generating), a tap never enters inline-edit mode.
  editable?: boolean;
  // A live/blur commit of an inline paragraph edit -> the parent maps it to an
  // editText op. Text is the paragraph's current plain text.
  onEditCommit?: (index: number, text: string) => void;
  // Enter pressed mid-paragraph: split `index` into `before` (stays) + `after`
  // (new paragraph inserted right after).
  onSplit?: (index: number, before: string, after: string) => void;
  // Backspace at offset 0: merge paragraph `curIndex` into `prevIndex`, with the
  // already-joined text. The parent emits editText(prevIndex, mergedText) then
  // deleteBlocks([curIndex]).
  onMerge?: (prevIndex: number, curIndex: number, mergedText: string) => void;
  // Fired true when a paragraph in the WebView gains an inline caret, false when it
  // blurs — lets the workspace hide the composer while editing.
  onEditActiveChange?: (active: boolean) => void;
}
```

Note the defaults live on the destructuring in the native component
(`rtl = false`, `editable = true`), not in this type — leave them there.

- [ ] **Step 2: Point the native component at the shared type**

In `components/workspace/WordDocxView.tsx`, replace the local
`export interface DocTapBlock` and the inline prop annotation with an import:

```ts
import type { DocTapBlock, WordDocxViewProps } from "./WordDocxView.types";
export type { DocTapBlock };

function WordDocxViewInner({ url, blocks, /* …same destructuring… */ }: WordDocxViewProps) {
```

- [ ] **Step 3: Verify types still pass**

```bash
npx tsc --noEmit
```

Expected: PASS. A failure means the extracted type drifted from the original —
diff it against git and fix.

- [ ] **Step 4: Write `components/workspace/WordDocxView.web.tsx`**

```tsx
import { View, Text, StyleSheet } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useTranslation } from "react-i18next";
import type { WordDocxViewProps } from "./WordDocxView.types";

export type { DocTapBlock } from "./WordDocxView.types";

/**
 * Web placeholder for the Word-fidelity view.
 *
 * The native component is a WebView running docx-preview with a tap-to-target
 * postMessage protocol and an offscreen double-buffered re-render. None of that
 * survives a naive port, and a half-working fidelity view is worse than none:
 * the whole point of it is that what you see is what Word shows.
 *
 * This is NOT the writer. `WorkspaceLexicalView` is, it is a `use dom` component,
 * and it renders natively on web — so nothing about editing is blocked here.
 */
export const WordDocxView = (_props: WordDocxViewProps) => {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface }]}>
      <Text style={[styles.text, { color: colors.textMuted }]}>
        {t("web.wordViewUnavailable")}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  text: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
```

- [ ] **Step 5: Write `components/workspace/PdfView.web.tsx`**

The native version loads PDF.js inside a WebView. A browser already has a PDF
viewer, so the web twin is the iframe the native one was emulating.

```tsx
import { View, StyleSheet } from "react-native";

/**
 * Web twin of the PDF view. The native version ships PDF.js inside a WebView
 * because a RN app has no PDF renderer; a browser does, so this is simply the
 * thing that was being emulated. Read-only, same as native.
 */
export const PdfView = ({ url }: { url: string }) => (
  <View style={styles.wrap}>
    <iframe src={url} style={{ width: "100%", height: "100%", border: "none" }} title="PDF" />
  </View>
);

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: "hidden" },
});
```

- [ ] **Step 6: Write `components/workspace/OnlyOfficeView.web.tsx`**

```tsx
import { View, StyleSheet } from "react-native";

/**
 * Web twin of the OnlyOffice view. The native version builds an HTML shell that
 * loads the OnlyOffice API script and hands it `config`; on web that shell is
 * the page, so the editor is embedded directly via its own iframe.
 *
 * `config` is typed `any` here for the same reason it is on native: it is the
 * OnlyOffice editor config object, passed straight through.
 */
export const OnlyOfficeView = ({
  documentServerUrl,
  config,
}: {
  documentServerUrl: string;
  config: any;
  onError?: (message: string) => void;
}) => {
  const src = `${documentServerUrl.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`;
  return (
    <View style={styles.wrap}>
      <iframe
        srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>html,body,#ph{margin:0;height:100%;}</style>
<script src="${src}"></script></head>
<body><div id="ph"></div>
<script>new DocsAPI.DocEditor("ph", ${JSON.stringify(config)});</script>
</body></html>`}
        style={{ width: "100%", height: "100%", border: "none" }}
        title="OnlyOffice"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: "hidden" },
});
```

- [ ] **Step 7: Write `components/RenderHtml.web.tsx`**

```tsx
import { useState } from "react";
import { View } from "react-native";
import { getTextDirection } from "@/lib/text-direction";
import { useThemeColors } from "@/hooks/useThemeColors";

/**
 * Web twin of the article renderer. The native version wraps the HTML in a
 * themed document inside an auto-sizing WebView; here the same document goes
 * into an iframe `srcDoc`, and the height still comes back by postMessage
 * because the parent owns the scrolling either way.
 */
export function RenderHtml({ html }: { html: string }) {
  const colors = useThemeColors();
  const [height, setHeight] = useState(120);
  const dir = getTextDirection(html);

  const doc = `<!DOCTYPE html><html dir="${dir}"><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;padding:0;background:transparent;color:${colors.text};
    font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.7;}
  a{color:${colors.primary};} img{max-width:100%;height:auto;}
</style></head><body>${html}
<script>
  function post(){parent.postMessage({__kwillHeight:document.body.scrollHeight},'*');}
  post();window.addEventListener('load',post);setTimeout(post,300);setTimeout(post,1000);
</script></body></html>`;

  if (typeof window !== "undefined") {
    window.onmessage = (e: MessageEvent) => {
      const h = (e.data ?? {}).__kwillHeight;
      if (typeof h === "number" && h > 0) setHeight(h);
    };
  }

  return (
    <View style={{ height }}>
      <iframe srcDoc={doc} style={{ width: "100%", height: "100%", border: "none" }} title="article" />
    </View>
  );
}
```

- [ ] **Step 8: Add the translation key in all three locales**

⚠️ The locale JSONs contain ~155 duplicate keys each and `json.load`/`json.dump`
silently drops them. **Edit these files surgically with a text editor — never by
round-tripping through a JSON parser.**

Add under the existing top-level structure in `locales/en.json`,
`locales/fr.json`, `locales/ar.json` respectively:

```json
  "web": { "wordViewUnavailable": "The Word-fidelity view is available in the Kwill app." },
```
```json
  "web": { "wordViewUnavailable": "L'aperçu fidèle à Word est disponible dans l'application Kwill." },
```
```json
  "web": { "wordViewUnavailable": "معاينة Word المطابقة متوفرة في تطبيق Kwill." },
```

- [ ] **Step 9: Verify no duplicate-key damage**

```bash
for f in locales/en.json locales/fr.json locales/ar.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f parses')"
  echo "  lines: $(wc -l < $f)"
done
```

Expected: all three parse, and each line count is exactly ONE more than before
your edit (`git diff --stat locales/` should show `1 insertion` per file, zero
deletions). Any deletion means a parser round-trip ate duplicate keys — revert
with `git checkout locales/` and redo by hand.

- [ ] **Step 10: Run the gate**

```bash
./scripts/verify-web.sh
```

Expected: the `react-native-webview` error is gone.

- [ ] **Step 11: Commit**

```bash
git add components/ locales/
git commit -m "feat(web): iframe twins for the WebView components

PDF, OnlyOffice and article HTML become iframes — on web that is the thing the
WebView was emulating. WordDocxView stays an honest placeholder: its value is a
tap-to-target protocol over postMessage, and a half-working fidelity view is
worse than none. The writer is unaffected (use dom, renders natively)."
```

---

### Task 9: Sever the boot seam

Two modules on the startup path touch native-only APIs.

**Files:**
- Modify: `lib/i18n.ts`
- Modify: `lib/push-notifications.ts`

- [ ] **Step 1: Give `restartApp` a web branch**

In `lib/i18n.ts`, `restartApp` currently calls `reloadAppAsync` from `expo`
(NOT `expo-updates` — the comment there rules that out deliberately). Its web
behaviour is not something to rely on, and a language change needs a genuine
document reload to re-apply direction anyway. Add the branch at the top of the
function body, after the delay:

```ts
export async function restartApp(delayMs = 500): Promise<boolean> {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

  // On web, re-applying text direction requires a real document reload — RN's
  // I18nManager only mirrors layout at startup, and on web "startup" is the
  // document. location.reload() is both simpler and more correct than anything
  // reloadAppAsync would do here.
  if (Platform.OS === "web") {
    window.location.reload();
    return true;
  }

  try {
    await reloadAppAsync("Language changed — applying new text direction");
    return true;
  } catch {
    if (__DEV__) DevSettings.reload();
    return false;
  }
}
```

Ensure `Platform` is imported — line 3 currently reads
`import { DevSettings, I18nManager } from "react-native";`. Change it to:

```ts
import { DevSettings, I18nManager, Platform } from "react-native";
```

- [ ] **Step 2: Make every push path a no-op on web**

`lib/push-notifications.ts` already lazy-`require`s `expo-notifications` behind
an Expo Go check, so it does not break the bundle — but on web the `require`
would still run. Extend the existing guard in `getNotifications()`:

```ts
function getNotifications(): typeof NotificationsModule | null {
  if (notificationsLoaded) return notificationsModule;
  notificationsLoaded = true;
  // Web has no native notification module to load. Returning null here makes
  // every push path a graceful no-op, exactly as it already does in Expo Go.
  if (Platform.OS === "web") return null;
  if (isRunningInExpoGo()) return null;
  try {
    notificationsModule = require("expo-notifications");
```

`Platform` is already imported in this file (line 1) — confirm with:

```bash
head -1 lib/push-notifications.ts
```

Expected: `import { Platform } from "react-native";`

- [ ] **Step 3: Run the gate**

```bash
./scripts/verify-web.sh
```

Expected: **PASS** — `✓ web export succeeded → dist-web/`. If it still fails,
the remaining error names a module this plan did not predict; fix that module
with the same twin pattern and note it.

- [ ] **Step 4: Commit**

```bash
git add lib/i18n.ts lib/push-notifications.ts
git commit -m "fix(web): guard the two native modules on the boot path

restartApp reloads the document (direction only re-applies at startup, and on
web startup IS the document); push becomes the same no-op it already is in
Expo Go."
```

---

### Task 10: Update the stale expo-sqlite comment

`scripts/publish-update.sh` documents that the web export "dies on expo-sqlite".
As of Task 6 that is no longer true, and a stale comment that says a build is
impossible is exactly the kind of thing that stops someone trying.

**Files:**
- Modify: `scripts/publish-update.sh`

- [ ] **Step 1: Replace the outdated paragraph**

Find the paragraph beginning "The web export dies on expo-sqlite" and replace
that sentence with:

```
# there is no reason to OTA a web bundle: the web app deploys to Vercel as a
# static site (scripts/build-web.sh), and expo-updates never serves it. The web
# export itself builds fine now — the four *.web.ts cache twins removed the
# expo-sqlite import that used to kill it.
```

Leave the `app.json` fingerprint warning in that comment **intact** — it is
still true, and Task 2 has now paid that cost once.

- [ ] **Step 2: Verify the script still parses**

```bash
bash -n scripts/publish-update.sh && echo "syntax ok"
```

Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
git add scripts/publish-update.sh
git commit -m "docs(web): the web export is no longer blocked by expo-sqlite"
```

---

### Task 11: Production web build script

**Files:**
- Create: `scripts/build-web.sh`

`EXPO_PUBLIC_*` values are inlined into the bundle. Building against the working
`.env` would ship a public website pointing at a LAN address — the same failure
`publish-update.sh` exists to prevent, with a wider blast radius because a
website has no install step to gate it.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Build the production web bundle.
#
#   ./scripts/build-web.sh          # → dist-web/, ready for Vercel
#
# Same .env shuffle as build-apk.sh and publish-update.sh, for the same reason:
# EXPO_PUBLIC_* values are INLINED into the bundle. Building with your working
# .env would publish a website pointing every visitor at the LAN box on your
# desk — and unlike an APK there is no install step between that mistake and a
# student hitting it.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.production ] || { echo "✗ .env.production is missing"; exit 1; }

RESTORE=0
if [ -f .env ]; then cp .env .env.devbackup; RESTORE=1; fi
restore() {
  if [ "$RESTORE" = "1" ]; then mv -f .env.devbackup .env; echo "▸ restored your dev .env"; else rm -f .env; fi
}
trap restore EXIT

cp .env.production .env
echo "▸ building web with production env:"
grep -E "^EXPO_PUBLIC" .env | sed 's/^/    /'

rm -rf dist-web
npx expo export --platform web --output-dir dist-web

echo "✓ dist-web/ built"
echo "  deploy: npx vercel deploy --prebuilt=false dist-web"
```

- [ ] **Step 2: Make it executable and run it**

```bash
chmod +x scripts/build-web.sh
./scripts/build-web.sh
```

Expected: `✓ dist-web/ built`, and the printed `EXPO_PUBLIC` lines must be the
**production** values, not your LAN address. Read them — this is the check.

- [ ] **Step 3: Verify the bundle does not contain a LAN address**

```bash
grep -rl "192.168\.\|10\.0\.0\.\|localhost:" dist-web/ | head
```

Expected: no output. Any hit means the env swap failed and this bundle must not
be deployed.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-web.sh
git commit -m "chore(web): production web build with the .env.production swap"
```

---

### Task 12: Vercel SPA rewrite

With `output: "single"` there is exactly one `index.html`. Without a catch-all
rewrite, a refresh on any client-side route returns 404. This is the single most
common way this deployment is broken.

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Write the config**

`.env.production` is **gitignored** (`.gitignore` line 66 — "secrets, never
commit"), so it does not exist on Vercel's builder and `build-web.sh` would
abort there on its own guard. Vercel supplies the same values from project
settings instead, so the build command is the bare export:

```json
{
  "buildCommand": "npx expo export --platform web --output-dir dist-web",
  "outputDirectory": "dist-web",
  "framework": null,
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

`scripts/build-web.sh` remains the **local** production build — for testing a
production bundle on your own machine, and for a manual deploy if Vercel is ever
bypassed. The two paths must agree on values; Step 2 below is what enforces that.

- [ ] **Step 2: Set the EXPO_PUBLIC_* variables in Vercel project settings**

Because the builder has no `.env.production`, every `EXPO_PUBLIC_*` key that
`.env.production` defines must exist in the Vercel project's Environment
Variables (Production **and** Preview). List what is required:

```bash
grep -E "^EXPO_PUBLIC" .env.production | cut -d= -f1
```

Add each one in Vercel with its production value. A missing key does not fail
the build — it inlines `undefined` and the app fails at runtime against a
broken API URL, which is far harder to diagnose. Set them before the first
deploy.

- [ ] **Step 3: Verify it parses**

```bash
node -e 'console.log(require("./vercel.json").rewrites[0].destination)'
```

Expected: `/index.html`

- [ ] **Step 4: Commit**

```bash
git add vercel.json
git commit -m "chore(web): Vercel SPA rewrite

Without the catch-all, refreshing any client-side route 404s."
```

---

### Task 13: Server CORS and Supabase redirect allow-list

**This task is in `~/modakerati-server` and the Supabase dashboard, not this
repo.** Until it is done, the deployed web app cannot authenticate or call the
API at all — the native client has no origin, so no preflight has ever been
sent and no CORS middleware has ever been needed.

**Files:**
- Modify: `~/modakerati-server/src/index.ts` (or wherever the Hono app is
  constructed — find it first, see Step 1)

- [ ] **Step 1: Find where the Hono app is constructed**

```bash
grep -rn "new Hono(" ~/modakerati-server/src | head
```

- [ ] **Step 2: Check whether CORS middleware already exists**

```bash
grep -rn "cors" ~/modakerati-server/src | head
```

If it already exists, add the web origin to its allow-list rather than adding a
second middleware.

- [ ] **Step 3: Add the middleware if absent**

Register it BEFORE the routes, and read allowed origins from the environment so
preview deployments can be added without a code change:

```ts
import { cors } from "hono/cors";

// The native client has no Origin header, so no preflight has ever reached this
// server. The web app is a different origin from the API and needs an explicit
// allow-list. Comma-separated so Vercel preview URLs can be added by config.
const WEB_ORIGINS = (process.env.WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

app.use("/api/*", cors({
  origin: (origin) => (WEB_ORIGINS.includes(origin) ? origin : null),
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));
```

- [ ] **Step 4: Run the server's test suite**

Unlike this repo, the server HAS vitest. Some suites are slow under full-suite
load and time out at the 5s default — re-run with a longer timeout before
treating a timeout as a failure.

```bash
cd ~/modakerati-server && npx vitest run --testTimeout=60000
```

Expected: PASS.

- [ ] **Step 5: Set `WEB_ORIGINS` and deploy the server**

Set `WEB_ORIGINS` to the Vercel deployment origin. Deploy per the repo's own
convention (a fix is a patch; a feature is `deploy minor`).

- [ ] **Step 6: Add the origin to Supabase**

In the Supabase dashboard for project `janzgpfnjzihelcwmkkg`:
Authentication → URL Configuration → **Redirect URLs** → add the Vercel origin.
Without this, OAuth dead-ends after Google hands control back.

- [ ] **Step 7: Verify CORS from a browser**

From the browser console on the deployed site (after Task 14):

```js
fetch(`${window.location.origin}`) // sanity
// then a real API call — expect 200/401, NOT a CORS error
```

A CORS error here means Step 5's env var did not reach the running server.

---

### Task 14: Deploy and smoke-test

**Files:** none

- [ ] **Step 1: Deploy**

```bash
npx vercel deploy
```

Take the preview URL. Do NOT promote to production yet — the desktop layout is
Plan 3 and this build is the mobile layout in a browser.

- [ ] **Step 2: Smoke-test, in this order**

Each line is pass/fail. Record failures rather than fixing them inline; several
are expected to belong to Plans 2 and 3.

- [ ] The site loads and shows the login screen
- [ ] **Hard-refresh on a deep route** (e.g. `/library`) — must NOT 404 (this
      is the SPA rewrite; if it fails, Task 12 did not take effect)
- [ ] Sign in with email and password
- [ ] Sign in with Google (expect this to need the Supabase redirect from
      Task 13 Step 6; if PKCE fails, that is the known `plain`-vs-S256 issue
      deferred to a later plan — record it)
- [ ] The library lists existing theses
- [ ] Open a thesis — the workspace renders
- [ ] The Lexical writer appears and accepts typed text
- [ ] Type a paragraph, wait for the save indicator, hard-refresh — the text
      survives (this is the Task 5 localStorage op queue)
- [ ] Send a chat message and get an AI reply
- [ ] Export a .docx and confirm the file downloads with a sensible filename
- [ ] Switch the language to Arabic — the page reloads and text is RTL
- [ ] Repeat the writer check once in Arabic

- [ ] **Step 3: Record the results**

Append the pass/fail list to this plan file under a `## Smoke results` heading,
with the date and the deployment URL. Plans 2 and 3 are scoped from what failed.

---

## Definition of done

- `./scripts/verify-web.sh` exits 0.
- `./scripts/build-web.sh` produces a `dist-web/` with no LAN address in it.
- A Vercel preview URL serves the app; a hard refresh on a deep route works.
- A student can sign in, open a thesis, type, and download a .docx.
- Both native fingerprints are recorded in the Task 2 commit message, and the
  team knows an APK rebuild is required before the next OTA.

## Explicitly NOT done here

- Desktop layout (permanent drawer, three-pane workspace) — **Plan 3**.
- IndexedDB caches; three of four are no-ops — **Plan 2**.
- Real Word-fidelity view on web — deferred, possibly permanently.
- Out-of-scope route guards, lazy MathJax, OAuth S256 — **Plan 4**.
- Custom domain and production promotion.
