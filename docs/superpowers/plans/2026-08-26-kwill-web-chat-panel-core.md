# Kwill Web Chat Panel — Core (Plan 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student can send a message from the workspace page's new chat panel, watch the reply stream in (with a collapsible reasoning trace), see the thread retitle itself live, click a `modk://b/N` link to jump to the block the AI is talking about, watch the document refresh after an edit, and switch between past conversations for the thesis.

**Architecture:** The workspace page stays a Server Component and gains two more server-side reads (the active thread, its first page of messages). A new Client Component, `ChatPanel`, is the first interactive boundary in the `/app` route tree — it streams replies directly from the browser to `modakerati-server` (bypassing Next.js entirely for that one call), parses the bracket control-frame protocol with a small hand-written incremental parser, and triggers `router.refresh()` to pick up document edits without losing its own state.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `react-markdown` + `remark-gfm` (new), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-kwill-web-chat-panel-design.md`

**Explicitly NOT done here** (per the spec's Plan 2a/2b split and deferred list):
- `MODK_ASK` / `MODK_CONFIRM` (Plan 2b) — both are safely stripped from the stream by this plan's parser, same as `MODK_TOOL`.
- Loading older messages beyond the initial page of 5 (no infinite scroll in the chat history — a small, explicitly deferred convenience, not a correctness gap).
- Chat attachments, chat search, a Stop-mid-generation button, `/continue-turn`.
- `error.tsx` anywhere — a stream failure gets an inline retry affordance instead (see Task 14), matching the Foundation's already-accepted gap.

---

## Read this before Task 1

**Gate for every task:**
```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```
Run it after every file you touch. `npm test` after each TDD task (1-3) and again at the very end (Task 16).

**The server contract this plan codes against (confirmed from `~/modakerati-server` source, not guessed):**
- `POST /api/chat/stream` body: `{ message: string, threadId: string }` is the complete minimum — no `thesisId`, `mode`, or `tzOffsetMinutes` needed alongside an existing `threadId`. Response is `text/plain` chunked (not SSE, not JSON) on success; on failure it's plain JSON: `402 { error, code: "quota_exhausted", ... }` or `409 { error, code: "continue_instead", ... }` — **both must be checked via `response.ok`/`response.status` before ever calling `response.body.getReader()`**, or the code will try to stream-parse a JSON error body.
- Every stream chunk has passed through the server's `streamSafe()`, which rewrites any UTF-16 surrogate half (i.e. every emoji/astral character) into the **literal 6-character text** `\uXXXX` before sending. This must be reversed for plain text to render correctly — see Task 1. JSON payload frames (`MODK_DOCCHANGES`, `MODK_TITLE`) don't need special handling for this: `\uXXXX` is valid JSON string-escape syntax, so `JSON.parse` reconstructs the emoji correctly on its own either way.
- Control frames: `[[MODK_THINK]]...[[/MODK_THINK]]` carries plain text (raw reasoning tokens). `[[MODK_DOCCHANGES]]...[[/MODK_DOCCHANGES]]` carries JSON: `{kind:"docChanges", turnId, checkpointSeq, tools}`. `[[MODK_TITLE]]...[[/MODK_TITLE]]` carries JSON: `{threadId, title}` — **not** a bare title string. `MODK_ASK`/`MODK_CONFIRM`/`MODK_TOOL` (and anything else `[[MODK_X]]`-shaped this plan doesn't name) get silently stripped — no event, never shown as raw brackets.
- `POST /api/threads/for-thesis` body `{thesisId}` → returns the `ThreadRow` **only**, never its messages — a separate `GET /api/threads/:id/messages` call is required.
- `GET /api/threads/:id/messages?limit=5` (no `before`) returns the **5 most recent** messages, already in ascending (oldest-first) order — exactly the shape needed for an initial page. A message row is `{id, threadId, thesisId, role, content, searchText, createdAt}` (camelCase, `content` not `text`, `createdAt` not `created_at` — a bare Drizzle result, no transform).
- `GET /api/threads?thesisId=<uuid>` returns every (non-archived by default) thread for that thesis, an array of `ThreadRow`, sorted pinned-first then by `lastMessageAt ?? createdAt` descending. `ThreadRow`: `{id, userId, thesisId, title, pinned, mode, archivedAt, lastMessageAt, createdAt, updatedAt, attachedAt}` — sort/display by **`lastMessageAt`**, not `updatedAt`.
- A user message's persisted `content` can carry a trailing `[[MODK_IMG]]{...}[[/MODK_IMG]]` or `[[MODK_FILE]]{...}[[/MODK_FILE]]` frame (from an attachment sent by the mobile app, which this plan doesn't build a sender for, but must not display raw JSON for if a thread already has one from history) — Task 4 strips both before display.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/features/chat/lib/unescape-stream.ts` | Reverses `streamSafe()`'s surrogate-escaping |
| `src/features/chat/lib/unescape-stream.test.ts` | Its tests |
| `src/features/chat/lib/control-frames.ts` | Incremental bracket-frame parser (buffers across chunks) |
| `src/features/chat/lib/control-frames.test.ts` | Its tests |
| `src/features/chat/lib/strip-persisted-frames.ts` | Strips `MODK_IMG`/`MODK_FILE` from historical message content |
| `src/features/chat/lib/strip-persisted-frames.test.ts` | Its tests |
| `src/features/chat/lib/consume-chat-stream.ts` | Reads a `Response`, drives parser + unescaper, calls handlers |
| `src/features/chat/types.ts` | `ChatMessage`, `ThreadSummary` mirrored from the server |
| `src/lib/api/student-browser.ts` | Client-safe token read + `postChatStream` |
| `src/features/chat/components/MessageBubble.tsx` | One message: markdown + `modk://` link handling |
| `src/features/chat/components/MessageList.tsx` | Scrollable message list |
| `src/features/chat/components/Composer.tsx` | Text input + send button |
| `src/features/chat/components/ThreadHistory.tsx` | Collapsed strip + expandable thread list |
| `src/features/chat/components/ChatPanel.tsx` | Orchestrator: owns all chat state |
| `src/features/chat/index.ts` | Barrel |
| `src/features/chat/locales/{en,fr,ar}.json` | Chat strings |

