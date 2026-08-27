# Kwill Web (Next.js) — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student can, from a browser, sign up (or sign in with an existing Kwill account), create a thesis, and open it to see the live document rendered as real blocks — inside `~/modakerati-dashboard`, at a new `/app` route tree separate from the staff console.

**Architecture:** A new authenticated route segment (`src/app/app/`) in the existing Next.js dashboard, gated by plain Supabase Auth (no `staff_role` check). A server-only API client (`src/lib/api/student.ts`) calls `modakerati-server`'s real student-facing endpoints directly with the user's own Supabase access token as a bearer token. A new `src/features/workspace/` module renders the server's `DocumentDTO.blocks[]` (paragraph/table/textbox/image/other) as real DOM, reusing the dashboard's existing UI kit and i18n.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `@supabase/ssr`, `next-intl`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-kwill-web-nextjs-design.md`

**Explicitly NOT done here** (see spec's "Explicitly deferred", and the follow-up chat plan):
- The AI chat panel, streaming, control-frame parsing, `modk://b/N` block links, multi-thread history — a separate plan, built on top of this one.
- Manual in-browser block editing, payments/upgrade UI, the university/template onboarding wizard, Google/Apple sign-in.
- Table cell fills/borders/spans/merged cells, floating shape `anchors` overlays — rendered as plain rows/text for v1; the DTO carries this data but this plan does not draw it.

---

## Read this before Task 1

**There is no dedicated test file for I/O-shaped code in this repo's Next.js app** (no test wraps `middleware.ts` or anything that hits `cookies()`/`fetch`) — the existing convention (`src/i18n/negotiate.test.ts`, `src/lib/auth/access.test.ts`) is to unit-test **pure functions only**. This plan follows that: the one pure-logic unit (RTL direction detection) gets a real TDD cycle; API-client and route code gets `tsc` + a manual dev-server smoke pass instead of a contrived test around `fetch`.

**Gate for every task:**
```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```
Run it after every file you touch. `npm test` (== `vitest run`) after Task 1 and again at the very end (Task 17).

**Do not create `src/middleware.ts`.** Next.js 16 renamed the concept to "Proxy," and because this project's app lives under `src/`, the file must be `src/proxy.ts` — a root-level `middleware.ts` is silently ignored. All auth gating already goes through `src/proxy.ts` → `updateSession()` in `src/lib/supabase/middleware.ts`; Task 4 edits that second file only.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/features/workspace/lib/direction.ts` | Pure RTL/LTR detection from text content |
| `src/features/workspace/lib/direction.test.ts` | Its tests |
| `src/features/workspace/types.ts` | `DocumentDTO`, `DocBlockDTO`, `DocSectionDTO` mirrored from the server |
| `src/lib/api/student.ts` | Bearer-token fetch client to `modakerati-server`'s student API |
| `src/features/workspace/components/blocks/ParagraphBlock.tsx` | Renders a `paragraph` block |
| `src/features/workspace/components/blocks/TableBlock.tsx` | Renders a `table` block |
| `src/features/workspace/components/blocks/TextboxBlock.tsx` | Renders a `textbox` block |
| `src/features/workspace/components/blocks/ImageBlock.tsx` | Renders an `image` block (figures + native charts) |
| `src/features/workspace/components/blocks/OtherBlock.tsx` | Renders an `other` (unsupported) block |
| `src/features/workspace/components/DocumentBlocks.tsx` | Maps `blocks[]` to the right block component |
| `src/features/workspace/index.ts` | Barrel |
| `src/features/workspace/locales/{en,fr,ar}.json` | Workspace strings |
| `src/features/student-app/locales/{en,fr,ar}.json` | Sign-up/sign-in/home/new-thesis strings |
| `src/app/app/(auth)/signup/page.tsx` | Sign-up form |
| `src/app/app/(auth)/signup/action.ts` | Sign-up server action |
| `src/app/app/(auth)/login/page.tsx` | Sign-in form |
| `src/app/app/(auth)/login/action.ts` | Sign-in server action |
| `src/app/app/(workspace)/layout.tsx` | Auth gate (no staff check) + profile bootstrap |
| `src/app/app/(workspace)/page.tsx` | Home: thesis list or empty state |
| `src/app/app/(workspace)/new/page.tsx` | New-thesis form |
| `src/app/app/(workspace)/new/action.ts` | Create-thesis server action |
| `src/app/app/(workspace)/[thesisId]/page.tsx` | The workspace: fetch + render the document |

`(auth)` and `(workspace)` are Next.js route groups — they don't appear in the URL. This gives `/app/login` and `/app/signup` their own un-gated branch of the tree, so the workspace layout's auth redirect can never loop against its own sign-in page.

**Modified**

| Path | Change |
|---|---|
| `src/lib/supabase/middleware.ts` | Add the `/app/*` auth branch (own login page, no staff check) |
| `src/i18n/messages.ts` | Register the two new locale bundles |

---

### Task 1: RTL direction detection (TDD)

Every block carries an optional `direction` from the server, but free-standing text (a table cell, a textbox line with no server-resolved direction) needs a client-side fallback — exactly like the app's own `detectDir` in `components/workspace/DocBlock.tsx`.

**Files:**
- Create: `src/features/workspace/lib/direction.ts`
- Test: `src/features/workspace/lib/direction.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/workspace/lib/direction.test.ts
import { describe, it, expect } from "vitest";
import { detectDir } from "./direction";

describe("detectDir", () => {
  it("detects Arabic text as rtl", () => {
    expect(detectDir("مرحبا بالعالم")).toBe("rtl");
  });

  it("detects French text as ltr", () => {
    expect(detectDir("Bonjour le monde")).toBe("ltr");
  });

  it("detects rtl even when Arabic is mixed with Latin characters", () => {
    expect(detectDir("Chapter 1: مقدمة")).toBe("rtl");
  });

  it("falls back to the given default when there is no strong-direction character", () => {
    expect(detectDir("123 456", true)).toBe("rtl");
    expect(detectDir("123 456", false)).toBe("ltr");
  });

  it("defaults to ltr with no fallback argument", () => {
    expect(detectDir("42")).toBe("ltr");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/workspace/lib/direction.test.ts
```

