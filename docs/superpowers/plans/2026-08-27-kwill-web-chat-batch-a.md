# Kwill Web Chat — Batch A ("it looks broken") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten gaps that make the shipped web chat panel read as unfinished on first use — unstyled markdown, silently-dropped file and image cards, a discarded reasoning trace, no progress signal on a long run, a list that fights the reader's scroll, no empty state, and no skeletons.

**Architecture:** Two new pure extractors (`attachment-frames.ts`, `time-dividers.ts`) mirror the existing `plan-frames.ts` pattern — the stream parser gains the two attachment frame kinds, while persisted history is re-parsed for the same frames, with `stripPersistedFrames` continuing to remove them from the markdown body. All chat markdown styling lives in one scoped `.chat-md` CSS block rather than a typography plugin, matching how `.landing`/`.guide`/`.workspace` already scope their own looks.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `react-markdown` + `remark-gfm`, Vitest.

**Tracker:** `docs/superpowers/specs/2026-08-27-kwill-web-chat-parity-inventory.md` — tick A1–A10 there on merge.

**Ported from:** every component here is a port of a mobile original. Each task names its source file; read it before writing.

---

## Read this before Task 1

**Gate after every file you touch:**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

`npm test` after every TDD task (2, 3, 10) and at the end (Task 16).

⚠️ **Disk is at ~97%.** `node_modules` in the worktree is a **symlink** to the main checkout. Never run `npm install`, never delete `node_modules`, and do not run `npm run build` except where Task 16 says to.

### Settled facts — do not re-research

**`MODK_FILE`** — `[[MODK_FILE]]{json}[[/MODK_FILE]]`, one per line appended to a message's `content`, **persisted** (the server does not strip it):

```json
{"kind":"file","url":"…signed…","filename":"ma-these.docx","title":"…","format":"docx","bytes":251000,"size":"245 KB","pages":42}
```

`title` and `pages` are optional. Accept a frame only if `typeof json.url === "string"`. The signed URL is short-lived, so an old card can legitimately fail to download.

**`MODK_IMG`** — `[[MODK_IMG]]{json}[[/MODK_IMG]]`, same persistence:

```json
{"kind":"image","url":"…","path":"…","mime":"image/jpeg","width":1568,"height":1024,"page":3}
```

`path`/`page` optional. Same `url`-is-a-string guard.

**Both** need the mobile parsers' second rule: after extracting closed frames, also strip a **dangling unclosed opener** (`/\[\[MODK_FILE\]\][\s\S]*$/`). An aborted stream leaves one, and raw JSON must never reach the reader. `stripPersistedFrames` already handles the body side of this — the new extractors only need to read.

**Existing pattern to follow:** `src/features/chat/lib/plan-frames.ts` already does exactly this job for `MODK_PLAN` — extract structured data from persisted content, keyed by message id, while `stripPersistedFrames` removes it from the body. Mirror its shape.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/features/chat/lib/attachment-frames.ts` | Extract `MODK_FILE`/`MODK_IMG` from persisted content |
| `src/features/chat/lib/attachment-frames.test.ts` | Its tests |
| `src/features/chat/lib/time-dividers.ts` | The 30-minute sitting-gap rule and its label |
| `src/features/chat/lib/time-dividers.test.ts` | Its tests |
| `src/features/chat/components/FileCard.tsx` | Export download card |
| `src/features/chat/components/ChatImageGrid.tsx` | Image thumbnails + full-screen viewer |
| `src/features/chat/components/ThinkingTrace.tsx` | Live reasoning window / "Thought for Xs" |
| `src/features/chat/components/AiWorkingNote.tsx` | m:ss clock with escalating copy |
| `src/features/chat/components/TimeDivider.tsx` | "Today 3:51 PM" between sittings |
| `src/features/chat/components/ChatWelcome.tsx` | Empty state |
| `src/features/chat/components/ChatSkeleton.tsx` | Layout-shaped loading placeholder |

**Modified**

| Path | Change |
|---|---|
| `src/app/globals.css` | The `.chat-md` markdown styling block |
| `src/features/chat/lib/control-frames.ts` (+ test) | Recognize `FILE` and `IMG` |
| `src/features/chat/lib/consume-chat-stream.ts` | `onFile` / `onImage` handlers |
| `src/features/chat/locales/{en,fr,ar}.json` | Batch A strings |
| `src/features/chat/components/MessageBubble.tsx` | Markdown class, file/image cards, long-answer collapse |
| `src/features/chat/components/MessageList.tsx` | Time dividers, scroll pinning, scroll-to-latest |
| `src/features/chat/components/ChatPanel.tsx` | Thinking trace, working note, welcome, attachment state |

---

### Task 1: Chat markdown styling

The panel has **zero** markdown CSS today: lists lose their bullets, tables their borders, code its card, headings render at body size. This is the single most visible gap.

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Read the mobile styling reference**

```bash
sed -n '1,80p' ~/modakerati/components/Markdown.tsx
```

The numbers below are ported from its stylesheet. Two decisions worth keeping: the library's heading underline was deliberately **deleted** (it clashed with `---` rules in the same answer), and a blockquote is a bar plus body rather than a border — on web that becomes `border-inline-start`, which flips correctly in RTL for free.

- [ ] **Step 2: Append the block to `globals.css`**

Add at the end of the file:

```css
/* ============================================================================
   Chat markdown (.chat-md) — the assistant's answers.
   ----------------------------------------------------------------------------
   Ported from ~/modakerati/components/Markdown.tsx. Scoped rather than global,
   and hand-written rather than @tailwindcss/typography, for the same reason
   .landing and .guide are scoped: this is one surface's voice, and `prose`
   would also restyle every other markdown consumer in the app.

   Tailwind's preflight removes list markers and heading sizes, so without this
   an answer renders as undifferentiated paragraphs — which is exactly what
   shipped.

   Base is 14px/21. An RTL answer gets 15px/26: Arabic needs more air at the
   same nominal size. Direction is set per message by MessageBubble's dir
   attribute, so [dir="rtl"] here keys off the message, not the app locale.
   ========================================================================== */
.chat-md {
  font-size: 14px;
  line-height: 21px;
}

.chat-md[dir="rtl"] {
  font-size: 15px;
  line-height: 26px;
}

.chat-md > :first-child { margin-top: 0; }
.chat-md > :last-child { margin-bottom: 0; }

.chat-md p { margin: 5px 0; }
.chat-md strong { font-weight: 700; }
.chat-md em { font-style: italic; }

/* No heading underline: it collided with `---` rules in the same answer. */
.chat-md h1 { font-size: 21px; line-height: 31px; font-weight: 700; margin: 14px 0 6px; }
.chat-md h2 { font-size: 19px; line-height: 29px; font-weight: 700; margin: 14px 0 6px; }
.chat-md h3 { font-size: 17px; line-height: 27px; font-weight: 700; margin: 12px 0 4px; }
.chat-md h4 { font-size: 15px; line-height: 24px; font-weight: 600; margin: 10px 0 3px; }
.chat-md h5 { font-size: 14px; line-height: 23px; font-weight: 600; margin: 8px 0 2px; }
.chat-md h6 { font-size: 14px; line-height: 23px; font-weight: 600; margin: 8px 0 2px; color: var(--subtext); }

.chat-md hr { border: 0; border-top: 1px solid var(--border); margin: 10px 0; }

.chat-md a { color: var(--primary-light); text-decoration: underline; }

