# Kwill on the web — the product in a browser

**Date:** 2026-08-20
**Status:** SUPERSEDED 2026-08-25 — see `2026-08-25-kwill-web-nextjs-design.md`.
Branch `feat/web-version` has 9/14 foundation tasks committed and working
(`npx expo export --platform web` succeeds as of 2026-08-21) but is paused, not
abandoned by any technical finding — a deliberate choice was made to build a
second web client inside `modakerati-dashboard` instead. Do not resume this
plan without checking that decision still holds.
**Ships before:** February 2027 (ahead of the فيفري → جوان season peak)

## The idea

A student writes their mémoire on a laptop. They always have. The phone is where
they check it, ask a question, and panic at midnight — but the actual writing,
the eight-hour formatting session the week before المناقشة, happens sitting at a
PC in a cyber or at home.

Kwill today cannot be opened on that PC. This spec puts the product in the
browser at the same URL a student can paste to a classmate.

It is **not** a marketing site and **not** a read-only viewer. It is the writing
core: sign in, open your thesis, edit it, talk to the AI about it, pay, and
download the .docx. Everything else the app does stays on the phone for now.

## Why this shape

Six decisions were made before the design and everything below follows from them.

**One codebase, not a fourth repo.** There are already three repos moving against
one Supabase project and one fast-moving server. A separate Next.js front-end
would mean maintaining two clients against that server forever, and the web
version would arrive after the season it was built for. Expo's web target keeps
the 42 Zustand stores, `lib/api.ts`, the trilingual layer and the RTL logic
shared by construction — an RTL fix or a new AI tool lands on both platforms the
same day.

**The writer is already web code, and that is what makes this cheap.** Eleven
files under `components/workspace/` are `'use dom'` components — the Lexical
editor, the page-layout engine, the MathJax preview. On native they are a
webview. On web the `dom` prop is ignored and they render as plain React DOM.
The single most complex thing in the product ports for free.

**Only four things are actually broken.** Not 365 files — four seams: the
filesystem, the SQLite caches, the webview components, and two boot-time native
imports. Each gets a narrow façade with a `.web.ts` twin so call sites stay
platform-blind.

**The desktop layout is a different information architecture, not a media
query — but only on one screen.** Auth, library, settings and subscription need a
max-width and nothing else. The workspace needs pinned structure, the document,
and a docked chat all visible at once. So the workspace gets its own
`.web.tsx`; everything else goes responsive in place. This keeps `isDesktop &&`
branching out of screens that ship today.

**Day one is the writing core, deliberately.** Auth → create → library →
workspace → chat → export, plus subscription. About twenty routes of the
fifty-nine. A student can do the whole real job, starting from nothing. The
rescue lane, voice, tasks, news, support and the labs stay on the phone until
the core is proven in a browser.

Creating a thesis is in scope for a structural reason, not an ambitious one:
`components/AppDrawer.tsx` puts «New thesis» in the drawer, and on web the
drawer *is* the permanent rail. An out-of-scope route sitting one click away in
the always-visible sidebar would contradict the rule below that out-of-scope
routes are never reachable by tapping. Either creation ships or the rail lies.

**The bundle must be gated by an export, not by types.** `npx tsc --noEmit` is
the only automated check this repo has, and it is provably blind to the failure
class that matters here — a `use dom` file with a named export once broke an
entire screen at bundle time with tsc green.

## Delivery

Same repo, same `app/` tree. A `web` block is added to `app.json`:

- **`output: "single"`** — a client-rendered SPA. Not `static`: every route in
  the day-one scope is behind auth, so pre-rendered HTML buys no SEO and only
  multiplies build outputs. Not `server`: the Hono API already exists in
  `~/modakerati-server`, and Expo API routes would be a second backend.
- Bundler is Metro (the v56 default). Favicon, theme colour and `lang` come from
  the existing brand constants.

**Host: Vercel**, alongside the staff dashboard. Two consequences that are part
of this design, not afterthoughts:

1. **An SPA rewrite rule is mandatory.** With `output: "single"` there is exactly
   one `index.html`. Without a catch-all rewrite, a refresh on any client-side
   route returns 404. This is the single most common way this deployment is
   broken on Vercel.
2. **CORS becomes a server change.** The web app is a different origin from
   `modakerati.greenpedal.net`. The Hono server has only ever served a native
   client, which has no origin and therefore never triggered a preflight. It must
   now allow the web origin — and Supabase must allow-list that same origin as a
   redirect URL, or OAuth dead-ends after the provider hands control back.

### Adding `web` to app.json moves the native runtime version