Expected: FAIL — `Cannot find module './direction'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/workspace/lib/direction.ts

// Mirrors the mobile app's RTL detection (components/workspace/DocBlock.tsx):
// a thesis's language field is unreliable, so direction is read from the text
// itself. Matches the first strong-direction character against the Unicode
// ranges for Hebrew, Arabic, Syriac, Thaana, and Arabic presentation forms —
// the same range the app uses — and falls back to the caller's default (the
// thesis's own `rtl` flag) when the text carries no such character at all.
const RTL_CHAR = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\u0800-\u083f\u0840-\u085f\u08a0-\u08ff\ufb1d-\ufb4d\ufb50-\ufdff\ufe70-\ufeff]/;

export function detectDir(text: string, fallbackRtl = false): "rtl" | "ltr" {
  if (RTL_CHAR.test(text)) return "rtl";
  return fallbackRtl ? "rtl" : "ltr";
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

```bash
cd ~/modakerati-dashboard && npx vitest run src/features/workspace/lib/direction.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/features/workspace/lib/direction.ts src/features/workspace/lib/direction.test.ts
git commit -m "feat(web-app): RTL direction detection for block content"
```

---

### Task 2: Shared document types

**Files:**
- Create: `src/features/workspace/types.ts`

- [ ] **Step 1: Write the types**

Mirrors `DocumentDTO`/`DocBlockDTO` exactly as defined in `modakerati-server/src/lib/thesis-doc.ts:96-218`. `sections` (header/footer page chrome) and `anchors` (floating shape overlays) are received but not rendered by this plan — typed as `unknown[]` so a future plan can type and use them without touching every block component again.

```typescript
// src/features/workspace/types.ts

export type ParaAlignment = "left" | "center" | "right" | "both" | null;
export type Direction = "rtl" | "ltr" | null;

export type DocBlockDTO =
  | {
      index: number;
      kind: "paragraph";
      text: string;
      styleId: string | null;
      level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      alignment: ParaAlignment;
      direction: Direction;
    }
  | {
      index: number;
      kind: "table";
      rows: string[][];
      align?: "left" | "center" | "right" | null;
      direction?: "rtl" | "ltr";
      header?: boolean;
    }
  | {
      index: number;
      kind: "image";
      dataUri?: string;
      svg?: string;
      hasMedia?: boolean;
      width?: number;
      height?: number;
      caption?: string;
      ornament?: boolean;
    }
  | {
      index: number;
      kind: "textbox";
      text: string;
      lines: TextBoxLine[];
      shape: TextBoxShape;
      alignment: ParaAlignment;
      direction: Direction;
    }
  | { index: number; kind: "other"; tag: string; text?: string };

export type TextBoxLine = {
  text: string;
  alignment: ParaAlignment;
  direction: Direction;
  bold?: boolean;
  sizePt?: number;
};

export type TextBoxShape = {
  rounded: boolean;
  border: { color: string; pt: number } | null;
  fill: string | null;
  width?: number;
  height?: number;
};

export type DocumentDTO =
  | {
      id: string;
      title: string;
      docMode: "live-docx";
      available: true;
      blocks: DocBlockDTO[];
      sections: unknown[];
      downloadUrl: string;
    }
  | { id: string; title: string; docMode: string; available: false };
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS (no consumers yet, so this only checks the file parses as valid TS).

- [ ] **Step 3: Commit**

```bash
git add src/features/workspace/types.ts
git commit -m "feat(web-app): document/block DTO types mirrored from modakerati-server"
```

---

### Task 3: Student API client

Bearer-token fetch wrapper to `modakerati-server`, following the same shape as the existing `src/lib/api/server.ts` (`adminFetch` → `x-admin-token`) but authenticating as the signed-in student instead of the admin service.

**Files:**
- Create: `src/lib/api/student.ts`

- [ ] **Step 1: Write the client**

```typescript
// src/lib/api/student.ts
import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DocumentDTO } from "@/features/workspace/types";

// A private (non-NEXT_PUBLIC_) var on purpose: this module is server-only and
// calls modakerati-server machine-to-machine. The sibling browser-facing
// NEXT_PUBLIC_MODAKERATI_SERVER_URL (used later, in ImageBlock's <img src>)
// must resolve publicly over HTTPS; this one may point at an internal address
// if ops ever splits them, matching the existing sibling src/lib/api/server.ts.
const BASE = process.env.MODAKERATI_SERVER_URL ?? "http://localhost:3000";

export class StudentApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "StudentApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The signed-in student's own Supabase access token, or null when there is no
 * session. Exposed (not just used internally) because the document media
 * endpoint is loaded from a plain `<img src>`, which can't carry an
 * Authorization header — the server accepts the token as a `?token=` query
 * param instead (modakerati-server/src/middleware/auth.ts), and that URL is
 * built outside this module, in the workspace page.
 */
export async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function studentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new StudentApiError(401, "not_signed_in", "Not signed in");

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new StudentApiError(
      res.status,
      body?.code,
      body?.error ?? `modakerati-server ${path} -> ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export interface StudentProfile {
  id: string;
  fullName: string;
  email: string;
  language: string;
}

/**
 * GET /api/user/profile lazily creates the `profiles` row from Supabase Auth
 * identity — there is no `on_auth_user_created` DB trigger on the current
 * database (modakerati-server/src/routes/user.ts:20-28). This MUST be called
 * once per session before any thesis call, or a brand-new sign-up hits thesis
 * creation with no profile row behind it.
 */
export async function ensureProfile(): Promise<StudentProfile> {
  return studentFetch<StudentProfile>("/api/user/profile");
}

export interface ThesisListItem {
  id: string;
  title: string;
  language: string | null;
  docMode: string;
  updatedAt: string;
  sectionCount: number;
  chapterCount: number;
}