**Modified**

| Path | Change |
|---|---|
| `package.json` | Add `react-markdown`, `remark-gfm` |
| `src/lib/api/student.ts` | Add `getOrCreateThread`, `getThreadMessages`, `listThreadsForThesis` |
| `src/i18n/messages.ts` | Register the chat locale bundle |
| `src/app/app/(workspace)/[thesisId]/page.tsx` | Two-column layout; fetch thread + messages server-side |

---

### Task 1: Reverse the stream's surrogate escaping (TDD)

**Files:**
- Create: `src/features/chat/lib/unescape-stream.ts`
- Test: `src/features/chat/lib/unescape-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/chat/lib/unescape-stream.test.ts
import { describe, it, expect } from "vitest";
import { unescapeStreamedSurrogates } from "./unescape-stream";

describe("unescapeStreamedSurrogates", () => {
  it("leaves plain ASCII text unchanged", () => {
    expect(unescapeStreamedSurrogates("hello world")).toBe("hello world");
  });

  it("restores an emoji encoded as a literal surrogate-pair escape", () => {
    // 😀 is U+1F600, UTF-16 surrogate pair 😀 — the server's
    // streamSafe() rewrites each half to the literal 6-character text.
    expect(unescapeStreamedSurrogates("hi \\ud83d\\ude00 there")).toBe("hi 😀 there");
  });

  it("restores multiple escaped emoji in one string", () => {
    expect(unescapeStreamedSurrogates("\\ud83d\\ude00\\ud83d\\ude01")).toBe("😀😁");
  });

  it("leaves Arabic and other non-surrogate Unicode text untouched", () => {
    expect(unescapeStreamedSurrogates("مرحبا")).toBe("مرحبا");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/unescape-stream.test.ts
```

Expected: FAIL — `Cannot find module './unescape-stream'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/chat/lib/unescape-stream.ts

// The server's streamSafe() (modakerati-server/src/routes/chat.ts) rewrites
// every UTF-16 surrogate half in the stream into the literal 6-character text
// "\uXXXX", so an emoji survives the route's ASCII-safety pass as two escaped
// halves rather than the character itself. Reversing it is a straight
// character-code substitution: each matched \uXXXX becomes the code unit it
// names, and JS string concatenation naturally re-pairs two adjacent restored
// surrogate halves back into the original character.
//
// This is necessarily lossy in one direction: if a reply's plain prose ever
// contained a literal backslash-u-hex sequence as actual text (extremely
// unlikely, e.g. explaining regex syntax), it would be restored as a
// character too. The mobile app consumes the identical stream and accepts the
// same tradeoff.
export function unescapeStreamedSurrogates(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/unescape-stream.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/lib/unescape-stream.ts src/features/chat/lib/unescape-stream.test.ts
git commit -m "feat(chat): reverse the stream's surrogate-pair escaping"
```

---

### Task 2: Strip persisted attachment frames from historical messages (TDD)

**Files:**
- Create: `src/features/chat/lib/strip-persisted-frames.ts`
- Test: `src/features/chat/lib/strip-persisted-frames.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/chat/lib/strip-persisted-frames.test.ts
import { describe, it, expect } from "vitest";
import { stripPersistedFrames } from "./strip-persisted-frames";

describe("stripPersistedFrames", () => {
  it("returns plain text unchanged", () => {
    expect(stripPersistedFrames("just a normal message")).toBe("just a normal message");
  });

  it("strips a trailing MODK_IMG frame from a user message with an attachment", () => {
    const raw = 'look at this\n[[MODK_IMG]]{"url":"https://example.com/x.png"}[[/MODK_IMG]]';
    expect(stripPersistedFrames(raw)).toBe("look at this");
  });

  it("strips a trailing MODK_FILE frame", () => {
    const raw = 'here is the export\n[[MODK_FILE]]{"url":"https://example.com/x.docx","filename":"thesis.docx"}[[/MODK_FILE]]';
    expect(stripPersistedFrames(raw)).toBe("here is the export");
  });

  it("strips both frames when both are present", () => {
    const raw = 'two attachments\n[[MODK_IMG]]{"url":"a"}[[/MODK_IMG]]\n[[MODK_FILE]]{"url":"b"}[[/MODK_FILE]]';
    expect(stripPersistedFrames(raw)).toBe("two attachments");
  });

  it("trims trailing whitespace left behind after stripping", () => {
    const raw = "message\n\n[[MODK_IMG]]{}[[/MODK_IMG]]   ";
    expect(stripPersistedFrames(raw)).toBe("message");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/strip-persisted-frames.test.ts
```

Expected: FAIL — `Cannot find module './strip-persisted-frames'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/chat/lib/strip-persisted-frames.ts

// A message's persisted `content` (from GET /api/threads/:id/messages) can
// carry a MODK_IMG or MODK_FILE frame appended by the mobile app's attachment
// flow (modakerati-server/src/lib/ai/image-frames.ts, tool-loop.ts) — the two
// frame kinds the server keeps in persisted content rather than stripping,
// per control-frames.ts's stripControlFrames. This plan doesn't render
// attachments, but a thread with mobile-app history must not show the raw
// JSON payload as literal chat text either.
export function stripPersistedFrames(content: string): string {
  return content
    .replace(/\[\[MODK_IMG\]\][\s\S]*?\[\[\/MODK_IMG\]\]/g, "")
    .replace(/\[\[MODK_FILE\]\][\s\S]*?\[\[\/MODK_FILE\]\]/g, "")
    .trim();
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/strip-persisted-frames.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/lib/strip-persisted-frames.ts src/features/chat/lib/strip-persisted-frames.test.ts
git commit -m "feat(chat): strip persisted attachment frames before display"
```

---

### Task 3: The incremental control-frame parser (TDD)

