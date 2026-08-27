# Kwill Web Chat — Batch C (attachments and composer chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web composer the attach button it is missing — pick or paste images, attach a document that becomes a thesis source the AI can read, see what is staged before sending, and dictate by voice.

**Architecture:** Images need **no upload endpoint**: they ride as base64 in an `attachments` field on the existing `POST /api/chat/stream` request, and the server uploads them and writes the `MODK_IMG` frames. Documents take the other path — uploaded to `POST /api/thesis/:id/sources` *before* the turn, then referenced by title in the message text. Downscaling uses a canvas where the app used `expo-image-manipulator`, and picking uses `<input type="file">` where the app used Expo pickers.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, Vitest, Web Speech API.

**Tracker:** `docs/superpowers/specs/2026-08-27-kwill-web-chat-parity-inventory.md` — ticks C2, C3, C5 on merge. C1 (message actions) and C4 (PDF preview) stay open: C1's Regenerate/Continue depend on Batch B, so the row is better built once those exist.

---

## Read this before Task 1

**Gate after every file you touch:**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

`npm test` after every TDD task and at the end.

⚠️ `node_modules` in the worktree is a **symlink**. Never `npm install`, never delete it.

⚠️ The main checkout has substantial uncommitted work by someone else (auth flow, `src/features/editor/`). Work only in the worktree; never stage anything outside your task's paths.

### Settled contracts — verified against source, do not re-research

**Images ride on the chat request. There is no image-upload endpoint.**

`POST /api/chat/stream` accepts an optional `attachments` field:

```typescript
attachments?: { base64: string; mime: string; width?: number; height?: number }[]
```

Server behaviour that shapes this plan (`~/modakerati-server/src/routes/chat.ts`):

- `sanitizeAttachments` caps at **4** and silently drops anything without a string `base64` or with an unsupported mime. It never fails the send — so a client that sends junk gets a reply with the images quietly missing, which is worse than refusing locally. Validate on the client.
- `storeAttachments` **drops attachments entirely when the thread has no `thesisId`**, because the storage path is `{userId}/{thesisId}/{uuid}.{ext}`. The web is always thesis-scoped so this holds, but do not send attachments on a thread with a null `thesisId`.
- Attachments are skipped when `regenerate` is set.
- Storage cap is **8 MB decoded**; supported mimes are jpeg/png/webp/gif.
- The server writes the `[[MODK_IMG]]` frames into the persisted message itself — the client never constructs them.

**App-side limits to mirror** (`~/modakerati/lib/chat-images.ts`): `MAX_CHAT_IMAGES = 4`, long edge `MAX_DIM = 1568`, base64 budget `MAX_B64 = 2_800_000` chars. A PNG stays PNG if it fits the budget, otherwise it is re-encoded as JPEG at quality 0.85. There is a fast path that skips re-encoding when type, pixels and bytes are all already within budget.

**Documents become sources.** `POST /api/thesis/:id/sources`, JSON `{ base64, filename, title?, description? }`, **10 MB** cap, returns **201** with `{ id, thesisId, title, description, filename, fileType, status, sizeBytes, createdAt }`. Accepted: `.docx`, `text/plain`, `text/markdown`, `application/pdf`. A file whose text cannot be extracted comes back with `status: "unextracted"` — stored, but the AI cannot read it, and the app tells the student so.

After a successful upload the app composes the message as:

```
[Attached file: ${source.title}${note}] ${prompt}
```

where `note` is `" — stored, but its text could not be extracted (unsupported file type)"` when `status === "unextracted"`. The AI then reads it through its own `list_sources` / `get_source_content` / `search_sources` tools. Only **one** document at a time.

### Deliberate deviations from the app, decided up front