`app.json` is a fingerprint input, and `fingerprint.config.js` ignores only
Gradle build output — so adding a `web` block **changes the Android and iOS
runtime version**. Every already-installed binary stops being offered OTA
updates until a new APK is built at the new fingerprint.

This is accepted rather than worked around. The alternative — a conditional
`app.config.js` that hides the `web` key from native fingerprint resolution —
trades a one-time rebuild for permanent fragility in the release path, and this
repo's release order is already the most delicate thing it does. The
consequence is a sequencing rule, not a code change: the commit adding the
`web` block is **native-affecting**, and must be followed by the existing order
— commit → build the APK → verify its fingerprint → publish the OTA. The plan
resolves the fingerprint before and after so the move is observed rather than
discovered.

### The environment trap

`EXPO_PUBLIC_*` values are inlined into the bundle at build time. A web build run
against the working `.env` ships a public site pointing at a LAN address —
exactly the failure `scripts/publish-update.sh` already exists to prevent for
OTA. The web build gets the same guard: `scripts/build-web.sh` swaps in
`.env.production` before exporting and restores afterwards. Nobody calls
`expo export --platform web` directly, for the same reason nobody calls
`eas update` directly.

## The four seams

Each is a façade whose native and web implementations satisfy the same exported
signatures, so no call site learns which platform it is on.

### 1. Filesystem — `expo-file-system` has no web support at all

Confirmed against the v56 docs: web is absent from the platform list, for both
the current `File`/`Directory`/`Paths` API and the legacy one. Eleven files touch
it. A `lib/fs/` façade covers the three things the day-one scope actually needs:

| Need | Native | Web |
|---|---|---|
| Hand the student an export | cache dir + `expo-sharing` | `Blob` → object URL → anchor download |
| Take a file from the student | `expo-document-picker` | `<input type="file">` |
| Read a file as a data URI | `File.base64()` | `FileReader` |

`lib/download-export.ts` deliberately fetches the signed export rather than
opening it in a browser, because the URL carries a JWT in its query string and an
external open would leak that token into browser history. The web path preserves
that property exactly: fetch to a Blob in-page, download from an object URL. The
token never reaches the address bar.

**The rule that keeps the bundle alive:** no web-reachable module may import
`expo-file-system` at module scope. This is how out-of-scope screens
(`rescue-store`, `combine-store`, `import-store`) stay merely unreachable instead
of breaking the build.

### 2. Caches — `expo-sqlite` on web is rejected

Four modules share one `kwill.db`: `thesis-op-queue`, `thesis-doc-cache`,
`outline-cache`, `chat-cache`. The v56 docs *do* offer a web build, and it is
being turned down on purpose:

- it is **alpha** and documented as possibly unstable;
- it needs wasm Metro configuration;
- it requires `Cross-Origin-Embedder-Policy: credentialless` and
  `Cross-Origin-Opener-Policy: same-origin` to get `SharedArrayBuffer`.

That last one is disqualifying. COEP constrains how every cross-origin
subresource on the page may load, and this product renders Supabase-hosted figure
images inside the document. Paying with the images to buy SQL we do not need is
a bad trade.

This is not a prediction. `scripts/publish-update.sh` already carries the
post-mortem: *"The web export dies on expo-sqlite: its web build imports
`./wa-sqlite/wa-sqlite.wasm`, that file is not in the published package, and
Metro fails the whole export over it."* Someone here has already run this
experiment. The `.web.ts` twins are therefore what makes a web build possible at
all, not an optimisation — removing the last web-reachable `expo-sqlite` import
is the fix. (That same comment independently reaches this spec's conclusion
about `app.json` being a fingerprint input.)

Instead: **IndexedDB twins** with identical exports. This is safe because the
modules are already written as narrow, failure-swallowing interfaces —
`thesis-op-queue.ts` is 118 lines whose contract is explicitly "persistence is a
reliability net; a broken disk queue must never break live editing." An
IndexedDB implementation honours that contract unchanged, and
`stores/thesis-doc-store.ts` never learns anything happened.

`chat-cache.ts` (259 lines) is the largest of the four and the only one with
non-trivial queries; it is the one to write first and the one most likely to need
its own shape rather than a mechanical translation.

### 3. WebView components — four files become iframes

`OnlyOfficeView`, `WordDocxView`, `PdfView` and `RenderHtml` each get a
`.web.tsx` sibling rendering an `<iframe>`. Platform extensions outside `app/`
need no base file, so these are pure additions.

### 4. Boot — two native imports on the startup path

