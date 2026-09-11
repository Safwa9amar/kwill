# Docx-Editor Migration (Lexical → @docx-editor.dev) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Lexical Writer with the docx-editor as the thesis editing surface in the Expo app, keeping every tool, AI surface and sheet the student has today, behind a flag until parity is verified — then delete Lexical.

**Architecture:** The docx-editor already runs in the app as an Expo DOM component (`components/workspace/docx-editor/DocxEditorDom.tsx`, bundled 2026-09-10 — Metro takes the package's CJS build, see `metro.config.js`). This plan wraps it in the **same native↔web contract the Lexical surface speaks** (`lexical-editor-store`: `LexicalCommand` in, `LexicalState` out, `flushEdits`), so the twelve native callers are untouched. The student's edits leave as whole bytes (`save()` → `PUT /:id/docx` with `If-Match`), every server-side mutation is followed by one conditional `reloadFromServer()`, and index↔engine identity is parsed from the engine's own node ids. Design and decisions: [2026-09-10-docx-editor-migration-design.md](../specs/2026-09-10-docx-editor-migration-design.md) — read D1–D12 before Task 1.

**Tech Stack:** Expo SDK 56 (`'use dom'` via `@expo/dom-webview`), React 19, `@docx-editor.dev/{core,react,fonts}` 2.12, Zustand, Hono + Drizzle (server), Vitest (server today; added to the app for pure modules in Task 4).

---

## Read this before Task 1

### Four facts that shape every task

1. **`'use dom'` modules may have exactly ONE export, the default.** A named export is a *bundle-time* failure that blanks the screen and `tsc` cannot see it. Every helper lives in a sibling module; `node scripts/verify-use-dom.mjs` is the gate after any change under `components/workspace/docx-editor/`.
2. **Props cross the DOM bridge as JSON; callbacks are async; nothing is synchronous.** Bytes never cross it — the DOM side fetches and PUTs the document itself with the token it is given (that is how the web trial works too).
3. **Indices are positional and shift.** The DTO's `index` equals the third segment of the engine's node id *at load time* (spec D7). Never store an id across a reload; re-find by text.
4. **Zustand selectors return primitives.** `useStore((s) => ({a: s.a}))` throws "Maximum update depth exceeded" on this codebase.

### What is already built (do not rebuild)

| Exists | Where |
|---|---|
| The DOM component, wasm from `public/`, Google-font resolver, CJS resolution in Metro | `components/workspace/docx-editor/DocxEditorDom.tsx`, `public/harfbuzz.wasm`, `metro.config.js` |
| A host screen that opens a thesis in it (dev) | `app/(app)/word-native.tsx` |
| Whole-bytes save route (no concurrency guard yet) | `~/kwill-server/src/routes/thesis/document.ts` `PUT /:id/docx` |
| The complete bubble tool vocabulary bound to engine slots | `~/kwill-dashboard/src/features/editor/docx-editor/bubble/useEigenTools.ts` (port, don't rewrite) |
| Chart SVG overlay + node-id → block-index proof | `~/kwill-dashboard/src/features/editor/docx-editor/bubble/ChartLayer.tsx` |
| AI proposal applied through `findMatches` + `replaceMatch` | `~/kwill-dashboard/src/features/editor/docx-editor/TrialBubble.tsx` |

### Phases and exit criteria

| Phase | Delivers | Exit criterion |
|---|---|---|
| **1 — Foundation** (this document, Tasks 1–12) | Server concurrency contract; the docx surface behind `writerEngine="docx"` speaking the existing store contract; save, reload, flush, navigation, pill anchoring, undo/redo | Student types, formats from the native bubble, an AI turn's edit appears, a `modk://` link scrolls, `expo export` is green |
| **2 — AI surfaces** (Tasks 13–16) | Inline suggestion, range rewrite, table proposal, completion — as overlays | Every ✦ dock action on a paragraph/range/table round-trips with approve/reject |
| **3 — Structure & sheets** (Tasks 17–23) | Equation, caption, header/footer sheets; chart layer + bar; pictures; search; insert menu; paste image | Every bubble toolset and sheet works on the docx surface |
| **4 — Parity extras** (Tasks 24–29) | Select mode, scroll restore, keyboard mode, drawer swipe, bundled Arabic fonts, IndexedDB pending save, wasm via `require()` | Feature map in the spec has no unchecked row except the two dropped by D11 |
| **5 — Cutover** (Tasks 30–33) | Default flip, Lexical deletion (≈9k lines), store rename, CLAUDE.md/docs | `grep -r lexical` finds nothing outside git history |

Phases 2–5 are specified below at task granularity with their files and interfaces pinned. **Each is expanded into bite-size steps when it starts** — several depend on what Phase 1 measures on a real device (bridge latency, reload cost on a 200-page thesis).

### Verification commands used throughout

```bash
# app
cd ~/kwill && npx tsc --noEmit                      # types
cd ~/kwill && node scripts/verify-use-dom.mjs        # the 'use dom' export rule
cd ~/kwill && npx vitest run                         # pure lib modules (after Task 4)
cd ~/kwill && npx expo export --platform android --output-dir /tmp/kwill-export && git diff --stat app.json
#   ⚠️ expo export has been seen to REWRITE app.json (moves the runtime fingerprint). If the
#   diff is non-empty and you did not edit it: git checkout app.json.
# server
cd ~/kwill-server && npx vitest run src/lib/__tests__/docx-etag.test.ts
cd ~/kwill-server && npx tsc --noEmit
```

---

## Phase 1 — Foundation

### Task 1: ETag helpers (server, pure)

**Files:**
- Create: `~/kwill-server/src/lib/docx-etag.ts`
- Test: `~/kwill-server/src/lib/__tests__/docx-etag.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/docx-etag.test.ts
import { describe, it, expect } from "vitest";
import { quoteEtag, ifNoneMatchIsCurrent, ifMatchAllows } from "../docx-etag";

describe("quoteEtag", () => {
  it("wraps the hash in double quotes", () => {
    expect(quoteEtag("abc123")).toBe('"abc123"');
  });
});

describe("ifNoneMatchIsCurrent (GET → 304?)", () => {
  it("is false with no header", () => expect(ifNoneMatchIsCurrent(undefined, "h1")).toBe(false));
  it("is false with no stored hash", () => expect(ifNoneMatchIsCurrent('"h1"', null)).toBe(false));
  it("matches a quoted tag", () => expect(ifNoneMatchIsCurrent('"h1"', "h1")).toBe(true));
  it("matches an unquoted tag", () => expect(ifNoneMatchIsCurrent("h1", "h1")).toBe(true));
  it("matches a weak tag", () => expect(ifNoneMatchIsCurrent('W/"h1"', "h1")).toBe(true));
  it("matches inside a list", () => expect(ifNoneMatchIsCurrent('"h0", "h1"', "h1")).toBe(true));
  it("matches a star", () => expect(ifNoneMatchIsCurrent("*", "h1")).toBe(true));
  it("rejects a different tag", () => expect(ifNoneMatchIsCurrent('"h0"', "h1")).toBe(false));
});

describe("ifMatchAllows (PUT → proceed?)", () => {
  it("allows when the header is absent (older clients are unconditional)", () => {
    expect(ifMatchAllows(undefined, "h1")).toBe(true);
    expect(ifMatchAllows("", "h1")).toBe(true);
  });
  it("allows a star", () => expect(ifMatchAllows("*", "h1")).toBe(true));
  it("allows the current hash", () => expect(ifMatchAllows('"h1"', "h1")).toBe(true));
  it("refuses a stale hash", () => expect(ifMatchAllows('"h0"', "h1")).toBe(false));
  it("refuses any hash when nothing is stored yet", () => expect(ifMatchAllows('"h1"', null)).toBe(false));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/kwill-server && npx vitest run src/lib/__tests__/docx-etag.test.ts`
Expected: FAIL — `Cannot find module '../docx-etag'`

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/lib/docx-etag.ts
//
// Conditional-request helpers for the whole-bytes document routes
// (GET/PUT /api/thesis/:id/docx). The tag is `theses.docHash` — the hash of the
// bytes currently in storage, which persistThesisDocx keeps current.
//
// Why a hash and not updatedAt: the app's global middleware stamps every response
// `Cache-Control: no-store`, so this is never about proxy caching. It is the
// client-side editor asking two questions — "is my copy still current?" (GET,
// If-None-Match → 304 skips a multi-megabyte reload after a no-op turn) and
// "may I overwrite?" (PUT, If-Match → 412 instead of clobbering an AI turn that
// landed since the client loaded). Spec D3/D4.

export function quoteEtag(hash: string): string {
  return `"${hash}"`;
}

function tagsOf(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^W\//i, ""))
    .map((s) => s.replace(/^"(.*)"$/, "$1"));
}

/** If-None-Match: the client already holds the current bytes → answer 304. */
export function ifNoneMatchIsCurrent(header: string | null | undefined, hash: string | null): boolean {
  if (!hash) return false;
  const tags = tagsOf(header);
  return tags.includes("*") || tags.includes(hash);
}

/**
 * If-Match: the write may proceed. An ABSENT header is unconditional — the
 * dashboard's trial route predates this and must keep working — but a PRESENT
 * header that names a stale hash is refused, and so is any hash when nothing is
 * stored yet (there is no document to be current against).
 */
export function ifMatchAllows(header: string | null | undefined, hash: string | null): boolean {
  if (header == null || header.trim() === "") return true;
  const tags = tagsOf(header);
  if (tags.includes("*")) return true;
  return hash != null && tags.includes(hash);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/kwill-server && npx vitest run src/lib/__tests__/docx-etag.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/kwill-server && git add src/lib/docx-etag.ts src/lib/__tests__/docx-etag.test.ts && git commit -m "feat(docx): ETag helpers for the whole-bytes document routes"
```

### Task 2: `GET /:id/docx` (bytes + ETag) and `If-Match` on the PUT

**Files:**
- Modify: `~/kwill-server/src/routes/thesis/document.ts` (the `PUT /:id/docx` block, ≈line 188)

- [ ] **Step 1: Find the byte-read helper the mirror route uses**

Run: `cd ~/kwill-server && grep -n "downloadDocx" src/routes/thesis/mirror.ts | head -2`
Expected: an `import { downloadDocx } from "…"` line. Copy that exact import into `document.ts` (top of file, next to the other imports). Also add: `import { ifMatchAllows, ifNoneMatchIsCurrent, quoteEtag } from "../../lib/docx-etag";` (adjust the relative path to match how `document.ts` imports its other `lib/` modules).

- [ ] **Step 2: Add the GET route directly ABOVE the existing `app.put("/:id/docx"`**

```ts
  // GET the WHOLE .docx — the load path of the client-side Word editor (the app's
  // docx surface and the dashboard's /word route). `ETag` is the stored bytes' hash
  // (theses.docHash); a client sending `If-None-Match` with the tag it already holds
  // gets a 304 and skips a multi-megabyte reload after a turn that changed nothing.
  // Spec: docs/superpowers/specs/2026-09-10-docx-editor-migration-design.md D3.
  app.get("/:id/docx", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const [thesis] = await db
      .select({ docPath: theses.docPath, docMode: theses.docMode, docHash: theses.docHash })
      .from(theses)
      .where(and(eq(theses.id, id), eq(theses.userId, userId)));
    if (!thesis) return c.json({ error: "Thesis not found" }, 404);
    if (thesis.docMode !== "live-docx" || !thesis.docPath) return c.json({ error: "Thesis is not a live Word document" }, 400);

    if (ifNoneMatchIsCurrent(c.req.header("if-none-match"), thesis.docHash)) {
      return c.body(null, 304, thesis.docHash ? { ETag: quoteEtag(thesis.docHash) } : {});
    }
    try {
      const buf = await downloadDocx(thesis.docPath);
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Length": String(buf.length),
      };
      if (thesis.docHash) headers.ETag = quoteEtag(thesis.docHash);
      return c.body(new Uint8Array(buf), 200, headers);
    } catch (e: any) {
      console.error("thesis docx GET failed:", id, e?.message ?? e);
      return c.json({ error: "Failed to read document" }, 500);
    }
  });
```

- [ ] **Step 3: Guard the PUT with `If-Match` and return the new hash**

Replace the body of the existing `app.put("/:id/docx", …)` from `const [thesis] = …` through the `withThesisLock` call with:

```ts
    const [thesis] = await db.select().from(theses).where(and(eq(theses.id, id), eq(theses.userId, userId)));
    if (!thesis) return c.json({ error: "Thesis not found" }, 404);
    if (thesis.docMode !== "live-docx" || !thesis.docPath) return c.json({ error: "Thesis is not a live Word document" }, 400);

    const MAX_BYTES = 60 * 1024 * 1024; // a thesis with embedded media; well under any real limit
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength === 0) return c.json({ error: "empty body" }, 400);
    if (raw.byteLength > MAX_BYTES) return c.json({ error: "document too large" }, 413);
    const buffer = Buffer.from(raw);
    // A .docx is a zip: "PK\x03\x04". Anything else is a client bug, never a document.
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) {
      return c.json({ error: "not a .docx (zip) payload" }, 400);
    }

    // Optimistic concurrency (spec D4). The check runs INSIDE the lock so an AI
    // turn that finishes between our read and our write cannot slip through.
    // 412 carries the current hash so the client can reload and keep its own
    // bytes as a recovery copy — the answer to "stale" is never a silent merge.
    const ifMatch = c.req.header("if-match");
    try {
      const outcome = await withThesisLock(id, async () => {
        const [cur] = await db.select({ docHash: theses.docHash }).from(theses).where(eq(theses.id, id));
        if (!ifMatchAllows(ifMatch, cur?.docHash ?? null)) {
          return { stale: true as const, docHash: cur?.docHash ?? null };
        }
        const history = await persistThesisDocx({ thesisId: id, userId, buffer, label: "Word editor save", source: "manual" });
        const [after] = await db.select({ docHash: theses.docHash }).from(theses).where(eq(theses.id, id));
        return { stale: false as const, docHash: after?.docHash ?? null, ...history };
      });
      if (outcome.stale) return c.json({ error: "stale", docHash: outcome.docHash }, 412);
      return c.json({ ok: true, canUndo: outcome.canUndo, canRedo: outcome.canRedo, docHash: outcome.docHash });
    } catch (e: any) {
      console.error("thesis docx PUT failed:", id, e?.message ?? e);
      return c.json({ error: "save failed" }, 500);
    }