This is the most intricate piece in the plan: frames can be split across arbitrary chunk boundaries (a `push()` call is one `reader.read()` result, not one frame), so the parser must buffer.

**Files:**
- Create: `src/features/chat/lib/control-frames.ts`
- Test: `src/features/chat/lib/control-frames.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/chat/lib/control-frames.test.ts
import { describe, it, expect } from "vitest";
import { ControlFrameParser } from "./control-frames";

describe("ControlFrameParser", () => {
  it("passes plain text through as text events", () => {
    const p = new ControlFrameParser();
    expect(p.push("hello world")).toEqual([{ type: "text", text: "hello world" }]);
    expect(p.flush()).toEqual([]);
  });

  it("extracts a MODK_THINK frame as a think event", () => {
    const p = new ControlFrameParser();
    const events = p.push("before[[MODK_THINK]]reasoning here[[/MODK_THINK]]after");
    expect(events).toEqual([
      { type: "text", text: "before" },
      { type: "think", text: "reasoning here" },
      { type: "text", text: "after" },
    ]);
  });

  it("parses a MODK_DOCCHANGES frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = { kind: "docChanges", turnId: "t1", checkpointSeq: 3, tools: ["edit_paragraph"] };
    const events = p.push(`[[MODK_DOCCHANGES]]${JSON.stringify(payload)}[[/MODK_DOCCHANGES]]`);
    expect(events).toEqual([{ type: "docChanges", payload }]);
  });

  it("parses a MODK_TITLE frame's JSON payload (not a bare title string)", () => {
    const p = new ControlFrameParser();
    const payload = { threadId: "abc-123", title: "Chapter 1 revisions" };
    const events = p.push(`[[MODK_TITLE]]${JSON.stringify(payload)}[[/MODK_TITLE]]`);
    expect(events).toEqual([{ type: "title", payload }]);
  });

  it("silently strips MODK_ASK, MODK_CONFIRM, and MODK_TOOL with no event", () => {
    const p = new ControlFrameParser();
    const events = p.push(
      "a[[MODK_ASK]]{\"question\":\"q\"}[[/MODK_ASK]]b[[MODK_CONFIRM]]{}[[/MODK_CONFIRM]]c[[MODK_TOOL]]x[[/MODK_TOOL]]d",
    );
    expect(events).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
      { type: "text", text: "d" },
    ]);
  });

  it("strips a frame kind it has never heard of, the same safe way", () => {
    const p = new ControlFrameParser();
    const events = p.push("x[[MODK_SOMETHING_FUTURE]]payload[[/MODK_SOMETHING_FUTURE]]y");
    expect(events).toEqual([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]);
  });

  it("drops a DOCCHANGES frame with malformed JSON instead of throwing", () => {
    const p = new ControlFrameParser();
    expect(() => p.push("[[MODK_DOCCHANGES]]not json[[/MODK_DOCCHANGES]]")).not.toThrow();
    expect(p.push("[[MODK_DOCCHANGES]]not json[[/MODK_DOCCHANGES]]")).toEqual([]);
  });

  it("reassembles a frame whose marker is split across two chunks", () => {
    const p = new ControlFrameParser();
    const first = p.push("hello [[MODK_TH");
    const second = p.push("INK]]reasoning[[/MODK_THINK]] world");
    expect([...first, ...second]).toEqual([
      { type: "text", text: "hello " },
      { type: "think", text: "reasoning" },
      { type: "text", text: " world" },
    ]);
  });

  it("reassembles a frame whose CONTENT is split across two chunks", () => {
    const p = new ControlFrameParser();
    const first = p.push("[[MODK_THINK]]partial rea");
    const second = p.push("soning[[/MODK_THINK]]");
    expect([...first, ...second]).toEqual([{ type: "think", text: "partial reasoning" }]);
  });

  it("unescapes surrogate pairs inside plain text events", () => {
    const p = new ControlFrameParser();
    expect(p.push("hi \\ud83d\\ude00")).toEqual([{ type: "text", text: "hi 😀" }]);
  });

  it("flush() emits any trailing plain text held back for marker safety", () => {
    const p = new ControlFrameParser();
    p.push("trailing");
    expect(p.flush()).toEqual([{ type: "text", text: "trailing" }]);
  });

  it("flush() emits nothing if the buffer ends mid-frame (a truncated stream)", () => {
    const p = new ControlFrameParser();
    p.push("text[[MODK_THINK]]unterminated");
    expect(p.flush()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/control-frames.test.ts
```