- **No Camera button.** The app's tray has file / photo / camera / paste. This is a desktop-first panel; `<input capture>` only means anything on a phone browser. Photo covers the real case.
- **No Paste button — paste works natively instead.** The app needs a button because there is no keyboard paste into an unfocused RN input. On the web, `Ctrl/Cmd+V` into the composer is the expected gesture, so this plan handles the `paste` event on the textarea and drops the button. That is *more* natural on web, not less.
- The tray therefore has **two** buttons: Attach (document) and Photo (images).

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/features/chat/lib/attachments.ts` | Limits, validation, canvas downscale, `File` → staged image |
| `src/features/chat/lib/attachments.test.ts` | Tests for the pure parts |
| `src/features/chat/components/AttachTray.tsx` | The `+` button and its two options |
| `src/features/chat/components/StagedAttachments.tsx` | Thumbnail row + document chip, each removable |
| `src/features/chat/lib/use-voice-dictation.ts` | Web Speech API hook, mirroring the app's `useVoiceDictation` |

**Modified**

| Path | Change |
|---|---|
| `src/lib/api/student-browser.ts` | `attachments` on `postChatStream`; `addSourceBrowser` |
| `src/features/chat/components/Composer.tsx` | Tray, staged row, paste handler, mic |
| `src/features/chat/components/ChatPanel.tsx` | Staged state, document upload before send, attachments on send |
| `src/features/chat/locales/{en,fr,ar}.json` | Batch C strings |

---

### Task 1: Attachment limits, validation and downscaling (TDD for the pure parts)

**Files:**
- Create: `src/features/chat/lib/attachments.ts`
- Test: `src/features/chat/lib/attachments.test.ts`

- [ ] **Step 1: Read the app original**

```bash
cat ~/modakerati/lib/chat-images.ts
```

Port its limits and its decision tree exactly. The canvas work replaces `expo-image-manipulator`; everything about *when* to re-encode is the same.

- [ ] **Step 2: Write the failing tests**

Only the pure functions are tested — canvas work needs a real browser and is deliberately left to the manual smoke pass.

```typescript
// src/features/chat/lib/attachments.test.ts
import { describe, it, expect } from "vitest";
import {
  MAX_CHAT_IMAGES,
  MAX_SOURCE_BYTES,
  isSupportedImageMime,
  isSupportedSourceMime,
  sourceMessagePrefix,
  base64Bytes,
} from "./attachments";

describe("image mime support", () => {
  it("accepts the four mimes the server stores", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(isSupportedImageMime(m)).toBe(true);
    }
  });

  it("rejects HEIC, which the server cannot store", () => {
    expect(isSupportedImageMime("image/heic")).toBe(false);
  });

  it("rejects a non-image", () => {
    expect(isSupportedImageMime("application/pdf")).toBe(false);
  });
});

describe("source mime support", () => {
  it("accepts docx, pdf, plain text and markdown", () => {
    expect(isSupportedSourceMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isSupportedSourceMime("application/pdf")).toBe(true);
    expect(isSupportedSourceMime("text/plain")).toBe(true);
    expect(isSupportedSourceMime("text/markdown")).toBe(true);
  });

  it("rejects an image as a source", () => {
    expect(isSupportedSourceMime("image/png")).toBe(false);
  });
});

describe("base64Bytes", () => {
  it("estimates decoded size from base64 length", () => {
    // 4 base64 chars encode 3 bytes.
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAAAAAAA")).toBe(6);
  });

  it("accounts for padding", () => {
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });
});

describe("sourceMessagePrefix", () => {
  it("names the attached source so the AI can find it", () => {
    expect(sourceMessagePrefix("Chapter 2 draft", "ready")).toBe("[Attached file: Chapter 2 draft]");
  });

  it("warns when the text could not be extracted", () => {
    // The student must know the AI cannot actually read it.
    expect(sourceMessagePrefix("scan.pdf", "unextracted")).toBe(
      "[Attached file: scan.pdf — stored, but its text could not be extracted (unsupported file type)]",
    );
  });
});