```

Also update the PUT's leading comment: replace the "⚠️ No merge. Bytes replace bytes…" paragraph with:

```ts
  // ⚠️ No merge — but no clobber either. A client sends `If-Match: "<docHash>"`
  // with the hash it loaded; a stale one is refused with 412 (see inside the
  // lock). Bytes still replace bytes when the check passes: the client is the
  // editor of record for the student's own typing (spec D2/D4).
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `cd ~/kwill-server && npx tsc --noEmit && npx vitest run --testTimeout=60000 2>&1 | tail -5`
Expected: tsc silent; vitest all green (same count as before + 13).

- [ ] **Step 5: Smoke the route against the local server**

Run (server running on :3000, `$TOKEN` a student access token, `$ID` a live thesis):
```bash
curl -s -D- -o /tmp/t.docx "http://localhost:3000/api/thesis/$ID/docx" -H "Authorization: Bearer $TOKEN" | grep -iE "^(HTTP|ETag|Content-Length)"
ETAG=$(curl -s -D- -o /dev/null "http://localhost:3000/api/thesis/$ID/docx" -H "Authorization: Bearer $TOKEN" | grep -i ^etag | cut -d' ' -f2 | tr -d '\r')
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/thesis/$ID/docx" -H "Authorization: Bearer $TOKEN" -H "If-None-Match: $ETAG"
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "http://localhost:3000/api/thesis/$ID/docx" -H "Authorization: Bearer $TOKEN" -H 'If-Match: "definitely-stale"' --data-binary @/tmp/t.docx
```
Expected: `200` + an `ETag`; then `304`; then `412`.

- [ ] **Step 6: Commit and deploy as a patch**

```bash
cd ~/kwill-server && git add src/routes/thesis/document.ts && git commit -m "feat(docx): GET /:id/docx with ETag; PUT honours If-Match (412 on a stale save)"
```
Deploy per the server's convention (fix → patch; see memory `server-versioning-and-history`).

### Task 3: `docHash` on the document DTO (server + app type)

**Files:**
- Modify: `~/kwill-server/src/lib/thesis-doc.ts` (the DTO union ≈line 217 and the return ≈line 1189–1198)
- Modify: `~/kwill/lib/api.ts` (`DocumentDTO`, ≈line 1628)

- [ ] **Step 1: Server — add the field to the type and the object**

In the union member at ≈line 217 append `docHash: string | null` after `downloadUrl: string`:
```ts
  | { id: string; title: string; docMode: "live-docx"; available: true; blocks: DocBlockDTO[]; sections: DocSectionDTO[]; downloadUrl: string; docHash: string | null }
```
In the return object at ≈line 1198, after `downloadUrl,` add:
```ts
    // The stored bytes' hash — the docx surface compares it against the ETag of
    // the document it holds to decide whether a doc tick means "reload" (D3).
    docHash: thesis.docHash ?? null,
```
Run: `cd ~/kwill-server && npx tsc --noEmit` → silent. Commit: `git commit -am "feat(docx): document DTO carries docHash"`.

- [ ] **Step 2: App — mirror it on the type**

In `lib/api.ts` `DocumentDTO`'s available branch, after `downloadUrl: string;` add:
```ts
      // Hash of the stored bytes (server `theses.docHash`). Optional: older
      // SQLite-cached DTOs predate it. The docx surface reloads when it differs
      // from the ETag of the document it holds.
      docHash?: string | null;
```
Run: `cd ~/kwill && npx tsc --noEmit` → silent. Commit: `git add lib/api.ts && git commit -m "feat(docx): DocumentDTO.docHash"`.

### Task 4: Vitest for the app's pure modules

**Files:**
- Modify: `~/kwill/package.json` (devDependencies + `test` script)
- Create: `~/kwill/vitest.config.ts`
- Modify: `~/kwill/CLAUDE.md` (the "Verification" section)

- [ ] **Step 1: Install and configure**