Expected: FAIL — `Cannot find module './control-frames'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/chat/lib/control-frames.ts
import { unescapeStreamedSurrogates } from "./unescape-stream";

export interface DocChangesPayload {
  kind: "docChanges";
  turnId: string;
  checkpointSeq: number;
  tools: string[];
}

export interface TitlePayload {
  threadId: string;
  title: string;
}

export type ControlFrameEvent =
  | { type: "text"; text: string }
  | { type: "think"; text: string }
  | { type: "docChanges"; payload: DocChangesPayload }
  | { type: "title"; payload: TitlePayload };

// Longest fixed marker text this parser ever needs to hold back at the end of
// an as-yet-unresolved buffer: "[[MODK_" is 7 characters, and a surrogate
// escape "\uXXXX" is 6 — holding back 6 trailing characters whenever no
// marker is found is enough to never split either one across an emitted
// "text" event and the next push().
const HOLD_BACK = 6;

const RECOGNIZED = new Set(["THINK", "DOCCHANGES", "TITLE"]);

/**
 * Incrementally parses the modakerati-server chat stream's bracket control-
 * frame protocol (`[[MODK_X]]...[[/MODK_X]]`) out of arbitrary-length text
 * chunks, buffering across chunk boundaries so a frame split mid-marker or
 * mid-content is reassembled correctly. Plain text (including text inside a
 * MODK_THINK frame) is unescaped via unescapeStreamedSurrogates before being
 * emitted; JSON-payload frames don't need that step separately, since
 * JSON.parse already resolves the same \uXXXX syntax on its own.
 *
 * Unrecognized frame kinds (MODK_ASK, MODK_CONFIRM, MODK_TOOL, and anything
 * this parser doesn't name) are stripped with no event — the safe default,
 * matching how the mobile client already treats an unknown frame.
 */
export class ControlFrameParser {
  private buffer = "";

  push(chunk: string): ControlFrameEvent[] {
    this.buffer += chunk;
    const events: ControlFrameEvent[] = [];

    for (;;) {
      const openIdx = this.buffer.indexOf("[[MODK_");
      if (openIdx === -1) {
        const safeLen = Math.max(0, this.buffer.length - HOLD_BACK);
        if (safeLen > 0) {
          events.push({ type: "text", text: unescapeStreamedSurrogates(this.buffer.slice(0, safeLen)) });
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }

      if (openIdx > 0) {
        events.push({ type: "text", text: unescapeStreamedSurrogates(this.buffer.slice(0, openIdx)) });
        this.buffer = this.buffer.slice(openIdx);
      }

      const openTagEnd = this.buffer.indexOf("]]");
      if (openTagEnd === -1) break; // Incomplete open tag — wait for more data.

      const frameName = this.buffer.slice(2, openTagEnd); // e.g. "MODK_THINK"
      const closeTag = `[[/${frameName}]]`;
      const contentStart = openTagEnd + 2;
      const closeIdx = this.buffer.indexOf(closeTag, contentStart);
      if (closeIdx === -1) break; // Incomplete frame — wait for more data.

      const rawContent = this.buffer.slice(contentStart, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);

      const kind = frameName.slice("MODK_".length);
      if (kind === "THINK") {
        events.push({ type: "think", text: unescapeStreamedSurrogates(rawContent) });
      } else if (RECOGNIZED.has(kind)) {
        try {
          const payload = JSON.parse(rawContent);
          events.push(
            kind === "DOCCHANGES"
              ? { type: "docChanges", payload }
              : { type: "title", payload },
          );
        } catch {
          // Malformed JSON from a frame this parser expected to be JSON —
          // drop it silently rather than throw and blank the panel.
        }
      }
      // Anything not in RECOGNIZED (MODK_ASK, MODK_CONFIRM, MODK_TOOL, or a
      // future frame kind) is stripped here with no event.
    }

    return events;
  }

  /** Call once the stream ends. Flushes trailing plain text; a buffer left
   *  mid-frame (a truncated/failed stream) is discarded, not shown broken. */
  flush(): ControlFrameEvent[] {
    const remaining = this.buffer;
    this.buffer = "";
    if (!remaining || remaining.includes("[[MODK_")) return [];
    return [{ type: "text", text: unescapeStreamedSurrogates(remaining) }];
  }
}
```

- [ ] **Step 4: Run the tests again and confirm they pass**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/control-frames.test.ts
```

Expected: PASS, 12/12.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/lib/control-frames.ts src/features/chat/lib/control-frames.test.ts
git commit -m "feat(chat): incremental control-frame parser for the stream protocol"
```

---

### Task 4: Chat types

**Files:**
- Create: `src/features/chat/types.ts`

- [ ] **Step 1: Write the types**

Mirrors the server's `chatMessages`/`chatThreads` row shapes exactly (`modakerati-server/src/db/schema.ts:175-230`), confirmed via the actual route responses — both are bare Drizzle results with no transform.

```typescript
// src/features/chat/types.ts

// Mirrors modakerati-server's chatMessages/chatThreads tables
// (src/db/schema.ts:175-230) — both routes return bare Drizzle rows with no
// transform, so these are exactly the wire shapes. Keep in sync by hand.

export interface ChatMessage {
  id: string;
  threadId: string | null;
  role: string; // always "user" | "assistant" in practice, stored as plain text server-side
  content: string;
  createdAt: string | null;
}

export interface ThreadSummary {
  id: string;
  userId: string;
  thesisId: string | null;
  title: string | null;
  pinned: boolean;
  mode: string;
  archivedAt: string | null;
  /** The field to sort/display "last activity" by — NOT updatedAt, which also
   *  bumps on mode/title changes unrelated to conversation activity. */
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  attachedAt: string | null;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/types.ts
git commit -m "feat(chat): ChatMessage/ThreadSummary types mirrored from modakerati-server"
```

---

### Task 5: Client-safe browser API helper (chat streaming + thread history)

**Files:**
- Create: `src/lib/api/student-browser.ts`

- [ ] **Step 1: Write the helper**