describe("limits", () => {
  it("matches the server's caps", () => {
    expect(MAX_CHAT_IMAGES).toBe(4);
    expect(MAX_SOURCE_BYTES).toBe(10 * 1024 * 1024);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/chat/lib/attachments.test.ts
```

Expected: FAIL — `Cannot find module './attachments'`.

- [ ] **Step 4: Write the module**

```typescript
// src/features/chat/lib/attachments.ts

// Ported from ~/modakerati/lib/chat-images.ts. The limits are the app's; the
// re-encoding is done with a canvas rather than expo-image-manipulator, but
// the decision tree for WHEN to re-encode is unchanged.
//
// The server (chat.ts sanitizeAttachments) silently DROPS an attachment it
// cannot use rather than failing the send — a student would get a reply that
// ignored their screenshot with no explanation. So everything here validates
// client-side first.

/** The server caps at 4 (MAX_ATTACHMENTS) and drops the rest silently. */
export const MAX_CHAT_IMAGES = 4;
/** Long edge, matching the app. Anything bigger is downscaled. */
export const MAX_DIM = 1568;
/** Base64 character budget per image (~2 MB). The server's hard limit is 8 MB
 *  decoded; this is the app's tighter working budget. */
export const MAX_B64 = 2_800_000;
/** The sources endpoint's cap. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const SOURCE_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
  "text/markdown",
];

export function isSupportedImageMime(mime: string): boolean {
  return IMAGE_MIMES.includes(mime);
}

export function isSupportedSourceMime(mime: string): boolean {
  return SOURCE_MIMES.includes(mime);
}

/** Decoded byte count for a base64 string, without decoding it. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The line the app prepends so the assistant knows a source was attached and
 *  can go read it with its own source tools. An unextracted file is called out
 *  explicitly — it is stored, but the AI genuinely cannot read it, and letting
 *  a student assume otherwise wastes their turn. */
export function sourceMessagePrefix(title: string, status: string): string {
  const note =
    status === "unextracted"
      ? " — stored, but its text could not be extracted (unsupported file type)"
      : "";
  return `[Attached file: ${title}${note}]`;
}

export interface StagedImage {
  /** Object URL for the thumbnail. Revoke it when the image is removed. */
  previewUrl: string;
  base64: string;
  mime: string;
  width: number;
  height: number;
}

export interface StagedDocument {
  file: File;
  name: string;
  size: number;
}

/** Strips the `data:...;base64,` prefix a FileReader result carries. */
function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(stripDataUrl(String(reader.result)));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = url;
  });
}

/**
 * Turns a picked File into a staged image, downscaling and re-encoding only
 * when it needs to — the same fast path the app has, so a screenshot that is
 * already small is not re-encoded (which would cost quality for nothing).
 *
 * Returns null for an unsupported type, so the caller can tell the student
 * rather than letting the server drop it silently.
 */
export async function prepareImage(file: File): Promise<StagedImage | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const passthrough = isSupportedImageMime(file.type);

    // Fast path: already a supported type, already small enough, already
    // within the byte budget. Re-encoding would only lose quality.
    if (passthrough && longEdge <= MAX_DIM) {
      const base64 = await fileToBase64(file);
      if (base64.length <= MAX_B64) {
        return {
          previewUrl: objectUrl,
          base64,
          mime: file.type,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      }
    }

    const scale = longEdge > MAX_DIM ? MAX_DIM / longEdge : 1;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);

    // A PNG stays PNG when it fits — screenshots of text stay crisp. Otherwise
    // JPEG at 0.85, the app's quality.
    let mime = file.type === "image/png" ? "image/png" : "image/jpeg";
    let base64 = stripDataUrl(canvas.toDataURL(mime, 0.85));
    if (base64.length > MAX_B64 && mime === "image/png") {
      mime = "image/jpeg";
      base64 = stripDataUrl(canvas.toDataURL(mime, 0.85));
    }
    if (base64.length > MAX_B64) return null;

    return { previewUrl: objectUrl, base64, mime, width, height };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

/** The wire shape `POST /api/chat/stream` expects. */
export interface ChatAttachmentUpload {
  base64: string;
  mime: string;
  width?: number;
  height?: number;
}

export function toUpload(image: StagedImage): ChatAttachmentUpload {
  return { base64: image.base64, mime: image.mime, width: image.width, height: image.height };
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/features/chat/lib/attachments.test.ts && npm test && npx tsc --noEmit
```

Expected: PASS, 10/10 in that file.

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/lib/attachments.ts src/features/chat/lib/attachments.test.ts
git commit -m "feat(chat): attachment limits, validation and canvas downscaling"
```

---

### Task 2: Browser API — attachments on send, and source upload

**Files:**
- Modify: `src/lib/api/student-browser.ts`

- [ ] **Step 1: Add `attachments` to `postChatStream`**

Import the type:

```typescript
import type { ChatAttachmentUpload } from "@/features/chat/lib/attachments";
```

Extend the body parameter:

```typescript
export async function postChatStream(
  body: {
    message: string;
    threadId: string;
    mode?: ChatMode;
    /** Images ride on the turn itself as base64 — there is no upload endpoint.
     *  The server stores them and writes the [[MODK_IMG]] frames into the
     *  persisted message. It caps at 4 and silently drops anything it cannot
     *  use, so the caller validates first. It also drops them entirely when
     *  the thread has no thesisId. */
    attachments?: ChatAttachmentUpload[];
  },
  signal?: AbortSignal,
): Promise<Response> {
```

The body is already `JSON.stringify(body)`, so nothing else changes.

- [ ] **Step 2: Add the source uploader**

Append to the file:

```typescript
export interface ThesisSource {
  id: string;
  thesisId: string;
  title: string;
  description: string | null;
  filename: string;
  fileType: string;
  /** "unextracted" means the file is stored but the AI cannot read its text —
   *  the student must be told, or they will assume it was understood. */
  status: string;
  sizeBytes: number;
  createdAt: string;
}

/** POST /api/thesis/:id/sources — a document attached in chat becomes a thesis
 *  SOURCE first, so the assistant can read it with its own source tools. The
 *  server caps at 10 MB and answers 201 with the stored row. */
export async function addSourceBrowser(
  thesisId: string,
  input: { base64: string; filename: string; description?: string },
): Promise<ThesisSource> {
  return browserFetch<ThesisSource>(`/api/thesis/${thesisId}/sources`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
git add src/lib/api/student-browser.ts
git commit -m "feat(chat): send image attachments and upload a document as a source"
```

---

### Task 3: Batch C strings

**Files:**
- Modify: `src/features/chat/locales/{en,fr,ar}.json`

Keys are the app's own (`chat.toolAttach`, `chat.toolPhoto`, `chat.removeAttachment`, `chat.attachedFile`, `chat.maxImages`, `chat.attachNeedsThesis`, `sources.uploading`).

- [ ] **Step 1: Add to `en.json`, inside the `"chat"` object**

```json
    "attach": "Attach",
    "photo": "Photo",
    "removeAttachment": "Remove attachment",
    "attachedFile": "Attached file",
    "maxImages": "You can attach up to {count} images.",
    "unsupportedImage": "That image type isn't supported. Try a JPG, PNG, WebP or GIF.",
    "unsupportedFile": "That file type isn't supported. Try a Word document, PDF, or text file.",
    "fileTooLarge": "That file is too large. The limit is 10 MB.",
    "uploadingSource": "Uploading…",
    "uploadFailed": "Couldn't upload that file. Try again.",
    "listening": "Listening…",
    "dictate": "Dictate"
```

- [ ] **Step 2: Add to `fr.json`**

```json
    "attach": "Joindre",
    "photo": "Photo",
    "removeAttachment": "Supprimer la pièce jointe",
    "attachedFile": "Fichier joint",
    "maxImages": "Vous pouvez joindre jusqu'à {count} images.",
    "unsupportedImage": "Ce type d'image n'est pas pris en charge. Essayez un JPG, PNG, WebP ou GIF.",
    "unsupportedFile": "Ce type de fichier n'est pas pris en charge. Essayez un document Word, un PDF ou un fichier texte.",
    "fileTooLarge": "Ce fichier est trop volumineux. La limite est de 10 Mo.",
    "uploadingSource": "Envoi en cours…",
    "uploadFailed": "Impossible d'envoyer ce fichier. Réessayez.",
    "listening": "Écoute en cours…",
    "dictate": "Dicter"
```

- [ ] **Step 3: Add to `ar.json`**

```json
    "attach": "إرفاق",
    "photo": "صورة",
    "removeAttachment": "إزالة المرفق",
    "attachedFile": "ملف مرفق",
    "maxImages": "يمكنك إرفاق {count} صور كحد أقصى.",
    "unsupportedImage": "نوع الصورة هذا غير مدعوم. جرّب JPG أو PNG أو WebP أو GIF.",
    "unsupportedFile": "نوع الملف هذا غير مدعوم. جرّب مستند Word أو PDF أو ملفًا نصيًا.",
    "fileTooLarge": "هذا الملف كبير جدًا. الحد الأقصى 10 ميغابايت.",
    "uploadingSource": "جارٍ الرفع…",
    "uploadFailed": "تعذر رفع الملف. حاول مرة أخرى.",
    "listening": "جارٍ الاستماع…",
    "dictate": "إملاء"
```

- [ ] **Step 4: Verify parity**

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

Expected: equal counts, both `ok: true`.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/locales
git commit -m "i18n(chat): Batch C strings"
```

---

### Task 4: `AttachTray`

**Files:**
- Create: `src/features/chat/components/AttachTray.tsx`

- [ ] **Step 1: Read the app original**

```bash
grep -n "toolsRow\|toggleTools\|TOOLS\|toolAttach\|toolPhoto" ~/modakerati/app/\(app\)/chat.tsx | head -20
```

The app's `+` rotates 45° when open and reveals an inline row of options. Two of its four carry over (see the deviations note at the top of this plan).

- [ ] **Step 2: Write the component**

```tsx
// src/features/chat/components/AttachTray.tsx
"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";

/**
 * The composer's `+` and the two options it reveals, ported from the app's
 * inline tools tray.
 *
 * The app has four (file / photo / camera / paste); this has two. Camera means
 * nothing on a desktop panel, and paste is handled natively by the composer's
 * own paste handler — Ctrl+V is the gesture a web user already reaches for,
 * where the app needed a button because RN has no keyboard paste into an
 * unfocused input.
 */
export function AttachTray({
  open,
  onToggle,
  onPickImages,
  onPickDocument,
  disabled,
  imagesFull,
}: {
  open: boolean;
  onToggle: () => void;
  onPickImages: (files: FileList) => void;
  onPickDocument: (file: File) => void;
  disabled: boolean;
  /** Already at MAX_CHAT_IMAGES — the Photo option is offered but refuses. */
  imagesFull: boolean;
}) {
  const t = useTranslations("chat");
  const imageInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={t("attach")}
        aria-expanded={open}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-subtext transition-transform hover:bg-card-hover disabled:opacity-50 ${
          open ? "rotate-45" : ""
        }`}
      >
        <Icon name="plus" size={18} />
      </button>

      {open && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => docInput.current?.click()}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-card-hover disabled:opacity-50"
          >
            <Icon name="paperclip" size={13} />
            {t("attach")}
          </button>
          <button
            type="button"
            onClick={() => imageInput.current?.click()}
            disabled={disabled || imagesFull}
            className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-card-hover disabled:opacity-50"
          >
            <Icon name="image" size={13} />
            {t("photo")}
          </button>
        </div>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onPickImages(e.target.files);
          // Reset so picking the same file twice still fires onChange.
          e.target.value = "";
        }}
      />
      <input
        ref={docInput}
        type="file"
        accept=".docx,.pdf,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain,text/markdown"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPickDocument(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
```

Icon names `plus`, `paperclip` and `image` must exist in `src/components/ui/icon.tsx`. `plus` and `image` already do; check `paperclip` and add it (import `Paperclip` from `lucide-react`, add `paperclip: Paperclip` to the `ICONS` map) if missing. Report what you added.

- [ ] **Step 3: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
git add src/features/chat/components/AttachTray.tsx src/components/ui/icon.tsx
git commit -m "feat(chat): attach tray with document and photo pickers"
```

---

### Task 5: `StagedAttachments`

**Files:**
- Create: `src/features/chat/components/StagedAttachments.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/features/chat/components/StagedAttachments.tsx
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui";
import type { StagedImage, StagedDocument } from "../lib/attachments";

/**
 * What is about to be sent, above the composer — thumbnails for images and a
 * chip for the one document. Ported from the app's staged rows.
 *
 * Everything here is removable: an attachment the student cannot take back
 * before sending is a trap, and a document in particular costs an upload.
 */
export function StagedAttachments({
  images,
  document,
  uploading,
  onRemoveImage,
  onRemoveDocument,
}: {
  images: StagedImage[];
  document: StagedDocument | null;
  uploading: boolean;
  onRemoveImage: (index: number) => void;
  onRemoveDocument: () => void;
}) {
  const t = useTranslations("chat");
  if (images.length === 0 && !document) return null;

  return (
    <div className="mb-2 flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image, i) => (
            <div key={image.previewUrl} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a static asset */}
              <img
                src={image.previewUrl}
                alt=""
                className="h-14 w-14 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => onRemoveImage(i)}
                aria-label={t("removeAttachment")}
                className="absolute -end-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-subtext hover:text-text"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {document && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2">
          <Icon name="file-text" size={14} className="shrink-0 text-subtext" />
          <span className="min-w-0 flex-1 truncate text-xs text-text">{document.name}</span>
          {uploading ? (
            <span className="text-[11px] text-subtext">{t("uploadingSource")}</span>
          ) : (
            <button
              type="button"
              onClick={onRemoveDocument}
              aria-label={t("removeAttachment")}
              className="shrink-0 text-subtext hover:text-text"
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
git add src/features/chat/components/StagedAttachments.tsx
git commit -m "feat(chat): staged attachment thumbnails and document chip"
```

---

### Task 6: Voice dictation

**Files:**
- Create: `src/features/chat/lib/use-voice-dictation.ts`

- [ ] **Step 1: Read the app original**

```bash
cat ~/modakerati/lib/voice.ts
```

Mirror its shape: `{ supported, listening, start, stop }`, with `supported` false rather than throwing where the capability is absent — the app returns `null` from an optional native module, the web checks for `SpeechRecognition`. Transcripts **append** to whatever was already in the box.

- [ ] **Step 2: Write the hook**

```typescript
// src/features/chat/lib/use-voice-dictation.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The Web Speech API is the counterpart of the app's expo-speech-recognition.
// Neither is universal — the app returns null from an optional native module
// when it isn't linked, and Firefox has no SpeechRecognition at all — so both
// expose `supported` and the caller hides the mic rather than offering a
// button that does nothing.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Dictation for the composer. `onTranscript` receives the final text, which
 * the caller APPENDS to whatever the student had already typed — the same
 * contract the app uses, so starting dictation never wipes a half-written
 * sentence.
 */
export function useVoiceDictation({
  lang,
  onTranscript,
}: {
  lang: string;
  onTranscript: (text: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Feature detection has to run in an effect: the server render has no window,
  // and rendering the mic on the server then hiding it would flash.
  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0]?.transcript ?? "";
      }
      if (text.trim()) onTranscript(text.trim());
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [lang, onTranscript]);

  return { supported, listening, start, stop };
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
git add src/features/chat/lib/use-voice-dictation.ts
git commit -m "feat(chat): voice dictation via the Web Speech API"
```

---

### Task 7: Composer — tray, staged row, paste, mic

**Files:**
- Modify: `src/features/chat/components/Composer.tsx`

- [ ] **Step 1: Read the current file**

It currently holds the mode chip, textarea and send/stop. Everything below is additive.

- [ ] **Step 2: Rewrite it**

```tsx
// src/features/chat/components/Composer.tsx
"use client";

import { useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, fInput } from "@/components/ui";
import { ModeChip } from "./ModeChip";
import { AttachTray } from "./AttachTray";
import { StagedAttachments } from "./StagedAttachments";
import { useVoiceDictation } from "../lib/use-voice-dictation";
import { MAX_CHAT_IMAGES, type StagedImage, type StagedDocument } from "../lib/attachments";
import type { ChatMode } from "../lib/chat-modes";

export function Composer({
  onSend,
  disabled,
  placeholder,
  mode,
  onModeChange,
  streaming,
  onStop,
  stopLabel,
  inputRef,
  images,
  document: stagedDocument,
  uploading,
  onPickImages,
  onPickDocument,
  onRemoveImage,
  onRemoveDocument,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder: string;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  streaming: boolean;
  onStop: () => void;
  stopLabel: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  images: StagedImage[];
  document: StagedDocument | null;
  /** A document upload is in flight — sending must wait for it. */
  uploading: boolean;
  onPickImages: (files: FileList) => void;
  onPickDocument: (file: File) => void;
  onRemoveImage: (index: number) => void;
  onRemoveDocument: () => void;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [value, setValue] = useState("");
  const [trayOpen, setTrayOpen] = useState(false);

  const { supported: voiceSupported, listening, start, stop } = useVoiceDictation({
    lang: locale,
    // Appends, so dictating never wipes a half-typed sentence.
    onTranscript: (text) => setValue((prev) => (prev ? `${prev} ${text}` : text)),
  });

  // An attachment alone is worth sending — the app allows it, and "here, look
  // at this" with no words is a real message.
  const hasContent = value.trim().length > 0 || images.length > 0 || stagedDocument !== null;

  const submit = () => {
    if (!hasContent || disabled || uploading) return;
    onSend(value.trim());
    setValue("");
    setTrayOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Ctrl/Cmd+V with an image on the clipboard. This is why there is no Paste
  // button: on the web it is simply the gesture people already use.
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    const list = new DataTransfer();
    for (const file of files) list.items.add(file);
    onPickImages(list.files);
  };

  return (
    <div className="border-t border-border p-3">
      <StagedAttachments
        images={images}
        document={stagedDocument}
        uploading={uploading}
        onRemoveImage={onRemoveImage}
        onRemoveDocument={onRemoveDocument}
      />

      <div className="mb-2 flex items-center gap-1.5">
        <AttachTray
          open={trayOpen}
          onToggle={() => setTrayOpen((v) => !v)}
          onPickImages={onPickImages}
          onPickDocument={onPickDocument}
          disabled={streaming || uploading}
          imagesFull={images.length >= MAX_CHAT_IMAGES}
        />
        <ModeChip mode={mode} onChange={onModeChange} disabled={streaming} />
      </div>

      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          placeholder={listening ? t("listening") : placeholder}
          aria-label={placeholder}
          maxLength={2000}
          rows={2}
          className={`${fInput} resize-none`}
        />

        {voiceSupported && !streaming && (
          <Button
            type="button"
            icon="mic"
            size="sm"
            variant={listening ? "danger" : "muted"}
            aria-label={t("dictate")}
            title={t("dictate")}
            onClick={listening ? stop : start}
          />
        )}

        {streaming ? (
          <Button
            type="button"
            icon="square"
            size="sm"
            variant="muted"
            aria-label={stopLabel}
            title={stopLabel}
            onClick={onStop}
          />
        ) : (
          <Button
            type="button"
            icon="send"
            size="sm"
            aria-label="Send"
            onClick={submit}
            disabled={disabled || uploading || !hasContent}
          />
        )}
      </div>
    </div>
  );
}
```

Icon `mic` must exist in the icon map — add it (`import { Mic } from "lucide-react"`, `mic: Mic`) if missing, and report.

- [ ] **Step 3: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: FAIL, errors ONLY in `ChatPanel.tsx` (it does not pass the new required props). Task 8 fixes that. Confirm nothing else errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/chat/components/Composer.tsx src/components/ui/icon.tsx
git commit -m "feat(chat): composer gains the attach tray, staged attachments, paste and mic"
```

---

### Task 8: `ChatPanel` — staging, upload, and sending with attachments

**Files:**
- Modify: `src/features/chat/components/ChatPanel.tsx`

- [ ] **Step 1: Read the current file**

It is large. The changes below are additive; keep everything else working.

- [ ] **Step 2: Add imports and state**

```tsx
import {
  MAX_CHAT_IMAGES,
  MAX_SOURCE_BYTES,
  isSupportedImageMime,
  isSupportedSourceMime,
  prepareImage,
  sourceMessagePrefix,
  toUpload,
  type StagedImage,
  type StagedDocument,
} from "../lib/attachments";
import { addSourceBrowser } from "@/lib/api/student-browser";
import { StagedAttachments } from "./StagedAttachments";
```

(`StagedAttachments` is rendered by `Composer`, so import it only if you use it directly — otherwise omit.)

State, alongside the rest:

```tsx
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [stagedDocument, setStagedDocument] = useState<StagedDocument | null>(null);
  const [uploadingSource, setUploadingSource] = useState(false);
```

- [ ] **Step 3: Add the staging handlers**

```tsx
  const pickImages = useCallback(
    async (files: FileList) => {
      setSendError(null);
      const room = MAX_CHAT_IMAGES - stagedImages.length;
      if (room <= 0) {
        setSendError(t("maxImages", { count: MAX_CHAT_IMAGES }));
        setRetryAction(() => () => {});
        return;
      }

      const picked: StagedImage[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        if (!isSupportedImageMime(file.type)) {
          // The server would silently drop it, leaving the student wondering
          // why their screenshot was ignored.
          setSendError(t("unsupportedImage"));
          setRetryAction(() => () => {});
          continue;
        }
        const prepared = await prepareImage(file);
        if (prepared) picked.push(prepared);
        else {
          setSendError(t("unsupportedImage"));
          setRetryAction(() => () => {});
        }
      }
      if (!mountedRef.current || picked.length === 0) return;
      setStagedImages((prev) => [...prev, ...picked].slice(0, MAX_CHAT_IMAGES));
    },
    [stagedImages.length, t],
  );

  const pickDocument = useCallback(
    (file: File) => {
      setSendError(null);
      if (!isSupportedSourceMime(file.type)) {
        setSendError(t("unsupportedFile"));
        setRetryAction(() => () => {});
        return;
      }
      if (file.size > MAX_SOURCE_BYTES) {
        setSendError(t("fileTooLarge"));
        setRetryAction(() => () => {});
        return;
      }
      setStagedDocument({ file, name: file.name, size: file.size });
    },
    [t],
  );

  const removeImage = useCallback((index: number) => {
    setStagedImages((prev) => {
      const image = prev[index];
      // The thumbnail holds an object URL; letting it leak keeps the whole
      // decoded image alive for the tab's lifetime.
      if (image) URL.revokeObjectURL(image.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const removeDocument = useCallback(() => setStagedDocument(null), []);
```

- [ ] **Step 4: Send with attachments**

`send` currently calls `postChatStream({ message: text, threadId, mode })`. It now has to do three more things: upload a staged document first, attach staged images, and clear staging.

Replace `send` with:

```tsx
  const send = useCallback(
    (text: string) => {
      const imagesToSend = stagedImages;
      const documentToSend = stagedDocument;

      void (async () => {
        let prompt = text;

        // A document becomes a thesis SOURCE before the turn, so the assistant
        // can read it with its own source tools. This costs a round-trip, which
        // is why the composer disables while it runs.
        if (documentToSend) {
          if (!mountedRef.current) return;
          setUploadingSource(true);
          try {
            const base64 = await fileToBase64(documentToSend.file);
            const source = await addSourceBrowser(thesisId, {
              base64,
              filename: documentToSend.name,
            });
            prompt = `${sourceMessagePrefix(source.title, source.status)} ${text}`.trim();
          } catch (err) {
            console.error("[chat] source upload failed", err);
            if (!mountedRef.current) return;
            setUploadingSource(false);
            setSendError(t("uploadFailed"));
            setRetryAction(() => () => send(text));
            return;
          }
          if (!mountedRef.current) return;
          setUploadingSource(false);
        }

        // Clear staging only once the upload has succeeded — a failed send
        // must not silently discard what the student attached.
        setStagedImages([]);
        setStagedDocument(null);
        for (const image of imagesToSend) URL.revokeObjectURL(image.previewUrl);

        await runTurn({
          userText: prompt,
          openStream: (signal) =>
            postChatStream(
              {
                message: prompt,
                threadId: thread.id,
                mode,
                ...(imagesToSend.length > 0
                  ? { attachments: imagesToSend.map(toUpload) }
                  : {}),
              },
              signal,
            ),
          failureMessage: t("sendFailed"),
          onRetry: () => send(prompt),
        });
      })();
    },
    [runTurn, thread.id, thesisId, mode, t, stagedImages, stagedDocument],
  );
```

Import `fileToBase64` from `../lib/attachments` alongside the rest.

- [ ] **Step 5: Clear staging on thread switch**

In `loadThreadState`:

```tsx
    setStagedImages((prev) => {
      for (const image of prev) URL.revokeObjectURL(image.previewUrl);
      return [];
    });
    setStagedDocument(null);
    setUploadingSource(false);
```

- [ ] **Step 6: Pass the new props to `Composer`**

```tsx
      <Composer
        onSend={send}
        disabled={sending || quotaExhausted || switchingThread}
        placeholder={t("placeholder")}
        mode={mode}
        onModeChange={setMode}
        streaming={sending}
        onStop={stopTurn}
        stopLabel={t("stop")}
        inputRef={composerInputRef}
        images={stagedImages}
        document={stagedDocument}
        uploading={uploadingSource}
        onPickImages={pickImages}
        onPickDocument={pickDocument}
        onRemoveImage={removeImage}
        onRemoveDocument={removeDocument}
      />
```

- [ ] **Step 7: Verify**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit && npm test
```

Expected: tsc ZERO errors, full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/features/chat/components/ChatPanel.tsx
git commit -m "feat(chat): stage, upload and send attachments"
```

---

### Task 9: Full verification

**Files:** none

- [ ] **Step 1: Automated gates**

```bash
cd ~/modakerati-dashboard
npx tsc --noEmit
npm test
npm run build
rm -rf .next
```

Expected: all three exit 0.

- [ ] **Step 2: Manual smoke pass**

`npm run dev`, sign in, open a thesis.

- [ ] The composer shows a `+` button; clicking it rotates it and reveals Attach and Photo.
- [ ] Photo opens a file picker; picking an image stages a thumbnail with a remove ×.
- [ ] Picking five images stages only four, and an error explains the limit.
- [ ] Picking a HEIC or SVG shows the unsupported-type message rather than silently doing nothing.
- [ ] **Copy a screenshot and press Ctrl/Cmd+V in the composer** — it stages as a thumbnail.
- [ ] Send a message with an image — it appears in your own bubble, and the AI can describe it.
- [ ] Reload the page — the image is still in the transcript (the server persisted a `MODK_IMG` frame).
- [ ] Attach a `.docx` — a chip shows its name; sending shows "Uploading…", then the message goes with an `[Attached file: …]` prefix and the AI can answer questions about the document's contents.
- [ ] Attach a scanned PDF whose text cannot be extracted — the prefix warns that it was stored but not readable.
- [ ] Attach a file over 10 MB — refused locally with the size message, no upload attempted.
- [ ] In Chrome or Safari, a mic button appears; dictating appends to whatever is already typed rather than replacing it. In Firefox the mic is absent, not broken.
- [ ] Sending with only an attachment and no text works.
- [ ] Switching threads clears anything staged.

- [ ] **Step 3: Tick the tracker**

Mark C2, C3 and C5 complete in `docs/superpowers/specs/2026-08-27-kwill-web-chat-parity-inventory.md` and commit.

## Definition of done

- `npx tsc --noEmit`, `npm test`, `npm run build` all exit 0.
- The composer has an attach button that stages images and one document.
- Images send with the turn and survive a reload.
- A document becomes a thesis source the AI can actually read, and an unreadable one says so.
- Paste works; dictation works where the browser supports it and is hidden where it does not.
- `/d` is untouched.

## Explicitly not done here

- **C1, the message actions row.** Its Regenerate and Continue entries depend on Batch B's turn-work logic, so the row should be built once those land rather than shipped half-wired.
- **C4, the in-chat PDF preview.**
- Camera capture and a Paste button — see the deviations note at the top.
- Drag-and-drop onto the composer. Natural on the web and cheap, but it is an addition rather than parity; worth a follow-up.