Run: `cd ~/kwill && npm install -D vitest@^4`

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The app had no test runner until the docx-editor migration. This runs PURE
// modules only — no React Native, no Expo, no DOM — which is why `include` is a
// short allow-list rather than a glob over the repo: `lib/` is full of modules
// that import `react-native` at the top, and importing one under node fails
// before the first assertion. Add a path here when you add a pure module with a
// test beside it; do not widen the glob.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: [
      "lib/docx-block-id.test.ts",
      "components/workspace/docx-editor/bridge/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "android/**", "ios/**", "dist/**"],
  },
});
```
Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Record it where the next session will look**

In `CLAUDE.md` → "Verification", replace `**This app has no JS test runner.** There are no test files and no lint config.` with:
```
**This app runs Vitest for PURE modules only** (`npx vitest run`; the allow-list is in `vitest.config.ts` — anything importing `react-native` cannot run under node). There is no lint config.
```
and add `npx vitest run              # pure lib modules (docx-editor bridge, block ids)` under `npx tsc --noEmit`.

- [ ] **Step 3: Verify the runner starts**

Run: `cd ~/kwill && npx vitest run`
Expected: `No test files found` (exit 0 — nothing matches yet).

- [ ] **Step 4: Commit**

```bash
cd ~/kwill && git add package.json package-lock.json vitest.config.ts CLAUDE.md && git commit -m "chore(test): vitest for the app's pure modules"
```

### Task 5: `blockIndexFromId` — engine node id → block index (pure)

**Files:**
- Create: `lib/docx-block-id.ts`
- Test: `lib/docx-block-id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/docx-block-id.test.ts
import { describe, it, expect } from "vitest";
import { blockIndexFromId, isBodyId } from "./docx-block-id";

describe("blockIndexFromId", () => {
  it("reads the third segment of a body node id", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.220.1.0")).toBe(220);
  });
  it("reads a bare paragraph id (no run suffix)", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.7")).toBe(7);
  });
  it("reads block zero", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.0.0.0")).toBe(0);
  });
  it("returns null for anything else", () => {
    expect(blockIndexFromId("")).toBeNull();
    expect(blockIndexFromId(null)).toBeNull();
    expect(blockIndexFromId(undefined)).toBeNull();
    expect(blockIndexFromId("/word/document.xml")).toBeNull();
    expect(blockIndexFromId("/word/document.xml#0.1")).toBeNull();
    expect(blockIndexFromId("garbage#a.b.c")).toBeNull();
  });
});

describe("isBodyId", () => {
  it("is true only for the main document part", () => {
    expect(isBodyId("/word/document.xml#0.1.3")).toBe(true);
    expect(isBodyId("/word/header1.xml#0.0.3")).toBe(false);
    expect(isBodyId("/word/footnotes.xml#0.2.1")).toBe(false);
    expect(isBodyId(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/kwill && npx vitest run lib/docx-block-id.test.ts`
Expected: FAIL — `Failed to resolve import "./docx-block-id"`

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/docx-block-id.ts
//
// The docx-editor stamps every painted node with its structural id —
//
//     /word/document.xml#<doc>.<body>.<blockIndex>[.<run>.<text>…]
//
// — and the THIRD segment is the body-child index, which is exactly the
// `DocBlockDTO.index` our server hands out for the same load of the same bytes
// (verified on real theses: chart placeholders `#0.1.220.1.0` / `#0.1.250.1.0`
// were DTO blocks 220 / 250). This is the ONLY bridge between the engine's
// identity and the AI's address space, and it goes one way: ids are PARSED,
// never built. To reach a block FROM an index, search its text and filter the
// matches through this function (see bridge/find-block.ts).
//
// ⚠️ Valid as of a load. A local edit that inserts or deletes a paragraph mints
// ids the DTO knows nothing about; the surface reloads after such a save so the
// two agree again (spec D7).

const BODY_PART = "/word/document.xml#";
const RE = /#(\d+)\.(\d+)\.(\d+)(?:\.|$)/;

/** The body-child index carried by an engine node id, or null. */
export function blockIndexFromId(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = RE.exec(id);
  if (!m) return null;
  const n = Number(m[3]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Only the main body's indices are block indices — a header or footnote story
 *  has its own numbering and must never be mistaken for one. */
export function isBodyId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(BODY_PART);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/kwill && npx vitest run lib/docx-block-id.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/kwill && git add lib/docx-block-id.ts lib/docx-block-id.test.ts && git commit -m "feat(docx): parse the engine's node id into a block index"
```

### Task 6: `mapCommand` — the native command envelope → engine actions (pure)

The native chrome dispatches `{type, value, nonce}` (see `components/workspace/lexical/editor-components/types.ts` and `plugins/editor-bridge/apply-command.ts` for every type in use today). This module is the docx-side twin of `apply-command.ts`, minus anything that needs a live editor — that part is Task 9's `Bridge`.

**Files:**
- Create: `components/workspace/docx-editor/bridge/command-map.ts`
- Test: `components/workspace/docx-editor/bridge/command-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// components/workspace/docx-editor/bridge/command-map.test.ts
import { describe, it, expect } from "vitest";
import { mapCommand } from "./command-map";

const cmd = (type: string, value?: string) => ({ type, value, nonce: 1 });

describe("mapCommand — inline marks and history", () => {
  it("maps the three toggles to the engine's text slots", () => {
    expect(mapCommand(cmd("bold"))).toEqual([{ kind: "slot", slot: "text.bold" }]);
    expect(mapCommand(cmd("italic"))).toEqual([{ kind: "slot", slot: "text.italic" }]);
    expect(mapCommand(cmd("underline"))).toEqual([{ kind: "slot", slot: "text.underline" }]);
  });
  it("maps undo/redo to history slots", () => {
    expect(mapCommand(cmd("undo"))).toEqual([{ kind: "slot", slot: "history.undo" }]);
    expect(mapCommand(cmd("redo"))).toEqual([{ kind: "slot", slot: "history.redo" }]);
  });
  it("maps clearFormatting", () => {
    expect(mapCommand(cmd("clearFormatting"))).toEqual([{ kind: "slot", slot: "format.clear" }]);
  });
});

describe("mapCommand — paragraph level", () => {
  it("maps align to the alignment slots and ignores an unknown value", () => {
    expect(mapCommand(cmd("align", "center"))).toEqual([{ kind: "slot", slot: "alignment.center" }]);
    expect(mapCommand(cmd("align", "justify"))).toEqual([{ kind: "slot", slot: "alignment.justify" }]);
    expect(mapCommand(cmd("align", "weird"))).toEqual([{ kind: "noop", reason: "align: unknown value weird" }]);
  });
  it("maps heading to Word's Heading styles, paragraph to Normal, quote to Quote", () => {
    expect(mapCommand(cmd("heading", "h2"))).toEqual([{ kind: "style", styleId: "Heading2" }]);
    expect(mapCommand(cmd("heading", "paragraph"))).toEqual([{ kind: "style", styleId: "Normal" }]);
    expect(mapCommand(cmd("quote"))).toEqual([{ kind: "style", styleId: "Quote" }]);
  });
  it("maps lists to the list slots", () => {
    expect(mapCommand(cmd("list", "bullet"))).toEqual([{ kind: "slot", slot: "list.bullet" }]);
    expect(mapCommand(cmd("list", "number"))).toEqual([{ kind: "slot", slot: "list.numbered" }]);
  });
  it("routes direction to the server — the engine exposes no paragraph-direction command", () => {
    expect(mapCommand(cmd("direction", "rtl"))).toEqual([{ kind: "server", changes: { direction: "rtl" } }]);
  });
  it("maps color to a hex mark, and an empty value to automatic", () => {
    expect(mapCommand(cmd("color", "C0392B"))).toEqual([{ kind: "marks", marks: { color: { kind: "hex", value: "C0392B" } } }]);
    expect(mapCommand(cmd("color", ""))).toEqual([{ kind: "marks", marks: { color: { kind: "auto" } } }]);
  });
});

describe("mapCommand — whole-block format from the pill", () => {
  it("selects the paragraph first, then sets (not toggles) the marks", () => {
    const value = JSON.stringify({ bold: true, italic: false, level: 3, alignment: "right", direction: "rtl", color: "2980B9" });
    expect(mapCommand(cmd("blockFormat", value))).toEqual([
      { kind: "selectParagraph" },
      { kind: "marks", marks: { bold: true, italic: false, color: { kind: "hex", value: "2980B9" } } },
      { kind: "style", styleId: "Heading3" },
      { kind: "paragraph", update: { alignment: "right" } },
      { kind: "server", changes: { direction: "rtl" } },
    ]);
  });
  it("level 0 is Normal; clearFormatting is the slot; a null color is automatic", () => {
    const value = JSON.stringify({ level: 0, clearFormatting: true, color: null });
    expect(mapCommand(cmd("blockFormat", value))).toEqual([
      { kind: "selectParagraph" },
      { kind: "marks", marks: { color: { kind: "auto" } } },
      { kind: "slot", slot: "format.clear" },
      { kind: "style", styleId: "Normal" },
    ]);
  });
  it("refuses malformed JSON without throwing", () => {
    expect(mapCommand(cmd("blockFormat", "{not json"))).toEqual([{ kind: "noop", reason: "blockFormat: malformed value" }]);
  });
});

describe("mapCommand — Lexical-only envelopes", () => {
  it("is a noop for serialize / patchBlocks / blur / focus / insert", () => {
    for (const t of ["serialize", "patchBlocks", "blur", "focus", "insert"]) {
      expect(mapCommand(cmd(t))).toEqual([{ kind: "noop", reason: `${t}: not an engine command` }]);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/kwill && npx vitest run components/workspace/docx-editor/bridge/command-map.test.ts`
Expected: FAIL — cannot resolve `./command-map`

- [ ] **Step 3: Write the minimal implementation**

```ts
// components/workspace/docx-editor/bridge/command-map.ts
//
// The native chrome → engine direction of the bridge, as a PURE translation.
// The envelope is the one lexical-editor-store dispatches today (BlockContextBar,
// FormatPanel, ListToolbar, AIDock, the ribbon…); keeping it means none of those
// callers change in Phase 1. Executing the actions needs a live editor and the
// React hooks that own paragraph style / format — that is Bridge.tsx.
//
// Two things worth knowing about the engine's vocabulary:
//  • Slots (`text.bold`, `alignment.left`, `list.bullet`, `history.undo`,
//    `format.clear`) TOGGLE against the current selection; `applyFormatting`
//    marks SET a value. The pill's blockFormat carries booleans that mean "make
//    it so", so it goes through marks, after selecting the whole paragraph.
//  • There is no paragraph-direction command (no `bidi` anywhere in the typed
//    surface at 2.12). Direction therefore takes the SERVER path — the same
//    `format` op the pill used before Lexical existed — and the surface reloads.

import type { BlockFmtChange, LexicalCommand } from "@/components/workspace/lexical/editor-components/types";

export type EngineAction =
  | { kind: "slot"; slot: string }
  | { kind: "style"; styleId: string }
  | { kind: "paragraph"; update: { alignment?: "left" | "center" | "right" | "justify" } }
  | { kind: "marks"; marks: Record<string, unknown> }
  | { kind: "selectParagraph" }
  | { kind: "server"; changes: { direction: "rtl" | "ltr" } }
  | { kind: "noop"; reason: string };

const ALIGNS = new Set(["left", "center", "right", "justify"]);

function colorMark(hex: string | null | undefined): Record<string, unknown> {
  const v = (hex ?? "").replace(/^#/, "").trim();
  return v ? { kind: "hex", value: v.toUpperCase() } : { kind: "auto" };
}

function headingStyle(level: number): string {
  return level <= 0 ? "Normal" : `Heading${Math.min(6, level)}`;
}

export function mapCommand(cmd: LexicalCommand): EngineAction[] {
  const v = cmd.value ?? "";
  switch (cmd.type) {
    case "bold":
    case "italic":
    case "underline":
      return [{ kind: "slot", slot: `text.${cmd.type}` }];
    case "undo":
      return [{ kind: "slot", slot: "history.undo" }];
    case "redo":
      return [{ kind: "slot", slot: "history.redo" }];
    case "clearFormatting":
      return [{ kind: "slot", slot: "format.clear" }];
    case "align":
      return ALIGNS.has(v)
        ? [{ kind: "slot", slot: `alignment.${v}` }]
        : [{ kind: "noop", reason: `align: unknown value ${v}` }];
    case "heading": {
      const m = /^h([1-6])$/.exec(v);
      if (m) return [{ kind: "style", styleId: headingStyle(Number(m[1])) }];
      if (v === "paragraph") return [{ kind: "style", styleId: "Normal" }];
      return [{ kind: "noop", reason: `heading: unknown value ${v}` }];
    }
    case "quote":
      return [{ kind: "style", styleId: "Quote" }];
    case "list":
      if (v === "bullet") return [{ kind: "slot", slot: "list.bullet" }];
      if (v === "number") return [{ kind: "slot", slot: "list.numbered" }];
      return [{ kind: "noop", reason: `list: unknown value ${v}` }];
    case "direction":
      return v === "rtl" || v === "ltr"
        ? [{ kind: "server", changes: { direction: v } }]
        : [{ kind: "noop", reason: `direction: unknown value ${v}` }];
    case "color":
      return [{ kind: "marks", marks: { color: colorMark(v) } }];
    case "blockFormat": {
      let ch: BlockFmtChange;
      try {
        ch = JSON.parse(v) as BlockFmtChange;
      } catch {
        return [{ kind: "noop", reason: "blockFormat: malformed value" }];
      }
      const out: EngineAction[] = [{ kind: "selectParagraph" }];
      const marks: Record<string, unknown> = {};
      if (ch.bold != null) marks.bold = ch.bold;
      if (ch.italic != null) marks.italic = ch.italic;
      if (ch.underline != null) marks.underline = ch.underline;
      if ("color" in ch) marks.color = colorMark(ch.color);
      if (Object.keys(marks).length) out.push({ kind: "marks", marks });
      if (ch.clearFormatting) out.push({ kind: "slot", slot: "format.clear" });
      if (ch.level != null) out.push({ kind: "style", styleId: headingStyle(ch.level) });
      if (ch.alignment && ALIGNS.has(ch.alignment)) {
        out.push({ kind: "paragraph", update: { alignment: ch.alignment as "left" | "center" | "right" | "justify" } });
      }
      if (ch.direction === "rtl" || ch.direction === "ltr") out.push({ kind: "server", changes: { direction: ch.direction } });
      return out;
    }
    default:
      return [{ kind: "noop", reason: `${cmd.type}: not an engine command` }];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/kwill && npx vitest run components/workspace/docx-editor/bridge/command-map.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Gate and commit**

Run: `cd ~/kwill && npx tsc --noEmit && node scripts/verify-use-dom.mjs | tail -1` → silent tsc; `All 3 'use dom' module(s) bundle cleanly`.
```bash
git add components/workspace/docx-editor/bridge/command-map.ts components/workspace/docx-editor/bridge/command-map.test.ts && git commit -m "feat(docx): map the native command envelope onto engine actions"
```

### Task 7: The flag, and two hooks on the bridge store

**Files:**
- Modify: `stores/settings-store.ts`
- Modify: `stores/lexical-editor-store.ts`
- Modify: `app/(app)/settings.tsx` (Developer section)

- [ ] **Step 1: `writerEngine` in settings (persisted)**

In `stores/settings-store.ts`: add `export type WriterEngine = "lexical" | "docx";` under `ToolbarOrientation`. In `SettingsState`, after `lastThesisId`:
```ts
  // Which surface the workspace mounts as the Writer (spec D12). "lexical" is the
  // shipping editor; "docx" is the docx-editor migration behind Settings →
  // Developer until parity is verified, then the default flips (Phase 5).
  writerEngine: WriterEngine;
  setWriterEngine: (v: WriterEngine) => void;
```
In the initial state after `lastThesisId: null,`: `writerEngine: "lexical",` and after `setLastThesisId`: `setWriterEngine: (writerEngine) => set({ writerEngine }),`.

- [ ] **Step 2: `reload` on the bridge store**

In `stores/lexical-editor-store.ts`, after `flushEdits` in the interface:
```ts
  // Waitable RELOAD of the docx surface from the server's bytes (registered by the
  // docx Writer view; null under Lexical, which reseeds from the DTO instead).
  // Callers that just mutated the document on the SERVER — a sheet, a chart edit,
  // history undo — await it so the student sees the result. Conditional on the
  // document hash, so a no-op is one 304. Spec D3.
  reload: (() => Promise<void>) | null;
  registerReload: (f: (() => Promise<void>) | null) => void;
```
Initial state: `reload: null,`; action: `registerReload: (f) => set({ reload: f }),`.

- [ ] **Step 3: The Developer toggle**

In `app/(app)/settings.tsx`, inside the `__DEV__` Developer `rows`, after the "Word Editor (native)" row:
```ts
              {
                // Spec D12: the docx-editor as THE Writer surface in the workspace,
                // instead of the Lexical editor. Persisted; takes effect on the next
                // workspace open.
                icon: FileText,
                iconColor: colors.brandPrimary,
                label: "Writer: docx-editor",
                type: "toggle" as const,
                toggleValue: writerEngine === "docx",
                onToggle: (v: boolean) => setWriterEngine(v ? "docx" : "lexical"),
              },
```
and, with the other `useSettingsStore` selectors at the top of the component (primitives only):
```ts
  const writerEngine = useSettingsStore((s) => s.writerEngine);
  const setWriterEngine = useSettingsStore((s) => s.setWriterEngine);
```

- [ ] **Step 4: Gate and commit**

Run: `cd ~/kwill && npx tsc --noEmit` → silent.
```bash
git add stores/settings-store.ts stores/lexical-editor-store.ts "app/(app)/settings.tsx" && git commit -m "feat(docx): writerEngine flag + reload hook on the bridge store"
```

### Task 8: Save loop and document loader (web-side, testable)

These run INSIDE the WebView (they use `fetch`) but hold no React and no engine reference, so they are unit-tested under node with a mocked `fetch` and fake timers.

**Files:**
- Create: `components/workspace/docx-editor/bridge/load-document.ts`
- Create: `components/workspace/docx-editor/bridge/save-loop.ts`
- Test: `components/workspace/docx-editor/bridge/load-document.test.ts`, `components/workspace/docx-editor/bridge/save-loop.test.ts`

- [ ] **Step 1: Write the failing loader test**

```ts
// components/workspace/docx-editor/bridge/load-document.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchDocument, unquoteEtag } from "./load-document";

const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;

function mockFetch(status: number, etag?: string) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === "etag" ? etag ?? null : null) },
    arrayBuffer: async () => bytes,
  })) as unknown as typeof fetch;
}

describe("unquoteEtag", () => {
  it("strips quotes and a weak prefix", () => {
    expect(unquoteEtag('"abc"')).toBe("abc");
    expect(unquoteEtag('W/"abc"')).toBe("abc");
    expect(unquoteEtag(null)).toBeNull();
  });
});

describe("fetchDocument", () => {
  it("GETs the bytes with the token and returns the unquoted etag", async () => {
    const f = mockFetch(200, '"h1"');
    const r = await fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", fetchImpl: f });
    expect(r).toEqual({ status: 200, bytes, docHash: "h1" });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://x/api/thesis/t/docx");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.cache).toBe("no-store");
  });
  it("sends If-None-Match and reports 304 without bytes", async () => {
    const f = mockFetch(304, '"h1"');
    const r = await fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", ifNoneMatch: "h1", fetchImpl: f });
    expect(r).toEqual({ status: 304 });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('"h1"');
  });
  it("throws on any other status", async () => {
    await expect(fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", fetchImpl: mockFetch(500) })).rejects.toThrow("500");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/kwill && npx vitest run components/workspace/docx-editor/bridge/load-document.test.ts`
Expected: FAIL — cannot resolve `./load-document`

- [ ] **Step 3: Write the loader**

```ts
// components/workspace/docx-editor/bridge/load-document.ts
//
// GET the whole .docx from the server (Task 2's route). The bytes stay in the
// WebView — they never cross the DOM bridge — and the ETag (the server's
// `docHash`) is what every later decision keys on: whether a reload is needed,
// and what `If-Match` a save must carry.

export function unquoteEtag(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(/^W\//i, "").replace(/^"(.*)"$/, "$1") || null;
}

export type FetchDocumentResult =
  | { status: 200; bytes: ArrayBuffer; docHash: string | null }
  | { status: 304 };

export async function fetchDocument(o: {
  apiBase: string;
  thesisId: string;
  token: string;
  ifNoneMatch?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FetchDocumentResult> {
  const f = o.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${o.token}` };
  if (o.ifNoneMatch) headers["If-None-Match"] = `"${o.ifNoneMatch}"`;
  const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { headers, cache: "no-store" });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`document ${res.status}`);
  return { status: 200, bytes: await res.arrayBuffer(), docHash: unquoteEtag(res.headers.get("etag")) };
}
```

- [ ] **Step 4: Run the loader test — PASS (5 tests). Then write the failing save-loop test**

```ts
// components/workspace/docx-editor/bridge/save-loop.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSaveLoop, type SaveState } from "./save-loop";

const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;

function mockPut(status: number, body: Record<string, unknown> = {}) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })) as unknown as typeof fetch;
}

describe("createSaveLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(fetchImpl: typeof fetch) {
    const states: SaveState[] = [];
    const loop = createSaveLoop({
      apiBase: "http://x",
      thesisId: "t",
      token: () => "tok",
      getBytes: async () => bytes,
      onState: (s) => states.push(s),
      debounceMs: 1500,
      fetchImpl,
    });
    return { loop, states };
  }

  it("debounces: one PUT after quiet, carrying If-Match, then adopts the returned hash", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    loop.markDirty();
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://x/api/thesis/t/docx");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"h1"');
    expect(loop.getHash()).toBe("h2");
    expect(states.map((s) => s.kind)).toEqual(["dirty", "saving", "saved"]);
    expect(states.at(-1)).toEqual({ kind: "saved", at: expect.any(Number), docHash: "h2" });
  });

  it("a 412 reports stale with the server's hash and keeps ours", async () => {
    const f = mockPut(412, { error: "stale", docHash: "srv" });
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(loop.getHash()).toBe("h1");
    expect(states.at(-1)).toEqual({ kind: "stale", serverHash: "srv" });
  });

  it("flush() saves immediately and resolves after the PUT", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing dirty is a no-op", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop } = make(f);
    await loop.flush();
    expect(f).not.toHaveBeenCalled();
  });

  it("saves are chained, never concurrent", async () => {
    let resolveFirst!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = () => r({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) }); }))
      .mockImplementationOnce(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h3" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    const first = loop.flush();
    loop.markDirty();
    const second = loop.flush();
    expect(f).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
    await second;
    expect(f).toHaveBeenCalledTimes(2);
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1].headers).toMatchObject({ "If-Match": '"h2"' });
    expect(loop.getHash()).toBe("h3");
  });

  it("onSaved fires with the saved bytes on success only", async () => {
    const f = vi.fn()
      .mockImplementationOnce(async () => ({ status: 412, ok: false, json: async () => ({ error: "stale", docHash: "srv" }) }))
      .mockImplementationOnce(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    const saved = vi.fn();
    const off = loop.onSaved(saved);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();               // 412 → no callback
    expect(saved).not.toHaveBeenCalled();
    await loop.flush();               // still dirty → retried → 200
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith(bytes);
    off();
  });

  it("a network error reports error and stays dirty for the next attempt", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toEqual({ kind: "error", message: "offline" });
    await loop.flush();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then write the save loop**

Run: `cd ~/kwill && npx vitest run components/workspace/docx-editor/bridge/save-loop.test.ts` → FAIL (module missing).

```ts
// components/workspace/docx-editor/bridge/save-loop.ts
//
// The student's edits leave as WHOLE BYTES (spec D2): `editor.save()` → PUT
// /api/thesis/:id/docx, debounced on typing pauses and forced by `flush()`
// (the `flushEdits` contract ai-service awaits before a turn). Every PUT carries
// `If-Match: "<hash we loaded or last saved>"`; a 412 means the server moved
// under us — a second device, the web — and is REPORTED, never merged (D4). The
// host decides what to do with a stale state; this loop just refuses to guess.
//
// Saves are chained. A flush landing while a save is in flight waits for it and
// then saves against the hash that save returned — two PUTs racing would have the
// second one refused with a 412 it did not deserve.
//
// No React, no engine: `getBytes` is injected (the DOM component binds it to
// `ref.save()`), which is what makes this testable under node.

export type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number; docHash: string | null }
  | { kind: "stale"; serverHash: string | null }
  | { kind: "error"; message: string };

export interface SaveLoop {
  markDirty(): void;
  flush(): Promise<void>;
  setHash(h: string | null): void;
  getHash(): string | null;
  /** Fires after every SUCCESSFUL PUT with the bytes that were saved (never on a
   *  412 or a network error). The bridge uses it to re-parse its own bytes after
   *  a structural edit (spec D7). Returns the unsubscribe. */
  onSaved(fn: (bytes: ArrayBuffer) => void): () => void;
  dispose(): void;
}

export function createSaveLoop(o: {
  apiBase: string;
  thesisId: string;
  token: () => string | null;
  getBytes: () => Promise<ArrayBuffer | null>;
  onState: (s: SaveState) => void;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
}): SaveLoop {
  const f = o.fetchImpl ?? fetch;
  const debounceMs = o.debounceMs ?? 1500;
  let hash: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  const savedListeners = new Set<(bytes: ArrayBuffer) => void>();

  async function saveOnce(): Promise<void> {
    if (!dirty || disposed) return;
    const token = o.token();
    if (!token) { o.onState({ kind: "error", message: "no token" }); return; }
    dirty = false;
    o.onState({ kind: "saving" });
    try {
      const bytes = await o.getBytes();
      if (!bytes) throw new Error("editor returned no bytes");
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Authorization: `Bearer ${token}`,
      };
      if (hash) headers["If-Match"] = `"${hash}"`;
      const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { method: "PUT", headers, body: bytes });
      const body = (await res.json().catch(() => ({}))) as { docHash?: string | null; error?: string };
      if (res.status === 412) {
        dirty = true; // the bytes are still the student's; the host decides
        o.onState({ kind: "stale", serverHash: body.docHash ?? null });
        return;
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
      if (typeof body.docHash === "string") hash = body.docHash;
      o.onState({ kind: "saved", at: Date.now(), docHash: hash });
      for (const l of savedListeners) l(bytes);
    } catch (e) {
      dirty = true;
      o.onState({ kind: "error", message: String((e as Error)?.message ?? e) });
    }
  }

  function enqueue(): Promise<void> {
    const run = chain.then(saveOnce);
    chain = run.catch(() => {});
    return run;
  }

  return {
    markDirty() {
      if (disposed) return;
      if (!dirty) o.onState({ kind: "dirty" });
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void enqueue(); }, debounceMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty) return chain;
      return enqueue();
    },
    setHash(h) { hash = h; },
    getHash() { return hash; },
    onSaved(fn) {
      savedListeners.add(fn);
      return () => { savedListeners.delete(fn); };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 6: Run both tests — PASS (5 + 7). Gate and commit**

Run: `cd ~/kwill && npx vitest run && npx tsc --noEmit && node scripts/verify-use-dom.mjs | tail -1`
```bash
git add components/workspace/docx-editor/bridge/load-document.ts components/workspace/docx-editor/bridge/load-document.test.ts components/workspace/docx-editor/bridge/save-loop.ts components/workspace/docx-editor/bridge/save-loop.test.ts && git commit -m "feat(docx): conditional document loader and If-Match save loop"
```

### Task 9: The DOM component and its bridge

This replaces the current `DocxEditorDom.tsx` (the 2026-09-10 spike: fetch-by-URL, no bridge). Four modules; only `DocxEditorDom.tsx` carries `'use dom'` and its single default export.

**Files:**
- Create: `components/workspace/docx-editor/bridge/dom-selectors.ts` (+ `dom-selectors.test.ts`)
- Create: `components/workspace/docx-editor/bridge/find-block.ts`
- Create: `components/workspace/docx-editor/bridge/Bridge.tsx`
- Rewrite: `components/workspace/docx-editor/DocxEditorDom.tsx`
- Modify: `vitest.config.ts` — already includes `components/workspace/docx-editor/bridge/**/*.test.ts`

- [ ] **Step 1: Failing test for the block-level id predicate**

```ts
// components/workspace/docx-editor/bridge/dom-selectors.test.ts
import { describe, it, expect } from "vitest";
import { isBlockLevelId } from "./dom-selectors";

describe("isBlockLevelId", () => {
  it("is true for a paragraph/table id (exactly three segments)", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42")).toBe(true);
  });
  it("is false for a run or text id (deeper) and for other parts", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42.0")).toBe(false);
    expect(isBlockLevelId("/word/document.xml#0.1.42.1.0")).toBe(false);
    expect(isBlockLevelId("/word/header1.xml#0.0.2")).toBe(false);
    expect(isBlockLevelId(null)).toBe(false);
  });
});
```
Run: `cd ~/kwill && npx vitest run components/workspace/docx-editor/bridge/dom-selectors.test.ts` → FAIL (module missing).

- [ ] **Step 2: `dom-selectors.ts` — read the painted DOM without knowing its attribute names**

```ts
// components/workspace/docx-editor/bridge/dom-selectors.ts
//
// The engine stamps painted elements with their node id (`/word/document.xml#…`,
// see lib/docx-block-id.ts). Which ATTRIBUTE carries it differs per node kind
// (`data-drawing-node-id` on drawings; paragraphs use their own) and is not part
// of the typed API, so nothing here names an attribute: an element "has a node
// id" when ANY attribute value starts with the body part prefix. A block-level id
// has exactly three segments; runs and text nodes go deeper.