`lib/push-notifications.ts` already lazy-`require`s `expo-notifications` behind
an Expo Go check, so it does not break the bundle; it needs a `web` branch added
to that same guard so every push path becomes a no-op. `lib/i18n.ts` calls
`reloadAppAsync` from `expo` for `restartApp` — **not** `expo-updates`; the
comment there is explicit that no updates dependency is wanted. Its web
behaviour is not relied upon: `restartApp` gets an explicit web branch calling
`location.reload()`, which is what the language switch needs anyway, since
re-applying text direction requires a genuine document reload.

## The desktop layout

One `hooks/useBreakpoint.ts` reading `useWindowDimensions()`, breaking at 1024.

**The sidebar is free.** The root is already an `expo-router/drawer` navigator.
React Navigation's `drawerType: "permanent"` turns it into a pinned rail at
≥1024 with no new navigator and no new component. `app/_layout.tsx` already
derives `DRAWER_POSITION` from `I18nManager.isRTL`, so the rail lands on the
right in Arabic on day one without a line of new RTL code.

**Simple screens** — auth, library, settings, subscription — get one shared
max-width container. That is the entire change for those routes.

**`app/(app)/thesis-workspace.web.tsx`** is the one genuinely new screen: a
structure rail, the A4 document, and a docked chat panel, all against the same
stores the mobile screen uses. Expo Router permits a `.web.tsx` route only when
the base file exists — `thesis-workspace.tsx` does, and its 1144 lines are not
touched. Mobile regression risk on the most complex screen in the product is
therefore zero.

The writer inside that layout is `WorkspaceLexicalView`, unchanged.

## Scope

**In, day one (~20 routes):** `login`, `signup`, `forgot-password`,
`reset-password`, `language`, `library`, `start-thesis`, `thesis-title`,
`thesis-topic`, `thesis-fields`, `thesis-plan`, `thesis-workspace`, `chat`,
`export`, `export-success`, `subscription`, `payment-success`,
`payment-failed`, `settings`, `account`.

`start-thesis` has two branches. The **from-scratch** branch is in scope. The
**import-an-existing-.docx** branch is not: it needs the document picker and
leads into the rescue lane, both of which are out. On web the import branch is
hidden rather than disabled — a greyed-out button on the first screen a new user
sees is a worse answer than an honest single path. New theses on web use the
default template; template browsing is out day one.

**Out, day one** — reachable on the phone, hidden from web navigation and guarded
if entered by URL: the rescue lane (6 routes), voice lab, tasks and task-run,
news, the support centre, combine/arrange, import-analysis, the Lexical labs,
push notifications, template browsing (`browse-templates`,
`university-templates`, `template-preview`), and the import branch of
`start-thesis`.

A guarded out-of-scope route renders a short "open this on the Kwill app" panel
rather than a blank screen or a crash. It must never be reachable by tapping.

## Verification

There is no JS test runner in this repo and this spec does not add one. The gate
is two commands, and the second is the one that matters:

```bash
npx tsc --noEmit
npx expo export --platform web
```

The export is what catches a native module reaching a web-reachable path, and
the `use dom` single-export violation that types cannot see. It becomes part of
the definition of done for every task in the plan, not a final step.

Beyond that, a manual smoke list per milestone: sign in with email, sign in with
Google, create a thesis from scratch, open it, type a paragraph and confirm it
survives a refresh (the IndexedDB queue), ask the AI to change something and
watch it land, export and download the .docx — then do all of it once in Arabic
to confirm direction, and once on a hard refresh of a deep route to confirm the
Vercel SPA rewrite.

## Risks

**Bundle weight.** `mathjax-full` and Lexical are both large, and react-native-web
adds its own. MathJax must be lazily loaded or first paint suffers on the
connections Algerian students actually have. This is a first-class task, not an
optimisation pass.

**`react-native-reorderable-list`.** It powers `OutlineReorderable`, which lives
*inside* the workspace and is therefore in scope. Its web support is unconfirmed.
Day-one fallback is a non-reorderable outline on web; reordering stays a phone
capability until verified.

**Google OAuth.** The PKCE flow is pinned to `plain` because Hermes has no
`TextEncoder`. Browsers do have it, so the web path should negotiate a genuine
S256 challenge rather than inherit a workaround for a constraint it does not
share. The redirect must remain `/`.

**Text selection and IME.** react-native-web's text handling is weaker than the
DOM's. This mostly does not matter, because the writer is already real DOM — but
it will show up in chat input and in any place the app renders long prose in
`<Text>`.

**Session storage.** `secureStoreAdapter` already falls back to `localStorage` on
web, so auth works unchanged — but a shared cyber PC is a real deployment
environment for this product, and localStorage persists. A logout that genuinely
clears state matters more here than it does on a personal phone.