```typescript
// src/lib/api/student-browser.ts

// Client-safe counterpart to lib/api/student.ts. That file is "server-only"
// and reads the session via cookies(); this one reads it via the BROWSER
// Supabase client, because streaming a chat reply needs a live ReadableStream
// response body, which a Next.js Server Action cannot hand back incrementally
// — see the chat panel spec's Architecture section. Must only ever be
// imported from a Client Component.
import { createClient } from "@/lib/supabase/client";

// Public var, deliberately: this runs in the browser, unlike student.ts's
// private MODAKERATI_SERVER_URL — see ImageBlock.tsx for the same distinction.
const BASE = process.env.NEXT_PUBLIC_MODAKERATI_SERVER_URL ?? "http://localhost:3000";

export class ChatStreamError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "ChatStreamError";
    this.status = status;
    this.code = code;
  }
}

export async function getBrowserAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * POSTs to /api/chat/stream and returns the raw Response — the caller must
 * check `response.ok` before reading `response.body` as a stream, since a
 * failure (402 quota_exhausted, 409 continue_instead, etc.) comes back as
 * plain JSON, not a stream.
 */
export async function postChatStream(body: { message: string; threadId: string }): Promise<Response> {
  const token = await getBrowserAccessToken();
  if (!token) throw new ChatStreamError(401, "not_signed_in", "Not signed in");

  return fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** Parses a non-ok /api/chat/stream response into a ChatStreamError. */
export async function parseChatStreamError(response: Response): Promise<ChatStreamError> {
  const body = await response.json().catch(() => null);
  return new ChatStreamError(
    response.status,
    body?.code,
    body?.error ?? `modakerati-server /api/chat/stream -> ${response.status}`,
  );
}

async function browserFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getBrowserAccessToken();
  if (!token) throw new ChatStreamError(401, "not_signed_in", "Not signed in");

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await parseGenericBrowserError(res, path);
  return (await res.json()) as T;
}

async function parseGenericBrowserError(response: Response, path: string): Promise<ChatStreamError> {
  const body = await response.json().catch(() => null);
  return new ChatStreamError(
    response.status,
    body?.code,
    body?.error ?? `modakerati-server ${path} -> ${response.status}`,
  );
}

/**
 * The three thread operations ChatPanel's history UI needs from the browser
 * (switching threads, expanding the history list, starting a new one).
 * Deliberately separate from lib/api/student.ts's server-side equivalents —
 * that file is "server-only" and reads the session via cookies(), which a
 * Client Component cannot do.
 */
export async function listThreadsForThesisBrowser(thesisId: string): Promise<ThreadSummary[]> {
  return browserFetch<ThreadSummary[]>(`/api/threads?thesisId=${encodeURIComponent(thesisId)}`);
}

export async function getThreadMessagesBrowser(threadId: string, limit = 5): Promise<ChatMessage[]> {
  return browserFetch<ChatMessage[]>(`/api/threads/${threadId}/messages?limit=${limit}`);
}

/** POST /api/threads body {thesisId} — ALWAYS creates a new thread, unlike
 *  the server-side getOrCreateThread's /for-thesis (which reuses the most
 *  recently active one). This is what "+ New conversation" calls. */
export async function createThreadBrowser(thesisId: string): Promise<ThreadSummary> {
  return browserFetch<ThreadSummary>("/api/threads", {
    method: "POST",
    body: JSON.stringify({ thesisId }),
  });
}
```

Add these two imports at the top of the file, alongside the existing `createClient` import:

```typescript
import type { ChatMessage, ThreadSummary } from "@/features/chat/types";
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/student-browser.ts
git commit -m "feat(chat): browser-side chat-stream and thread-history client"
```

---

### Task 6: Extend the server-only student API client for threads

**Files:**
- Modify: `src/lib/api/student.ts`

- [ ] **Step 1: Add the three thread functions**

Add this import alongside the existing `DocumentDTO` import at the top of the file:

```typescript
import type { ChatMessage, ThreadSummary } from "@/features/chat/types";
```

Add these three functions at the end of the file (after `getThesisDocument`):

```typescript
/** POST /api/threads/for-thesis — gets or creates the active thread for a
 *  thesis. Returns the ThreadRow only; call getThreadMessages separately. */
export async function getOrCreateThread(thesisId: string): Promise<ThreadSummary> {
  return studentFetch<ThreadSummary>("/api/threads/for-thesis", {
    method: "POST",
    body: JSON.stringify({ thesisId }),
  });
}

/** GET /api/threads/:id/messages?limit=N — the N most recent messages,
 *  already in ascending (oldest-first) order. No `before` support here:
 *  loading older history is out of scope for this plan. */
export async function getThreadMessages(threadId: string, limit = 5): Promise<ChatMessage[]> {
  return studentFetch<ChatMessage[]>(`/api/threads/${threadId}/messages?limit=${limit}`);
}

/** GET /api/threads?thesisId=X — every thread for this thesis, pinned-first
 *  then by lastMessageAt descending (the server's own sort). */
export async function listThreadsForThesis(thesisId: string): Promise<ThreadSummary[]> {
  return studentFetch<ThreadSummary[]>(`/api/threads?thesisId=${encodeURIComponent(thesisId)}`);
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/student.ts
git commit -m "feat(chat): server-side thread fetchers on the student API client"
```

---

### Task 7: The shared stream consumer

**Files:**
- Create: `src/features/chat/lib/consume-chat-stream.ts`

- [ ] **Step 1: Write the consumer**

This is the function Plan 2b will also call, against `/confirm-action`/`/cancel-action` responses — those return the identical stream shape, so nothing here is `/stream`-specific except its caller.

```typescript
// src/features/chat/lib/consume-chat-stream.ts
import { ControlFrameParser, type DocChangesPayload, type TitlePayload } from "./control-frames";

export interface ChatStreamHandlers {
  onText: (text: string) => void;
  onThink?: (text: string) => void;
  onDocChanges?: (payload: DocChangesPayload) => void;
  onTitle?: (payload: TitlePayload) => void;
}

/**
 * Reads a modakerati-server chat-stream Response body to completion, driving
 * `handlers` as text and control frames are parsed out of it. Shared by every
 * endpoint that returns this stream shape (POST /stream today; Plan 2b's
 * /confirm-action and /cancel-action reuse this unchanged).
 *
 * Caller's responsibility, not this function's: checking `response.ok`
 * before calling this (a non-ok response is plain JSON, not a stream).
 */
export async function consumeChatStream(response: Response, handlers: ChatStreamHandlers): Promise<void> {
  if (!response.body) throw new Error("Response has no body to stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new ControlFrameParser();

  const apply = (events: ReturnType<ControlFrameParser["push"]>) => {
    for (const event of events) {
      if (event.type === "text") handlers.onText(event.text);
      else if (event.type === "think") handlers.onThink?.(event.text);
      else if (event.type === "docChanges") handlers.onDocChanges?.(event.payload);
      else if (event.type === "title") handlers.onTitle?.(event.payload);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    apply(parser.push(decoder.decode(value, { stream: true })));
  }
  apply(parser.flush());
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/lib/consume-chat-stream.ts
git commit -m "feat(chat): shared stream consumer, reused by Plan 2b's confirm/cancel actions"
```

---

### Task 8: Add react-markdown and remark-gfm

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependencies**

```bash
cd ~/modakerati-dashboard && npm install react-markdown@^10.1.0 remark-gfm@^4.0.1
```

Both are confirmed compatible with this project's React 19 (`react-markdown@10`'s peer dependency is `react: >=18`).