/* Marker column restored — preflight strips it. padding-inline-start keeps the
   markers on the reading side in RTL without a second rule. */
.chat-md ul,
.chat-md ol { margin: 2px 0; padding-inline-start: 22px; }
.chat-md ul { list-style: disc; }
.chat-md ol { list-style: decimal; }
.chat-md li { margin-bottom: 2px; }
.chat-md li::marker { color: var(--subtext); }
/* An ordered marker stays LTR so "10." never renders as ".10" in an RTL answer. */
.chat-md ol > li::marker { direction: ltr; unicode-bidi: isolate; }

.chat-md blockquote {
  border-inline-start: 3px solid var(--primary);
  padding-inline-start: 10px;
  margin: 6px 0;
  opacity: 0.92;
}

.chat-md code {
  font-family: Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  background: var(--surface);
  color: var(--accent);
  padding: 1px 4px;
  border-radius: 4px;
}

.chat-md pre {
  margin: 6px 0;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--input);
  overflow-x: auto;
  /* Code is code in every locale — never mirrored. */
  direction: ltr;
  text-align: left;
}

.chat-md pre code {
  background: none;
  color: var(--text);
  font-size: 12.5px;
  line-height: 19px;
  padding: 0;
  border-radius: 0;
}

/* A table narrower than its content scrolls rather than squeezing columns
   below legibility — the mobile port uses a 92px floor for the same reason. */
.chat-md .chat-md-table-wrap { overflow-x: auto; margin: 8px 0; }

.chat-md table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.chat-md th,
.chat-md td {
  padding: 8px 10px;
  border: 1px solid var(--border);
  text-align: start;
}

.chat-md th {
  background: var(--surface);
  font-weight: 600;
}

.chat-md img { max-width: 100%; height: auto; border-radius: 8px; }
```

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS (CSS-only change; the class is applied in Task 13).

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(chat): real markdown styling for assistant answers"
```

---

### Task 2: Recognize FILE and IMG frames in the stream parser (TDD)

**Files:**
- Modify: `src/features/chat/lib/control-frames.ts`
- Modify: `src/features/chat/lib/control-frames.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("ControlFrameParser", …)` block, before its closing `});`:

```typescript
  it("parses a MODK_FILE frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = {
      kind: "file",
      url: "https://example.com/a.docx",
      filename: "these.docx",
      format: "docx",
      bytes: 251000,
      size: "245 KB",
      pages: 42,
    };
    expect(p.push(`[[MODK_FILE]]${JSON.stringify(payload)}[[/MODK_FILE]]`)).toEqual([
      { type: "file", payload },
    ]);
  });

  it("parses a MODK_IMG frame's JSON payload", () => {
    const p = new ControlFrameParser();
    const payload = { kind: "image", url: "https://example.com/x.jpg", mime: "image/jpeg", width: 800, height: 600 };
    expect(p.push(`[[MODK_IMG]]${JSON.stringify(payload)}[[/MODK_IMG]]`)).toEqual([
      { type: "image", payload },
    ]);
  });
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/control-frames.test.ts
```

Expected: FAIL — both return `[]` (currently stripped as unknown).

- [ ] **Step 3: Add the payload types**

In `control-frames.ts`, after the existing `PlanStepPayload` interface:

```typescript
export interface FilePayload {
  kind: "file";
  /** Signed and SHORT-LIVED — an old card can legitimately fail to download,
   *  which the caller must surface rather than swallow. */
  url: string;
  filename: string;
  title?: string;
  /** "docx" | "pdf" | "tex" in practice; kept open, since the badge just
   *  uppercases whatever arrives. */
  format: string;
  bytes?: number;
  /** Pre-formatted by the server, e.g. "245 KB". */
  size?: string;
  pages?: number;
}

export interface ImagePayload {
  kind: "image";
  url: string;
  path?: string;
  mime?: string;
  width?: number;
  height?: number;
  page?: number;
}
```

Extend the `ControlFrameEvent` union with:

```typescript
  | { type: "file"; payload: FilePayload }
  | { type: "image"; payload: ImagePayload };
```

- [ ] **Step 4: Register the kinds**

In `JSON_FRAME_EVENTS`, widen the value type and add two entries:

```typescript
const JSON_FRAME_EVENTS: Record<
  string,
  "docChanges" | "title" | "confirm" | "ask" | "plan" | "planStep" | "file" | "image"
> = {
  DOCCHANGES: "docChanges",
  TITLE: "title",
  CONFIRM: "confirm",
  ASK: "ask",
  PLAN: "plan",
  PLAN_STEP: "planStep",
  FILE: "file",
  IMG: "image",
};
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/features/chat/lib/control-frames.test.ts && npm test && npx tsc --noEmit
```

