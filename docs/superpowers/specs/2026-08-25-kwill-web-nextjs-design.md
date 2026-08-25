# Kwill web v1 — editor + AI chat core, inside the dashboard

**Date:** 2026-08-25
**Status:** design approved, not yet planned
**Supersedes:** `2026-08-20-web-version-design.md` for the "Kwill on the web" goal.

## This deliberately replaces the Expo-web-export approach

A spec from 2026-08-20 already answered "how do we put Kwill in a browser,"
and answered it differently: port the existing Expo app via `output: "single"`
(react-native-web), sharing the mobile app's stores and `lib/api.ts`, deployed
as its own Vercel project alongside the dashboard. That plan is not abandoned
by accident — it is **real, working, and 9 of its 14 foundation tasks are
already committed** on branch `feat/web-version` (`app.json`'s web block, the
web export gate, the localStorage op queue, the no-op cache twins, the boot-path
guards; `npx expo export --platform web` reportedly succeeds there as of
2026-08-21).

This spec exists because, presented with that status, the explicit choice was
made to build a **second, independent** web client instead: a new authenticated
route tree inside `~/modakerati-dashboard`, talking directly to
`~/modakerati-server`'s real student-facing API, with its own document renderer
and chat client written for the DOM rather than ported from React Native. The
reasoning for that choice — reusing the dashboard's already-configured
Supabase/Vercel/UI-kit/i18n plumbing outweighs the two-client maintenance cost —
is the requester's call to make, not a technical conclusion this spec re-derives.
`feat/web-version` and its spec are left in place, untouched, in case work on
that path resumes later; they should not be executed against in the meantime.

## What ships

A student can, entirely from a browser, at a URL under `~/modakerati-dashboard`:
sign up (or sign in with an existing app account — one shared Supabase project),
create a thesis, open the document workspace, and talk to the AI to edit it —
the same tool-driven editing the app does, rendered as a real block-based
document rather than a static preview.

**In scope:**
- Student sign-up / sign-in (Supabase Auth, email+password), separate from the
  staff `staff_role` gate that guards `/d`.
- Thesis creation (title + language; server-enforced free-tier = 1 thesis) and
  a thesis list.
- The document workspace: a block-based renderer for paragraph / table /
  textbox / image / chart blocks, driven by the real `DocumentDTO` the app uses.
- The AI chat panel: streamed replies, the same bracket control-frame protocol
  the app parses, and `modk://b/N` links that scroll to the block they name.
- Multi-thread chat history per thesis (list, switch, auto-titled).

**Explicitly deferred** (separate future sub-projects, not silently dropped):
- Manual in-browser block editing (typing into a paragraph, table cell edits,
  drag reorder). v1 editing is AI-driven only — the page re-renders after each
  turn.
- A payments/subscription purchase or upgrade flow on web. Quota is still
  enforced server-side; hitting it on web just shows a message, no checkout.
- The university/template/norm-profile onboarding wizard. Creation uses server
  defaults.
- Chat attachments, chat search, scheduled tasks, header/footer editing,
  pagination/page-view, OnlyOffice PDF export UI, Google/Apple sign-in.

## Architecture

Lives inside `~/modakerati-dashboard` — reuses its Supabase project, Vercel
deploy, Tailwind/UI kit (`src/components/ui`), and `next-intl` i18n. Sits
alongside the existing `app/d/` (staff console, `staff_role`-gated) and the
root marketing page, as a third route segment: `app/app/` → URL `/app`.

- **Auth boundary.** `src/lib/supabase/middleware.ts` gains an `/app/*` branch:
  requires a signed-in Supabase user, and — unlike `/d` — does **not** check
  `staff_role`. A signed-in staff member visiting `/app` is just a user like
  any other there; no cross-gate needed.
- **API layer.** A new `src/lib/api/student.ts` reads the Supabase session
  client-side and calls `modakerati-server` directly with
  `Authorization: Bearer <access_token>` — the same trust model the Expo app
  uses — rather than proxying every endpoint through Next.js server actions.
  Base URL follows the existing `MODAKERATI_SERVER_URL` convention already used
  by `src/lib/api/server.ts`, exposed to the browser as
  `NEXT_PUBLIC_MODAKERATI_SERVER_URL`.
  **No server-side CORS change is needed** — `modakerati-server`'s Hono app
  already runs global `cors({ origin: "*", allowHeaders: [...,
  "Authorization"] })` (`src/index.ts:49`), confirmed during design.