import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

const BODY_PREFIX = "/word/document.xml#";

export function isBlockLevelId(id: string | null | undefined): boolean {
  return isBodyId(id) && /#\d+\.\d+\.\d+$/.test(id as string);
}

/** The body node id an element carries, if any. */
export function nodeIdOf(el: Element): string | null {
  for (const a of Array.from(el.attributes)) if (a.value.startsWith(BODY_PREFIX)) return a.value;
  return null;
}

/** The nearest painted BLOCK (paragraph / table) element at or above `node`. */
export function blockElementOf(node: Node | null): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    const id = nodeIdOf(el);
    if (id && isBlockLevelId(id)) return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

export type SpannedBlock = { index: number; text: string; el: HTMLElement };

/**
 * Every painted body block the current browser selection spans, in document
 * order, plus which one holds the FOCUS end. Mirrors what read-state.ts reported
 * for Lexical (`blocks` + `index`/`text`) so the native multi-block selection
 * keeps working unchanged. Pages the engine has virtualised out are not in the
 * DOM and therefore not in this list — a limitation the host tolerates: a
 * selection that long is an AI "range" ask, and those re-resolve by text.
 */
export function spannedBlocks(sel: Selection | null): { blocks: SpannedBlock[]; focus: SpannedBlock | null } {
  if (!sel || sel.rangeCount === 0) return { blocks: [], focus: null };
  const range = sel.getRangeAt(0);
  const first = blockElementOf(range.startContainer);
  const last = blockElementOf(range.endContainer);
  if (!first) return { blocks: [], focus: null };
  const toBlock = (el: HTMLElement): SpannedBlock | null => {
    const index = blockIndexFromId(nodeIdOf(el));
    return index == null ? null : { index, text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), el };
  };
  const out: SpannedBlock[] = [];
  let el: HTMLElement | null = first;
  while (el) {
    const b = toBlock(el);
    if (b) out.push(b);
    if (el === last || !last) break;
    // Walk forward through the painted siblings between the two ends.
    let next: Element | null = el.nextElementSibling;
    while (next && !isBlockLevelId(nodeIdOf(next))) next = next.nextElementSibling;
    el = next as HTMLElement | null;
  }
  const focusEl = blockElementOf(sel.focusNode);
  const focus = focusEl ? toBlock(focusEl) : out[0] ?? null;
  return { blocks: out, focus };
}
```
Run the test → PASS (2 tests).

- [ ] **Step 3: `find-block.ts` — index → engine match (spec D7, the one allowed direction)**

```ts
// components/workspace/docx-editor/bridge/find-block.ts
import type { Editor, TextMatch } from "@docx-editor.dev/react";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