- [ ] **Step 2: Verify the install and a clean build**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npm run build
```

Expected: both PASS. The build is the real gate here — confirms the new dependency's types resolve and it doesn't break webpack.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(chat): add react-markdown + remark-gfm"
```

---

### Task 9: `MessageBubble` — markdown rendering + block-link scrolling

**Files:**
- Create: `src/features/chat/components/MessageBubble.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/features/chat/components/MessageBubble.tsx
"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { detectDir } from "@/features/workspace/lib/direction";

const MODK_LINK_RE = /^modk:\/\/b\/(\d+)(?:-\d+)?$/;

function scrollToBlock(index: number): void {
  document.getElementById(`block-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// modk://b/N (and the first index of a modk://b/N-M range) scrolls the
// document panel to that block — every block component the Foundation built
// already carries id="block-{index}" for exactly this. Every other link opens
// normally in a new tab, since a chat reply's ordinary https:// links (e.g. a
// citation source) are real external references, not in-app navigation.
const components: Components = {
  a({ href, children }) {
    const match = href ? MODK_LINK_RE.exec(href) : null;
    if (match) {
      const index = Number(match[1]);
      return (
        <a
          href={`#block-${index}`}
          onClick={(e) => {
            e.preventDefault();
            scrollToBlock(index);
          }}
          className="text-primary hover:underline cursor-pointer"
        >
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        {children}
      </a>
    );
  },
};

export function MessageBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const dir = detectDir(content);
  const isUser = role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
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
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/components/MessageBubble.tsx
git commit -m "feat(chat): message bubble — markdown rendering + modk:// block-link scrolling"
```

---

### Task 10: `MessageList`

**Files:**
- Create: `src/features/chat/components/MessageList.tsx`

- [ ] **Step 1: Write the component**

Auto-scrolls to the newest message whenever the list grows (a new message arrives, or a streaming reply's text updates in place — that's still the same last item, but its content growing should keep it in view).

```tsx
// src/features/chat/components/MessageList.tsx
"use client";

import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../types";

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {messages.map((message) => (
        <MessageBubble key={message.id} role={message.role === "user" ? "user" : "assistant"} content={message.content} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/components/MessageList.tsx
git commit -m "feat(chat): scrollable message list, auto-scrolls to newest"
```

---

### Task 11: `Composer`

**Files:**
- Create: `src/features/chat/components/Composer.tsx`

- [ ] **Step 1: Write the component**

Reuses the existing `fInput`/`Button` primitives (`src/components/ui`), matching every other form in this app. Submits on Enter (without Shift) as well as via the button, since a chat composer that requires clicking Send is a worse experience than every other chat product a student has used.

```tsx
// src/features/chat/components/Composer.tsx
"use client";

import { useState, type KeyboardEvent } from "react";
import { Button, fInput } from "@/components/ui";

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder: string;
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
    <div className="flex items-end gap-2 border-t border-border p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className={`${fInput} resize-none`}
      />
      <Button type="button" onClick={submit} disabled={disabled || !value.trim()}>
        {"→"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/components/Composer.tsx
git commit -m "feat(chat): message composer, Enter-to-send"
```

---

### Task 12: `ThreadHistory`

**Files:**
- Create: `src/features/chat/components/ThreadHistory.tsx`

- [ ] **Step 1: Write the component**

Collapsed by default, showing only the active thread's title with a chevron. Expanding lazily calls `onExpand` (the parent fetches the list only then, per the design's "not on initial page load" decision).

This component is purely presentational — it takes its translatable strings as props rather than calling `useTranslations` itself, so `ChatPanel` (the one caller) is the single place that owns the `chat` i18n namespace.

```tsx
// src/features/chat/components/ThreadHistory.tsx
"use client";

import { useState } from "react";
import { Icon } from "@/components/ui";
import type { ThreadSummary } from "../types";

export function ThreadHistory({
  activeTitle,
  threads,
  onExpand,
  onSelect,
  onNewThread,
  activeThreadId,
  newConversationLabel,
  loadingLabel,
  untitledLabel,
}: {
  activeTitle: string;
  threads: ThreadSummary[] | null;
  onExpand: () => void;
  onSelect: (threadId: string) => void;
  onNewThread: () => void;
  activeThreadId: string;
  newConversationLabel: string;
  loadingLabel: string;
  untitledLabel: string;
}) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && threads === null) onExpand();
  };

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text hover:bg-card-hover"
      >
        <span className="truncate">{activeTitle}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-border">
          <button
            type="button"
            onClick={onNewThread}
            className="w-full text-left px-4 py-2.5 text-sm text-primary hover:bg-card-hover"
          >
            + {newConversationLabel}
          </button>
          {threads === null ? (
            <div className="px-4 py-2.5 text-sm text-subtext">{loadingLabel}</div>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => onSelect(thread.id)}
                className={`w-full text-left px-4 py-2.5 text-sm truncate hover:bg-card-hover ${
                  thread.id === activeThreadId ? "text-primary font-medium" : "text-text"
                }`}
              >
                {thread.title || untitledLabel}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS. If `Icon` requires a specific icon-name union type rather than a bare `string`, check `src/components/ui/icon.tsx` and either use exact names it accepts (likely `"chevron-up"`/`"chevron-down"` already exist, since this is a `lucide-react`-backed icon set per the dashboard's dependencies) or adjust to whatever the actual prop type requires.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/components/ThreadHistory.tsx
git commit -m "feat(chat): collapsible thread history strip"
```

---

### Task 13: Chat i18n bundle

**Files:**
- Create: `src/features/chat/locales/en.json`
- Create: `src/features/chat/locales/fr.json`
- Create: `src/features/chat/locales/ar.json`
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: `src/features/chat/locales/en.json`**

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
    "retry": "Retry"
  }
}
```

- [ ] **Step 2: `src/features/chat/locales/fr.json`**

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
    "retry": "Réessayer"
  }
}
```

- [ ] **Step 3: `src/features/chat/locales/ar.json`**

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
    "retry": "إعادة المحاولة"
  }
}
```

- [ ] **Step 4: Register the bundle in `src/i18n/messages.ts`**

Read the file first — it's the same manually-maintained import list the Foundation plan already extended once (for `student-app`/`workspace`). Add three imports:

```typescript
import features_chat_en from "@/features/chat/locales/en.json";
import features_chat_fr from "@/features/chat/locales/fr.json";
import features_chat_ar from "@/features/chat/locales/ar.json";
```

Push each into its locale's array:

```typescript
const byLocale: Record<Locale, Record<string, unknown>[]> = {
  en: [shared_en, /* ...existing entries..., */ features_chat_en],
  fr: [shared_fr, /* ...existing entries..., */ features_chat_fr],
  ar: [shared_ar, /* ...existing entries..., */ features_chat_ar],
};
```

- [ ] **Step 5: Confirm every JSON file parses**

```bash
cd ~/modakerati-dashboard
for f in src/features/chat/locales/*.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f parses')"
done
```

Expected: 3 lines, each ending "parses".

- [ ] **Step 6: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/chat/locales src/i18n/messages.ts
git commit -m "i18n(chat): trilingual strings for the chat panel"
```

---

### Task 14: `ChatPanel` — the orchestrator

**Files:**
- Create: `src/features/chat/components/ChatPanel.tsx`
- Create: `src/features/chat/index.ts`

- [ ] **Step 1: Write `ChatPanel`**

Owns all interactive state. Batches streamed text into React state on a fixed interval (matching the mobile app's `FLUSH_MS = 90`) rather than on every parsed event, so a fast stream doesn't thrash re-renders.

```tsx
// src/features/chat/components/ChatPanel.tsx
"use client";

import { useCallback, useRef, useState } from "react";
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
} from "@/lib/api/student-browser";
import { consumeChatStream } from "../lib/consume-chat-stream";
import { stripPersistedFrames } from "../lib/strip-persisted-frames";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ThreadHistory } from "./ThreadHistory";
import type { ChatMessage, ThreadSummary } from "../types";

const FLUSH_MS = 90;

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
}: {
  thesisId: string;
  initialThread: ThreadSummary;
  initialMessages: ChatMessage[];
}) {
  const t = useTranslations("chat");
  const router = useRouter();

  const [thread, setThread] = useState(initialThread);
  const [messages, setMessages] = useState<ChatMessage[]>(stripAll(initialMessages));
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [switchingThread, setSwitchingThread] = useState(false);

  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendToLastAssistant = (assistantId: string, textToAdd: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + textToAdd } : m)),
    );
  };

  const startFlushLoop = (assistantId: string) => {
    flushTimerRef.current = setInterval(() => {
      if (!pendingTextRef.current) return;
      const text = pendingTextRef.current;
      pendingTextRef.current = "";
      appendToLastAssistant(assistantId, text);
    }, FLUSH_MS);
  };

  const stopFlushLoop = (assistantId: string) => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    flushTimerRef.current = null;
    if (pendingTextRef.current) {
      const text = pendingTextRef.current;
      pendingTextRef.current = "";
      appendToLastAssistant(assistantId, text);
    }
  };

  const send = useCallback(
    async (text: string) => {
      setSendError(null);
      const userMessage: ChatMessage = {
        id: localId(),
        threadId: thread.id,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      const assistantId = localId();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        threadId: thread.id,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setSending(true);
      setThinking(null);

      let docChanged = false;
      startFlushLoop(assistantId);

      try {
        const response = await postChatStream({ message: text, threadId: thread.id });

        if (!response.ok) {
          throw await parseChatStreamError(response);
        }

        await consumeChatStream(response, {
          onText: (delta) => {
            pendingTextRef.current += delta;
          },
          onThink: (delta) => {
            setThinking((prev) => (prev ?? "") + delta);
          },
          onDocChanges: () => {
            docChanged = true;
          },
          onTitle: (payload) => {
            setThread((prev) => (prev.id === payload.threadId ? { ...prev, title: payload.title } : prev));
          },
        });

        stopFlushLoop(assistantId);
        setThinking(null);
        if (docChanged) router.refresh();
      } catch (err) {
        stopFlushLoop(assistantId);
        setThinking(null);
        if (err instanceof ChatStreamError && err.code === "quota_exhausted") {
          setQuotaExhausted(true);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        } else {
          setSendError(t("sendFailed"));
        }
      } finally {
        setSending(false);
      }
    },
    [thread.id, router, t],
  );

  // Lazy: the thread list is only fetched the first time the history strip is
  // expanded, per the design — the common case (the one active thread) is
  // already in initialThread/initialMessages from the server.
  const expandHistory = useCallback(() => {
    if (threads !== null) return;
    listThreadsForThesisBrowser(thesisId)
      .then(setThreads)
      .catch(() => setThreads([])); // an empty list degrades to "no history yet", not a crash
  }, [thesisId, threads]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (sending || threadId === thread.id) return;
      const target = threads?.find((th) => th.id === threadId);
      if (!target) return;
      setSwitchingThread(true);
      getThreadMessagesBrowser(threadId)
        .then((msgs) => {
          setThread(target);
          setMessages(stripAll(msgs));
        })
        .catch(() => setSendError(t("sendFailed")))
        .finally(() => setSwitchingThread(false));
    },
    [sending, thread.id, threads, t],
  );

  const newThread = useCallback(() => {
    if (sending) return;
    setSwitchingThread(true);
    createThreadBrowser(thesisId)
      .then((created) => {
        setThread(created);
        setMessages([]);
        setThreads((prev) => (prev ? [created, ...prev] : prev));
      })
      .catch(() => setSendError(t("sendFailed")))
      .finally(() => setSwitchingThread(false));
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

      <MessageList messages={messages} />

      {switchingThread && (
        <div className="px-4 pb-2 text-xs text-subtext italic">{t("loadingThreads")}</div>
      )}

      {thinking && (
        <div className="px-4 pb-2 text-xs text-subtext italic">{t("thinking")}</div>
      )}

      {quotaExhausted && (
        <div className="mx-3 mb-2 px-3.5 py-2.5 bg-warning/10 border border-warning/20 rounded-[10px]">
          <p className="text-warning text-sm">{t("quotaExhausted")}</p>
        </div>
      )}

      {sendError && (
        <div className="mx-3 mb-2 flex items-center justify-between px-3.5 py-2.5 bg-danger/10 border border-danger/20 rounded-[10px]">
          <p className="text-danger text-sm">{sendError}</p>
          <Button type="button" onClick={() => setSendError(null)}>
            {t("retry")}
          </Button>
        </div>
      )}

      <Composer
        onSend={send}
        disabled={sending || quotaExhausted || switchingThread}
        placeholder={t("placeholder")}
      />
    </div>
  );
}
```

`selectThread`/`newThread` both refuse to act while `sending` is true (a `postChatStream` call in flight is bound to the `threadId` it captured at call time, so switching threads mid-stream can't corrupt anything — but a reply landing in a thread the student has since navigated away from would be confusing UI, so it's blocked outright rather than handled).

- [ ] **Step 2: Write the barrel**

```typescript
// src/features/chat/index.ts
export * from "./types";
export { ChatPanel } from "./components/ChatPanel";
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS. If `useTranslations` (client-side next-intl hook, as opposed to the Server Component `getTranslations`) isn't already used anywhere in this repo, confirm `NextIntlClientProvider` wraps the app in the root layout — check `src/app/layout.tsx`; if it's missing, this step's implementer must add it there (wrapping `{children}`) before this component can resolve translations client-side, and should report that as a necessary deviation rather than leaving a runtime crash.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ChatPanel.tsx src/features/chat/index.ts
git commit -m "feat(chat): ChatPanel orchestrator — streaming send, thinking trace, thread title"
```

---

### Task 15: Wire the chat panel into the workspace page

**Files:**
- Modify: `src/app/app/(workspace)/[thesisId]/page.tsx`

- [ ] **Step 1: Rewrite the page as a two-column layout**

```tsx
// src/app/app/(workspace)/[thesisId]/page.tsx
import { getTranslations } from "next-intl/server";
import { getThesisDocument, getAccessToken, getOrCreateThread, getThreadMessages } from "@/lib/api/student";
import { DocumentBlocks } from "@/features/workspace";
import { detectDir } from "@/features/workspace/lib/direction";
import { ChatPanel } from "@/features/chat";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ thesisId: string }>;
}) {
  const { thesisId } = await params;
  const t = await getTranslations("workspace");
  const doc = await getThesisDocument(thesisId);

  if (!doc.available) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center text-subtext">{t("notAvailable")}</div>
    );
  }

  const [accessToken, thread] = await Promise.all([getAccessToken(), getOrCreateThread(thesisId)]);
  const initialMessages = await getThreadMessages(thread.id);

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <header className="border-b border-border px-8 py-4">
          <h1 dir={detectDir(doc.title)} className="text-lg font-semibold text-text">
            {doc.title || t("untitled")}
          </h1>
        </header>
        <DocumentBlocks blocks={doc.blocks} thesisId={thesisId} accessToken={accessToken} />
      </div>
      <ChatPanel thesisId={thesisId} initialThread={thread} initialMessages={initialMessages} />
    </div>
  );
}
```

The chat column's `border-s` (from Task 14's `ChatPanel`, "start" side per CSS logical properties) and this page's plain `flex` row are what make the dock RTL-aware for free: in an `ar` session the ancestor `<html dir="rtl">` (set by the root layout from the resolved locale) flips which physical side "start" resolves to, so the chat column docks on the correct side without any manual left/right branching here.

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/app/(workspace)/[thesisId]/page.tsx"
git commit -m "feat(chat): wire the chat panel into the workspace page's two-column layout"
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

Expected: PASS, including all `control-frames`/`unescape-stream`/`strip-persisted-frames` tests.

- [ ] **Step 3: Production build**

```bash
cd ~/modakerati-dashboard && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke pass**