export async function listMyTheses(): Promise<ThesisListItem[]> {
  return studentFetch<ThesisListItem[]>("/api/thesis");
}

export interface CreatedThesis {
  id: string;
  title: string;
  language: string | null;
  docMode: string;
}

/**
 * POST /api/thesis. Only `title`/`language` are sent — templateId,
 * normProfileId, frontMatter and sections all take server defaults (the
 * onboarding wizard that picks those is out of scope for this plan). The
 * server enforces free-tier = 1 thesis and returns 402 with
 * `code: "thesis_limit"` on exhaustion (modakerati-server/src/lib/billing/thesis-limit.ts:42)
 * — callers should catch `StudentApiError` and check `.status === 402`.
 */
export async function createThesis(input: {
  title: string;
  language: string;
}): Promise<CreatedThesis> {
  return studentFetch<CreatedThesis>("/api/thesis", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getThesisDocument(thesisId: string): Promise<DocumentDTO> {
  return studentFetch<DocumentDTO>(`/api/thesis/${thesisId}/document`);
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Confirm the env var already exists**

```bash
grep -w MODAKERATI_SERVER_URL ~/modakerati-dashboard/.env.local.example
```

Expected: one line, already present (added for admin/server-to-server calls, see `src/lib/api/server.ts`) — no `.env` change needed for this plan.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/student.ts
git commit -m "feat(web-app): bearer-token API client for modakerati-server's student endpoints"
```

---

### Task 4: `/app` auth branch in the Supabase middleware

Today, any signed-out visitor to a non-public path is sent to `/login` — the **staff** sign-in page, which redirects into `/d` on success. A student needs their own destination. This task gives `/app/*` its own gate.

**Files:**
- Modify: `src/lib/supabase/middleware.ts`

- [ ] **Step 1: Add the student-auth path set and the two new branches**

Insert the new `STUDENT_AUTH_PATHS` set next to `PUBLIC_PATHS`, and the two new branches immediately after the existing `PUBLIC_PATHS` check and before the existing `!user` check:

```typescript
// src/lib/supabase/middleware.ts
const PUBLIC_PATHS = new Set(["/", "/guide", "/privacy", "/terms", "/accessibility"]);

// The student surface's own sign-up/sign-in pages. Public — but a signed-in
// visitor is sent straight into /app instead of being shown the form again.
const STUDENT_AUTH_PATHS = new Set(["/app/login", "/app/signup"]);
```

```typescript
  if (PUBLIC_PATHS.has(pathname)) {
    return supabaseResponse;
  }

  // Student auth pages: public, but redirect a signed-in visitor into /app.
  if (STUDENT_AUTH_PATHS.has(pathname)) {
    if (user) {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  // The student surface has its own sign-in page. Without this branch, a
  // signed-out visitor to /app/* would fall into the staff rule below and land
  // on /login, which redirects into /d on success — the wrong destination for
  // a student, and a page that never mentions Kwill's student product at all.
  // Anchored to a path boundary (not a bare startsWith) so a future sibling
  // route like /apply or /approve can never be silently swept into this gate.
  if ((pathname === "/app" || pathname.startsWith("/app/")) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/app/login";
    return NextResponse.redirect(url);
  }

  // Unauthenticated → redirect to /login
  if (!user && !pathname.startsWith("/login")) {
```

The rest of the file (the staff `/login` redirect rules) is unchanged.

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/supabase/middleware.ts
git commit -m "feat(web-app): /app gets its own sign-in redirect, separate from staff /login"
```

---

### Task 5: `ParagraphBlock`

**Files:**
- Create: `src/features/workspace/components/blocks/ParagraphBlock.tsx`

- [ ] **Step 1: Write the component**

`level` (0–6) is the paragraph's heading depth — 0 renders as body text, 1–6 as `h1`–`h6`. `direction` falls back to content detection when the server didn't resolve one.

```tsx
// src/features/workspace/components/blocks/ParagraphBlock.tsx
import { createElement } from "react";
import { detectDir } from "../../lib/direction";
import type { DocBlockDTO } from "../../types";

type ParagraphBlockDTO = Extract<DocBlockDTO, { kind: "paragraph" }>;

const ALIGN_CLASS: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
  both: "text-justify",
};

export function ParagraphBlock({ block }: { block: ParagraphBlockDTO }) {
  const dir = block.direction ?? detectDir(block.text);
  const tag = block.level > 0 ? `h${block.level}` : "p";
  const sizeClass =
    block.level === 1
      ? "text-2xl font-semibold"
      : block.level === 2
        ? "text-xl font-semibold"
        : block.level > 0
          ? "text-lg font-medium"
          : "text-base";

  return createElement(
    tag,
    {
      id: `block-${block.index}`,
      dir,
      className: `${sizeClass} ${ALIGN_CLASS[block.alignment ?? ""] ?? ""} text-text leading-relaxed`,
    },
    block.text || " ",
  );
}
```

` ` (a non-breaking space) keeps an empty paragraph from collapsing to zero height, matching how the app treats blank paragraphs.

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/workspace/components/blocks/ParagraphBlock.tsx
git commit -m "feat(web-app): render paragraph/heading document blocks"
```

---

### Task 6: `TableBlock`

v1 renders plain rows and a header flag only — cell fills, borders, colspans, and per-cell images/lists (`fills`/`textColors`/`spans`/`cellImages`/`cellLists` on the real DTO) are not drawn here; that fidelity is out of scope for this plan.

**Files:**
- Create: `src/features/workspace/components/blocks/TableBlock.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/features/workspace/components/blocks/TableBlock.tsx
import { detectDir } from "../../lib/direction";
import type { DocBlockDTO } from "../../types";

type TableBlockDTO = Extract<DocBlockDTO, { kind: "table" }>;

export function TableBlock({ block }: { block: TableBlockDTO }) {
  const flatText = block.rows.flat().join(" ");
  const dir = block.direction ?? detectDir(flatText);
  const [headerRow, ...bodyRows] = block.rows;
  const hasHeader = block.header && headerRow;
  const bodyStart = hasHeader ? bodyRows : block.rows;

  return (
    <table
      id={`block-${block.index}`}
      dir={dir}
      className="w-full border-collapse border border-border text-sm"
    >
      {hasHeader && (
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th key={i} className="border border-border bg-card-hover px-3 py-2 text-start font-medium text-text">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {bodyStart.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci} className="border border-border px-3 py-2 text-text">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
git add src/features/workspace/components/blocks/TableBlock.tsx
git commit -m "feat(web-app): render table document blocks"
```

---

### Task 7: `TextboxBlock`

**Files:**
- Create: `src/features/workspace/components/blocks/TextboxBlock.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/features/workspace/components/blocks/TextboxBlock.tsx
import { detectDir } from "../../lib/direction";
import type { DocBlockDTO } from "../../types";

type TextboxBlockDTO = Extract<DocBlockDTO, { kind: "textbox" }>;

const ALIGN_CLASS: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
  both: "text-justify",
};

export function TextboxBlock({ block }: { block: TextboxBlockDTO }) {
  const dir = block.direction ?? detectDir(block.text);

  return (
    <div
      id={`block-${block.index}`}
      dir={dir}
      className={`px-4 py-3 text-text ${block.shape.rounded ? "rounded-xl" : "rounded-none"} ${ALIGN_CLASS[block.alignment ?? ""] ?? ""}`}
      style={{
        backgroundColor: block.shape.fill ?? undefined,
        border: block.shape.border
          ? `${block.shape.border.pt}pt solid ${block.shape.border.color}`
          : undefined,
      }}
    >
      {block.lines.map((line, i) => (
        <p
          key={i}
          dir={line.direction ?? detectDir(line.text)}
          className={`${ALIGN_CLASS[line.alignment ?? ""] ?? ""} ${line.bold ? "font-semibold" : ""}`}
          style={line.sizePt ? { fontSize: `${line.sizePt}pt` } : undefined}
        >
          {line.text || " "}
        </p>
      ))}
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
git add src/features/workspace/components/blocks/TextboxBlock.tsx
git commit -m "feat(web-app): render textbox document blocks"
```

---

### Task 8: `ImageBlock`

Three sources, in priority order: an inline `dataUri`, a native chart's `svg`, or (when `hasMedia` is true and neither is present) a lazy-loaded authenticated image.

**The `svg` field needs care.** It is server-rebuilt vector from the thesis's own chart XML — not raw user upload — but this plan does not audit `docx-chart.ts`'s output for injected `<script>`/event-handler content, so it is never injected into the DOM with `dangerouslySetInnerHTML` (which *would* execute any script tag it contained). It is instead base64-encoded and rendered through a plain `<img src="data:image/svg+xml;base64,...">` — an `<img>` tag never executes scripts embedded in an SVG payload, regardless of what the payload contains, so this is safe independent of that audit.

**Files:**
- Create: `src/features/workspace/components/blocks/ImageBlock.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/features/workspace/components/blocks/ImageBlock.tsx
import { detectDir } from "../../lib/direction";
import type { DocBlockDTO } from "../../types";

type ImageBlockDTO = Extract<DocBlockDTO, { kind: "image" }>;

export function ImageBlock({
  block,
  thesisId,
  accessToken,
}: {
  block: ImageBlockDTO;
  thesisId: string;
  accessToken: string | null;
}) {
  // Page ornaments are background decoration Word paints around the whole
  // page, not a figure in the reading flow — the app hides these too.
  if (block.ornament) return null;

  let src: string | null = null;
  if (block.dataUri) {
    src = block.dataUri;
  } else if (block.svg) {
    // See the task note above: base64 into an <img>, never dangerouslySetInnerHTML.
    const base64 = Buffer.from(block.svg, "utf-8").toString("base64");
    src = `data:image/svg+xml;base64,${base64}`;
  } else if (block.hasMedia && accessToken) {
    // A plain <img> can't carry an Authorization header, so the token travels
    // as a query param — the server's auth middleware accepts this fallback
    // specifically for non-fetch loads (modakerati-server/src/middleware/auth.ts).
    const base = process.env.NEXT_PUBLIC_MODAKERATI_SERVER_URL ?? "http://localhost:3000";
    src = `${base}/api/thesis/${thesisId}/document/media/${block.index}?token=${encodeURIComponent(accessToken)}`;
  }

  return (
    <figure id={`block-${block.index}`} className="flex flex-col items-center gap-2 py-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- data: and authenticated URLs, not a static asset next/image can optimize
        <img
          src={src}
          alt={block.caption ?? ""}
          width={block.width}
          height={block.height}
          className="max-w-full h-auto"
        />
      ) : (
        <div className="w-full max-w-md aspect-video border border-dashed border-border rounded-lg flex items-center justify-center text-subtext text-sm">
          {block.caption ?? "—"}
        </div>
      )}
      {block.caption && (
        <figcaption dir={detectDir(block.caption)} className="text-sm text-subtext text-center">
          {block.caption}
        </figcaption>
      )}
    </figure>
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
git add src/features/workspace/components/blocks/ImageBlock.tsx
git commit -m "feat(web-app): render image/chart document blocks

Charts render via a base64 <img>, never dangerouslySetInnerHTML, so an SVG
payload can never execute script content regardless of what it contains."
```

---

### Task 9: `OtherBlock` + `DocumentBlocks` aggregator

**Files:**
- Create: `src/features/workspace/components/blocks/OtherBlock.tsx`
- Create: `src/features/workspace/components/DocumentBlocks.tsx`
- Modify: `src/features/workspace/index.ts` (new file)

- [ ] **Step 1: Write `OtherBlock`**

```tsx
// src/features/workspace/components/blocks/OtherBlock.tsx
import { detectDir } from "../../lib/direction";
import type { DocBlockDTO } from "../../types";

type OtherBlockDTO = Extract<DocBlockDTO, { kind: "other" }>;

export function OtherBlock({ block }: { block: OtherBlockDTO }) {
  return (
    <div
      id={`block-${block.index}`}
      dir={detectDir(block.text ?? "")}
      className="px-3 py-2 text-sm text-subtext italic"
    >
      {block.text || `— ${block.tag} —`}
    </div>
  );
}
```

- [ ] **Step 2: Write `DocumentBlocks`**

```tsx
// src/features/workspace/components/DocumentBlocks.tsx
import type { DocBlockDTO } from "../types";
import { ParagraphBlock } from "./blocks/ParagraphBlock";
import { TableBlock } from "./blocks/TableBlock";
import { TextboxBlock } from "./blocks/TextboxBlock";
import { ImageBlock } from "./blocks/ImageBlock";
import { OtherBlock } from "./blocks/OtherBlock";

export function DocumentBlocks({
  blocks,
  thesisId,
  accessToken,
}: {
  blocks: DocBlockDTO[];
  thesisId: string;
  accessToken: string | null;
}) {
  return (
    <div className="space-y-3 max-w-3xl mx-auto py-8">
      {blocks.map((block) => {
        switch (block.kind) {
          case "paragraph":
            return <ParagraphBlock key={block.index} block={block} />;
          case "table":
            return <TableBlock key={block.index} block={block} />;
          case "textbox":
            return <TextboxBlock key={block.index} block={block} />;
          case "image":
            return (
              <ImageBlock
                key={block.index}
                block={block}
                thesisId={thesisId}
                accessToken={accessToken}
              />
            );
          case "other":
            return <OtherBlock key={block.index} block={block} />;
          default:
            // Defensive backstop, not dead code: lib/api/student.ts does a bare
            // `as T` cast with no runtime validation, so a server-side DTO
            // addition or a malformed payload can reach here with a `kind`
            // outside today's 5-member union. Render something visible rather
            // than silently dropping content a student can't otherwise see.
            return (
              <div
                key={(block as { index?: number }).index ?? -1}
                className="px-3 py-2 text-sm text-subtext italic"
              >
                — unsupported block —
              </div>
            );
        }
      })}
    </div>
  );
}
```

- [ ] **Step 3: Write the barrel**

```typescript
// src/features/workspace/index.ts
export * from "./types";
export { DocumentBlocks } from "./components/DocumentBlocks";
```

- [ ] **Step 4: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/workspace/components/blocks/OtherBlock.tsx \
        src/features/workspace/components/DocumentBlocks.tsx \
        src/features/workspace/index.ts
git commit -m "feat(web-app): document block dispatcher + workspace feature barrel"
```

---

### Task 10: i18n bundles

Two feature-local locale bundles, registered in `src/i18n/messages.ts` exactly the way every other feature already is.

**Files:**
- Create: `src/features/student-app/locales/en.json`
- Create: `src/features/student-app/locales/fr.json`
- Create: `src/features/student-app/locales/ar.json`
- Create: `src/features/workspace/locales/en.json`
- Create: `src/features/workspace/locales/fr.json`
- Create: `src/features/workspace/locales/ar.json`
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: `src/features/student-app/locales/en.json`**

```json
{
  "studentApp": {
    "signUp": {
      "title": "Create your Kwill account",
      "email": "Email",
      "password": "Password",
      "submit": "Sign up",
      "haveAccount": "Already have an account?",
      "signInLink": "Sign in",
      "checkEmail": "Check your email to confirm your account, then sign in."
    },
    "signIn": {
      "title": "Sign in to Kwill",
      "email": "Email",
      "password": "Password",
      "submit": "Sign in",
      "noAccount": "New to Kwill?",
      "signUpLink": "Create an account"
    },
    "home": {
      "title": "Your theses",
      "emptyTitle": "You don't have a thesis yet",
      "emptyCta": "Create your first thesis",
      "newThesis": "New thesis",
      "updated": "Updated {date}"
    },
    "newThesis": {
      "title": "New thesis",
      "titleLabel": "Title",
      "languageLabel": "Language",
      "submit": "Create",
      "limitReached": "You already have a thesis on the free plan. Open it from your app to continue, or upgrade from the Kwill app.",
      "backToTheses": "Back to your theses",
      "createFailed": "Something went wrong creating your thesis. Please try again."
    }
  }
}
```

- [ ] **Step 2: `src/features/student-app/locales/fr.json`**

```json
{
  "studentApp": {
    "signUp": {
      "title": "Créez votre compte Kwill",
      "email": "E-mail",
      "password": "Mot de passe",
      "submit": "S'inscrire",
      "haveAccount": "Vous avez déjà un compte ?",
      "signInLink": "Se connecter",
      "checkEmail": "Vérifiez votre e-mail pour confirmer votre compte, puis connectez-vous."
    },
    "signIn": {
      "title": "Connexion à Kwill",
      "email": "E-mail",
      "password": "Mot de passe",
      "submit": "Se connecter",
      "noAccount": "Nouveau sur Kwill ?",
      "signUpLink": "Créer un compte"
    },
    "home": {
      "title": "Vos mémoires",
      "emptyTitle": "Vous n'avez pas encore de mémoire",
      "emptyCta": "Créer votre premier mémoire",
      "newThesis": "Nouveau mémoire",
      "updated": "Mis à jour {date}"
    },
    "newThesis": {
      "title": "Nouveau mémoire",
      "titleLabel": "Titre",
      "languageLabel": "Langue",
      "submit": "Créer",
      "limitReached": "Vous avez déjà un mémoire sur l'offre gratuite. Ouvrez-le depuis votre espace pour continuer, ou passez à un forfait supérieur depuis l'application Kwill.",
      "backToTheses": "Retour à vos mémoires",
      "createFailed": "Une erreur est survenue lors de la création de votre mémoire. Veuillez réessayer."
    }
  }
}
```

- [ ] **Step 3: `src/features/student-app/locales/ar.json`**

```json
{
  "studentApp": {
    "signUp": {
      "title": "أنشئ حساب Kwill الخاص بك",
      "email": "البريد الإلكتروني",
      "password": "كلمة المرور",
      "submit": "إنشاء حساب",
      "haveAccount": "لديك حساب بالفعل؟",
      "signInLink": "تسجيل الدخول",
      "checkEmail": "تحقق من بريدك الإلكتروني لتأكيد حسابك، ثم سجّل الدخول."
    },
    "signIn": {
      "title": "تسجيل الدخول إلى Kwill",
      "email": "البريد الإلكتروني",
      "password": "كلمة المرور",
      "submit": "تسجيل الدخول",
      "noAccount": "جديد على Kwill؟",
      "signUpLink": "إنشاء حساب"
    },
    "home": {
      "title": "مذكراتك",
      "emptyTitle": "ليس لديك مذكرة بعد",
      "emptyCta": "أنشئ مذكرتك الأولى",
      "newThesis": "مذكرة جديدة",
      "updated": "آخر تحديث {date}"
    },
    "newThesis": {
      "title": "مذكرة جديدة",
      "titleLabel": "العنوان",
      "languageLabel": "اللغة",
      "submit": "إنشاء",
      "limitReached": "لديك بالفعل مذكرة واحدة ضمن الخطة المجانية. افتحها من مساحتك للمتابعة، أو قم بالترقية من تطبيق Kwill.",
      "backToTheses": "العودة إلى مذكراتك",
      "createFailed": "حدث خطأ أثناء إنشاء مذكرتك. يرجى المحاولة مرة أخرى."
    }
  }
}
```

- [ ] **Step 4: `src/features/workspace/locales/en.json`**

```json
{
  "workspace": {
    "notAvailable": "This thesis doesn't have a live document yet.",
    "untitled": "Untitled thesis"
  }
}
```

- [ ] **Step 5: `src/features/workspace/locales/fr.json`**

```json
{
  "workspace": {
    "notAvailable": "Ce mémoire n'a pas encore de document actif.",
    "untitled": "Mémoire sans titre"
  }
}
```

- [ ] **Step 6: `src/features/workspace/locales/ar.json`**

```json
{
  "workspace": {
    "notAvailable": "لا تحتوي هذه المذكرة على مستند فعّال بعد.",
    "untitled": "مذكرة بدون عنوان"
  }
}
```

- [ ] **Step 7: Register both bundles in `src/i18n/messages.ts`**

Read the file first — it's a manually-maintained import list (see Task-9 research: `import features_support_en from "@/features/support/locales/en.json";` etc., merged per-locale via `Object.assign`). Add four imports (two features × the `en`/`fr`/`ar` you're wiring — repeat for all three locales) alongside the existing ones, and push each into its locale's array:

```typescript
import features_studentapp_en from "@/features/student-app/locales/en.json";
import features_studentapp_fr from "@/features/student-app/locales/fr.json";
import features_studentapp_ar from "@/features/student-app/locales/ar.json";
import features_workspace_en from "@/features/workspace/locales/en.json";
import features_workspace_fr from "@/features/workspace/locales/fr.json";
import features_workspace_ar from "@/features/workspace/locales/ar.json";
```

```typescript
const byLocale: Record<Locale, Record<string, unknown>[]> = {
  en: [shared_en, /* ...existing entries..., */ features_studentapp_en, features_workspace_en],
  fr: [shared_fr, /* ...existing entries..., */ features_studentapp_fr, features_workspace_fr],
  ar: [shared_ar, /* ...existing entries..., */ features_studentapp_ar, features_workspace_ar],
};
```

- [ ] **Step 8: Confirm every JSON file parses**

```bash
cd ~/modakerati-dashboard
for f in src/features/student-app/locales/*.json src/features/workspace/locales/*.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f parses')"
done
```

Expected: 6 lines, each ending "parses".

- [ ] **Step 9: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/features/student-app/locales src/features/workspace/locales src/i18n/messages.ts
git commit -m "i18n(web-app): trilingual strings for student sign-up/in, home, and workspace"
```

---

### Task 11: Sign-up page + action

**Files:**
- Create: `src/app/app/(auth)/signup/action.ts`
- Create: `src/app/app/(auth)/signup/page.tsx`

- [ ] **Step 1: Write the action**

```typescript
// src/app/app/(auth)/signup/action.ts
"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

// Mirrors src/app/login/action.ts's shape (SSR client sets session cookies,
// error surfaces via ?error=), but signUp() has a second outcome: Supabase may
// require email confirmation before a session exists. When it does, `session`
// comes back null even though the call succeeded — that path sends the
// student to /app/login with a "check your email" message instead of /app.
export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const emailRedirectTo = host ? `${proto}://${host}/app/login` : undefined;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: emailRedirectTo ? { emailRedirectTo } : undefined,
  });

  if (error) {
    redirect(`/app/signup?error=${encodeURIComponent(error.message)}`);
  }

  if (!data.session) {
    redirect("/app/login?confirmEmail=1");
  }

  redirect("/app");
}
```

- [ ] **Step 2: Write the page**

```tsx
// src/app/app/(auth)/signup/page.tsx
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button } from "@/components/ui";
import { fInput } from "@/components/ui";
import { LanguageSwitcher } from "@/components/language-switcher";
import { signUp } from "./action";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const t = await getTranslations("studentApp.signUp");

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6 p-8 bg-card rounded-2xl border border-border">
        <h1 className="text-xl font-semibold text-text text-center">{t("title")}</h1>

        <form action={signUp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-subtext">
              {t("email")}
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" className={fInput} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-subtext">
              {t("password")}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              className={fInput}
            />
          </div>

          {error && (
            <div className="px-3.5 py-2.5 bg-danger/10 border border-danger/20 rounded-[10px]">
              <p className="text-danger text-sm">{error}</p>
            </div>
          )}

          <Button type="submit" className="w-full">
            {t("submit")}
          </Button>
        </form>

        <p className="text-sm text-subtext text-center">
          {t("haveAccount")}{" "}
          <Link href="/app/login" className="text-primary hover:underline">
            {t("signInLink")}
          </Link>
        </p>

        <div className="flex justify-center">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS. If `fInput`/`Button` aren't both exported from `@/components/ui`'s barrel, check `src/components/ui/index.ts` and adjust the import — `fInput` is exported from `./primitives`, re-exported via `export * from "./primitives"`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/app/(auth)/signup"
git commit -m "feat(web-app): student sign-up page"
```

---

### Task 12: Sign-in page + action

**Files:**
- Create: `src/app/app/(auth)/login/action.ts`
- Create: `src/app/app/(auth)/login/page.tsx`

- [ ] **Step 1: Write the action**

```typescript
// src/app/app/(auth)/login/action.ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Same shape as src/app/login/action.ts, redirecting to /app instead of /d —
// this is the student surface's sign-in, kept separate so the two audiences
// never share a post-login destination.
export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/app/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/app");
}
```

- [ ] **Step 2: Write the page**

```tsx
// src/app/app/(auth)/login/page.tsx
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button, fInput } from "@/components/ui";
import { LanguageSwitcher } from "@/components/language-switcher";
import { signIn } from "./action";

export default async function StudentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; confirmEmail?: string }>;
}) {
  const { error, confirmEmail } = await searchParams;
  const t = await getTranslations("studentApp.signIn");
  const tSignUp = await getTranslations("studentApp.signUp");

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6 p-8 bg-card rounded-2xl border border-border">
        <h1 className="text-xl font-semibold text-text text-center">{t("title")}</h1>

        {confirmEmail && (
          <div className="px-3.5 py-2.5 bg-primary/10 border border-primary/20 rounded-[10px]">
            <p className="text-primary text-sm">{tSignUp("checkEmail")}</p>
          </div>
        )}

        <form action={signIn} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-subtext">
              {t("email")}
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" className={fInput} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-subtext">
              {t("password")}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={fInput}
            />
          </div>

          {error && (
            <div className="px-3.5 py-2.5 bg-danger/10 border border-danger/20 rounded-[10px]">
              <p className="text-danger text-sm">{error}</p>
            </div>
          )}

          <Button type="submit" className="w-full">
            {t("submit")}
          </Button>
        </form>

        <p className="text-sm text-subtext text-center">
          {t("noAccount")}{" "}
          <Link href="/app/signup" className="text-primary hover:underline">
            {t("signUpLink")}
          </Link>
        </p>

        <div className="flex justify-center">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/app/(auth)/login"
git commit -m "feat(web-app): student sign-in page"
```

---

### Task 13: Workspace layout — auth gate + profile bootstrap

Wraps every page under the `(workspace)` route group. The Supabase middleware (Task 4) already redirects a signed-out visitor before this ever renders — this is the same belt-and-suspenders re-check `src/app/d/layout.tsx` does — and it is the one place every `/app` page passes through, so it's where the profile bootstrap call belongs.

**Files:**
- Create: `src/app/app/(workspace)/layout.tsx`

- [ ] **Step 1: Write the layout**

```tsx
// src/app/app/(workspace)/layout.tsx
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/api/student";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/app/login");

  // Must run before any page under this layout touches thesis data — there is
  // no DB trigger creating the `profiles` row (see lib/api/student.ts).
  await ensureProfile();

  return <div className="min-h-screen bg-background">{children}</div>;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/app/(workspace)/layout.tsx"
git commit -m "feat(web-app): /app auth gate + profile bootstrap, no staff_role check"
```

---

### Task 14: Home page — thesis list or empty state

**Files:**
- Create: `src/app/app/(workspace)/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// src/app/app/(workspace)/page.tsx
import { getTranslations, getLocale } from "next-intl/server";
import Link from "next/link";
import { Card, Button, PageHeader } from "@/components/ui";
import { listMyTheses } from "@/lib/api/student";

export default async function StudentHomePage() {
  const t = await getTranslations("studentApp.home");
  // A Server Component's toLocaleDateString() runs on the server with no
  // implicit browser locale, so it must be passed explicitly — otherwise an
  // fr/ar visitor sees a French/Arabic sentence wrapped around an
  // English-formatted date.
  const locale = await getLocale();
  const theses = await listMyTheses();

  return (
    <div className="max-w-3xl mx-auto p-8">
      <PageHeader
        title={t("title")}
        actions={
          theses.length > 0 && (
            <Link href="/app/new">
              <Button>{t("newThesis")}</Button>
            </Link>
          )
        }
      />

      {theses.length === 0 ? (
        <Card className="text-center py-12">
          <p className="text-subtext mb-4">{t("emptyTitle")}</p>
          <Link href="/app/new">
            <Button>{t("emptyCta")}</Button>
          </Link>
        </Card>
      ) : (
        <div className="space-y-3">
          {theses.map((thesis) => (
            <Link key={thesis.id} href={`/app/${thesis.id}`}>
              <Card className="hover:bg-card-hover transition-colors">
                <h2 className="text-text font-medium">{thesis.title}</h2>
                <p className="text-sm text-subtext">
                  {t("updated", { date: new Date(thesis.updatedAt).toLocaleDateString(locale) })}
                </p>
              </Card>
            </Link>
          ))}
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

Expected: PASS. If `PageHeader`'s `actions` prop rejects a `boolean | ReactElement` union, wrap the conditional in `{theses.length > 0 ? (<Link>...) : null}` instead of `&&` — check the exact `PageHeader` prop type in `src/components/ui/page-header.tsx` if this fails.

- [ ] **Step 3: Commit**

```bash
git add "src/app/app/(workspace)/page.tsx"
git commit -m "feat(web-app): student home — thesis list or empty state"
```

---

### Task 15: New-thesis page + action

**Files:**
- Create: `src/app/app/(workspace)/new/action.ts`
- Create: `src/app/app/(workspace)/new/page.tsx`

- [ ] **Step 1: Write the action**

```typescript
// src/app/app/(workspace)/new/action.ts
"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createThesis, StudentApiError } from "@/lib/api/student";

export async function createNewThesis(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const language = String(formData.get("language") ?? "fr");

  if (!title) {
    redirect("/app/new?error=" + encodeURIComponent("Title is required"));
  }

  let thesis;
  try {
    thesis = await createThesis({ title, language });
  } catch (e) {
    if (e instanceof StudentApiError && e.status === 402) {
      redirect("/app/new?limit=1");
    }
    // Never forward a raw StudentApiError/fetch message here: on a non-402
    // failure it can be modakerati-server's own `${path} -> ${status}` string
    // (see lib/api/student.ts's studentFetch) or a raw fetch failure —
    // internal plumbing a student has no use for and shouldn't see.
    const t = await getTranslations("studentApp.newThesis");
    redirect("/app/new?error=" + encodeURIComponent(t("createFailed")));
  }

  redirect(`/app/${thesis.id}`);
}
```

- [ ] **Step 2: Write the page**

```tsx
// src/app/app/(workspace)/new/page.tsx
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button, fInput, PageHeader } from "@/components/ui";
import { createNewThesis } from "./action";

const LANGUAGES = ["fr", "ar", "en"] as const;

export default async function NewThesisPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; limit?: string }>;
}) {
  const { error, limit } = await searchParams;
  const t = await getTranslations("studentApp.newThesis");

  return (
    <div className="max-w-lg mx-auto p-8">
      <PageHeader title={t("title")} />

      <form action={createNewThesis} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="title" className="block text-sm font-medium text-subtext">
            {t("titleLabel")}
          </label>
          <input id="title" name="title" type="text" required className={fInput} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="language" className="block text-sm font-medium text-subtext">
            {t("languageLabel")}
          </label>
          <select id="language" name="language" defaultValue="fr" className={fInput}>
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {limit && (
          <div className="px-3.5 py-2.5 bg-warning/10 border border-warning/20 rounded-[10px] space-y-2">
            <p className="text-warning text-sm">{t("limitReached")}</p>
            <Link href="/app" className="text-sm text-primary hover:underline inline-block">
              {t("backToTheses")}
            </Link>
          </div>
        )}

        {error && (
          <div className="px-3.5 py-2.5 bg-danger/10 border border-danger/20 rounded-[10px]">
            <p className="text-danger text-sm">{error}</p>
          </div>
        )}

        <Button type="submit" className="w-full">
          {t("submit")}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/modakerati-dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/app/(workspace)/new"
git commit -m "feat(web-app): new-thesis form, surfaces the free-tier limit as a message"
```

---

### Task 16: The workspace page

**Files:**
- Create: `src/app/app/(workspace)/[thesisId]/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// src/app/app/(workspace)/[thesisId]/page.tsx
import { getTranslations } from "next-intl/server";
import { getThesisDocument, getAccessToken } from "@/lib/api/student";
import { DocumentBlocks } from "@/features/workspace";
import { detectDir } from "@/features/workspace/lib/direction";

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

  const accessToken = await getAccessToken();

  return (
    <div>
      <header className="border-b border-border px-8 py-4">
        <h1 dir={detectDir(doc.title)} className="text-lg font-semibold text-text">
          {doc.title || t("untitled")}
        </h1>
      </header>
      <DocumentBlocks blocks={doc.blocks} thesisId={thesisId} accessToken={accessToken} />
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
git add "src/app/app/(workspace)/[thesisId]"
git commit -m "feat(web-app): the document workspace — fetches and renders the thesis as blocks"
```

---

### Task 17: Full verification pass

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

Expected: PASS, including the 5 `detectDir` tests from Task 1.

- [ ] **Step 3: Production build**

```bash
cd ~/modakerati-dashboard && npm run build
```

Expected: PASS. This is the gate that catches anything `tsc` can't — an accidentally-client component missing `"use client"`, an unresolved import, etc.

- [ ] **Step 4: Manual smoke pass**

Run `npm run dev`, then walk through, in order — record any failure rather than fixing it inline; note it for follow-up:

- [ ] `/app` while signed out redirects to `/app/login` (not the staff `/login`)
- [ ] Sign up with a new email + password
- [ ] If email confirmation is required: confirm via the email, then sign in at `/app/login`; if not required: land on `/app` directly
- [ ] `/app` shows the empty state with a "create your first thesis" CTA
- [ ] Create a thesis (title + language) — lands on `/app/<id>`, document blocks render
- [ ] Go back to `/app` — the new thesis appears in the list
- [ ] Try creating a second thesis — the free-tier-limit message appears, not a crash
- [ ] Sign out, sign back in at `/app/login` — lands on `/app`, the thesis is still there
- [ ] Repeat the whole pass once with a French-language thesis and once with an Arabic-language thesis — confirm paragraph/table/textbox blocks render RTL for the Arabic one
- [ ] Visit `/d` — confirm the staff console is unaffected (still gated by `staff_role`, unrelated to anything this plan touched)

- [ ] **Step 5: Record results**

If anything in Step 4 failed, note it in a follow-up task before treating this plan as done — this plan's definition of done is the checklist below, not "the code compiles."

## Definition of done

- `npx tsc --noEmit`, `npm test`, and `npm run build` all exit 0 in `~/modakerati-dashboard`.
- A signed-out visitor to `/app/*` lands on `/app/login`, never the staff `/login`.
- A new student can sign up, create a thesis (subject to the free-tier limit), and see it rendered as real document blocks — paragraphs, tables, textboxes, images/charts — in both LTR and RTL.
- `/d` (the staff console) is unaffected.

## Explicitly not done here

- The AI chat panel and everything it depends on (streaming, control-frame parsing, `modk://b/N` block links, multi-thread history) — a separate follow-up plan.
- Manual block editing, payments/upgrade UI, the template/university onboarding wizard, Google/Apple sign-in.
- Table cell fills/borders/spans, floating shape (`anchors`) overlays, section header/footer chrome.