/**
 * The engine's match for block `index`: search the block's own text, keep the
 * BODY match whose node id parses back to `index`; if none does (ids drifted
 * since the load — a local structural edit not yet reloaded), fall back to the
 * first body match, which is the right block whenever its text is unique.
 * `maxLen` bounds the query for navigation; pass Infinity to select the WHOLE
 * paragraph (`match.length` is then the paragraph's length).
 */
export function findBlockMatch(editor: Editor, index: number, text: string, maxLen = 120): TextMatch | null {
  const q = text.replace(/\s+/g, " ").trim().slice(0, maxLen);
  if (!q) return null;
  const matches = Array.from(editor.findMatches(q)).filter((m) => isBodyId(m.blockId));
  return matches.find((m) => blockIndexFromId(m.blockId) === index) ?? matches[0] ?? null;
}
```

- [ ] **Step 4: `Bridge.tsx` — the React half, mounted as a CHILD of `<DocxEditor>` (it needs the editor context for the hooks, exactly as the web `TrialBubble` does)**

```tsx
// components/workspace/docx-editor/bridge/Bridge.tsx
//
// The live half of the bridge. Runs inside the engine's React context (a child
// of <DocxEditor>), so the slot/style/format hooks resolve. Owns: the selection
// report (engine → LexicalState), command execution (LexicalCommand → engine),
// the save loop's triggers, flush, reload and scroll-to-index.
//
// Hooks are called UNCONDITIONALLY and the slot table is fixed — React's rule.

import { useCallback, useEffect, useRef } from "react";
import {
  useEditorCommand,
  useEditorEvent,
  useEditorState,
  useParagraphFormat,
  useParagraphStyle,
} from "@docx-editor.dev/react";
import type { DocxEditorRef, EditorCommand } from "@docx-editor.dev/react";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { mapCommand } from "./command-map";
import { findBlockMatch } from "./find-block";
import { spannedBlocks } from "./dom-selectors";
import { fetchDocument } from "./load-document";
import type { SaveLoop } from "./save-loop";

// A report counts as the student's own doing for this long after a touch/key.
// Same constant, same reason as Lexical's EditorBridge: focus leaving the WebView
// (tapping ✦ Ask) collapses the selection, and the host must be able to refuse
// the phantom single-block report that follows.
const DRIVING_MS = 1500;

export type BridgeProps = {
  editorRef: React.RefObject<DocxEditorRef | null>;
  saveLoop: SaveLoop;
  apiBase: string;
  thesisId: string;
  token: string;
  command: LexicalCommand | null | undefined;
  scrollToIndex: { index: number; text: string; nonce: number } | null | undefined;
  reloadNonce: number | undefined;
  flushNonce: number | undefined;
  onState: (s: LexicalState) => void;
  onFlushed: ((nonce: number) => void) | undefined;
  onReloaded: ((docHash: string | null) => void) | undefined;
  onServerFormat: ((index: number, changes: { direction: "rtl" | "ltr" }) => void) | undefined;
};