Expected: all PASS (22 in that file: 20 existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/lib/control-frames.ts src/features/chat/lib/control-frames.test.ts
git commit -m "feat(chat): parse FILE and IMG control frames"
```

---

### Task 3: Extract attachments from persisted history (TDD)

**Files:**
- Create: `src/features/chat/lib/attachment-frames.ts`
- Test: `src/features/chat/lib/attachment-frames.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/chat/lib/attachment-frames.test.ts
import { describe, it, expect } from "vitest";
import { parseFileFrames, parseImageFrames, extractAttachmentState } from "./attachment-frames";
import type { ChatMessage } from "../types";

function msg(id: string, content: string, role = "assistant"): ChatMessage {
  return { id, threadId: "t1", thesisId: null, role, content, searchText: null, createdAt: null };
}

const FILE = {
  kind: "file" as const,
  url: "https://example.com/a.docx",
  filename: "these.docx",
  format: "docx",
  size: "245 KB",
  pages: 42,
};
const IMG = { kind: "image" as const, url: "https://example.com/x.jpg", width: 800, height: 600 };

describe("parseFileFrames", () => {
  it("returns nothing for plain text", () => {
    expect(parseFileFrames("here is your export")).toEqual([]);
  });

  it("extracts a file frame", () => {
    expect(parseFileFrames(`ready\n[[MODK_FILE]]${JSON.stringify(FILE)}[[/MODK_FILE]]`)).toEqual([FILE]);
  });

  it("skips a frame with no url, mirroring the mobile guard", () => {
    expect(parseFileFrames('[[MODK_FILE]]{"filename":"x.docx"}[[/MODK_FILE]]')).toEqual([]);
  });

  it("skips malformed JSON instead of throwing", () => {
    expect(() => parseFileFrames("[[MODK_FILE]]not json[[/MODK_FILE]]")).not.toThrow();
    expect(parseFileFrames("[[MODK_FILE]]not json[[/MODK_FILE]]")).toEqual([]);
  });

  it("ignores a dangling unclosed frame from an aborted stream", () => {
    expect(parseFileFrames('done\n[[MODK_FILE]]{"url":"https://x/a.docx"')).toEqual([]);
  });
});

describe("parseImageFrames", () => {
  it("extracts an image frame", () => {
    expect(parseImageFrames(`look\n[[MODK_IMG]]${JSON.stringify(IMG)}[[/MODK_IMG]]`)).toEqual([IMG]);
  });

  it("skips a frame with no url", () => {
    expect(parseImageFrames('[[MODK_IMG]]{"width":10}[[/MODK_IMG]]')).toEqual([]);
  });

  it("extracts several images from one message", () => {
    const b = { ...IMG, url: "https://example.com/y.jpg" };
    const raw = `[[MODK_IMG]]${JSON.stringify(IMG)}[[/MODK_IMG]][[MODK_IMG]]${JSON.stringify(b)}[[/MODK_IMG]]`;
    expect(parseImageFrames(raw)).toEqual([IMG, b]);
  });
});

describe("extractAttachmentState", () => {
  it("returns empty maps for a thread with no attachments", () => {
    expect(extractAttachmentState([msg("m1", "hi")])).toEqual({ filesByMessageId: {}, imagesByMessageId: {} });
  });

  it("keys each attachment by the message that carried it", () => {
    const state = extractAttachmentState([
      msg("m1", `[[MODK_FILE]]${JSON.stringify(FILE)}[[/MODK_FILE]]`),
      msg("m2", `[[MODK_IMG]]${JSON.stringify(IMG)}[[/MODK_IMG]]`, "user"),
    ]);
    expect(state.filesByMessageId).toEqual({ m1: [FILE] });
    expect(state.imagesByMessageId).toEqual({ m2: [IMG] });
  });

  it("handles a message carrying both kinds", () => {
    const state = extractAttachmentState([
      msg("m1", `[[MODK_FILE]]${JSON.stringify(FILE)}[[/MODK_FILE]][[MODK_IMG]]${JSON.stringify(IMG)}[[/MODK_IMG]]`),
    ]);
    expect(state.filesByMessageId.m1).toEqual([FILE]);
    expect(state.imagesByMessageId.m1).toEqual([IMG]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/attachment-frames.test.ts
```

Expected: FAIL — `Cannot find module './attachment-frames'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/chat/lib/attachment-frames.ts
import type { FilePayload, ImagePayload } from "./control-frames";
import type { ChatMessage } from "../types";

// MODK_FILE and MODK_IMG are persisted in a message's content, exactly like
// MODK_PLAN — the server keeps all four rather than stripping them. So a
// reloaded thread must rebuild its attachment cards from message text.
// stripPersistedFrames removes the same frames from the markdown BODY; these
// two passes are complementary (strip for the body, extract for the cards),
// which is the same arrangement plan-frames.ts uses.
//
// Both guards below are ported from ~/modakerati/lib/file-frames.ts and
// lib/chat-images.ts: accept a frame only when `url` is a string, and never
// treat a DANGLING unclosed opener as a frame — an aborted stream leaves one,
// and raw JSON must never reach the reader.
const FILE_RE = /\[\[MODK_FILE\]\]([\s\S]*?)\[\[\/MODK_FILE\]\]/g;
const IMG_RE = /\[\[MODK_IMG\]\]([\s\S]*?)\[\[\/MODK_IMG\]\]/g;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Every well-formed file frame in one message's raw content. */
export function parseFileFrames(content: string): FilePayload[] {
  const files: FilePayload[] = [];
  for (const match of content.matchAll(FILE_RE)) {
    const parsed = parseJson(match[1]) as Partial<FilePayload> | null;
    if (!parsed || typeof parsed.url !== "string") continue;
    files.push({
      kind: "file",
      url: parsed.url,
      filename: typeof parsed.filename === "string" ? parsed.filename : "",
      format: typeof parsed.format === "string" ? parsed.format : "",
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      ...(typeof parsed.bytes === "number" ? { bytes: parsed.bytes } : {}),
      ...(typeof parsed.size === "string" ? { size: parsed.size } : {}),
      ...(typeof parsed.pages === "number" ? { pages: parsed.pages } : {}),
    });
  }
  return files;
}

/** Every well-formed image frame in one message's raw content. */
export function parseImageFrames(content: string): ImagePayload[] {
  const images: ImagePayload[] = [];
  for (const match of content.matchAll(IMG_RE)) {
    const parsed = parseJson(match[1]) as Partial<ImagePayload> | null;
    if (!parsed || typeof parsed.url !== "string") continue;
    images.push({
      kind: "image",
      url: parsed.url,
      ...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
      ...(typeof parsed.mime === "string" ? { mime: parsed.mime } : {}),
      ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
      ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
      ...(typeof parsed.page === "number" ? { page: parsed.page } : {}),
    });
  }
  return images;
}

export interface AttachmentState {
  filesByMessageId: Record<string, FilePayload[]>;
  imagesByMessageId: Record<string, ImagePayload[]>;
}

/** Rebuilds attachment-card state for a thread from its raw (unstripped)
 *  messages. Must run BEFORE stripPersistedFrames. */
export function extractAttachmentState(messages: ChatMessage[]): AttachmentState {
  const filesByMessageId: Record<string, FilePayload[]> = {};
  const imagesByMessageId: Record<string, ImagePayload[]> = {};

  for (const message of messages) {
    const files = parseFileFrames(message.content);
    if (files.length > 0) filesByMessageId[message.id] = files;

    const images = parseImageFrames(message.content);
    if (images.length > 0) imagesByMessageId[message.id] = images;
  }

  return { filesByMessageId, imagesByMessageId };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/chat/lib/attachment-frames.test.ts && npm test && npx tsc --noEmit
```

Expected: PASS, 11/11 in that file.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/lib/attachment-frames.ts src/features/chat/lib/attachment-frames.test.ts
git commit -m "feat(chat): extract file and image attachments from persisted history"
```

---

### Task 4: Route attachment frames through the consumer

**Files:**
- Modify: `src/features/chat/lib/consume-chat-stream.ts`

- [ ] **Step 1: Add the handlers**

Extend the import with `type FilePayload, type ImagePayload`. Add to `ChatStreamHandlers` after `onPlanStep`:

```typescript
  /** An export the assistant produced. Persisted, so it also comes back from
   *  history via attachment-frames.ts. */
  onFile?: (payload: FilePayload) => void;
  onImage?: (payload: ImagePayload) => void;
```

Add two branches to `dispatchEvents`:

```typescript
      else if (event.type === "file") handlers.onFile?.(event.payload);
      else if (event.type === "image") handlers.onImage?.(event.payload);
```

- [ ] **Step 2: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npx vitest run src/features/chat/lib/consume-chat-stream.test.ts
```

Expected: both PASS (handlers are optional, so nothing existing breaks).

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/lib/consume-chat-stream.ts
git commit -m "feat(chat): route file and image frames through the stream consumer"
```

---

### Task 5: Batch A strings

Every string is ported from the mobile app's locale files. Do not reword.

**Files:**
- Modify: `src/features/chat/locales/{en,fr,ar}.json`

- [ ] **Step 1: Add to `en.json`**

Inside the top-level `"chat"` object, alongside the existing keys:

```json
    "download": "Download",
    "pages": "{n} pages",
    "attachedImage": "Attached image",
    "close": "Close",
    "thinkingEllipsis": "Thinking…",
    "thoughtFor": "Thought for {d}",
    "tokenCount": "{count} tokens",
    "viewMore": "View more",
    "showLess": "Show less",
    "scrollToLatest": "Scroll to latest message",
    "today": "Today",
    "yesterday": "Yesterday",
    "working": {
      "short": "Working on it…",
      "long": "Still working — this can take a while. Please wait.",
      "veryLong": "Still working on a long task — please keep waiting.",
      "veryLongStoppable": "Still working on a long task — keep waiting, or tap Stop."
    },
    "welcome": {
      "body": "I'm your thesis assistant. I can draft chapters, structure your plan, fix formatting and handle citations — in Arabic, French or English."
    }
```

- [ ] **Step 2: Add to `fr.json`**

```json
    "download": "Télécharger",
    "pages": "{n} pages",
    "attachedImage": "Image jointe",
    "close": "Fermer",
    "thinkingEllipsis": "Réflexion en cours…",
    "thoughtFor": "Réflexion pendant {d}",
    "tokenCount": "{count} jetons",
    "viewMore": "Afficher plus",
    "showLess": "Afficher moins",
    "scrollToLatest": "Aller au dernier message",
    "today": "Aujourd'hui",
    "yesterday": "Hier",
    "working": {
      "short": "Je m'en occupe…",
      "long": "Toujours en cours — cela peut prendre un moment. Veuillez patienter.",
      "veryLong": "Toujours en cours sur une tâche longue — veuillez patienter.",
      "veryLongStoppable": "Toujours en cours sur une tâche longue — patientez, ou appuyez sur Arrêter."
    },
    "welcome": {
      "body": "Je suis votre assistant de mémoire. Je peux rédiger des chapitres, structurer votre plan, corriger la mise en forme et gérer les citations — en arabe, en français ou en anglais."
    }
```

- [ ] **Step 3: Add to `ar.json`**

```json
    "download": "تنزيل",
    "pages": "{n} صفحة",
    "attachedImage": "صورة مرفقة",
    "close": "إغلاق",
    "thinkingEllipsis": "جارٍ التفكير…",
    "thoughtFor": "فكّر لمدة {d}",
    "tokenCount": "{count} رمز",
    "viewMore": "عرض المزيد",
    "showLess": "عرض أقل",
    "scrollToLatest": "الانتقال إلى آخر رسالة",
    "today": "اليوم",
    "yesterday": "أمس",
    "working": {
      "short": "جارٍ العمل…",
      "long": "لا يزال العمل جاريًا — قد يستغرق ذلك بعض الوقت. يرجى الانتظار.",
      "veryLong": "لا يزال العمل جاريًا على مهمة طويلة — يرجى مواصلة الانتظار.",
      "veryLongStoppable": "لا يزال العمل جاريًا على مهمة طويلة — واصل الانتظار، أو اضغط على إيقاف."
    },
    "welcome": {
      "body": "أنا مساعدك في المذكرة. يمكنني كتابة الفصول، وتنظيم خطتك، وإصلاح التنسيق، ومعالجة الاستشهادات — بالعربية أو الفرنسية أو الإنجليزية."
    }
```

- [ ] **Step 4: Verify parity and parsing**

```bash
cd ~/modakerati-dashboard
node -e "
const fs=require('fs');
const keys=o=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v?keys(v).map(s=>k+'.'+s):[k]).sort();
const [en,fr,ar]=['en','fr','ar'].map(l=>keys(JSON.parse(fs.readFileSync('src/features/chat/locales/'+l+'.json','utf8'))));
console.log('counts',en.length,fr.length,ar.length);
console.log('fr ok:',JSON.stringify(en)===JSON.stringify(fr),'ar ok:',JSON.stringify(en)===JSON.stringify(ar));
"
npx tsc --noEmit
```

Expected: equal counts, both `ok: true`, tsc PASS. A missing key renders its raw path at runtime, so fix any mismatch before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/locales
git commit -m "i18n(chat): Batch A strings"
```

---

### Task 6: `FileCard`

**Files:**
- Create: `src/features/chat/components/FileCard.tsx`

- [ ] **Step 1: Read the original**

```bash
cat ~/modakerati/components/FileCard.tsx
```

Port its anatomy: a tinted icon well (Word blue `#2B6CB0` for docx, purple `#6B46C1` otherwise), title, a format badge plus `size · pages` meta, and a full-width Download footer. The whole card is one control. Its key decision: tapping opens the **signed URL directly** rather than an in-app preview — "the export is the thing the student came for".

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/FileCard.tsx
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";
import { detectDir } from "@/features/workspace/lib/direction";
import type { FilePayload } from "../lib/control-frames";

/** Word blue for a .docx, purple for anything else (LaTeX, PDF) — ported from
 *  the app so an export looks the same on both clients. */
function tintFor(format: string): string {
  return format.toLowerCase() === "docx" ? "#2B6CB0" : "#6B46C1";
}

/**
 * An export the assistant produced, from a [[MODK_FILE]] frame. Ported from the
 * app's FileCard.
 *
 * The whole card is a link to the signed URL — deliberately not an in-app
 * preview, because the export is the thing the student came for. That URL is
 * short-lived, so an old card can legitimately 404; the browser surfaces that
 * rather than this component pretending it worked.
 */
export function FileCard({ file }: { file: FilePayload }) {
  const t = useTranslations("chat");
  const tint = tintFor(file.format);
  const title = file.title || file.filename;

  const meta = [file.size, file.pages ? t("pages", { n: file.pages }) : null]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-2 block overflow-hidden rounded-[14px] border border-border bg-surface hover:border-primary/40"
    >
      <div className="flex items-center gap-3 p-3">
        <span
          className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[10px]"
          style={{ backgroundColor: `${tint}1A` }}
        >
          <Icon name="file-text" size={24} style={{ color: tint }} />
        </span>
        <span className="min-w-0 flex-1">
          <span dir={detectDir(title)} className="block truncate text-sm font-semibold text-text">
            {title}
          </span>
          <span className="mt-1.5 flex items-center gap-[7px]">
            {file.format && (
              <span
                className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                style={{ backgroundColor: `${tint}1A`, color: tint }}
              >
                {file.format}
              </span>
            )}
            {meta && <span className="text-[11.5px] font-medium text-subtext">{meta}</span>}
          </span>
        </span>
      </div>
      <span className="flex items-center justify-center gap-1.5 border-t border-border py-2.5">
        <Icon name="download" size={15} className="text-primary" />
        <span className="text-[12.5px] font-semibold text-primary">{t("download")}</span>
      </span>
    </a>
  );
}
```

Note: `Icon` must accept a `style` prop for the tint. Check `src/components/ui/icon.tsx` — if `IconProps` has no `style`, add `style?: CSSProperties` to it and pass it through to the rendered component, and say so in your report.

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/FileCard.tsx src/components/ui/icon.tsx
git commit -m "feat(chat): file download card, ported from the app"
```

---

### Task 7: `ChatImageGrid`

**Files:**
- Create: `src/features/chat/components/ChatImageGrid.tsx`

- [ ] **Step 1: Read the original**

```bash
cat ~/modakerati/components/ChatImages.tsx
```

Port the two layouts and the viewer. A **single** image is 216px wide, capped at 260px tall, `object-fit: contain`, aspect ratio from its own dimensions — a lone proportional image is never cropped. **Several** images become 104px square tiles, `object-fit: cover`, wrapping with a 6px gap.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/ChatImageGrid.tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";
import type { ImagePayload } from "../lib/control-frames";

/**
 * Images carried by a message, from [[MODK_IMG]] frames. Ported from the app's
 * ChatImageGrid.
 *
 * One image renders proportionally and uncropped; several become square tiles,
 * because a wall of differently-shaped thumbnails reads as clutter. Clicking
 * any of them opens a full-screen viewer.
 */
export function ChatImageGrid({ images }: { images: ImagePayload[] }) {
  const t = useTranslations("chat");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (images.length === 0) return null;
  const single = images.length === 1;

  return (
    <>
      <div className={single ? "my-2" : "my-2 flex flex-wrap gap-1.5"}>
        {images.map((image, i) => (
          <button
            key={`${image.url}-${i}`}
            type="button"
            onClick={() => setOpenIndex(i)}
            className={
              single
                ? "block w-[216px] overflow-hidden rounded-xl bg-black/10"
                : "block h-[104px] w-[104px] overflow-hidden rounded-[10px] bg-black/10"
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- remote signed URL, not a static asset next/image can optimize */}
            <img
              src={image.url}
              alt={t("attachedImage")}
              className={single ? "max-h-[260px] w-full object-contain" : "h-full w-full object-cover"}
              style={
                single && image.width && image.height
                  ? { aspectRatio: `${image.width} / ${image.height}` }
                  : undefined
              }
            />
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
          onClick={() => setOpenIndex(null)}
          role="presentation"
        >
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setOpenIndex(null)}
            className="absolute end-4 top-4 flex h-[38px] w-[38px] items-center justify-center rounded-full bg-white/15 text-white"
          >
            <Icon name="x" size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- remote signed URL */}
          <img
            src={images[openIndex].url}
            alt={t("attachedImage")}
            className="max-h-[82vh] w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ChatImageGrid.tsx
git commit -m "feat(chat): image thumbnails and full-screen viewer, ported from the app"
```

---

### Task 8: `ThinkingTrace`

The panel currently captures `MODK_THINK` text and throws it away, showing a static "Thinking…". This replaces that.

**Files:**
- Create: `src/features/chat/components/ThinkingTrace.tsx`

- [ ] **Step 1: Read the original**

```bash
cat ~/modakerati/components/ThinkingTrace.tsx
```

Behaviours to carry: a spinning `✻` while streaming; a live window of the **last 6 lines**, scanned only from the **last 2000 characters** (splitting the whole trace on every chunk is O(n²) and janks the UI); a fade over the top of that window; auto-open on stream start and auto-close on stream end; and a finished chip reading "Thought for 45s". The live token estimate is `ceil(length / 4)` — an approximation, never shown on the finished chip.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/ThinkingTrace.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";

const LIVE_LINES = 6;
/** Only the tail is split per chunk — scanning the whole trace on every push is
 *  O(n²) and visibly janks a long reasoning run. */
const LIVE_TAIL_CHARS = 2000;

/** "45s", "1m 4s", "2m" — matches the app's formatThinkingDuration. */
function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function liveLines(text: string): string[] {
  const tail = text.length > LIVE_TAIL_CHARS ? text.slice(-LIVE_TAIL_CHARS) : text;
  // Start at the first newline inside the tail so the window never opens
  // mid-sentence.
  const start = text.length > LIVE_TAIL_CHARS ? tail.indexOf("\n") + 1 : 0;
  return tail
    .slice(start)
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-LIVE_LINES);
}

/**
 * The model's reasoning, ported from the app's ThinkingTrace. A fading window
 * of the last few lines while it streams, collapsing to a "Thought for 45s"
 * chip you can re-open.
 *
 * Renders nothing when there is no trace and nothing is streaming.
 */
export function ThinkingTrace({
  text,
  streaming,
  durationMs,
}: {
  text: string;
  streaming: boolean;
  durationMs?: number;
}) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const prevStreaming = useRef(streaming);

  // Open when a run starts, close when it ends — the trace is interesting while
  // it happens and clutter afterwards.
  useEffect(() => {
    if (!prevStreaming.current && streaming) setOpen(true);
    if (prevStreaming.current && !streaming) setOpen(false);
    prevStreaming.current = streaming;
  }, [streaming]);

  const trimmed = text.trim();
  if (!streaming && !trimmed) return null;

  const label = streaming
    ? t("thinkingEllipsis")
    : durationMs
      ? t("thoughtFor", { d: formatDuration(durationMs) })
      : t("thinking");

  // Deliberately an approximation of the model's own scratchpad, not billed
  // usage — and never shown once the run is finished.
  const tokens = streaming && trimmed ? Math.ceil(trimmed.length / 4) : 0;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-start"
      >
        <span className={`text-[13px] leading-none ${streaming ? "animate-spin text-primary-light" : "text-subtext"}`}>
          ✻
        </span>
        <span className={`text-xs font-medium ${streaming ? "text-primary-light" : "text-subtext"}`}>
          {label}
          {tokens > 0 && ` · ${t("tokenCount", { count: tokens })}`}
        </span>
        <span className="flex-1" />
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} className="text-subtext" />
      </button>

      {open && streaming && (
        <div className="relative mt-2 max-h-[110px] overflow-hidden border-s-2 border-primary ps-2.5">
          {/* The fade is what makes a scrolling window read as a window rather
              than as clipped text. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[22px] bg-gradient-to-b from-card to-transparent" />
          <div className="flex flex-col justify-end">
            {liveLines(text).map((line, i, all) => (
              <p
                key={i}
                dir="ltr"
                className={`text-[11.5px] italic leading-[17px] text-subtext ${
                  i === all.length - 1 ? "opacity-95" : "opacity-45"
                }`}
              >
                {line}
              </p>
            ))}
          </div>
        </div>
      )}

      {open && !streaming && trimmed && (
        <div className="mt-2 max-h-[220px] overflow-y-auto border-s-2 border-border ps-2.5">
          <p dir="ltr" className="whitespace-pre-wrap text-[11.5px] italic leading-[17px] text-subtext">
            {trimmed}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ThinkingTrace.tsx
git commit -m "feat(chat): live reasoning trace, ported from the app"
```

---

### Task 9: `AiWorkingNote`

**Files:**
- Create: `src/features/chat/components/AiWorkingNote.tsx`

- [ ] **Step 1: Read the originals**

```bash
cat ~/modakerati/components/AiWorkingNote.tsx
cat ~/modakerati/hooks/useWorkingClock.ts
```

The rule that matters: the note appears only once the stream has been **quiet for 2.5 seconds**. A steadily-streaming reply is its own progress indicator; this exists for the silences, when a tool is running and nothing is arriving. Copy escalates at 25s and 90s and **never de-escalates**.

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/AiWorkingNote.tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/** The stream must go quiet this long before the note speaks. A reply that is
 *  actively streaming is its own progress indicator; this is for the silences,
 *  when a tool is running and nothing is arriving. */
const QUIET_MS = 2500;

/** m:ss — 0:07, 12:03. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A quiet clock so a three-minute tool run isn't mistaken for a hang. Ported
 * from the app's AiWorkingNote + useWorkingClock.
 *
 * Copy escalates at 25s and 90s and never de-escalates — a message that walked
 * back to "Working on it…" would read as progress that had been lost.
 */
export function AiWorkingNote({
  active,
  startedAt,
  lastEventAt,
  stoppable = true,
}: {
  active: boolean;
  /** When the turn began, for the elapsed clock. */
  startedAt: number | null;
  /** When the last stream event arrived, for the quiet-gate. */
  lastEventAt: number | null;
  stoppable?: boolean;
}) {
  const t = useTranslations("chat");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active || startedAt === null) return null;
  if (lastEventAt !== null && now - lastEventAt < QUIET_MS) return null;

  const elapsed = now - startedAt;
  const message =
    elapsed >= 90_000
      ? stoppable
        ? t("working.veryLongStoppable")
        : t("working.veryLong")
      : elapsed >= 25_000
        ? t("working.long")
        : t("working.short");

  return (
    <div className="mt-2 flex items-center gap-1.5 px-4 pb-2">
      <span className="animate-spin text-[13px] leading-none text-subtext">✻</span>
      <span className="min-w-0 shrink text-xs font-medium text-subtext">{message}</span>
      <span className="flex-1" />
      {/* Forced LTR with tabular figures so the clock never reorders or jitters
          in an Arabic UI. */}
      <span dir="ltr" className="text-[11.5px] text-subtext tabular-nums">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/AiWorkingNote.tsx
git commit -m "feat(chat): AI working note with an elapsed clock, ported from the app"
```

---

### Task 10: Time dividers (TDD)

**Files:**
- Create: `src/features/chat/lib/time-dividers.ts`
- Test: `src/features/chat/lib/time-dividers.test.ts`
- Create: `src/features/chat/components/TimeDivider.tsx`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/chat/lib/time-dividers.test.ts
import { describe, it, expect } from "vitest";
import { shouldShowTime } from "./time-dividers";

const T = "2026-08-27T15:00:00.000Z";

describe("shouldShowTime", () => {
  it("shows a divider before the very first message", () => {
    expect(shouldShowTime(null, T)).toBe(true);
  });

  it("hides it inside the same sitting", () => {
    const tenMinutesLater = "2026-08-27T15:10:00.000Z";
    expect(shouldShowTime(T, tenMinutesLater)).toBe(false);
  });

  it("shows it after a gap longer than 30 minutes", () => {
    const muchLater = "2026-08-27T15:31:00.000Z";
    expect(shouldShowTime(T, muchLater)).toBe(true);
  });

  it("returns false for an unparseable stamp — a wrong divider is worse than none", () => {
    expect(shouldShowTime(T, "not a date")).toBe(false);
    expect(shouldShowTime("not a date", T)).toBe(false);
  });

  it("returns false when the current message has no timestamp at all", () => {
    expect(shouldShowTime(T, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/time-dividers.test.ts
```

Expected: FAIL — `Cannot find module './time-dividers'`.

- [ ] **Step 3: Write the module**

```typescript
// src/features/chat/lib/time-dividers.ts

/** A new "sitting" starts after half an hour of silence. Ported from the app's
 *  TimeDivider. */
const GAP_MS = 30 * 60 * 1000;

/** Whether a divider belongs above the message stamped `iso`, given the one
 *  before it. An unparseable stamp yields false: a divider showing the wrong
 *  time is worse than no divider. */
export function shouldShowTime(prevIso: string | null, iso: string | null): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  if (!prevIso) return true;
  const prev = Date.parse(prevIso);
  if (Number.isNaN(prev)) return false;
  return at - prev > GAP_MS;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/chat/lib/time-dividers.test.ts && npm test && npx tsc --noEmit
```

Expected: PASS, 5/5.

- [ ] **Step 5: Write the component**

```tsx
// src/features/chat/components/TimeDivider.tsx
"use client";

import { useLocale, useTranslations } from "next-intl";

/**
 * "Today 3:51 PM" between sittings. Ported from the app's TimeDivider, and
 * centred for the same reason: the divider belongs to both speakers.
 *
 * Times go through toLocaleTimeString rather than a hand-rolled formatter, so
 * 12-versus-24-hour and Arabic-Indic digits come free with the locale.
 */
export function TimeDivider({ iso }: { iso: string }) {
  const t = useTranslations("chat");
  const locale = useLocale();

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = at.toDateString() === yesterday.toDateString();

  const label = sameDay
    ? `${t("today")} ${time}`
    : isYesterday
      ? `${t("yesterday")} ${time}`
      : `${at.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time}`;

  return <p className="mt-2 mb-1.5 text-center text-xs font-medium text-subtext">{label}</p>;
}
```

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit
git add src/features/chat/lib/time-dividers.ts src/features/chat/lib/time-dividers.test.ts src/features/chat/components/TimeDivider.tsx
git commit -m "feat(chat): time dividers between sittings, ported from the app"
```

---

### Task 11: `ChatWelcome` and `ChatSkeleton`

**Files:**
- Create: `src/features/chat/components/ChatWelcome.tsx`
- Create: `src/features/chat/components/ChatSkeleton.tsx`

- [ ] **Step 1: Read the original welcome**

```bash
cat ~/modakerati/components/chat/ChatWelcome.tsx
```

The web version drops the 200px art (that asset lives in the app bundle) and keeps the copy plus a single icon, which is the part that carries the meaning. It also drops both CTAs: they deep-link to `chat-guide` and `support-guide` screens the web app does not have. Report that as a deliberate deviation.

- [ ] **Step 2: Write `ChatWelcome`**

```tsx
// src/features/chat/components/ChatWelcome.tsx
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";

/**
 * The empty state for a conversation with no messages yet. Ported from the
 * app's ChatWelcome, minus its two CTAs — both deep-link to guide screens the
 * web app does not have — and minus the bundled art.
 *
 * Worth keeping from the original's history: this replaced a fake assistant
 * message, which was regenerable and counted as conversation history. An empty
 * state is not a message.
 */
export function ChatWelcome() {
  const t = useTranslations("chat");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
      <Icon name="sparkles" size={40} className="text-primary" />
      <p className="text-[15px] leading-relaxed text-subtext">{t("welcome.body")}</p>
    </div>
  );
}
```

- [ ] **Step 3: Write `ChatSkeleton`**

```tsx
// src/features/chat/components/ChatSkeleton.tsx
"use client";

/**
 * Layout-shaped placeholder for a thread being loaded or switched. Shaped like
 * the transcript it replaces — alternating assistant and student bubbles — per
 * the standing rule that a loading state is never a spinner.
 */
export function ChatSkeleton() {
  return (
    <div className="flex-1 space-y-3 px-4 py-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3">
          <div className="flex justify-start">
            <div className="h-16 w-[70%] animate-pulse rounded-2xl bg-card" />
          </div>
          <div className="flex justify-end">
            <div className="h-9 w-[45%] animate-pulse rounded-2xl bg-card" />
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
git add src/features/chat/components/ChatWelcome.tsx src/features/chat/components/ChatSkeleton.tsx
git commit -m "feat(chat): welcome empty state and loading skeleton"
```

---

### Task 12: `MessageBubble` — markdown class, attachments, long-answer collapse

**Files:**
- Modify: `src/features/chat/components/MessageBubble.tsx`

- [ ] **Step 1: Read the current file and the mobile collapse logic**

```bash
cd ~/modakerati-dashboard && cat src/features/chat/components/MessageBubble.tsx
grep -n "EXPAND_THRESHOLD\|COLLAPSED_HEIGHT\|FadeOverlay" ~/modakerati/components/chat/MessageBubble.tsx
```

Thresholds to port: clip at **1200 characters**, collapsed height **420px**, and collapse applies **only to a finished assistant answer** — never to a streaming one (the height would fight the stream) and never to the student's own message.

- [ ] **Step 2: Apply the changes**

Add imports:

```tsx
import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileCard } from "./FileCard";
import { ChatImageGrid } from "./ChatImageGrid";
import type { FilePayload, ImagePayload } from "../lib/control-frames";
```

Add these constants above the component:

```tsx
/** Ported from the app: 1200, raised from an earlier 280 which collapsed
 *  answers that were not long at all. */
const EXPAND_THRESHOLD = 1200;
const COLLAPSED_HEIGHT = 420;
```

Extend the props with `files`, `images`, and `streaming`:

```tsx
  files = [],
  images = [],
  streaming = false,
```

and their types:

```tsx
  files?: FilePayload[];
  images?: ImagePayload[];
  /** A streaming answer is never collapsed — a fixed height would fight the
   *  incoming text. */
  streaming?: boolean;
```

Inside the component, before the return:

```tsx
  const t = useTranslations("chat");
  const [expanded, setExpanded] = useState(false);
  const collapsible = !isUser && !streaming && content.length > EXPAND_THRESHOLD;
  const collapsed = collapsible && !expanded;
```

Add `className="chat-md"` to the `<ReactMarkdown>` wrapper — put it on the bubble's inner container so the CSS from Task 1 applies. Wrap the markdown in the collapse container, and render attachments after the bubble. The bubble block becomes:

```tsx
      {content && (
        <div
          dir={dir}
          className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser ? "bg-primary text-white" : "bg-card border border-border text-text"
          }`}
        >
          <div
            className="chat-md relative overflow-hidden"
            style={collapsed ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </ReactMarkdown>
            {collapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-card" />
            )}
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 text-xs font-medium text-subtext hover:text-text"
            >
              {expanded ? t("showLess") : t("viewMore")}
            </button>
          )}
        </div>
      )}

      {images.length > 0 && (
        <div className="w-full max-w-[85%]">
          <ChatImageGrid images={images} />
        </div>
      )}

      {files.map((file, i) => (
        <div key={`${file.url}-${i}`} className="w-full max-w-[85%]">
          <FileCard file={file} />
        </div>
      ))}
```

Keep the existing plan-card block exactly as it is, after these.

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: FAIL, with errors ONLY in `MessageList.tsx` (it doesn't pass the new optional props — they're optional, so in fact this should PASS; if it does pass, good). Either way, no errors outside the chat feature.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/MessageBubble.tsx
git commit -m "feat(chat): styled markdown, attachment cards and long-answer collapse in the bubble"
```

---

### Task 13: `MessageList` — dividers, scroll pinning, scroll-to-latest

The list currently calls `scrollIntoView` on every `messages` change, which during a stream is every 90 ms — it fights anyone reading back through history.

**Files:**
- Modify: `src/features/chat/components/MessageList.tsx`

- [ ] **Step 1: Read the mobile scroll logic**

```bash
grep -n "isNearBottomRef\|userHasScrolledRef\|NEAR_BOTTOM\|handleScroll\|showScrollDown" ~/modakerati/app/\(app\)/chat.tsx | head -30
```

The rule to port: auto-scroll only while the reader is **near the bottom** (within 160px), and treat "near bottom" as true until the reader has actually scrolled — the opening layout fires scroll events that would otherwise strand them mid-history.

- [ ] **Step 2: Rewrite the component**

```tsx
// src/features/chat/components/MessageList.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";
import { MessageBubble } from "./MessageBubble";
import { TimeDivider } from "./TimeDivider";
import { shouldShowTime } from "../lib/time-dividers";
import type { ChatMessage } from "../types";
import type {
  FilePayload,
  ImagePayload,
  PlanPayload,
  PlanStepPayload,
} from "../lib/control-frames";

/** Within this many pixels of the bottom counts as "following along". */
const NEAR_BOTTOM = 160;

export function MessageList({
  messages,
  plansByMessageId,
  ticksByPlanId,
  donePlanIds,
  filesByMessageId,
  imagesByMessageId,
  streamingMessageId,
  runningPlanId,
  plansDisabled,
  onExecutePlan,
  onAskPlanChanges,
}: {
  messages: ChatMessage[];
  plansByMessageId: Record<string, PlanPayload[]>;
  ticksByPlanId: Record<string, PlanStepPayload[]>;
  donePlanIds: Set<string>;
  filesByMessageId: Record<string, FilePayload[]>;
  imagesByMessageId: Record<string, ImagePayload[]>;
  /** The assistant message currently receiving tokens, if any — it is never
   *  collapsed. */
  streamingMessageId: string | null;
  runningPlanId: string | null;
  plansDisabled: boolean;
  onExecutePlan: (planId: string) => void;
  onAskPlanChanges: () => void;
}) {
  const t = useTranslations("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Starts true so a freshly-opened thread lands on the newest message.
  const nearBottomRef = useRef(true);
  // Only a real scroll counts. The opening layout fires scroll events at offset
  // 0 that would otherwise read as "far from the bottom" and strand the reader.
  const hasScrolledRef = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    hasScrolledRef.current = true;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    nearBottomRef.current = distance < NEAR_BOTTOM;
    setShowScrollDown(!nearBottomRef.current);
  }, []);

  useEffect(() => {
    if (!hasScrolledRef.current || nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const scrollToBottom = () => {
    nearBottomRef.current = true;
    setShowScrollDown(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((message, i) => (
          <div key={message.id} className="space-y-3">
            {shouldShowTime(i === 0 ? null : messages[i - 1].createdAt, message.createdAt) &&
              message.createdAt && <TimeDivider iso={message.createdAt} />}
            <MessageBubble
              role={message.role === "user" ? "user" : "assistant"}
              content={message.content}
              streaming={streamingMessageId === message.id}
              plans={plansByMessageId[message.id]}
              ticksByPlanId={ticksByPlanId}
              donePlanIds={donePlanIds}
              files={filesByMessageId[message.id]}
              images={imagesByMessageId[message.id]}
              runningPlanId={runningPlanId}
              plansDisabled={plansDisabled}
              onExecutePlan={onExecutePlan}
              onAskPlanChanges={onAskPlanChanges}
            />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {showScrollDown && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={t("scrollToLatest")}
          className="absolute bottom-3 end-4 flex h-[42px] w-[42px] items-center justify-center rounded-full border border-border bg-card shadow-lg hover:bg-card-hover"
        >
          <Icon name="chevron-down" size={22} className="text-text" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: FAIL, with errors ONLY in `ChatPanel.tsx` (missing the new `MessageList` props). Task 14 supplies them. Confirm nothing else errors, then continue.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/MessageList.tsx
git commit -m "feat(chat): time dividers, scroll pinning and a scroll-to-latest button"
```

---

### Task 14: `ChatPanel` — wire Batch A together

**Files:**
- Modify: `src/features/chat/components/ChatPanel.tsx`

- [ ] **Step 1: Read the current file**

```bash
cd ~/modakerati-dashboard && cat src/features/chat/components/ChatPanel.tsx
```

- [ ] **Step 2: Apply the changes**

Add imports:

```tsx
import { extractAttachmentState } from "../lib/attachment-frames";
import { ThinkingTrace } from "./ThinkingTrace";
import { AiWorkingNote } from "./AiWorkingNote";
import { ChatWelcome } from "./ChatWelcome";
import { ChatSkeleton } from "./ChatSkeleton";
import type { FilePayload, ImagePayload } from "../lib/control-frames";
```

Add state, alongside the existing plan state:

```tsx
  const [attachments, setAttachments] = useState(() => extractAttachmentState(initialMessages));
  /** Which assistant message is currently receiving tokens — MessageList uses
   *  it to keep a streaming answer out of the long-answer collapse. */
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingDurationMs, setThinkingDurationMs] = useState<number | undefined>(undefined);
```

In `runTurn`, right after the optimistic messages are appended and `setSending(true)`:

```tsx
      setStreamingMessageId(assistantId);
      setTurnStartedAt(Date.now());
      setLastEventAt(Date.now());
      setThinkingDurationMs(undefined);
      setThinkingStartedAt(null);
```

In the handlers passed to `consumeChatStream`, extend `onText` and `onThink`, and add the two new ones:

```tsx
          onText: (delta) => {
            pendingTextRef.current += delta;
            if (mountedRef.current) setLastEventAt(Date.now());
          },
          onThink: (delta) => {
            if (!mountedRef.current) return;
            setLastEventAt(Date.now());
            setThinkingStartedAt((prev) => prev ?? Date.now());
            setThinking((prev) => (prev ?? "") + delta);
          },
          onFile: (payload: FilePayload) => {
            if (!mountedRef.current) return;
            setLastEventAt(Date.now());
            setAttachments((prev) => ({
              ...prev,
              filesByMessageId: {
                ...prev.filesByMessageId,
                [assistantId]: [...(prev.filesByMessageId[assistantId] ?? []), payload],
              },
            }));
          },
          onImage: (payload: ImagePayload) => {
            if (!mountedRef.current) return;
            setLastEventAt(Date.now());
            setAttachments((prev) => ({
              ...prev,
              imagesByMessageId: {
                ...prev.imagesByMessageId,
                [assistantId]: [...(prev.imagesByMessageId[assistantId] ?? []), payload],
              },
            }));
          },
```

In `runTurn`'s `finally`, inside the existing `if (mountedRef.current)` block:

```tsx
          setStreamingMessageId(null);
          setTurnStartedAt(null);
          setLastEventAt(null);
          if (thinkingStartedAt !== null) {
            setThinkingDurationMs(Date.now() - thinkingStartedAt);
            setThinkingStartedAt(null);
          }
```

In `loadThreadState`, re-seed attachments and clear the turn clocks:

```tsx
    setAttachments(extractAttachmentState(msgs));
    setStreamingMessageId(null);
    setTurnStartedAt(null);
    setLastEventAt(null);
    setThinking(null);
    setThinkingDurationMs(undefined);
    setThinkingStartedAt(null);
```

Replace the transcript region of the returned JSX. The existing `<MessageList …>` call plus the `{thinking && …}` line become:

```tsx
      {switchingThread ? (
        <ChatSkeleton />
      ) : messages.length === 0 ? (
        <ChatWelcome />
      ) : (
        <MessageList
          messages={messages}
          plansByMessageId={plansByMessageId}
          ticksByPlanId={ticksByPlanId}
          donePlanIds={donePlanIds}
          filesByMessageId={attachments.filesByMessageId}
          imagesByMessageId={attachments.imagesByMessageId}
          streamingMessageId={streamingMessageId}
          runningPlanId={runningPlanId}
          plansDisabled={sending || quotaExhausted || switchingThread}
          onExecutePlan={executePlan}
          onAskPlanChanges={askPlanChanges}
        />
      )}

      {(thinking || thinkingDurationMs !== undefined) && (
        <div className="px-4 pb-1">
          <ThinkingTrace
            text={thinking ?? ""}
            streaming={sending && thinkingStartedAt !== null}
            durationMs={thinkingDurationMs}
          />
        </div>
      )}

      <AiWorkingNote
        active={sending}
        startedAt={turnStartedAt}
        lastEventAt={lastEventAt}
      />
```

Delete the old `{switchingThread && <div …>{t("loadingThreads")}</div>}` line — the skeleton replaces it.

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npm test
```

Expected: tsc PASSES with zero errors (Task 13's deliberate errors resolved), full suite green.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/ChatPanel.tsx
git commit -m "feat(chat): wire attachments, thinking trace, working note, welcome and skeleton"
```

---

### Task 15: Strip attachment frames from the streamed body

`stripPersistedFrames` cleans a message loaded from history, but a `MODK_FILE`/`MODK_IMG` frame arriving mid-stream reaches the bubble as raw text — the parser now emits an event for it, but the surrounding prose is unaffected. Confirm and close that gap.

**Files:**
- Modify (only if needed): `src/features/chat/components/ChatPanel.tsx`

- [ ] **Step 1: Establish whether there is a gap**

The stream parser consumes a complete `[[MODK_FILE]]…[[/MODK_FILE]]` frame and emits a `file` event **instead of** text, so the frame should never reach `pendingTextRef`. Verify by reading `control-frames.ts`'s `push` loop: confirm that a recognized JSON frame's raw content is removed from the buffer and never emitted as a `text` event.

If that holds, there is nothing to change — record the finding and skip to Step 3.

- [ ] **Step 2: Only if a gap exists**

If a frame *can* leak into text (e.g. an unclosed frame at end of stream reaching `flush()`), apply `stripPersistedFrames` to the assistant message's accumulated content once the turn ends, in `runTurn`'s success path:

```tsx
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: stripPersistedFrames(m.content) } : m)),
        );
```

- [ ] **Step 3: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npm test
```

```bash
git add -A src/features/chat
git commit -m "fix(chat): ensure attachment frames never reach the rendered body"
```

If Step 1 found no gap, commit nothing and say so in your report.

---

### Task 16: Full verification

**Files:** none

- [ ] **Step 1: Automated gates**

```bash
cd ~/modakerati-dashboard
npx tsc --noEmit
npm test
npm run build
```

Expected: all three exit 0. The build writes to `.next/` — **delete it afterwards** (`rm -rf .next`) to reclaim disk, since the machine is near capacity.

- [ ] **Step 2: Manual smoke pass**

`npm run dev`, sign in as a student, open a thesis.

- [ ] A reply containing a bulleted list renders **with bullets**; a table has borders; a code block sits in a card; headings are larger than body text.
- [ ] An Arabic reply renders RTL at the larger size, and an ordered list's numbers still read "1." not ".1".
- [ ] Ask for an export ("send me the file") — a **download card** appears with a format badge and size, and clicking it downloads.
- [ ] A long reply (over ~1200 characters) is clipped with a fade and a "View more" control that expands it.
- [ ] During a reply, the reasoning trace streams in a fading window and collapses to "Thought for Xs" when done; clicking it re-opens the full trace.
- [ ] Ask for something slow (a document-wide edit) — once the stream goes quiet for ~2.5 s, the working note appears with a counting m:ss clock, and its wording escalates past 25 s.
- [ ] Scroll up mid-stream — the view **stays** where you put it, and a scroll-to-latest button appears; clicking it returns to the bottom and re-arms auto-scroll.
- [ ] Start a new conversation — the welcome state shows instead of a blank pane.
- [ ] Switch threads — a layout-shaped skeleton shows, not a spinner.
- [ ] Messages separated by more than 30 minutes carry a "Today 3:51 PM" divider.

- [ ] **Step 3: Tick the tracker**

Mark A1–A10 complete in `docs/superpowers/specs/2026-08-27-kwill-web-chat-parity-inventory.md` (in the `~/modakerati` repo) and commit that.

## Definition of done

- `npx tsc --noEmit`, `npm test`, `npm run build` all exit 0.
- Markdown answers are styled: lists, tables, code, headings, blockquotes.
- File and image frames render as cards instead of vanishing.
- The reasoning trace is visible and collapses to a duration.
- A long quiet run shows a counting clock rather than looking hung.
- Scrolling back during a stream is not fought.
- Empty and loading states exist.
- `/d` is untouched.

## Explicitly not done here

Batches B, C and D of the parity inventory — turn robustness (retry, regenerate, continue, background resume), message actions and attachments (upload), and thread management (search, rename, pin, pagination).