- **Workspace code.** A new `src/features/workspace/` houses the block
  renderer, the chat panel, and the thread list. These are *new*
  implementations for the DOM, not ports — but they follow the same contracts
  the Expo app's equivalents already define (see Data flow), so behavior stays
  recognizable to anyone who knows the app.

## Data flow

1. **Auth.** Sign up/in via Supabase Auth (client-side) → session for Next.js
   pages. Access token is forwarded as a bearer token on every
   `modakerati-server` call.
2. **Profile bootstrap.** First `/app` visit calls `GET /api/user/profile`,
   which lazily creates the `profiles` row — there is no `on_auth_user_created`
   trigger on the current database, confirmed current in
   `modakerati-server/src/routes/user.ts:20-28`. This must run before anything
   else touches thesis data.
3. **Thesis creation.** "New thesis" → `POST /api/thesis` with `{ title,
   language }` only; other fields (`templateId`, `normProfileId`, etc.) are
   omitted and take server defaults. The route enforces free-tier = 1 thesis
   (`modakerati-server/src/lib/billing/thesis-limit.ts:42`) and returns 402
   `{ error, code: "thesis_limit", plan, limit, used }` on exhaustion — v1
   surfaces that as a plain message, no purchase flow.
4. **Workspace load.** `GET /api/thesis/:id/document` returns the whole
   `DocumentDTO` in one call: `{ id, title, docMode, available, blocks,
   sections, downloadUrl }`
   (`modakerati-server/src/lib/thesis-doc.ts:216-218`). `DocBlockDTO` is a
   union on `kind` — `paragraph` (`text, styleId, level, alignment, direction,
   anchors?`), `table` (`rows: string[][]`, optional per-cell images/lists),
   `textbox` (`text, lines[], shape, alignment, direction`), `image` (covers
   both figures and native charts — `dataUri?` inline ≤~200KB, `hasMedia?` for
   lazy load via `GET /:id/document/media/:index`, or `svg?` for a chart
   rebuilt server-side as vector), `other` (unsupported structural block,
   rendered as a placeholder). Real `<svg><text>` renders Arabic correctly in a
   browser — unlike the app's RNSVG-based renderer, no label-overlay hack is
   needed for chart captions here.
5. **Chat.** `POST /api/threads/for-thesis` gets/creates the active thread;
   `GET /api/threads/:id/messages` (paginated via `since`/`before`/`limit`)
   loads history; sending posts to `POST /api/chat/stream` — a **chunked text
   stream, not SSE** — carrying interleaved answer text and bracket control
   frames (`MODK_THINK`, `MODK_ASK`, `MODK_CONFIRM`, `MODK_DOCCHANGES`,
   `MODK_TITLE`, `MODK_TOOL`, …) that the client parses the same way the app's
   `lib/ai-service.ts` does. Browser `fetch` streams natively — none of the RN
   `expo/fetch` workaround applies here.
6. **Block links.** `modk://b/N` is an ordinary markdown link with a custom
   scheme; the chat renderer's link handler intercepts that scheme and scrolls
   the workspace to the named block index. On `MODK_DOCCHANGES` or turn
   completion, the workspace re-fetches the document so the index a link points
   to is current.

## Verification

- New pure logic (control-frame parsing, block-link resolution, thread
  grouping) gets unit tests via the dashboard's existing vitest setup.
- Manual pass through the dashboard dev server (not just `tsc`/`next build`):
  sign up → create a thesis → ask the AI to change something → confirm it
  renders and the reply's block link scrolls to the right place. Repeat once in
  Arabic to confirm RTL block rendering.
- `npx tsc --noEmit` and `npm run build` (dashboard) both green before calling
  a milestone done.

## Housekeeping

The 2026-08-20 spec's status line should be updated to point here, so nobody
picks up `feat/web-version` assuming it is still the live plan without knowing
this decision was made.