export function Bridge(p: BridgeProps) {
  const editorOf = () => p.editorRef.current?.getEditor() ?? null;
  const drivenAt = useRef(0);
  const lastFocus = useRef<{ index: number; text: string } | null>(null);
  const structureChanged = useRef(false);
  const restore = useRef<{ index: number; text: string } | null>(null);

  // Fixed slot table (hooks, unconditional).
  const slots: Record<string, ReturnType<typeof useEditorCommand>> = {
    "text.bold": useEditorCommand("text.bold"),
    "text.italic": useEditorCommand("text.italic"),
    "text.underline": useEditorCommand("text.underline"),
    "alignment.left": useEditorCommand("alignment.left"),
    "alignment.center": useEditorCommand("alignment.center"),
    "alignment.right": useEditorCommand("alignment.right"),
    "alignment.justify": useEditorCommand("alignment.justify"),
    "list.bullet": useEditorCommand("list.bullet"),
    "list.numbered": useEditorCommand("list.numbered"),
    "format.clear": useEditorCommand("format.clear"),
    "history.undo": useEditorCommand("history.undo"),
    "history.redo": useEditorCommand("history.redo"),
  };
  const style = useParagraphStyle();
  const para = useParagraphFormat();
  const isLoading = useEditorState((s) => s.isLoading);

  useEffect(() => {
    const mark = () => { drivenAt.current = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(ev, mark, true);
    return () => { for (const ev of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(ev, mark, true); };
  }, []);

  // ── engine → native: the selection report ──
  const report = useCallback(() => {
    const editor = editorOf();
    if (!editor) return;
    const sel = window.getSelection();
    const { blocks, focus } = spannedBlocks(sel);
    const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const fmt = editor.getSelectionFormatting();
    const styleId = fmt.styleId ?? "";
    const h = /^Heading([1-6])$/.exec(styleId);
    const blockType = slots["list.bullet"].isActive ? "bullet"
      : slots["list.numbered"].isActive ? "number"
      : h ? `h${h[1]}`
      : styleId === "Quote" ? "quote"
      : "paragraph";
    if (focus) lastFocus.current = { index: focus.index, text: focus.text };
    p.onState({
      bold: !!fmt.bold, italic: !!fmt.italic, underline: !!fmt.underline,
      blockType,
      isRTL: focus ? getComputedStyle(focus.el).direction === "rtl" : false,
      alignment: (fmt.alignment as LexicalState["alignment"]) ?? null,
      index: focus?.index ?? -1,
      text: focus?.text ?? "",
      blocks: blocks.map(({ index, text }) => ({ index, text })),
      y: rect && rect.height > 0 ? rect.top : -1,
      canUndo: slots["history.undo"].isEnabled,
      canRedo: slots["history.redo"].isEnabled,
      userDriven: document.hasFocus() && Date.now() - drivenAt.current < DRIVING_MS,
    });
  }, [p.onState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEditorEvent("selectionChange", report);
  useEditorEvent("change", (change) => {
    if ((change.created?.length ?? 0) + (change.deleted?.length ?? 0) > 0) structureChanged.current = true;
    p.saveLoop.markDirty();
    report();
  });

  // ── native → engine: commands ──
  useEffect(() => {
    const cmd = p.command;
    const editor = editorOf();
    if (!cmd || !editor) return;
    for (const a of mapCommand(cmd)) {
      switch (a.kind) {
        case "slot": slots[a.slot]?.execute(); break;
        case "style": style.setValue(a.styleId); break;
        case "paragraph": para.apply(a.update); break;
        case "marks": editor.exec({ type: "applyFormatting", marks: a.marks } as unknown as EditorCommand); break;
        case "selectParagraph": {
          const f = lastFocus.current;
          const m = f ? findBlockMatch(editor, f.index, f.text, Infinity) : null;
          if (m) editor.selectMatch(m);
          break;
        }
        case "server": { const f = lastFocus.current; if (f) p.onServerFormat?.(f.index, a.changes); break; }
        case "noop": break;
      }
    }
  }, [p.command?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── flush (awaited by ai-service before a turn) ──
  useEffect(() => {
    const n = p.flushNonce;
    if (n == null) return;
    void p.saveLoop.flush().finally(() => p.onFlushed?.(n));
  }, [p.flushNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── reload from the server (spec D3), conditional on the hash we hold ──
  const reload = useCallback(async (force: boolean) => {
    const editor = editorOf();
    try {
      const r = await fetchDocument({ apiBase: p.apiBase, thesisId: p.thesisId, token: p.token, ifNoneMatch: force ? null : p.saveLoop.getHash() });
      if (r.status === 304) { p.onReloaded?.(p.saveLoop.getHash()); return; }
      restore.current = lastFocus.current;
      p.editorRef.current?.load(r.bytes);
      p.saveLoop.setHash(r.docHash);
      p.onReloaded?.(r.docHash);
    } catch (e) {
      console.warn("[docx] reload failed", e);
      p.onReloaded?.(p.saveLoop.getHash());
    }
    void editor;
  }, [p.apiBase, p.thesisId, p.token, p.saveLoop, p.onReloaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (p.reloadNonce == null || p.reloadNonce === 0) return;
    void reload(false);
  }, [p.reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a save that changed paragraph STRUCTURE, re-parse our own bytes so the
  // node ids are positional again (D7). No network: the bytes are the ones we
  // just sent. The caret is put back by text below.
  useEffect(() => {
    const unsub = p.saveLoop.onSaved((bytes) => {
      if (!structureChanged.current) return;
      structureChanged.current = false;
      restore.current = lastFocus.current;
      p.editorRef.current?.load(bytes);
    });
    return unsub;
  }, [p.saveLoop, p.editorRef]);

  // Put the caret back after any load() — the engine re-parses, ids are new.
  useEffect(() => {
    if (isLoading) return;
    const keep = restore.current;
    const editor = editorOf();
    if (!keep || !editor) return;
    restore.current = null;
    const m = findBlockMatch(editor, keep.index, keep.text);
    if (m) { editor.selectMatch(m); editor.scrollToBlock(m.blockId); }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── scroll to a block index (outline drawer, modk:// links, deep link) ──
  useEffect(() => {
    const t = p.scrollToIndex;
    const editor = editorOf();
    if (!t || !editor || isLoading) return;
    const m = findBlockMatch(editor, t.index, t.text);
    if (m) editor.scrollToBlock(m.blockId);
  }, [p.scrollToIndex?.nonce, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
```

- [ ] **Step 5: Rewrite `DocxEditorDom.tsx`**

```tsx
'use dom';

// The docx-editor as THE Writer surface, bundled into the app as an Expo DOM
// component. Speaks the native chrome's existing contract (LexicalCommand in,
// LexicalState out — see bridge/Bridge.tsx), loads and saves the document itself
// (bytes never cross the JSON bridge), and reloads on request.
//
// ⚠️ babel-preset-expo allows this module ONE export, the default. Everything
// else lives in ./bridge/. Gate: node scripts/verify-use-dom.mjs.
//
// Assets: harfbuzz.wasm is served from public/ (copied into the binary; not
// OTA-updatable — Task 29 moves it to require()). Fonts come from the package's
// Google resolver until Task 27 bundles Arabic faces; loadDefaultFonts() is never
// used because its `new URL(…, import.meta.url)` cannot resolve under Metro.

import { useEffect, useMemo, useRef, useState } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { DocxEditorRef, Editor, FontConfigurationFragment, FontResolver } from "@docx-editor.dev/react";
import { setHarfBuzzWasmUrl } from "@docx-editor.dev/core/layout";
import { googleFonts } from "@docx-editor.dev/fonts/google";
import "@docx-editor.dev/core/styles/editor.css";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { Bridge } from "./bridge/Bridge";
import { fetchDocument } from "./bridge/load-document";
import { createSaveLoop, type SaveState } from "./bridge/save-loop";

let wasmConfigured = false;
function ensureWasm(): void {
  if (wasmConfigured) return;
  setHarfBuzzWasmUrl(`${process.env.EXPO_BASE_URL ?? "/"}harfbuzz.wasm`);
  wasmConfigured = true;
}

function makeFontResolver(): FontResolver {
  const google = googleFonts({
    substitute: {
      "Traditional Arabic": "Amiri",
      "Simplified Arabic": "Amiri",
      "Arabic Typesetting": "Amiri",
      "Sakkal Majalla": "Amiri",
    },
  });
  return async (request): Promise<FontConfigurationFragment> => {
    const fragment = await google(request);
    if (fragment.failures.length) console.warn("[docx] font faces that failed to load:", fragment.failures);
    return { sources: fragment.sources, substitutions: fragment.substitutions };
  };
}

// The WebView gives the page no height of its own; the engine needs one.
const PAGE_CSS = "html,body,#root{height:100%;margin:0;overflow:hidden;background:#f0f0f5}";

export default function DocxEditorDom({
  apiBase, thesisId, token, command, scrollToIndex, reloadNonce, flushNonce,
  onState, onSave, onReady, onFlushed, onReloaded, onServerFormat, onError,
  dom: _dom,
}: {
  apiBase: string;
  thesisId: string;
  token: string;
  command?: LexicalCommand | null;
  scrollToIndex?: { index: number; text: string; nonce: number } | null;
  reloadNonce?: number;
  flushNonce?: number;
  onState: (s: LexicalState) => Promise<void>;
  onSave?: (s: SaveState) => Promise<void>;
  onReady?: (info: { pages: number; docHash: string | null }) => Promise<void>;
  onFlushed?: (nonce: number) => Promise<void>;
  onReloaded?: (docHash: string | null) => Promise<void>;
  onServerFormat?: (index: number, changes: { direction: "rtl" | "ltr" }) => Promise<void>;
  onError?: (message: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const ref = useRef<DocxEditorRef>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const fonts = useMemo(() => makeFontResolver(), []);

  // One save loop per mount; getBytes is bound to the ref so it always saves the
  // editor that is on screen.
  const saveLoop = useMemo(
    () => createSaveLoop({
      apiBase, thesisId,
      token: () => tokenRef.current,
      getBytes: async () => (await ref.current?.save()) ?? null,
      onState: (s) => void onSave?.(s),
    }),
    [apiBase, thesisId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => () => saveLoop.dispose(), [saveLoop]);

  useEffect(() => {
    ensureWasm();
    let alive = true;
    void (async () => {
      try {
        const r = await fetchDocument({ apiBase, thesisId, token });
        if (!alive || r.status !== 200) return;
        saveLoop.setHash(r.docHash);
        setBytes(r.bytes);
      } catch (e) {
        if (alive) void onError?.(`could not load the document: ${String(e)}`);
      }
    })();
    return () => { alive = false; };
  }, [apiBase, thesisId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReady = (editor: Editor) => {
    void onReady?.({ pages: editor.snapshot().page.total, docHash: saveLoop.getHash() });
  };

  if (!bytes) return <style>{PAGE_CSS}</style>;

  return (
    <div style={{ height: "100%" }}>
      <style>{PAGE_CSS}</style>
      <DocxEditor
        ref={ref}
        document={bytes}
        mode="edit"
        fonts={fonts}
        colorMode="light"
        zoomMode="auto"
        chrome={false}
        onReady={handleReady}
        onFontError={(e) => console.warn("[docx] font error", e.code)}
        className="h-full"
      >
        <Bridge
          editorRef={ref}
          saveLoop={saveLoop}
          apiBase={apiBase}
          thesisId={thesisId}
          token={token}
          command={command}
          scrollToIndex={scrollToIndex}
          reloadNonce={reloadNonce}
          flushNonce={flushNonce}
          onState={(s) => void onState(s)}
          onFlushed={(n) => void onFlushed?.(n)}
          onReloaded={(h) => void onReloaded?.(h)}
          onServerFormat={(i, c) => void onServerFormat?.(i, c)}
        />
      </DocxEditor>
    </div>
  );
}
```
Note: `onChange` on `<DocxEditor>` is NOT used — `Bridge` subscribes to the `change` event itself so the structural flag and the dirty mark live in one place.

- [ ] **Step 6: Gates**

Run: `cd ~/kwill && npx vitest run && npx tsc --noEmit && node scripts/verify-use-dom.mjs | tail -1`
Expected: all tests pass; tsc silent (if `chrome`, `className` or `snapshot().page` are rejected, read the prop's real name in `node_modules/@docx-editor.dev/react/dist/index.d.ts` — the web trial at `~/kwill-dashboard/src/features/editor/docx-editor/WordEditorTrial.tsx:255` compiles against the same 2.12.0 types and is the reference); `All 3 'use dom' module(s) bundle cleanly`.

- [ ] **Step 7: Commit**

```bash
git add components/workspace/docx-editor && git commit -m "feat(docx): DOM surface with the native command/state bridge, save loop and reload"
```

### Task 10: `WorkspaceDocxView` — the native host

Mirrors `WorkspaceLexicalView`'s host duties for Phase 1 (its `onState` handling is copied, not reinvented — the phantom-collapse guard and the selection sync are hard-won). Chrome (header/footer) selections, select mode, suggestions, completion, insert, paste, scroll restore arrive in Phases 2–4.

**Files:**
- Create: `components/workspace/WorkspaceDocxView.tsx`

- [ ] **Step 1: Write the host**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import DocxEditorDom from "@/components/workspace/docx-editor/DocxEditorDom";
import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import type { SaveState } from "@/components/workspace/docx-editor/bridge/save-loop";
import type { DocBlockDTO } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";

// The docx-editor as the Writer (spec D12, behind settings.writerEngine). Phase 1
// host: token, command/state bridge, flush + reload registration, doc-tick → reload,
// outline/deep-link scroll, pill anchoring, the save banner. Everything index-based
// on the native side keeps working because the DOM reports the same LexicalState
// Lexical did.

const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** The text to search for when navigating to `index`: the block's own text for a
 *  paragraph, else the nearest paragraph ABOVE it (a table or figure has no
 *  searchable text; landing just above it is the right place to look). */
function anchorTextFor(blocks: DocBlockDTO[], index: number): { index: number; text: string } {
  for (let i = index; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "paragraph" && b.text.trim()) return { index: i, text: b.text };
  }
  return { index, text: "" };
}

export function WorkspaceDocxView({ thesisId, active, deepLinkBlock }: {
  thesisId: string;
  active: boolean;
  deepLinkBlock?: number | null;
}) {
  const colors = useThemeColors();
  const [token, setToken] = useState<string | null>(null);
  const command = useLexicalEditorStore((s) => s.command);
  const docTick = useThesisDocStore((s) => s.tick[thesisId] ?? 0);
  const scrollTarget = useWorkspaceStore((s) => s.scrollTarget);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [flushNonce, setFlushNonce] = useState<number | undefined>(undefined);
  const [scrollTo, setScrollTo] = useState<{ index: number; text: string; nonce: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const editorHashRef = useRef<string | null>(null);
  const editorTopRef = useRef(0);
  const lastSelKeyRef = useRef("");
  const flushWaiters = useRef(new Map<number, () => void>());
  const reloadWaiters = useRef<(() => void)[]>([]);

  // A fresh token on mount; the DOM side holds it for its own fetches. (A session
  // outliving the hour re-mounts on the next workspace open; Phase 4 refreshes it
  // in place on AppState "active".)
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setToken(data.session?.access_token ?? null); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    useLexicalEditorStore.getState().setActive(active);
    return () => useLexicalEditorStore.getState().setActive(false);
  }, [active]);

  // flushEdits: bump a nonce the DOM watches; resolve when it reports back (8s cap).
  const flushEdits = useCallback((): Promise<void> => new Promise((resolve) => {
    const n = Date.now();
    flushWaiters.current.set(n, resolve);
    setFlushNonce(n);
    setTimeout(() => { if (flushWaiters.current.delete(n)) resolve(); }, 8000);
  }), []);
  const onFlushed = useCallback(async (n: number) => { flushWaiters.current.get(n)?.(); flushWaiters.current.delete(n); }, []);
  useEffect(() => {
    useLexicalEditorStore.getState().registerFlushEdits(flushEdits);
    return () => useLexicalEditorStore.getState().registerFlushEdits(null);
  }, [flushEdits]);

  // reload: same nonce pattern, awaited by sheets/history after a server mutation.
  const reload = useCallback((): Promise<void> => new Promise((resolve) => {
    reloadWaiters.current.push(resolve);
    setReloadNonce((n) => n + 1);
    setTimeout(resolve, 8000);
  }), []);
  useEffect(() => {
    useLexicalEditorStore.getState().registerReload(reload);
    return () => useLexicalEditorStore.getState().registerReload(null);
  }, [reload]);
  const onReloaded = useCallback(async (h: string | null) => {
    editorHashRef.current = h;
    reloadWaiters.current.splice(0).forEach((r) => r());
  }, []);

  // The doc changed on the server by something other than our save (an AI turn's
  // MODK_DOCCHANGES → revalidate, a sheet, history) → the DTO's hash moves away
  // from the one the editor holds → reload. A conditional GET, so a false alarm
  // is one 304.
  useEffect(() => {
    const d = useThesisDocStore.getState().byId[thesisId];
    const h = d?.available ? d.docHash ?? null : null;
    if (h && editorHashRef.current && h !== editorHashRef.current) setReloadNonce((n) => n + 1);
  }, [docTick, thesisId]);

  const onReady = useCallback(async (info: { pages: number; docHash: string | null }) => {
    editorHashRef.current = info.docHash;
  }, []);

  const onSave = useCallback(async (s: SaveState) => {
    if (s.kind === "saved") {
      editorHashRef.current = s.docHash;
      setBanner("Saved");
      // The block model must catch up with the bytes: indices for the AI, the
      // outline drawer, block links. revalidate no-ops while ops are queued —
      // there are none on this surface.
      void useThesisDocStore.getState().revalidate(thesisId);
    } else if (s.kind === "stale") {
      // Phase 1: reload the server's version and say so. Phase 4 (Task 28) keeps
      // the refused bytes as a recovery copy and offers Restore.
      setBanner("Changed elsewhere — reloaded");
      setReloadNonce((n) => n + 1);
    } else if (s.kind === "error") {
      setBanner(`Save failed: ${s.message}`);
    } else if (s.kind === "saving") {
      setBanner("Saving…");
    } else {
      setBanner(null);
    }
  }, [thesisId]);
  useEffect(() => {
    if (!banner || banner === "Saving…") return;
    const t = setTimeout(() => setBanner(null), 2600);
    return () => clearTimeout(t);
  }, [banner]);

  // Direction has no engine command: the server's `format` op, whose echo bumps
  // the tick → the hash moves → the effect above reloads the surface.
  const onServerFormat = useCallback(async (index: number, changes: { direction: "rtl" | "ltr" }) => {
    await flushEdits();
    await useThesisDocStore.getState().mutate(thesisId, { type: "format", indices: [index], changes });
  }, [thesisId, flushEdits]);

  // Outline drawer / modk:// link / deep link → scroll by index (+ its text).
  useEffect(() => {
    const target = scrollTarget?.index ?? deepLinkBlock ?? null;
    if (target == null) return;
    const d = useThesisDocStore.getState().byId[thesisId];
    const blocks = d?.available ? d.blocks : [];
    setScrollTo({ ...anchorTextFor(blocks, target), nonce: (scrollTarget?.nonce ?? 0) + 1 });
  }, [scrollTarget?.nonce, deepLinkBlock, thesisId]); // eslint-disable-line react-hooks/exhaustive-deps

  // engine → native, copied from WorkspaceLexicalView.onState (non-chrome path).
  const onState = useCallback(async (s: LexicalState) => {
    useLexicalEditorStore.getState().setHistoryAvail(!!s.canUndo, !!s.canRedo);
    if (useWorkspaceStore.getState().selectMode) { lastSelKeyRef.current = ""; return; }
    if (s.userDriven === false && (s.blocks?.length ?? 1) <= 1 && useWorkspaceStore.getState().selectedBlocks.length > 1) return;
    useWorkspaceStore.getState().setChromeSelection(null);
    useLexicalEditorStore.getState().setFormat({
      bold: s.bold, italic: s.italic, underline: s.underline,
      blockType: s.blockType, isRTL: s.isRTL, alignment: s.alignment,
    });
    const spanned = s.blocks && s.blocks.length ? s.blocks : [{ index: s.index, text: s.text }];
    const selKey = spanned.map((b) => b.index).join(",");
    if (selKey !== lastSelKeyRef.current) {
      lastSelKeyRef.current = selKey;
      const ws = useWorkspaceStore.getState();
      if (spanned.length > 1) ws.setSelection(spanned, true);
      else if (spanned[0].index >= 0) ws.selectBlock(spanned[0].index, spanned[0].text);
    }
    if (typeof s.y === "number" && s.y >= 0) useFloatingPillStore.getState().setAnchorY(editorTopRef.current + s.y);
  }, []);

  if (!token) return <View style={styles.fill} />;

  return (
    <View style={styles.fill} onLayout={(e) => { editorTopRef.current = e.nativeEvent.layout.y; }}>
      <DocxEditorDom
        apiBase={API_BASE}
        thesisId={thesisId}
        token={token}
        command={command}
        scrollToIndex={scrollTo}
        reloadNonce={reloadNonce}
        flushNonce={flushNonce}
        onState={onState}
        onSave={onSave}
        onReady={onReady}
        onFlushed={onFlushed}
        onReloaded={onReloaded}
        onServerFormat={onServerFormat}
        onError={async (m) => setBanner(m)}
        dom={{ style: { flex: 1 }, scrollEnabled: true }}
      />
      {banner ? (
        <View style={[styles.banner, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{banner}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  banner: { position: "absolute", bottom: 12, alignSelf: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
});
```
`editorTopRef` from `onLayout.y` is the editor's offset inside its parent; `WorkspaceLexicalView` measures the absolute screen top with `measureInWindow` — copy its `wrapRef.current?.measureInWindow(...)` block into this host's `onLayout` if the pill lands offset (it will on Android where the status-bar strip is above).

- [ ] **Step 2: Gate and commit**

Run: `cd ~/kwill && npx tsc --noEmit` → silent. `git add components/workspace/WorkspaceDocxView.tsx && git commit -m "feat(docx): native host for the docx Writer surface"`.

### Task 11: Mount it behind the flag

**Files:**
- Modify: `app/(app)/thesis-workspace.tsx` (import ≈line 55; the mount ≈line 870)

- [ ] **Step 1: Switch the Writer layer**

Add the import next to `WorkspaceLexicalView`'s: `import { WorkspaceDocxView } from "@/components/workspace/WorkspaceDocxView";` and, with the screen's other primitive selectors, `const writerEngine = useSettingsStore((s) => s.writerEngine);` (add the `useSettingsStore` import if the file does not have it — `grep -n useSettingsStore "app/(app)/thesis-workspace.tsx"`).

Replace the `<WorkspaceLexicalView … />` element with:
```tsx
              {writerEngine === "docx" ? (
                // Spec D12: the docx-editor as the Writer, behind Settings → Developer
                // until parity is verified. Same props as the Lexical surface.
                <WorkspaceDocxView thesisId={thesisId} active={previewMode === null} deepLinkBlock={deepLinkBlock} />
              ) : (
                <WorkspaceLexicalView
                  thesisId={thesisId}
                  blocks={liveDoc.blocks}
                  rtl={docRtl}
                  active={previewMode === null}
                  deepLinkBlock={deepLinkBlock}
                />
              )}
```

- [ ] **Step 2: Retire the spike screen**

`app/(app)/word-native.tsx` was the 2026-09-10 proof that the editor bundles; it passes the OLD `docxUrl` prop and no longer compiles against Task 9. The flag replaces it: delete the file, its `<Stack.Screen name="word-native" />` line in `app/(app)/_layout.tsx`, and the "Word Editor (native)" row in `app/(app)/settings.tsx`. Keep `word-trial.tsx` (the WebView-onto-the-web-app baseline) — it is the side-by-side comparison for Task 12.

- [ ] **Step 3: Gate and commit**

Run: `cd ~/kwill && npx tsc --noEmit && node scripts/verify-use-dom.mjs | tail -1`.
```bash
git add "app/(app)/thesis-workspace.tsx" "app/(app)/_layout.tsx" "app/(app)/settings.tsx" && git rm -q "app/(app)/word-native.tsx" && git commit -m "feat(docx): mount the docx Writer behind writerEngine; retire the spike screen"
```

### Task 12: Verify on a device, then the export gate

- [ ] **Step 1: Run the stack** — server (`cd ~/kwill-server && npm run dev`, deployed Task 2 or local), `cd ~/kwill && npx expo start --clear`, a dev build on a real Android phone (the shaper and fonts do not behave on an emulator the way they do on device).

- [ ] **Step 2: Walk the checklist** (Settings → Developer → "Writer: docx-editor" ON, open a live thesis):

| Check | Expect |
|---|---|
| Opens; pages, running header/footer, page numbers painted | yes; banner none |
| Type in a paragraph, wait 2s | banner "Saving…" → "Saved"; `GET /:id/document` in the server log after it |
| Tap a word → native bubble shows Text tools; Bold chip | bold applied to the selection; chip pressed state follows the caret |
| Bubble → Style → Heading 2 | the paragraph becomes Heading 2 (engine style), saved |
| Bubble → Align → Center; List → Bullet | both apply |
| Bubble → Direction → RTL | server op runs, surface reloads with the paragraph RTL, caret back in place |
| Undo/redo from the dock | steps the engine's history; chips enable/disable with `canUndo/canRedo` |
| Select across three paragraphs → ✦ | dock shows the range scope for 3 blocks |
| Chat: "add a sentence to the introduction" | turn runs after the flush; on finish the surface reloads and shows the sentence |
| Tap a `modk://` link in the answer | surface scrolls to that block |
| Structure drawer → tap a heading | scrolls to it |
| Split a paragraph (Enter), wait for save | "Saved"; a subsequent bubble action targets the right paragraph (ids re-minted) |
| Second device (or the web /word route) saves first, then type here | banner "Changed elsewhere — reloaded" (412 path) |

Record anything that fails in `docs/superpowers/plans/2026-09-10-docx-editor-migration.md` under a "Phase 1 findings" heading before moving on — Phases 2–4 are expanded from those findings.

- [ ] **Step 3: The export gate**

Run: `cd ~/kwill && npx expo export --platform android --output-dir /tmp/kwill-export 2>&1 | grep -E "Bundled|failed"; git diff --stat app.json`
Expected: four `Bundled` lines, no `failed`; an EMPTY `app.json` diff (if not: `git checkout app.json`).

- [ ] **Step 4: Commit the findings**

```bash
git add docs/superpowers/plans/2026-09-10-docx-editor-migration.md && git commit -m "docs(plan): Phase 1 findings from device verification"
```

---

## Phase 2 — AI surfaces (overlays)

All four surfaces share one primitive built in Task 13: an **overlay layer** inside the DOM component that positions React cards on a paragraph's or table's viewport rect and re-anchors on scroll/zoom/repaint — the exact technique the web `ChartLayer` uses (portal to `<body>`, `position: fixed`, rect from the painted element found by node id). Lexical rendered these as decorator nodes *inside* the tree; here the document is never mutated to show a proposal, which also removes the whole "a pending proposal suppresses reseed/save" class of guards.

### Task 13: `OverlayLayer` + `useBlockRect(index)`
- Create: `components/workspace/docx-editor/overlays/OverlayLayer.tsx`, `overlays/use-block-rect.ts`, `overlays/find-block-element.ts` (+ `.test.ts` for the pure id filter)
- Interface: `useBlockRect(index: number): DOMRect | null` — resolves the painted element whose `data-*-node-id` parses (`blockIndexFromId`) to `index` under `/word/document.xml#`, observes it with `ResizeObserver` + the viewport's scroll, returns a live rect. Returns `null` while the page is virtualised out (the card then hides rather than floats).
- Acceptance: a debug overlay drawn on the focused paragraph follows it through scroll, zoom and a reload.

### Task 14: Inline suggestion card (paragraph rewrite / caption / fill / source image / chart)
- Create: `overlays/SuggestionCard.tsx`; Modify: `DocxEditorDom.tsx` (`suggestion` + `onSuggestAction` props — the SAME `SuggestionInput` shape from `editor-components/types.ts`), `WorkspaceDocxView.tsx` (mirror `WorkspaceLexicalView`'s `suggestion` memo and `onSuggestAction` verbatim)
- Modify: `stores/suggestion-store.ts` — `approve()` gains an applier hook: `useLexicalEditorStore.getState().applyText?.(index, text)`; when it returns `true` the store does NOT enqueue the `editText` op (spec D8). `applyText` is registered by the docx host and implemented in the DOM as `findMatches(original)` filtered by index → `exec({type:"replaceMatch", match, text})` → `onDirty`.
- Non-text actions (`insertTable`, `insertSourceImage`, `setChart`, `setCaption`) keep the server path; the host calls `reloadFromServer()` after `store.approve` resolves.
- Acceptance: ✦ Rewrite on a paragraph shows the card over that paragraph with the word diff (`lib/word-diff.ts`, reuse), Approve replaces the text in place and a save follows; Reject leaves the document untouched.

### Task 15: Range rewrite card + table proposal card
- Create: `overlays/RangeCard.tsx` (rect = union of `useBlockRect(start..end)`), `overlays/TableProposalCard.tsx` (rect of the table block; renders `TableDiff` from `lib/table-diff.ts`, reuse)
- Both approve on the server (`applyThesisRangeReplace`, `/ops` tableOp batch — the existing store code) then `reloadFromServer()`.
- Acceptance: a two-paragraph selection → Rewrite → one card over both; approve → the range is replaced and the editor shows the server's result.

### Task 16: Completion chip (D11)
- Create: `overlays/CompletionChip.tsx`; Modify: `DocxEditorDom.tsx` (caret watcher: collapsed caret at paragraph end + 600ms idle → `onRequestCompletion({index, text})`; `completion` prop streams in; accept → `exec({type:"insertText", text})` at the caret then `onCommitCompletion(index, fullText)`).
- Modify: `stores/completion-store.ts` `accept()` — same `applyText` hook rule as Task 14 (local insert already happened → skip the `editText` op).
- Acceptance: pause at the end of a paragraph → chip appears below the caret with the streamed continuation; tap inserts it.

---

## Phase 3 — Structure and sheets

Every task here is "detect the tap → open the existing native sheet → the sheet's existing server call → `reloadFromServer()`". The sheets and their stores are unchanged; what is new is the detection in the DOM and one reload after the fact.

### Task 17: Equation tap → `EquationSheet`
- Modify: `DocxEditorDom.tsx` — click/tap on an element inside the engine's equation node (`DocxEditorEquation` markup; find the class in the painted DOM on a real thesis and pin it in `overlays/find-block-element.ts`) → resolve its paragraph's index → `onEquationTap(JSON.stringify({index, math}))` using the DTO's `math` for that block (host passes `blocksIndex` → math). Host reuses `WorkspaceLexicalView.onEquationTap` verbatim.
- Acceptance: tapping an equation opens the sheet on that equation; saving updates it and the editor reloads.

### Task 18: Header/footer tap → `HeaderFooterSheet`
- Modify: `DocxEditorDom.tsx` — `selectionChange` whose selection scope is a header/footer story (`snapshot.scope` / `getHeaderFooterState()`) → report `blockType: "chrome:top" | "chrome:bottom"` with the section's first block index (from `DocSectionDTO`, host passes `sections`) — the SAME shape `read-state.ts` emits for `ChromeNode`, so `BlockContextBar`'s `hfTop/hfBottom` toolsets and the sheet open unchanged.
- The editor's own header/footer editing mode stays enabled for typing directly into a header (a bonus over Lexical); the sheet remains the AI/template path.
- Acceptance: tap a running header → the header bubble; ✦ → the sheet; apply → reload shows it on every page.

### Task 19: Chart layer + chart bar
- Port `~/kwill-dashboard/src/features/editor/docx-editor/bubble/ChartLayer.tsx` and `chart-placeholder.ts` (+ its test) to `components/workspace/docx-editor/overlays/ChartLayer.tsx`; the host passes `drawings` from the DTO exactly as `word/page.tsx` does. Chart tools stay in the native `ChartToolbar` (server `updateThesisChart`) → `reloadFromServer()` + `revalidate` (new SVG).
- Acceptance: a thesis with native charts shows them (not blank placeholders); changing the chart type in the bubble updates it.

### Task 20: Pictures
- Rotate/flip/delete: engine commands via the ported `useEigenTools` (`transformImage`, `deleteImage`) — local, then save. Crop / remove-bg / replace / caption: existing `ImageToolbar` server calls → `reloadFromServer()`. Insert (Insert menu "figure", paste image): server `insertImage` → reload.
- Modify: `DocxEditorDom.tsx` reports `blockType: "image"` when `snapshot.image != null` with the drawing's index (parse `data-drawing-node-id`).
- Acceptance: every chip in `ImageToolbar` does what it does on Lexical.

### Task 21: Search panel
- Modify: `DocxEditorDom.tsx` — `search` prop `{query, current}` → `findMatches(query)`; report `onSearchMatches({count, byIndex})` for the panel's counter; `current` → `selectMatch`. Replace-one/all → `replaceMatch` per match → save. Semantic hits (server, by block index) → `scrollToIndex` (Task 9's path).
- Modify: `stores/search-store.ts` — matches are `{blockIndex, start, end}` today; keep the shape (map from `TextMatch.blockId` via `blockIndexFromId`, `start`, `length`).
- Acceptance: find/replace/semantic all navigate on the docx surface.

### Task 22: Insert menu (`BottomInsertDrawer`) + slash trigger
- Modify: `DocxEditorDom.tsx` — caret-text watcher for `/query` at the caret → `onInsertTrigger` (same payload as `SlashPlugin`); `command.type === "insert"` with a `BlockKind`: text kinds (`h1..h6`, `quote`, `normal`, `title`, `subtitle`, `intenseQuote`, `noSpacing`, `bullet`, `number`) → paragraph style / list slot after deleting the `/query` text; `pageBreak` → `insert.pageBreak`; `figure`/`pasteImage`/`table`/`equation`/`toc`/`footnote` → the drawer's existing native/server path → reload.
- Acceptance: typing `/` blooms the menu; picking Heading 2 converts the paragraph; picking Table inserts one after a reload.

### Task 23: Paste image
- Modify: `DocxEditorDom.tsx` — `paste` listener on the content root with `PasteImagePlugin`'s generous "maybe an image" test → `onPasteImage(index)`; host reuses `WorkspaceLexicalView.onPasteImage` (flush → `pasteImageFromClipboard` → reload).

---

## Phase 4 — Parity extras

### Task 24: Checkbox select mode
- Create: `overlays/SelectCheckboxes.tsx` — one checkbox per body block positioned by `useBlockRect`; `selectActive` makes the engine read-only (`mode: "view"`) and `onToggleSelect(index, text)` feeds the workspace store as today.

### Task 25: Scroll restore
- Modify: `stores/editor-scroll-store.ts` — `ScrollAnchor` becomes `{ index: number; text: string; delta: number; y: number }` (text = first 80 chars of the top visible paragraph). DOM: report on a 700ms poll like `ScrollSyncPlugin`; restore by `findMatches(text)` filtered by index (fallback: text only) → `scrollToBlock` → adjust by `delta`; `onScrollRestored`.

### Task 26: Keyboard mode + drawer swipe
- `keyboardActive=false` → set `inputmode="none"` on the engine's contenteditable root (query it once after `onReady`); `DrawerSwipePlugin`'s touch heuristics attached to the viewport, excluding tables/images by node kind.

### Task 27: Bundled Arabic fonts (D9)
- Add OFL faces under `assets/fonts/docx/` (Scheherazade New Regular/Bold, Noto Naskh Arabic Regular/Bold, Amiri Regular/Bold/Italic/BoldItalic). In the DOM: `require("@/assets/fonts/docx/ScheherazadeNew-Regular.ttf")` → URL → `fetch` → bytes → `FontSource { request:{family,weight,style}, id, bytes, hash: sha256, faceIndex: 0 }`; `substitutions` map `Traditional Arabic`→`Scheherazade New`, `Sakkal Majalla`→`Noto Naskh Arabic`, `Simplified Arabic`/`Arabic Typesetting`→`Amiri`, each with `lineMetrics` measured once (heightEm/baselineEm from the face's OS/2 table — record the numbers in the module). Latin stays on Google (Carlito/Caladea/Tinos/Arimo).
- Acceptance: `snapshot.fontSubstitutions` names the bundled faces; the font notice in the UI reads "substituted: Traditional Arabic → Scheherazade New".

### Task 28: Pending-save queue in IndexedDB (D6)
- Create: `components/workspace/docx-editor/bridge/pending-save.ts` (port `~/kwill-dashboard/src/features/editor/lib/idb.ts`): `putPending(thesisId, bytes, baseHash)`, `takePending(thesisId)`. `save-loop.ts` writes pending BEFORE the PUT and clears it after 2xx; on mount, a pending record is PUT first with its own `If-Match`; a 412 keeps it as `recovered:<ts>` and the host shows "We kept a copy of your unsaved edits" with Restore (loads those bytes) / Discard.
- Acceptance: kill the app mid-typing offline → reopen online → the edit is on the server.

### Task 29: wasm via `require()` (EAS-Update-safe)
- Add `"wasm"` to `config.resolver.assetExts` in `metro.config.js`; `setHarfBuzzWasmUrl(require("@docx-editor.dev/core/harfbuzz.wasm"))` — verify the resolved value is a URL string in a DOM bundle (log it on first run); delete `public/harfbuzz.wasm`. Re-run `expo export` and confirm the wasm appears under `assets/` and the editor still reports HarfBuzz (no `wasmUnavailable`).

---

## Phase 5 — Cutover

### Task 30: Flip the default
- `settings-store.writerEngine` default → `"docx"`; the Developer toggle stays one release for rollback via OTA.

### Task 31: Delete Lexical
- Remove: `components/workspace/lexical/**`, `components/workspace/WorkspaceLexicalView.tsx`, `lib/lexical-writeback.ts`, `lib/page-layout.ts`, `lib/section-chrome.ts` (if only the chrome bands used it — grep first), `app/(app)/lexical-lab.tsx`, `lexical-roundtrip.tsx`, `lexical-writeback.tsx`, their `Stack.Screen` lines and Settings rows, the `@lexical/*` and `lexical` dependencies, `stores/workspace-store.showPages/showChrome` (engine pages are always on). Keep `lib/word-diff.ts`, `lib/table-diff.ts`, `lib/thesis-ops.ts` (server paths still use ops for structural edits).
- Gate: `npx tsc --noEmit`, `node scripts/verify-use-dom.mjs`, `expo export`, and `grep -rn "lexical" app components lib stores hooks --include=*.ts --include=*.tsx` → only `lexical-editor-store` (renamed in Task 32).

### Task 32: Rename the bridge store
- `stores/lexical-editor-store.ts` → `stores/editor-bridge-store.ts` (`useEditorBridgeStore`), `LexicalCommand`→`EditorCommandEnvelope`, `LexicalState`→`EditorSelectionState`, `lexActive`→`editorActive` in `ToolbarCtx`. Mechanical; one commit; tsc is the gate.

### Task 33: Docs and memory
- Update `CLAUDE.md` "The document model" (editing is whole-bytes with `If-Match`; ops remain for structural server paths), mark the page-view spec superseded (header line), tick the feature map in the migration spec, and write the memory notes the next session needs (`docx-editor-migration`, the `expo export`-rewrites-`app.json` trap).

---

## Self-review (run after writing, fixed inline)

- **Spec coverage:** every feature-map row has a task above (Phase 1: rows 1–8; Phase 2: 9–12; Phase 3: 13–19; Phase 4: 20–25; dropped rows: D11). `flushEdits` (Task 10), `docHash` reload (Tasks 3, 8, 10), `If-Match` (Tasks 2, 8).
- **Placeholder scan:** no "TBD/TODO/similar to"; Phases 2–5 are intentionally task-granular (see "Phases and exit criteria") and each names its files, interfaces and acceptance.
- **Type consistency:** `LexicalCommand`/`LexicalState`/`SuggestionInput` come from `components/workspace/lexical/editor-components/types.ts` until Task 32 renames them; `blockIndexFromId` (Task 5) is the only id parser; `reloadFromServer` (Task 8) and `applyText` (Task 14) are the two hooks registered on `lexical-editor-store` (Task 7 adds `reload`, Task 14 adds `applyText`).