Run `npm run dev`, sign in as a student with an existing thesis, then walk through in order:

- [ ] Open a thesis — the chat panel appears docked beside the document, showing the thread's existing history (or empty if new)
- [ ] Send a message — it appears immediately, the composer disables, a streamed reply appears progressively
- [ ] If the AI's reasoning is visible for that turn, a "Thinking…" indicator appears and clears when the reply lands
- [ ] Ask the AI to make an edit to the document — after the reply completes, the document panel updates to reflect it (via the page refresh), and the chat panel's own message history is untouched by that refresh
- [ ] If the reply contains a `modk://b/N`-style reference, clicking it scrolls the document panel to that block
- [ ] Send enough messages to trigger the quota limit (or use a test account already near it) — confirm the banner appears and the composer disables, rather than the panel crashing
- [ ] Expand the thread-history strip — confirm it lists past threads for this thesis, lazily fetched (only once expanded)
- [ ] Repeat the whole pass once with an Arabic-language thesis — confirm the chat panel docks on the correct (start) side and message text renders RTL correctly, including a reply containing both Arabic and an embedded `modk://` link

- [ ] **Step 5: Record results**

Note any failures for follow-up rather than fixing inline — this plan's definition of done is the checklist above passing, not the code merely compiling.

## Definition of done

- `npx tsc --noEmit`, `npm test`, and `npm run build` all exit 0 in `~/modakerati-dashboard`.
- A student can send a message, watch it stream in, see the document update after an AI edit, click a block link to scroll to it, and switch between past threads for the thesis.
- The message-quota 402 shows a banner, not a crash.
- `/d` (the staff console) and everything the Foundation plan built are unaffected.

## Explicitly not done here

- `MODK_ASK` and `MODK_CONFIRM` (Plan 2b) — both are silently stripped by this plan's parser, exactly like `MODK_TOOL`.
- Loading older messages beyond the initial page of 5.
- Chat attachments, chat search, a Stop-mid-generation button, `/continue-turn`.
- `error.tsx` anywhere in the route tree (same accepted gap as the Foundation).
