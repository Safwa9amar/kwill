# Rescue v2 — M4, M5, M6: saved runs, the app, the dashboard (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, the only option (D-21: a fresh implementer per task, a reviewer after each). Do not execute this plan with executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student takes a finished mémoire from Word to a deposit-ready thesis inside the Kwill app: free diagnosis, one-time payment, a repair that survives a closed app, an honest failure with a refund, free re-runs and a full version history. Staff set the price and see every run.

**Architecture:** The document pipeline stays pure in `src/lib/rescue/`; M4 moves its orchestration out of the lab CLI into `src/lib/rescue/pipeline/` with an injected renderer and brain, so the CLI and the server run one code path. A new layer, `src/lib/rescue-run/`, holds everything the no-model guard forbids (database, storage, leases, billing links). A durable job table in Postgres drives one stage at a time: any server process claims a stage by lease, writes its outputs to storage and `stage_state`, and the next claim carries on, so a crash, a recycle or a deploy costs minutes and nothing else. The app is one living screen at `app/(app)/rescue/`, derived from the `phase` the server returns; the phone holds no state that a cold start cannot rebuild. The dashboard adds two pages over `/admin/rescue/*`.

**Tech stack:** Hono, Postgres (`pool` + Drizzle descriptions), Supabase Storage, `@kwill/docx-engine`, real Word on the Mac through `scripts/word-convert-service.mjs`; Expo SDK 56, React Native new architecture, Zustand, `@gorhom/bottom-sheet` 5, Reanimated 4, expo-router, i18next; Next.js, next-intl, Tailwind; vitest everywhere a pure module or a route can run.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md` (D-1 to D-27, §3, §6, §7, §8, §9, §11, §12, §13).
**Mockups:** `docs/superpowers/specs/2026-11-02-rescue-v2/03-living-thesis-flow.html` (lines 229-495), `04-history.html` (lines 282-371). The spec's screen number = the mock's number + 1 from mock 2 on. This plan uses the spec's numbers.

**Not in this plan:** the production brain (M7), the single release itself (§7 of this plan hands it over), deleting the old lane (D-1), a Cloudflare named tunnel, the web lane.

**State of the neighbours when this was written (2026-11-02):** server at `ea026ff`. M2b is still landing: `cover/apply.ts`, `deposit/pack.ts`, `regenerate/dividers.ts`, `regenerate/font-policy.ts`, `regenerate/typed-notes.ts`, `regenerate/caption-position.ts` exist as untracked files, `regenerate/references.ts` is a stub at the time of reading, and nothing is wired into `regenerate/index.ts`, `prove/prove.ts` or `scripts/rescue-lab/cli.ts` yet. M3 (`review/`) has a plan and no code. **Gate 0 (P-53):** M2b's integration and the whole M3 fix loop finish and merge before Group S-A starts, so no other session edits `regenerate/*`, `prove/*`, `scripts/rescue-lab/cli.ts` or `replay.ts` while M4 runs. **The Mac's Word host already has two things this plan once listed as work:** the host-wide lock `scripts/word-lock.mjs` (`withWordLock`, wired into `scripts/word-convert-service.mjs` in commit 8aa300e), so every instance on this Mac converts one file at a time, and commit dcaf210, which stops a stuck copy from blocking later jobs. Word can still wedge on a dialog or a hang, which is what P-54 and Task S10 add.

---

## Decisions taken

The owner delegated every decision and asked not to be asked. Each choice below is final for this plan. D-n are the spec's decisions; P-n are this plan's.

| # | Decision | Reason |
|---|---|---|
| P-1 | Student API at `/api/rescue-v2`, staff API at `/admin/rescue`. PUT and POST only, no PATCH. | `/api/rescue` is the live old lane and its `GET /:id` and `POST /:id/repair` would swallow any `/api/rescue/v2/...` path. CORS in `src/index.ts:52` has no PATCH, which matters when the web lane arrives. |
| P-2 | New names until and after D-1: `stores/rescue-v2-store.ts`, locale block `rescueV2`, `lib/rescue-v2-*.ts`, `components/rescue/`. The route folder is `app/(app)/rescue/` as the spec says; it does not collide with the flat `rescue-*.tsx` screens. | `stores/rescue-store.ts` and `rescue.*` keys serve six live screens and the root layout. Renaming later is churn with no user value, so nothing gets renamed at D-1. |
| P-3 | Production job mechanism: an in-process runner, durable through Postgres. Claim by `FOR UPDATE SKIP LOCKED`, lease 5 min, heartbeat 60 s, commits fenced by `lease_owner`. Woken by the existing per-minute cron on `/api/tasks/tick` (which is also the keep-alive) and by a kick on every enqueue. | A backgrounded promise dies with the process, so durability must live in the DB. Passenger idles the app without traffic, so a timer alone is not enough. A cron-launched worker is worse here: production env lives in `.htaccess`/`app_settings`, each worker counts against the 100-process ceiling that has wedged this account, and `deploy.mjs` deletes `dist/` underneath it. A deploy now costs at most one lease. |
| P-4 | A separate `rescue_jobs` table, not lease columns on `rescue_versions`. | Three jobs have no version (`read_guide`, `parse_note`, `cover_samples`), a version must be immutable once done, and the queue's churn does not belong on the timeline's row. |
| P-5 | Two lanes. `heavy` (Word and CPU stages): at most one running on the whole host, enforced by a partial unique index. `brain`: up to 3 running, which only wait. No `worker_threads`, no child processes. | Word is serial and its queue is shared with PDF view and the AI render tools; pipeline CPU shares the API's event loop, so one heavy stage at a time protects both. Thread exhaustion SIGABRTs this host, so no worker threads. A brain wait must not hold Word. |
| P-6 | Paid and re-run jobs have `priority` 0, free diagnoses 1. | A paying student never queues behind free traffic for the one Word. |
| P-7 | A stage gets 3 attempts, each spent by an error the stage reports. A converter that cannot be reached is not an attempt: the job waits (`waiting_reason='converter'`), the student sees a calm line, and after 48 hours the version fails honestly (`converter_unavailable`). **Amended by P-61:** an attempt is spent when a stage reports an error, not at claim, and a process death is a separate, capped `lease_losses`. | A sleeping Mac must not burn a student's attempts or fail a paid run; a poison stage must not loop forever. |
| P-8 | Add an async job API to the Mac service (`POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/result`, `DELETE /jobs/:id`), content-addressed by a client key, with a `rasterize` op that needs no Word. The old sync endpoints stay for the deployed server. | `/convert` sends headers only when finished, and Cloudflare's edge cuts a response at about 100 s (unverified, and not worth finding out in production); queue wait eats the client timeout; a job that timed out still occupies Word. A job id derived from the bytes makes a resumed stage find its own conversion. `rasterize` saves the "+1 conversion" the host's missing `pdftoppm` would cost. |
| P-9 | Fix the watchdog now: ignore `api.trycloudflare.com`, never kick the Word service when only the tunnel is broken, back off 15 min on a 429. Bind the service to `127.0.0.1` and require `x-word-secret` on `/jobs`. The quick tunnel stays. A named tunnel is out: it needs a Cloudflare-managed zone nobody has verified exists, and P-8 removes the reason it was wanted. | The watchdog's kill loop is the one thing that makes a long conversion impossible (memory: `word-converter-watchdog-loop`). The owner's standing "you decide" (memory: `rescue-v2-full-autonomy`) covers it. Job results hold theses, so they get a secret. |
| P-10 | Uploads are raw bytes, one `PUT` per part, sent with `FileSystem.createUploadTask` from `expo-file-system/legacy`. Limits: a part and the whole upload may each reach `rescue.max_object_mb` ÷ 2.5 (default 50 ÷ 2.5 = 20 MB, P-64), 12 parts; guide 15 MB. Every upload passes `preflightDocx` first (P-56). | Base64 in JSON holds a third more in the phone's JS heap and the server's, and one lost part would resend everything. `PUT /api/thesis/:id/docx` already takes raw bytes. `createUploadTask` reports real progress and keeps going in the background on iOS. The merged source and the PDF are each one stored object and a PDF can grow past its .docx, while local storage caps at 50 MiB and the cloud limit is unverified: a file we cannot store must be refused at upload, not end as `stage_crashed`. §7 raises the setting only after checking the bucket. |
| P-11 | Page images are JPEG, 800 px wide, quality 60, stored content-addressed at `{root}/pages/{sha1}.jpg`. `rescue_versions.pages` is the ordered list of those paths. | The spec's 5 MB per version is low (76 pages measured 24-27 MB at q78/900 px). Unchanged pages are shared across versions, so a re-run costs only what changed, and "pages that differ" in Compare is a hash comparison with no pixel work and no conversion. |
| P-12 | No `expo-image`. `lib/rescue-v2-page-cache.ts` downloads each page once to `Paths.cache/rescue-pages/{hash}.jpg` and RN `<Image>` shows the file. | Signed URLs change at every signing and would bust a URL-keyed cache. A hash-keyed file cache needs no native dependency, so the fingerprint does not move until the Share task, and `master` can keep publishing OTA fixes until the release. |
| P-13 | The app polls `GET /projects/:id` every 3 s, foreground only, while a job runs. No SSE. | SSE through Passenger is unverified, `expo/fetch` can hang `reader.read()`, and a killed socket needs reconciling anyway. The DTO is under a few KB during a run. |
| P-14 | The thesis row is created only when the first rescue publishes. Publishing skips `thesisAllowance`: a paid or included rescue always gets its slot. | A diagnosis spends no slot (the old lane's rule). A student who paid must not meet a 402 at the moment of delivery. The slot then counts normally against creating other theses. |
| P-15 | Every version keeps an immutable `.docx`. The working copy goes through `persistThesisDocx`, whose `healBeforeWrite` may change bytes, so the version stores the returned `docHash` as `thesis_doc_hash` and "edited in Kwill" compares against that. If the thesis changed while a re-run ran, publish does not overwrite it: the version stays in History with `published=false` and the student is told. | What Prove checked is what the student downloads. A newer edit by the student always outranks a background job. |
| P-16 | Entitlement is stored on the project: `purchase`, `subscription` or `staff`. Checked once when the student continues past the diagnosis, then permanent for that project. | Plans lapse and D-13 does not. `currentPlanCode` is the only way to read the plan; never `currentPeriod`, which spends the trial. |
| P-17 | "Free until the defense" = free for 365 days from entitlement (`rescue.rerun_window_days`), at most 10 re-runs a day per project. No defense date is asked. | Nobody can verify a date a student types; a year covers any academic calendar. The cap protects Word and the model bill from a loop. |
| P-18 | A re-run must be the same thesis. **Replaced by P-57** (an anchor that never moves, a check in both directions, and a human review instead of a dead end). Blocks of 30+ characters are still compared as letters only, so a rescued file coming back with typography fixes in every paragraph still counts as the same thesis. | Otherwise one payment rescues a whole class. 40% survives a supervisor rewriting two chapters. Comparing letters only, against both, means a rescued file coming back with typography fixes in every paragraph still counts as the same thesis. |
| P-19 | Free diagnosis limits, read from the DB: 3 new projects per student per 24 h, one free flow in progress at a time, and 20 free jobs queued across the host (`rescue_busy`). | Each diagnosis costs Word time and, from M7, model money. An in-memory limit would not hold across processes or a restart. |
| P-20 | `rescue.price_dzd` in `app_settings`, read straight from the DB at checkout and in `/config`. Unset means not for sale. Whole dinars, 1 to 100000. | `setSetting` updates only the handling process's cache and the process count is not knowable from the repo. Never hardcoded (D-7). |
| P-21 | Two switches keep it dark until the release. Server: `rescue.enabled` unset → every student route answers 503 `rescue_disabled` and the tick does nothing. App: `lib/rescue-v2-enabled.ts` `RESCUE_V2_ENABLED: boolean = __DEV__`, flipped to `true` in the release commit. | D-19: nothing ships piece by piece, yet other fixes will deploy before then. A constant, not an env var, because EAS env outranks `.env.production` (memory: `ota-eas-update`). |
| P-22 | No refund API exists, so a refund is honest bookkeeping: the first rescue failing sets `payments.refund_status='due'`, opens a Support case and shows on the runs list and on a refunds-due list read straight from `payments`, so a double payment or a payment for a deleted project stays visible; `finance_admin` returns the money by hand and marks it. The student's copy says "we will return your payment" until staff mark it, then "we returned it". Subscribers and re-runs see "nothing was charged" / "your last version is untouched" instead. | `chargily.ts` has no refund call and manual payments are bank transfers. Mock 18's "we refunded you" would be a lie for up to days, and wrong for subscribers. |
| P-23 | iOS: no price, no "buy", no "free", and no mention of the email. The server mails every non-entitled student when the diagnosis finishes, on every platform, and again at most once per 3 days (P-69); the mail links to `/pay?token=…&project=…`. The app's status sheet states the fact and offers a refresh. Screen 18 shows refund state as status words with no amount, method or link (A7). | App Store 3.1.1, and the pattern already accepted for messages (`quota-email.ts`). The trigger is an event on the server, not a button in the app. |
| P-24 | All brain work happens before payment: `map`, `ask` and `read_cover` run in the free stages; the two cover samples render after entitlement. | The paid screens 10-12 then have no brain waits. A paying student never watches a spinner between questions, and with the session brain those waits are minutes. |
| P-25 | The free preview runs the whole Reset + Regenerate, then one Word conversion, and finds the chapter's page by reading the PDF's text; the marked render is the fallback only when that fails. Read 2 + preview 1 = 3 conversions for a free diagnosis. | Cutting a two-page document out would need section surgery and would lie about what the student gets. D-10 says really repaired. |
| P-26 | Screen 2's part "thumbnails" are small paper pages showing each part's own opening text (`MiniTextPage`), not rendered images. | A real thumbnail is one more Word conversion per part, before the student has confirmed anything, and the order screen must not wait minutes. The text is their own, which is what the screen needs. |
| P-27 | Voice in screens 5 and 17 uses the device recogniser (`useVoiceDictation`, `lib/voice.ts`), not `POST /api/stt`. This departs from §6's wording. | No app code calls `/api/stt` today, `routes/stt.ts` itself calls the phone's recogniser the default and the route an escape hatch, and the note is shown back as editable text and chips, so a bad transcription is seen and fixed. The recogniser's language is picked beside the mic and defaults to the thesis language (§6: Arabic or French, whatever the UI language). |
| P-28 | Re-run source rule: a new upload if there is one; else the thesis's working copy if its hash moved; else the last version's own source. A rescued file as source first loses every `KwillGenerated` block (`stripGenerated`). Each version saves both `map` (keys of its source) and `final_map` (keys of its output), and the diff matches against both, by exact key and then by unique text. What Kwill generated and `stripGenerated` cannot remove (TOC and list lines, empty section-break carriers) gets its role by code in the diff and never reaches Map. | A student may re-upload their own copy, the rescued file they downloaded, or edit in Kwill. All three must reuse the map. Neighbour context in blockKey (§7) would otherwise re-ask the blocks around every edit, and a TOC line changes whenever a page number does. **Refined by P-67** for a chosen file plus editor edits. |
| P-29 | A re-run that meets new low-confidence blocks pauses at `await_answers` and shows screen 11 for the new questions only; "let Kwill decide" resumes it. A new block has no rendered page yet, so these questions show their excerpt on a blank paper instead of a zoomed page. This departs from §9.2 #11 on a re-run only. | Questions are asked, never guessed; old answers carry over by blockKey, so nothing is asked twice. Rendering the source just to zoom would cost two more Word conversions on a path that is rare, and the excerpt is the line being asked about. |
| P-30 | Student counts are written as "label: N" («نقاط سنصلحها: 47», "Things we'll fix: 47") and stats as plural labels over a number. No plural-suffixed keys. | Arabic counted nouns change form with N, the app has no `Intl.PluralRules`, and i18next would fall back to one/other. One honest form reads correctly for every N in all three languages. |
| P-31 | Controls the mocks lack: D-22 caption numbers, D-24 dividers and frames, §5.11/D-26 reference sorting are switches in an "Additions" row on screen 10 and in H5. Captions get a group on screen 16. Screen 12 has three cases (no cover → generated only; clean cover → keep or generated; messy cover → cleaned or generated). The label is "Algerian standard cover", never "official" (D-23 says standard). Empty cover values prefill first from the catalogue row of the chosen university (its name in the thesis's language, its logo on the generated cover), then from the student's own profile, each tagged; the brain still returns only what it found in the file. Screen 15 gains a History link and a "changes from your supervisor?" link. | The later decisions came after the mocks; D-22 and D-24 put these controls on the confirm screens. Typing a university name the profile already holds is friction, and the student confirms every value on the same screen. |
| P-32 | A student's notes are a list (`notes jsonb`), not one `note text`. Chips and conflicts are computed by code from the brain's answer, and a conflict exists only against a value that came from the department guide. | §6: "saved as a new note" on every re-run means several notes. §6: "a clash with the department guide"; a value from the catalogue or the default just yields, tagged "from your note". |
| P-33 | The rescue path never uses BYOK. Stages run outside any request, on platform configuration: a kick leaves the request's async context on purpose (Task S16). | A student's key exists only in a request's ALS (memory: `byok-free-tier`), the ALS follows every `await` and promise started inside that request, and a tick claims any student's job. `runWithAiContext` replaces the AI context only, so without the exit another student's stage would run on this student's key. |
| P-34 | Diagnosis-only projects expire after 30 days and can be deleted by the student at any time. The TTL applies only to a project with no thesis; from the moment a thesis exists, §7's "kept until the thesis is deleted" holds. Entitled projects live until the thesis is deleted. Deleting the account sweeps both, whether the student does it (`DELETE /api/user/account`) or staff do (`/d/users`, through S20's route). | The file is a student's thesis and we hold it for free, so this departs from §7's "v0 is never deleted" for a thesis nobody paid to keep. `rescue_projects.user_id` has no FK to `profiles` (cloud may lack the row), so an account delete must sweep explicitly; the dashboard's `auth.admin.deleteUser` would otherwise leave blobs nothing can find. |
| P-35 | Entry points: a new drawer row, a card in `ChatWelcome`, and Share. At release the drawer's `import` row becomes plain `handleImport` for every build; it is production's only plain-import door, so it must not be replaced. Cold start resumes on `/rescue` only for a project mid-run and touched in the last 24 h; a finished one waits for its push or the drawer. | §13 says the `__DEV__` gate is "replaced", but the row is also the import door. A student who did a free diagnosis last week should land in their chat, not be hijacked. |
| P-36 | `/rescue` turns the drawer's edge swipe off while focused. | `swipeEdgeWidth: 32` has no other opt-out under `(app)` and would fight the page swipe and the Compare slider. The route has its own way out: the shell draws ✕ or back on every step (Task A3), because iOS has no hardware back and this Stack has no gesture. |
| P-37 | Tests and walks never touch the cloud database. `~/kwill-server/.env` points at CLOUD (checked 2026-11-02), and `dotenv` does not overwrite a variable already set, so every DB test and the local server get a local `DATABASE_URL` on the command line. A vitest setup file blanks any other value before `dotenv` can load the cloud one (Task S0), so existing DB tests skip too. `scripts/rescue-local-db.sh` builds the local database, which starts empty. `RESCUE_BRAIN=session` refuses to start against a non-local DB. | The SQL is not on cloud until the release, and a session brain on cloud would hang real students. Existing suites load `.env` through `dotenv/config` and only skip when the URL is absent, so a plain `vitest run` would otherwise write to production. |
| P-38 | Dashboard gets exactly two write actions on rescue data beyond the price: mark a refund returned (`finance_admin`) and retry a failed run (`support_admin`, `platform_admin`). Deleting a user, which exists today, also sweeps their rescue blobs first (P-34). | Without the first, invariant 5 has no end. Without the second, a run that failed on a since-fixed bug is a dead end for a student who may have a deadline. |
| P-39 | Time left comes from a constant, 6 s per page for a whole rescue (measured: t01 over 15 min), scaled per stage; `null` while waiting on the brain or on Word. | §9.1 wants a time left. Averaging past runs is not worth building before M7 changes the numbers; S22 re-measures the constant. |
| P-40 | Arabic UI text stays on the system font; no Noto Sans Arabic or Amiri asset is added. Thesis pages are images, so they need none. | Only Inter is loaded today, and a font asset is a fingerprint input. |
| P-41 | What a re-run really redoes. Partial: Map (changed blocks only), Ask (new questions only), Review (the pages that differ from the last version's, which hold every changed block) and page-image uploads (content-addressed). Whole: Reset, Regenerate and every Word render, because a page number, a TOC entry and pagination are only true of the whole file. So brain cost scales with what changed and Word time scales with the thesis (P-39's 6 s a page). Target, measured by S22: at most 1.5 × P-39's constant, and zero brain tasks when no block changed. This narrows §3 "re-converts only those" and §7 "cost scales with what changed", and mock 17's "under a minute" is not promised anywhere. | Word cannot paginate part of a file, and rendering less would make the TOC and the page numbers wrong, which is the exact fault a re-run exists to fix. The copy says what is true: only changed pages are re-checked, and no question comes back. |
| P-42 | `map`, `final_map` and work files store a block's index `i` beside its key. The index means a position in that version's own immutable source or output and is never read across versions; matching between versions uses keys only. | §7's "indices are never stored" is about indices that go stale. These cannot: the file they point at never changes. Reset, Prove and the change report need positions, and re-deriving them would re-parse the file each time. |
| P-43 | A staff retry of a failed v0 resets that row in place: its `failure` and `stage_state` are appended to `stage_state.priorFailures`, then it runs again. Every other failed row stays immutable and a retry makes a new version. | v0 has no place on the timeline until it is done, so nobody sees the change, and `n=0` must stay v0: a second original row would push the first rescue to "version 2" or need negative version numbers. The attempt's cost and failure stay readable. |
| P-44 | The original is downloadable, never restorable (`rescue_cannot_restore_original`). This departs from D-18's "every version restorable". A split thesis's original also offers each part as uploaded, and its .docx download is named as the merged file. | The original never passed Prove and has no deposit pack, so restoring it would put an unproven version on top of the timeline. A student who wants it back downloads it and uploads it as a re-run, which proves it. Invariant 4 keeps the parts, so the student can have them. |
| P-45 | What a note can do. A wish about the look becomes a rule, which changes the file: the 21 fields plus `secondFont`, `secondSize`, `noNumberDedication`, `noNumberThanks`, `keepTables` (Task S9a). A statement about the structure becomes a hint, which reaches Map and Review. Anything else goes to `refused` with its reason, `not-supported` included, and the student reads "noted, but we can't apply this". Nothing sits under "we understood" without an effect. A removed chip takes its meaning with it: Map and Review receive the standing hints, and the raw note text only while that note has not been parsed. | §6 and mock 5 promise "French in Times 12", "no number on the dedication", "keep my tables as they are" as understood. A chip the file then ignores would be a lie on the screen the student trusts most. Moving annexes is forbidden by D-26, so it is refused, never a hint. |
| P-46 | D-8's cleanup ships as spacing around punctuation, tatweel and collapsed spaces (the seven `TypoKind`s). Parentheses direction, digit consistency and quote shapes are left as the student typed them; mixed digits stay detected and never fixed. This narrows D-8. | Each of those three changes a character the student wrote, in places where the right answer depends on meaning (a citation, an ISBN, a Latin passage inside Arabic). Invariant 1 allows a fix only where Prove can replay it with certainty, and none of the three has that rule today. Nothing in the copy promises them. |
| P-47 | v1 has one structure check for every format. For `imrad` and `1275`, `structure.required` holds only `cover`, `toc`, `bibliography`, and introduction and conclusion become recommended. Screen 6 still names the format. This departs from §4's "each has its own required section structure" until real profiles exist (§15). | Nobody has verified a 1275 or faculty IMRAD section list, and `section-missing` is shown to the student. Saying less is honest; saying "your conclusion is missing" about a business-model mémoire would not be. |
| P-48 | A deposit pack never holds back a proven thesis. Inside the pack, a form Word refuses is left out with its reason and the rest ships. If the stage itself keeps failing (3 attempts), the version still publishes with no pack and says so. Screen 15 lists what is in the pack and what is not, and "rebuild" starts a `pack_rebuilt` re-run: free, from `deposit` on, on the same .docx and PDF, no Word except the forms. A change to the deposit rule alone uses the same path. | D-12 sells the pack, so a silent gap is wrong, but Prove passed and the student may have a deadline. A rebuild is cheap because every input already exists, and a version stays immutable because the rebuild is a new one. |
| P-49 | S14 lands on `master` before the release SQL reaches cloud, so the statements for plans and top-ups never name `rescue_project_id` or `refund_*`. Only a `kind='rescue'` branch does, and `rescue.enabled` keeps that branch closed until the SQL is on. No cloud write before the release, no held branch. | P-21 expects other fixes to deploy before then, and those statements serve real payments today. Holding S14 off `master` would strand every task after it in a tree that has one branch, and writing to cloud early breaks "this plan never writes to it". |
| P-50 | Under `keep` and `clean` the cover's words do not change, so screen 12's values feed the deposit forms only, and the sheet says so. `clean` finds its title block from the values as read (`readFields`), never the edited ones. `proveCover` runs for `generated` only. | D-23: a kept or cleaned cover holds the student's own words. Without this, a corrected name reaches the forms and not the cover while the screen implies otherwise, and proving an edited value on an untouched cover would fail a sound file and owe a refund. |
| P-51 | A Chargily row counts as `pending_card` for 15 minutes from `created_at`, then as `none`. `failed` and `canceled` are `none`. A late webhook still grants. The same age rule decides `hasPendingPayment` and the sweep; a manual `pending` row always counts. | `openCheckout` writes the row before the student pays, and closing the browser sends no webhook. Without a window, one abandoned checkout means an endless "confirming" sheet, a project that cannot be deleted and a TTL that never fires. |
| P-52 | A restore over editor edits pins the snapshot `persistThesisDocx` takes and the dialog says the edits are kept, reachable by undo in the editor. | §7: editor edits are not rows, so a restore would otherwise leave them only in the 20-entry undo ring, and "edited in Kwill" disappears from the timeline the moment the hashes match. |
| P-53 | Order of work. M2b's integrator and M3 (its §1 code, the `review` CLI command, `replay.ts` and the whole fix loop) are finished and merged before S0 starts. From Gate 0 on S5 owns `scripts/rescue-lab/cli.ts`, and the M3 loop does not resume against it. Corpus replays (`replay.ts all`, then `replay-rerun.ts all` once it exists) run before S9a, after S9a and S9c, after S5, and again in S22 after every defect fix; §8 asks for them green. The host-wide Word lock `scripts/word-lock.mjs` and commit dcaf210 already exist (see the header), so the private :8093 instance and production's :8092 may run side by side. | Two sessions on the same files make S5's SAME diff meaningless and lose fixes; M3's own rule is that the corpus re-runs after every change. S9a rewrites styles, layout, reset, apparatus, tables and the index, and its claim that defaults stay byte for byte needs a golden number from before it, not after. |
| P-54 | A Word failure is the student's file only when a canary proves Word healthy. After a timeout, an AppleScript error or any unclassified failure, the service converts a small document it builds itself. Canary fails: it restarts Word and answers `wedged: …`, which the client maps to `WordConverterDownError` (the job waits, no strike, no attempt). Canary passes and the file fails twice: `WordRefusedError`. A job that overruns its limit while the canary passes: `WordTimeoutError`, a stage error that spends an attempt and can only end as `stage_crashed`, never as `word_refused`. An error with no prefix, from an older service, counts as `wedged`. The limit scales with bytes and with the pages the caller knows. The last canary result and the restart count reach `/admin/rescue/runs/summary`, and a restart is logged for the owner. | After a modal dialog or a hang AppleScript times out while Word stays stuck; with nothing to tell the two apart, every later job failed twice and a sound thesis was told its file is broken and refunded. Blaming the file needs evidence. |
| P-55 | Word only ever sees a sanitised copy. `sanitizeForWord` removes `w:updateFields`, `attachedTemplate`, external relationships of the types template, subDocument, oleObject and altChunk, and macro parts, and unlinks INCLUDETEXT, INCLUDEPICTURE, LINK, DDE, DDEAUTO and IMPORT fields into their cached result. When a render asks Word to update fields, the script updates only TOC, PAGEREF, PAGE, NUMPAGES, SEQ and REF, with Word's display alerts off. A dialog is attributed by the canary (P-54): a job that raises a dialog while the canary is healthy is the file's. Running Word and poppler under their own macOS account without Full Disk Access is the stronger fix; it is the owner's call and sits in §7, not in a task. | Reset keeps field instructions, so a student's INCLUDETEXT would run on the owner's Mac at every paid render, with Word holding Full Disk Access. The cached result is what Word shows anyway, so the student sees no difference. |
| P-56 | Before any byte is stored, `preflightDocx` reads only the zip's central directory: at most 5000 entries, 400 MB uncompressed in all, 100 MB for any one XML part, a compression ratio of at most 200 on any entry, `[Content_Types].xml` naming the WordprocessingML main part, and no macro part. `Content-Length` is required (411) and the whole upload is checked against the sizes already stored, not the sizes the client declared. After the inventory: at most 60 000 blocks and 700 pages, with a refusal the student can read (`rescue_too_big`). An inventory that cannot be parsed is `not_docx`, non-retriable. A guide must start with `%PDF-` or a JPEG or PNG signature, and a PDF guide has at most 40 pages. | Every stage runs in the API's event loop (P-5): a zip bomb would be inflated there, three times, taking chat and payments with it, and a renamed xlsx would burn three heavy attempts. |
| P-57 | The same-thesis check (replaces P-18). A project keeps an anchor, the inventory of the source it was paid for (v0's, or the version a staff review rebased it to: `anchor_version_id`), and the anchor never follows the last version. A re-run passes only when both hold: the share of the anchor's long blocks still in the new file is at least `rescue.same_thesis_min` (0.4), and the share of the new file's long blocks found in the anchor or in the last version's source or output is at least `rescue.same_thesis_traceable_min` (0.6). Otherwise the run stops with `not_same_thesis`: no refund, no attempt spent, `failure.reviewable`, and the student may press 'Ask us to look', which opens a Support case. Staff retry with `overrideSameThesis`, which rebases the anchor to that file. Cover identity is not a signal: a re-run runs no `read_cover`. | A + B then B, or 40% of one thesis kept in each file of a class, passed a one-directional check against the last version. A student who really rewrote most of the thesis is not blocked for good: a person looks, and nothing is spent meanwhile. |
| P-58 | A plan includes at most `rescue.plan_rescues_per_30d` (default 2) rescues per student in a rolling 30 days, counted from the append-only `rescue_ledger` (kind `grant_plan`), so deleting a project gives nothing back. Past it, `POST /continue` answers 402 `rescue_allowance_used` and the student buys the rescue like a free student. P-14's skip of `thesisAllowance` applies only to a grant inside the allowance. Purchases and staff grants are written to the same ledger and never capped. Entitlement stays permanent for its project (P-16). | The monthly plan costs 2500 DZD, about one shop mise en page: unlimited permanent rescues from one subscription makes the plan a way round the price. Two a month covers a student's own retries, and the number is a setting. |
| P-59 | Free limits count from `rescue_ledger`, which survives project deletion: new projects 3 per student per 24 h (`rescue.free_diagnoses_per_day`), note parses 10 per student per day, guide reads 5, cover sample renders 6 and only for an entitled project (`POST /cover/samples` answers 402 otherwise). A fresh account is counted by account only; a device or IP signal waits until abuse shows. | `countRecentProjects` counted live rows, so create, diagnose, delete and repeat ran Word and the model on every loop for nothing, and twenty queued free jobs close `rescue_busy` to every honest student. |
| P-60 | A restore row is a full copy of its target (`copyVersionRow`): every path, `settings`, `proof`, `map`, `final_map`, stats and deposit. The project's standing choices (rule edits, answers, cover, the notes' chips) are reset to the target's `settings` snapshot in the same transaction, so the next re-run does not silently undo the restore. | A re-run reads 'the last done version' for its source, priors, impact and pack; a half copy broke each of them. |
| P-61 | Runner limits. An attempt is spent when a stage reports an error, never at claim. A process death is a lease loss (`lease_losses`, capped at 6), and a job with two lease losses is claimed after all others. Every stage has a budget (`StageDef.budgetMs`, the Word and brain waits inside it having their own limits), enforced by `Promise.race`; on expiry the stage is requeued with an attempt spent. A brain wait ends `RESCUE_BRAIN_WAIT_HOURS` (default 6) after `waiting_since`: a pipeline job fails `brain_failed`, a side job goes to `failed`; after 4 timeouts of one job every further one spends an attempt. The tick has a reconciler (P-62) and its own deadline, so one hung call cannot stop the runner. | Three infrastructure events (a deploy, a tunnel rotation, an idle recycle) failed a sound paid run with a refund; a hung stage or a brain that never answers held the host's one Word slot or billed forever. |
| P-62 | Failure and enqueue are atomic. A version failing, its `failure`, `refund_status='due'` and the job ending are one transaction; the Support case, push and cost snapshot are idempotent follow-ups the tick re-drives. A version and its job are created in one transaction (`createVersionWithJob`), as are a side state and its job. The tick reconciles: a `running` version with no job gets one; a `parsing`, `reading` or `rendering` state with no job goes to `failed`; a `kind='rescue'` payment that is paid or approved and named by no project is granted (or, for a gone project, becomes refund due); a v0-done, not entitled, for-sale project with no ready-email gets it. | Six separate writes meant a crash left a student told 'we will return your payment' with no refund row, a run 'repairing' for ever with no job, or money taken with no entitlement. |
| P-63 | Delivery and refund are exclusive. A staff retry that delivers a first rescue whose payment is `due` waives the refund (`refund_status='waived'`, with a note) and the done push tells the student. `markRefunded` on a project with a done rescue answers 409 `rescue_already_delivered` unless staff pass `confirmDelivered`. `POST /reruns` requires a done rescue and answers 409 `rescue_refund_due` while the payment is due. | Otherwise one failed run could end with the student holding the thesis and the money. |
| P-64 | Storage is bounded. The upload limit is `rescue.max_object_mb` ÷ 2.5, because the pack's zip stores the docx and PDF uncompressed. A `deposit/{kind}` entry equal to the thesis is a reference to `thesis.*`, not a copy. The zip exists for the newest done version only; a finished version removes the previous one's zip and `work/` and keeps its docx, PDF, pages and inventories (D-18). A project stops at `rescue.project_max_mb` (default 800) with a readable `rescue_storage_full`; staff lift it by raising the setting. A zip that would pass the object limit is skipped with `omitted: zip-too-large` and no rebuild is offered; screen 15 shares the files one by one. `/runs/summary` carries total bytes. | Only page images were deduplicated: about seven whole-file objects per run, 140 MB for a 20 MB thesis, with 10 re-runs a day for a year and no total. |
| P-65 | Deletion leaves nothing behind. Deleting a project, a thesis or an account writes a tombstone (`rescue_tombstones`, the storage root) in the same transaction as the delete; the tick sweeps a tombstone again once the lease time has passed, and the runner sweeps when it finds its project gone, so blobs a running stage wrote later go too. The MCP tool `delete_thesis` goes through `deleteThesisCompletely`. A project that has an entitlement and no thesis cannot be deleted (409 `rescue_entitled`, `RescueProjectSummaryDTO.canDelete`). | 'Delete my thesis' kept the thesis in storage when a stage was running, or when the chat tool did the deleting, and a paid project could be deleted with the money kept silently. |
| P-66 | Index-addressed edits carry `If-Match`. `POST /api/thesis/:id/ops` accepts the document tag the batch was built against (the same `ifMatchAllows` as the docx PUT; absent means today's behaviour) and answers 412 on a mismatch, which the app's existing 'server rejected: drop the queue, alert, revalidate' path handles. The app flushes the op queue before it creates a re-run and revalidates the open thesis on the rescue done push and on focus while the thesis has a rescue project. | Regenerate shifts every index; a queued `editText index=N` from an offline phone, or from a workspace left open during a repair, would overwrite a different paragraph of the proven thesis. |
| P-67 | A chosen file plus editor edits. The file wins (P-28), the edits are not in it, screen 17 says so, and publish pins the snapshot it takes (`pinSnapshot`), as restore does (P-52). A version records `source_kind` (`upload`, `working_copy`, `previous`) and the timeline claims 'absorbed your edit' only for `working_copy`. A staff retry of a failed re-run starts at `source`, and publish refuses to overwrite a thesis when `sourceDocHash` is missing (`published:false`). | An upload silently discarded editor edits while the screen promised to include them, and a retry days later overwrote a newer edit. |
| P-68 | `rescue.enabled` takes `staff` as well as `1`: student routes then open only for profiles with a `staff_role`, and the tick runs. §7 runs a small thesis and a 300-page one end to end on the host as staff, records peak RSS, event-loop lag, thread count and stage seconds, and sets `1` only inside the stop limits it names. | The pipeline is only ever run on a Mac; its first run on the shared, thread-limited host would otherwise be a student's paid run. |
| P-69 | Amends P-23. The ready-email goes out when v0 finishes, and again at most once per 3 days (`email_sent_at`) from the 402 path of `POST /continue` and from a tick sweep. It is a server event, so the app still mentions nothing on iOS. The `/pay` expiry page for a rescue link says to open the latest email. | One send at one moment was skipped by an unset price, a down mailer or a plan that lapsed later, and an iOS student then had no way to pay. |
| P-70 | A university's norm profile applies by itself only when its `discipline` is `generic`. For a science or law-humanities profile the diagnosis runs on the Algerian default and screen 4 asks 'Use the rules of {profile name}?' (`RescueSetupDTO.profileOffer`); `normProfileId` is set only on a yes. | `catalogueProfileFor` matched university and language only, so an Arabic science thesis would be diagnosed and rebuilt on a law faculty's 16 pt rules. |
| P-71 | Publish and restore call `persistThesisDocx`, which starts RAG indexing and its embeddings call (`recordAiCall`, feature `rag.index`). That is outside the rescue pipeline's no-model guard by design, not part of `snapshotCost`, and the localhost environment sets `RAG_INDEXING=off`. | §8 says no model cost in the rescue path until M7; this one is real and was undeclared. |
| P-72 | **The app screens start ahead of Gate 0 (the owner's request, 2026-11-04).** A-A and A-B run while M3 is still running, against §1's contract and `lib/rescue-v2-fixtures.ts`, in the app repo only. Gate 0 still holds for every server task. When S2 lands, its contract is compared with `types/rescue-v2.ts`, and any difference is fixed before S19. A9 to A11 wait for their own conditions. | The app needs only the contract, and its files don't overlap the engine work. The risk is contract drift, including Diagnose codes added during M3, so A2 takes its codes from the server's current Diagnose rather than from this plan's list. |

---

## Rules every task follows

**Repos.** `~/kwill-server` (Hono, vitest, `strict:false`, relative imports without `.js`, branch `master`). `~/kwill` (Expo, tsc + vitest allow-list, branch `master`). `~/kwill-dashboard` (Next.js, vitest, branch `master`). All three share one Supabase project; this plan never writes to it.

**Git in shared trees.** Other sessions work in these trees at the same time.
- Commit only with `git add -- <exact new paths>` (git does not know a new file until then) and `git commit -m "..." -- <exact paths>`. Never `git add .`, `git add -A`, `git stash` or `--amend`.
- Before editing a file, run `git diff --stat -- <file>`. If it already has someone else's hunk, commit only your hunk: `git hash-object -w` a blob built from `git show HEAD:<file>` plus your change, `git update-index --cacheinfo 100644,<sha>,<file>`, then commit without paths. Known dirty today: server `package.json`, `src/routes/rescue.ts`, many `src/__tests__/*`.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No pushes and no deploys from this plan.** A dashboard push goes live on Vercel. An app OTA reaches students. The server deploys at the release.

**Task protocol.** Each task runs in this order: write the listed tests; run them and see them fail for the right reason; implement; run them and see them pass; run the repo's gate; a reviewer subagent reads the diff and reports, Claude arbitrates (D-21); commit the exact paths. A step that writes production code never starts before its tests exist, except layout components, whose test is `npx tsc --noEmit` plus the named walk.

**Gates.**
```bash
cd ~/kwill-server && npx tsc --noEmit 2>&1 | grep -E "src/(db/(rescue-schema|index)|lib/(rescue|rescue-run|billing|render|document-storage|support-cases|notifications|word-converter|thesis-delete|thesis-history)|routes/(rescue-v2|admin-rescue|payment|pay|tasks|support|user))" ; npx vitest run src/lib/rescue/__tests__/no-model-client.test.ts
cd ~/kwill && npx tsc --noEmit && npx vitest run
cd ~/kwill-dashboard && npx tsc --noEmit && npx vitest run
```
Some server suites time out at the 5 s default under load; re-run with `--testTimeout=60000` before calling that a failure. Judge server `tsc` on your own files while M2b is landing.

**Database in tests (P-37).**
```bash
cd ~/kwill-server && ./scripts/rescue-local-db.sh     # Task S0: the local stack, API :54331, DB :54332, schema, accounts, one thesis. Safe to re-run.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run
```
Every test that touches Postgres opens with:
```ts
const LOCAL = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
describe.skipIf(!LOCAL)("…", () => { /* … */ });
```

**The guard.** `src/lib/rescue/__tests__/no-model-client.test.ts` covers `src/lib/rescue` and `scripts/rescue-lab`, transitively. Forbidden in reach: `lib/ai/`, `lib/format/`, `db/`, `lib/supabase.ts`, `lib/document-storage.ts`, `lib/thesis-render.ts`, `lib/stt.ts`, `lib/tts.ts`, `lib/embedding-service.ts`, `lib/thesis-classify.ts`, `lib/thesis-structure.ts`, `lib/thesis-plan.ts`, `lib/chat-memory.ts`; packages `openai`, `@openrouter/sdk`, `@supabase/supabase-js`, `pg`, `postgres`, `drizzle-orm`; the text of provider URLs, key names, `require(`, `createRequire`, non-literal `import(`. `lib/word-converter.ts` and `lib/render/*` are allowed. So: anything touching the DB, storage, billing, settings, notifications or `runWithAiContext` lives in `src/lib/rescue-run/` or `src/routes/`, and `scripts/rescue-lab/` must not import `rescue-run`.

**Native modules at boot.** Never a top-level `import sharp` or `import { Resvg }` in anything a route reaches: the host aborts at startup with no output (memory: `deploy-stage-boot-before-passenger`). Use `await import`. S21 adds a test.

**Names.** Rows are camelCase in code (Drizzle; `jobs.ts` maps its raw rows to the same camelCase through `toJobRow`). snake_case appears only in SQL and when this plan names a column.

**Byte safety.** New document surgery follows M2b's list: never the engine's xml2js-backed paths on a thesis. `w:pPr`, `w:rPr`, `w:sectPr`, `w:tblPr` are ordered.

**Privacy.** `lab/` holds real theses. Tests use invented text. Logs and reports carry counts, codes and pages, never student words. Excerpts leave the server only to the owning student.

**Copy shown to students.** Reassure, never judge: "things we'll fix", never "errors" or "violations". No "section break", "field", "style", "block", "index". The student never sees a block index (CLAUDE.md).

**Expo docs.** AGENTS.md is binding. Before touching each module read: `https://docs.expo.dev/versions/v56.0.0/sdk/sharing/`, `/sdk/filesystem-legacy/`, `/sdk/document-picker/`, `/sdk/notifications/`, `/sdk/haptics/`, `/sdk/webbrowser/`, and `https://docs.expo.dev/router/advanced/native-intent/`.

---

## 1. The contract (server, app and dashboard all build to this section)

If a task finds this section wrong, fix this section in the same commit as the code, then tell the other two tracks. Everything else in the plan follows from it.

### 1.1 The state machine

**A project** is one thesis being rescued. **A version** is one row of its timeline. Version 0 (`kind='original'`) always exists and carries the free stages. Version 1 (`kind='rescue'`) is the first paid repair. Later ones are `rerun` or `restore`.

`rescue_versions.status`: `running` (a job is queued or running on it) → `waiting_student` (it stands on an `await_*` stage, no job) → `running` → `done` | `failed`. A `done` or `failed` row never changes again, except `failure_acked_at`, `support_conversation_id`, `cost`, the follow-up marker inside `failure` (P-62), and a failed v0 that staff retry (P-43). A job whose version is no longer `running` is ended by the claim, never run (P-62).

`rescue_jobs.status`: `queued` → `running` → back to `queued` for the next stage, or `done` (no next stage, or the version now waits on the student), or `failed`. A job row is one continuation of work; when a student step resumes the version, a new job row is inserted.

**Stages, in order.** One claim runs exactly one stage. "Heavy" means the single host-wide slot (P-5). Word conversions are counted per stage so the cost can be read.

| Stage | Applies to | Lane | Word | Brain task | Does | Next | Reading/repair step |
|---|---|---|---|---|---|---|---|
| `await_upload` | v0, upload re-run | none | | | Waits for every part's `PUT` | one part: `read` (v0) or `source` (re-run). Several: `propose_order` | `upload` |
| `propose_order` | split only | brain | | `order_parts` | `summarizePart` each part, ask | `await_part_order` | `upload` |
| `await_part_order` | split only | none | | | Student confirms on screen 2 | `merge` | `upload` |
| `merge` | split only | heavy | | | `mergeVerbatim` + `checkAssembly`, writes `source.docx`, keeps `commentsStripped` | `read` (v0) or `source` (re-run) | `upload` |
| `read` | v0 | heavy | 2 | | `readInventory`, render, JPEG pages published as each uploads, `page-map.json` | `await_setup` | `read` |
| `await_setup` | v0 | none | | | Student on screens 4 and 5, then `POST /diagnose` | `map` | `read` |
| `map` | v0 | brain | | `map` (windows) | Roles + format; sees the student's note | `diagnose` | `understand` |
| `diagnose` | v0 | heavy | | | Resolve rules, `readFacts`, `diagnose`, build the view | `ask` | `compare` |
| `ask` | v0 | brain | | `ask` | At most 5 questions; skipped when no candidates | `read_cover` | `compare` |
| `read_cover` | v0 | brain | | `read_cover` | Cover fields found in the file | `preview` | `compare` |
| `preview` | v0 | heavy | 1 (2 on fallback) | | Reset + Regenerate on defaults, two watermarked pages | `done` | `compare` |
| `source` | re-run | heavy | | | Pick source, strip generated blocks, inventory, diff, same-thesis check against the anchor (P-57), rekey answers and questions | `map_changed` | `prepare` |
| `map_changed` | re-run | brain | | `map` (changed blocks only; plus every heading when a new structure hint came with this run) | Skipped when nothing to look at. No page images: a new block has no page yet | `ask_changed` | `prepare` |
| `ask_changed` | re-run | brain | | `ask` (new candidates only) | Skipped when none | `await_answers` if new questions, else `reset` | `prepare` |
| `await_answers` | re-run | none | | | Screen 11 for the new questions, then `POST /versions/:vid/resume` | `reset` | `prepare` |
| `reset` | rescue, re-run | heavy | | | `reset`, re-inventory, remap roles | `regenerate` | `prepare` |
| `regenerate` | rescue, re-run | heavy | | | All Regenerate steps; each step moves the bar | `render` | `styles` to `captions` |
| `render` | rescue, re-run | heavy | 2 | | Final render, TOC numbers filled, JPEG pages published as each uploads | `review` | `check` |
| `review` | rescue, re-run | brain | | `review` | One round of `reviewRound` (M3); on a re-run, changed pages only | `review_render` if fixes and round < 3, else `prove` | `check` |
| `review_render` | rescue, re-run | heavy | 2 | | Re-render after fixes | `review` | `check` |
| `prove` | rescue, re-run | heavy | | | Every Prove check. Any fail → honest failure | `deposit` | `check` |
| `deposit` | rescue, re-run | heavy | up to 5 | | `buildDepositPack`; one bad form is left out, the rest ship; after 3 failed attempts the version goes on with no pack (P-48) | `publish` | `check` |
| `publish` | rescue, re-run | heavy | | | Immutable copy, thesis row, `persistThesisDocx` inside `withThesisLock`, cost, push | `done` | `check` |

A `pack_rebuilt` re-run starts at `deposit` on its parent's .docx and PDF and its `publish` writes nothing to the thesis (P-48). `restore` versions run no stage: the route writes them `done` in one request. Job-only kinds outside this table: `read_guide` and `parse_note` (brain lane), `cover_samples` (heavy lane, Word up to 2).

**Project phase.** The server computes one `phase` for the app (`computePhase`, Task S2). The app derives its screen from `phase` plus local navigation (`screenFor`, Task A1).

| `phase` | When | Screen (spec number) |
|---|---|---|
| (no project yet) | | 1 Start |
| `uploading` | v0 or a re-run on `await_upload` | 3 Reading, upload row current (17's sheet stays up for a re-run) |
| `proposing_order` | on `propose_order` | 2 Your parts, skeleton |
| `await_part_order` | on `await_part_order` | 2 Your parts |
| `reading` | v0 on `merge`, `read` | 3 Reading |
| `await_setup` | v0 on `await_setup` | 4 Which rules, then 5 Your notes |
| `understanding` | v0 on `map` | 6 Understood, working title |
| `diagnosing` | v0 on `diagnose`, `ask`, `read_cover`, `preview` | 6 Understood, counts shown once `summary` exists |
| `diagnosed` | v0 done, not entitled | 7 Diagnosis ↔ 8 After preview; 9 Payment when the CTA says so |
| `confirm_rules` | entitled, rules not confirmed | 10 Rules |
| `confirm_questions` | entitled, an unanswered question; or a re-run on `await_answers` | 11 Question |
| `confirm_cover` | entitled, rules confirmed, no question left, no rescue started | 12 Cover |
| `repairing` | a rescue or re-run version on any other stage | 13 Repairing |
| `done` | a version is done and nothing is running | 15 Result (16, 17, H2-H5 by local navigation) |
| `failed` | newest finished version failed and is not acked, or v0 failed, or the project was entitled before its newest finished version failed and that one is acked with no done rescue (a purchase made after the failure falls through to `confirm_*`) | 18 Honest failure; 17 with a banner when `failure.code='not_same_thesis'` |

Screen 14 is the push notification. H1 (library) is its own route. H6 is a dialog over H3.

**Step lists.** `progress.track='reading'` has 3 rows: `upload`, `read`, `understand` (`compare` shows on screen 6). `progress.track='repairing'` is the 8-part bar: 1 `prepare`, 2 `styles`, 3 `typography`, 4 `sections`, 5 `cover`, 6 `toc`, 7 `captions`, 8 `check`. Regenerate's hook names map as: `styles`, `roles` → 2; `typography` → 3; `layout` → 4; `cover`, `dividers`, `frames`, `plain-pages` → 5; `apparatus` → 6; `references`, `typed-notes`, `caption-position`, `fonts`, `markers` → 7. The hooks do not run in step order (typed notes and caption position run before layout, dividers, frames and plain pages after apparatus), so `stage_state.progress.step` only moves up: a hook name never moves the bar back. An unknown hook name keeps the current step.

### 1.2 The SQL: `~/kwill-server/sql/2026-11-02-rescue-v2.sql`

Named for the day it is written; rename it if written later. Applied by hand, `ensureSchema` is dead on production.

```sql
-- Rescue v2: saved runs (projects, versions, jobs) and the rescue purchase.
-- Apply locally:  psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -f sql/2026-11-02-rescue-v2.sql
-- Apply on cloud: supabase db query --linked -f sql/2026-11-02-rescue-v2.sql   (bare means LOCAL)
-- Idempotent.
--
-- NOT added to ensureSchema(): that path is dead on production — `templates`
-- hit Postgres's 1600-column ceiling. This file is the real migration.
-- Spec: kwill docs/superpowers/specs/2026-11-02-rescue-v2-design.md §7.

CREATE TABLE IF NOT EXISTS rescue_projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No FK to profiles: cloud has no on_auth_user_created trigger, so a student may have no row.
  user_id             uuid NOT NULL,
  -- The rescued thesis in the library. NULL until the first rescue publishes.
  thesis_id           uuid REFERENCES theses(id) ON DELETE CASCADE,
  title               text NOT NULL DEFAULT '',
  source              text NOT NULL DEFAULT 'picker',   -- picker | share
  -- v0 bytes, one per uploaded part, never deleted while the project lives.
  original_paths      text[] NOT NULL DEFAULT '{}',
  -- { order: number[], continuesPrevious: number[], roles: [{ index, role }] }
  part_order          jsonb,
  university_id       uuid REFERENCES universities(id) ON DELETE SET NULL,
  norm_profile_id     uuid REFERENCES norm_profiles(id) ON DELETE SET NULL,
  guide_path          text,
  guide_filename      text,
  guide_state         text NOT NULL DEFAULT 'none',     -- none | reading | read | failed
  guide_rules         jsonb,                            -- DeepPartial<RescueRules>
  language            text,                             -- ar | fr | en, detected from the content
  format              text,                             -- classic | imrad | 1275
  rules               jsonb,                            -- resolved: default < catalogue < guide < note < edits
  rule_sources        jsonb,                            -- { "body.font": "guide", ... }
  rule_edits          jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules_confirmed_at  timestamptz,
  notes               jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ at, kind: start|supervisor, text }]
  note_state          text NOT NULL DEFAULT 'none',     -- none | parsing | ready | failed
  note_rules          jsonb,                            -- NoteRules
  -- ai_usage_log.turn_id of supervisor notes parsed since the last version; the next re-run adopts them.
  pending_turn_ids    uuid[] NOT NULL DEFAULT '{}',
  questions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  answers             jsonb NOT NULL DEFAULT '{}'::jsonb, -- { blockKey: { role } | { decide: true } }
  cover               jsonb,                            -- CoverState
  entitlement         text,                             -- purchase | subscription | staff
  -- The same-thesis anchor (P-57): the version whose inventory.json the check compares against. NULL = v0. A staff review rebases it.
  anchor_version_id   uuid,
  purchase_id         uuid,                             -- payments.id; no FK, payments outlive projects
  entitled_at         timestamptz,
  rerun_free_until    timestamptz,
  email_sent_at       timestamptz,
  expires_at          timestamptz,                      -- diagnosis-only TTL; NULL once entitled
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_projects_user ON rescue_projects (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rescue_projects_expiry ON rescue_projects (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rescue_projects_thesis ON rescue_projects (thesis_id) WHERE thesis_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rescue_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES rescue_projects(id) ON DELETE CASCADE,
  n                       integer NOT NULL,
  parent_id               uuid REFERENCES rescue_versions(id) ON DELETE SET NULL,
  kind                    text NOT NULL,                -- original | rescue | rerun | restore
  trigger                 text NOT NULL,                -- first_diagnosis | first_rescue | rules_edited | supervisor_note | new_file | edited_in_kwill | restored | staff_retry | pack_rebuilt
  status                  text NOT NULL DEFAULT 'running', -- running | waiting_student | done | failed
  stage                   text NOT NULL,
  stage_state             jsonb NOT NULL DEFAULT '{}'::jsonb,
  parts                   jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ index, filename, sizeBytes, path, sha256, uploaded, role, continuesPrevious, openingText }]
  settings                jsonb NOT NULL DEFAULT '{}'::jsonb, -- snapshot: rules, sources, notes, noteRules, answers, cover, language, format, universityId, costTurnIds
  -- `i` in both maps is a position in that version's own immutable file (P-42).
  map                     jsonb,                        -- MapResult of source_path: { keyVersion, corpusId, runId, inventoryHash, fingerprint, format, roles: { blockKey: { i, role, confidence } } }. Consumers read map.roles.
  final_map               jsonb,                        -- { blockKey: { i, role, sourceKey? } } of doc_path; sourceKey = the block of source_path it came from
  source_path             text,
  inventory_path          text,
  page_map_path           text,
  final_inventory_path    text,
  final_page_map_path     text,
  doc_path                text,                         -- immutable .docx of this version
  pdf_path                text,
  pages                   text[] NOT NULL DEFAULT '{}', -- ordered page image paths, content-addressed
  deposit_path            text,                         -- the zip
  deposit_files           jsonb,                        -- { zipName, files: [{ kind, name, path, sizeBytes }], omitted: [{ kind, reason }] }
  preview                 jsonb,                        -- { coverPath, chapterPath, beforeChapterPage }
  diagnosis               jsonb,                        -- { raw: Diagnosis, view: RescueDiagnosisDTO }
  changes                 jsonb,                        -- ChangeReport
  proof                   jsonb,                        -- { ok, docx, pdf, extra, exempt: [{ key, reason }] }
  stats                   jsonb,                        -- { pagesBefore, pagesAfter, fixes, changedPages, changedBlocks, keptBlocks, commentsStripped }
  cost                    jsonb,                        -- RescueCost
  thesis_doc_hash         text,                         -- theses.doc_hash right after publish
  published               boolean NOT NULL DEFAULT false,
  failure                 jsonb,                        -- { code, stage, page, refund, detail }
  failure_acked_at        timestamptz,
  source_kind             text,                         -- upload | working_copy | previous (P-67); NULL on v0 and restores
  support_conversation_id uuid REFERENCES support_conversations(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, n)
);
CREATE INDEX IF NOT EXISTS rescue_versions_project ON rescue_versions (project_id, n DESC);
CREATE INDEX IF NOT EXISTS rescue_versions_recent ON rescue_versions (created_at DESC);
CREATE INDEX IF NOT EXISTS rescue_versions_status ON rescue_versions (status, created_at DESC);
-- One running rescue or re-run per project.
CREATE UNIQUE INDEX IF NOT EXISTS rescue_versions_one_active ON rescue_versions (project_id)
  WHERE kind <> 'original' AND status IN ('running', 'waiting_student');

CREATE TABLE IF NOT EXISTS rescue_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES rescue_projects(id) ON DELETE CASCADE,
  version_id      uuid REFERENCES rescue_versions(id) ON DELETE CASCADE,
  kind            text NOT NULL,                        -- pipeline | read_guide | parse_note | cover_samples
  stage           text NOT NULL,                        -- the stage this claim will run; = kind for the others
  lane            text NOT NULL,                        -- heavy | brain
  priority        integer NOT NULL DEFAULT 1,           -- 0 paid, 1 free
  status          text NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
  not_before      timestamptz NOT NULL DEFAULT now(),
  lease_owner     text,
  lease_until     timestamptz,
  stage_attempts  integer NOT NULL DEFAULT 0,           -- spent when a stage reports an error (P-61), reset when the stage changes
  lease_losses    integer NOT NULL DEFAULT 0,           -- a process died or hung under this job; capped, never an attempt
  timeouts        integer NOT NULL DEFAULT 0,           -- brain timeouts of this job
  waiting_reason  text,                                 -- converter | brain
  waiting_since   timestamptz,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error      text,                                 -- codes and counts, never student text
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_jobs_claim ON rescue_jobs (lane, status, priority, not_before, created_at);
CREATE INDEX IF NOT EXISTS rescue_jobs_expired ON rescue_jobs (lease_until) WHERE status = 'running';
-- The one Word and the one event loop: a second running heavy job cannot exist on any process.
CREATE UNIQUE INDEX IF NOT EXISTS rescue_jobs_heavy_one_running ON rescue_jobs (lane)
  WHERE lane = 'heavy' AND status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS rescue_jobs_one_per_version ON rescue_jobs (version_id)
  WHERE kind = 'pipeline' AND status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS rescue_jobs_one_side_per_project ON rescue_jobs (project_id, kind)
  WHERE kind <> 'pipeline' AND status IN ('queued', 'running');

-- The rescue purchase. kind gains 'rescue' and status gains 'refunded': both are free text, no DDL.
-- Live statements for plans and top-ups never name these columns: S14 reaches production before this file does (P-49).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS rescue_project_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_status     text;        -- due | done | waived (P-63)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason     text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at       timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by       uuid;
CREATE INDEX IF NOT EXISTS payments_rescue_project ON payments (rescue_project_id) WHERE rescue_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_refund_due ON payments (refund_status) WHERE refund_status = 'due';

-- Append-only counts that survive a deleted project (P-58, P-59). No FK on purpose.
CREATE TABLE IF NOT EXISTS rescue_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  project_id  uuid,
  kind        text NOT NULL,   -- project | note_parse | guide_read | cover_render | grant_plan | grant_purchase | grant_staff
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_ledger_user ON rescue_ledger (user_id, kind, created_at DESC);

-- A deleted project's storage root, swept again once a running stage cannot still be writing (P-65).
CREATE TABLE IF NOT EXISTS rescue_tombstones (
  root        text PRIMARY KEY,   -- {userId}/rescue/{projectId}
  user_id     uuid NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS on and closed: only the server (service role) reaches these. No policies, on purpose.
ALTER TABLE rescue_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rescue_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rescue_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rescue_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rescue_tombstones ENABLE ROW LEVEL SECURITY;
```

Verify after applying (`--linked` on cloud at the release, bare locally):
```bash
supabase db query --linked "select tablename, rowsecurity from pg_tables where tablename in ('rescue_projects','rescue_versions','rescue_jobs','rescue_ledger','rescue_tombstones')"   # all true
supabase db query --linked "select count(*) from pg_policies where tablename in ('rescue_projects','rescue_versions','rescue_jobs','rescue_ledger','rescue_tombstones')"              # 0
```

### 1.3 Shared types

Server: `src/lib/rescue/pipeline/contract.ts`. App: `types/rescue-v2.ts`, this first block word for word (re-declared, the repos share no package). The second block, "server-side only", stays on the server. Dashboard: the admin shapes in §1.4 only.

```ts
export const RESCUE_STAGES = [
  "await_upload", "propose_order", "await_part_order", "merge", "read", "await_setup",
  "map", "diagnose", "ask", "read_cover", "preview",
  "source", "map_changed", "ask_changed", "await_answers",
  "reset", "regenerate", "render", "review", "review_render", "prove", "deposit", "publish",
  "done",
] as const;
export type RescueStage = (typeof RESCUE_STAGES)[number];
export type RescueLane = "heavy" | "brain";
export type RescueJobKind = "pipeline" | "read_guide" | "parse_note" | "cover_samples";
export type RescueVersionKind = "original" | "rescue" | "rerun" | "restore";
export type RescueVersionStatus = "running" | "waiting_student" | "done" | "failed";
export type RescueTrigger =
  | "first_diagnosis" | "first_rescue" | "rules_edited" | "supervisor_note"
  | "new_file" | "edited_in_kwill" | "restored" | "staff_retry" | "pack_rebuilt";
export type RescueFailureCode =
  | "not_docx" | "word_refused" | "merge_refused" | "regenerate_failed" | "prove_failed"
  | "stage_crashed" | "brain_failed" | "converter_unavailable" | "not_same_thesis" | "too_big";

export type RescuePhase =
  | "uploading" | "proposing_order" | "await_part_order" | "reading" | "await_setup"
  | "understanding" | "diagnosing" | "diagnosed"
  | "confirm_rules" | "confirm_questions" | "confirm_cover"
  | "repairing" | "done" | "failed";

export type RescueStepKey =
  | "upload" | "read" | "understand" | "compare"
  | "prepare" | "styles" | "typography" | "sections" | "cover" | "toc" | "captions" | "check";

export interface RescueProgressDTO {
  track: "reading" | "repairing";
  /** 1-based. On "repairing", 1..8. */
  step: number;
  of: number;
  stepKey: RescueStepKey;
  pagesReady: number;
  pagesTotal: number;
  /** null while waiting on the brain or on Word: never a made-up number. */
  etaSeconds: number | null;
}

export interface RescueConfigDTO {
  enabled: boolean;
  forSale: boolean;
  priceDzd: number | null;
  paymentsEnabled: boolean;
  manualEnabled: boolean;
  limits: { partMb: number; parts: number; totalMb: number; guideMb: number };
}

export interface RescuePartDTO {
  index: number;
  filename: string;
  sizeBytes: number;
  uploaded: boolean;
  role: "cover" | "front-matter" | "introduction" | "chapter" | "conclusion" | "bibliography" | "annex" | "other" | null;
  continuesPrevious: boolean;
  /** Position in the proposed or confirmed order, 0-based. `parts` always arrives sorted by it (once an order exists), so screen 2 shows the proposal. */
  order: number;
  /** The part's own first lines, for the mini page on screen 2. */
  openingText: string;
}

export interface RescueNoteChipDTO {
  id: string;
  label: string;
  kind: "rule" | "hint";
  /** kind "rule" only. */
  ruleField?: RescueRuleFieldId;
  value?: string | number | boolean;
}
export interface RescueNoteConflictDTO {
  id: string;
  fieldId: RescueRuleFieldId;
  noteValue: string | number | boolean;
  guideValue: string | number | boolean;
  choice: "note" | "guide" | null;
}
export interface RescueNoteDTO {
  /** The newest note's text. */
  text: string;
  /** How many notes are saved, for H5. */
  count: number;
  state: "none" | "parsing" | "ready" | "failed";
  chips: RescueNoteChipDTO[];
  conflicts: RescueNoteConflictDTO[];
  refused: { label: string; reason: "changes-words" | "skips-checks" | "breaks-deposit" | "not-supported" }[];
}

export interface RescueSetupDTO {
  universityId: string | null;
  universityName: string | null;
  normProfileId: string | null;
  /** True when the university came from the student's profile. */
  fromProfile: boolean;
  /** P-70: a faculty-specific profile of this university, offered as a question; null when none, or when a generic one was applied by itself. */
  profileOffer: { id: string; name: string } | null;
  guide: { state: "none" | "reading" | "read" | "failed"; filename: string | null };
}

export interface RescueSummaryDTO {
  pages: number;
  chapters: number;
  figures: number;
  tables: number;
  equations: number;
  footnotes: number;
  hasCover: boolean;
  format: "classic" | "imrad" | "1275";
  language: "ar" | "fr" | "en";
}

export type RescueChipKey = "headings" | "cover" | "toc" | "numbering" | "figures" | "text" | "structure";
export interface RescueDotDTO {
  n: number;
  chip: RescueChipKey;
  /** A Diagnose code with any ":id" removed: "margins", "section-missing". */
  code: string;
  page: number;
  /** 0..1 from the top of the page. */
  topPct: number;
  params: Record<string, string | number>;
}
export interface RescueDiagnosisDTO {
  total: number;
  chips: { key: RescueChipKey; count: number }[];
  dots: RescueDotDTO[];
  /**
   * Things only the student can fill in, such as an empty conclusion. Said kindly, never counted in `total`.
   * `section` null: the item is about a place (a figure with no caption), worded from `diagnosis.problems.<code>`.
   */
  studentItems: { code: string; section: string | null; pages: number[] }[];
  /** Captions left unnumbered that D-22 will number. Shown beside the switch on the rules screen. */
  captionNumbersToAdd: number;
  /** Soft outlines on one page for screen 6. */
  outline: { page: number; bands: { topPct: number; heightPct: number; role: string }[] } | null;
}

export type RescueRuleFieldId =
  | "bodyFont" | "bodySize" | "secondFont" | "secondSize" | "alignment" | "lineSpacing"
  | "h1Size" | "h2Size" | "h3Size" | "headingBold"
  | "marginTop" | "marginBottom" | "marginBinding" | "marginOpposite" | "bindingSide"
  | "frontMatter" | "pagePosition" | "noNumberDedication" | "noNumberThanks" | "footnoteSize" | "deposit"
  | "captionNumbers" | "dividers" | "frames" | "referencesSort" | "keepTables";
export type RescueRuleRowId = "font" | "headings" | "spacing" | "margins" | "numbering" | "footnotes" | "deposit" | "additions";
export interface RescueRuleFieldDTO {
  id: RescueRuleFieldId;
  row: RescueRuleRowId;
  kind: "enum" | "number" | "switch";
  value: string | number | boolean;
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  source: "default" | "catalogue" | "guide" | "note" | "student";
}
export interface RescueRulesDTO {
  fields: RescueRuleFieldDTO[];
  fromGuide: boolean;
  confirmedAt: string | null;
}

export interface RescueQuestionDTO {
  /** A content hash. Never shown. */
  key: string;
  text: string;
  excerpt: string;
  /** null on a re-run: a new block has no page yet (P-29). The app shows the excerpt on a blank paper. */
  page: number | null;
  topPct: number | null;
  options: { label: string; role: string }[];
  answer: { role: string } | { decide: true } | null;
}

export type RescueCoverChoice = "keep" | "clean" | "generated";
export interface RescueCoverFieldsDTO {
  university?: string; faculty?: string; department?: string;
  degree?: string; field?: string; specialty?: string;
  title?: string; subtitle?: string;
  students?: string[]; supervisor?: string; coSupervisor?: string;
  jury?: { name: string; rank?: string; role?: string }[];
  academicYear?: string;
}
export interface RescueCoverDTO {
  hasCover: boolean;
  allowedChoices: RescueCoverChoice[];
  defaultChoice: RescueCoverChoice;
  choice: RescueCoverChoice | null;
  fields: RescueCoverFieldsDTO;
  fieldSources: Record<string, "cover" | "thanks" | "catalogue" | "profile" | "student">;
  /** Fields the chosen cover cannot do without, still empty. */
  missing: string[];
  samples: "none" | "rendering" | "ready" | "failed";
}

export interface RescueEntitlementDTO {
  kind: "purchase" | "subscription" | "staff" | null;
  /** True when the student's current plan includes the rescue: screen 9 is skipped. */
  includedByPlan: boolean;
  forSale: boolean;
  priceDzd: number | null;
  purchase: {
    state: "none" | "pending_card" | "pending_manual" | "rejected_manual" | "paid" | "refund_due" | "refunded";
    rejectReason: string | null;
  };
  rerunFreeUntil: string | null;
}

export interface RescueFailureDTO {
  versionId: string;
  code: RescueFailureCode;
  /** The page a Prove check pointed at, when it could. */
  page: number | null;
  /** What happens to the money. */
  refund: "none" | "due" | "done";
  /** Newest version still good, null when none. */
  previousVersionN: number | null;
  /** not_same_thesis: a person can look at it (P-57). */
  reviewable: boolean;
  reviewRequested: boolean;
}

/** What a version's deposit pack holds. Screen 15 builds its line from this, never from fixed words. */
export interface RescuePackDTO {
  /** partial: something a rebuild could add is left out. missing: no pack at all (P-48). */
  state: "ready" | "partial" | "missing";
  /** Kinds in the zip, in pack order: thesis-pdf, thesis-docx, abstract-sheet, integrity-declaration, deposit-authorisation, cd-note. */
  files: string[];
  /** Left out and worth saying: the rules' own choices (pdf-only, not-required) never appear here. */
  omitted: { kind: string; reason: "no-abstracts" | "render-failed" | "missing" }[];
}

export interface RescueVersionSummaryDTO {
  id: string;
  n: number;
  kind: RescueVersionKind;
  trigger: RescueTrigger;
  /** For "restored": which version came back. */
  triggerN: number | null;
  status: RescueVersionStatus;
  createdAt: string;
  finishedAt: string | null;
  pages: number;
  fixes: number;
  changedPages: number | null;
  published: boolean;
  /** The student edited in Kwill between the parent version and this one: a grey step under it on the timeline. */
  editedBefore: boolean;
  /** Blocks that differed from the parent when this version read its source. */
  changedBlocks: number | null;
  /** null on the original and while the version runs. */
  pack: RescuePackDTO | null;
}

export type RescueChangeGroup = "cover" | "toc" | "headings" | "captions" | "numbering" | "pages" | "references" | "notes" | "fonts" | "typography" | "other";
export interface RescueChangeItemDTO {
  page: number | null;
  code: string;
  count: number;
  params: Record<string, string | number>;
}
export interface RescueChangeReportDTO {
  total: number;
  groups: { key: RescueChangeGroup; count: number; items: RescueChangeItemDTO[] }[];
}

export interface RescueVersionDetailDTO extends RescueVersionSummaryDTO {
  changes: RescueChangeReportDTO | null;
  deposit: { files: { kind: string; name: string; sizeBytes: number }[]; omitted: { kind: string; reason: string }[] } | null;
  settings: { coverChoice: RescueCoverChoice | null; notes: number; answers: number };
}

export interface RescueProjectDTO {
  id: string;
  title: string;
  thesisId: string | null;
  language: "ar" | "fr" | "en" | null;
  phase: RescuePhase;
  waiting: "converter" | "brain" | null;
  progress: RescueProgressDTO | null;
  /** The version a job works on now, v0 during the free stages. */
  activeVersionId: string | null;
  originalVersionId: string;
  currentVersion: RescueVersionSummaryDTO | null;
  parts: RescuePartDTO[];
  setup: RescueSetupDTO;
  note: RescueNoteDTO;
  summary: RescueSummaryDTO | null;
  diagnosis: RescueDiagnosisDTO | null;
  previewReady: boolean;
  entitlement: RescueEntitlementDTO;
  rules: RescueRulesDTO | null;
  questions: RescueQuestionDTO[];
  cover: RescueCoverDTO | null;
  failure: RescueFailureDTO | null;
  editedInKwill: boolean;
  /** Cold start navigates here only when true (P-35). */
  resumeOnOpen: boolean;
  updatedAt: string;
}

export interface RescueProjectSummaryDTO {
  id: string;
  title: string;
  /** False for an entitled project with no thesis yet: paid money is never deleted silently (P-65). */
  canDelete: boolean;
  thesisId: string | null;
  phase: RescuePhase;
  currentVersionN: number | null;
  currentVersionAt: string | null;
  coverPageVersionId: string | null;
  resumeOnOpen: boolean;
  updatedAt: string;
}

export interface RescueImpactDTO {
  /** none: nothing to redo, the CTA is off. pack: only the deposit pack (P-48). note: a new note with no rule in it. */
  scope: "none" | "pack" | "note" | "pages" | "all";
  pages: number[];
  toc: boolean;
  nextN: number;
  /** Blocks edited in Kwill since the last version; null when not measured. */
  changedBlocks: number | null;
}
```

Server-side only, same file:

```ts
export const STAGE_LANE: Partial<Record<RescueStage, RescueLane>> = {
  propose_order: "brain", merge: "heavy", read: "heavy",
  map: "brain", diagnose: "heavy", ask: "brain", read_cover: "brain", preview: "heavy",
  source: "heavy", map_changed: "brain", ask_changed: "brain",
  reset: "heavy", regenerate: "heavy", render: "heavy", review: "brain", review_render: "heavy",
  prove: "heavy", deposit: "heavy", publish: "heavy",
};
export const STAGE_USES_WORD: ReadonlySet<RescueStage> = new Set(["read", "preview", "render", "review_render", "deposit"]);

/** The cover's stored state (`rescue_projects.cover`). RescueCoverDTO is its view. */
export interface CoverState {
  hasCover: boolean;
  /** The `read_cover` stage's dry run of `applyCover` (policy clean) changed nothing: no empties removed, no paragraph restyled, no page break removed (Task S17). */
  alreadyClean: boolean;
  allowedChoices: RescueCoverChoice[];  // no cover → ["generated"]; clean → ["keep","generated"]; messy → ["clean","generated"]
  defaultChoice: RescueCoverChoice;     // no cover → generated; clean → keep; messy → clean
  choice: RescueCoverChoice | null;
  /** What the student confirmed. Feeds the deposit forms always, and the cover only under `generated` (P-50). */
  fields: Partial<CoverFields>;
  /** As `read_cover` found them, never edited: `clean` finds its title block from these. */
  readFields: Partial<CoverFields>;
  fieldSources: Record<string, "cover" | "thanks" | "catalogue" | "profile" | "student">;
  samples: "none" | "rendering" | "ready" | "failed";
  /** Fields changed while the samples were rendering: the job renders once more before it ends (Task S17). */
  dirty?: boolean;
}

/** parse_note's answer. Here, not in S6's file, because S8 builds on it in the same group. */
export type ParsedChip =
  | { id: string; kind: "rule"; label: string; path: string; value: string | number | boolean }
  /** A statement about the structure, for Map and Review. A wish about the look is never a hint (P-45). */
  | { id: string; kind: "hint"; label: string; hint: string };
export interface ParseNoteAnswer {
  taskId: string;
  chips: ParsedChip[];
  refused: { label: string; reason: "changes-words" | "skips-checks" | "breaks-deposit" | "not-supported" }[];
  notes?: string;
}

/** One change, placed. `at` is a final block index, null for a whole-document rule. Holds no student text. */
export interface ChangeEvent {
  code: string;
  group: RescueChangeGroup;
  at: number | null;
  count: number;
  params?: Record<string, string | number>;
}

// The three files below live in v{n}/work/ and are what one stage hands the next across processes. They may hold
// block lists and, for typed notes, the student's words, so they never go in a row, a DTO or a log. They go when the version ends.

/** v{n}/work/reset.json */
export interface ResetWork {
  /** Source block -> reset block, -1 when gone. */
  indexMap: number[];
  deleted: number[];
  report: ResetReport;
  roles: Record<string, { i: number; role: string }>;
}

/** v{n}/work/regen.json */
export interface RegenWork {
  /** Reset block -> final block, -1 when gone. */
  indexMap: number[];
  /** Final block index -> role. */
  finalRoles: Record<number, string>;
  /** Every step's report as it came, `layout.indexMap` included. `typography.changes` keep `i` and `kind` only: the words stay out. */
  report: RegenerateResult["report"];
  /** Built by `changeEvents` (Task S9), in final indices, so nothing later needs the maps again. */
  events: ChangeEvent[];
  /** D-26: final indices of the blocks declared moved. Prove reads the order back through them. */
  moved: number[];
  /** typed-notes.ts: `proof` and `ledger`, in that step's indices. */
  notes: { proof: TypedNotesProof; ledger: NoteLedgerRow[] } | null;
  /** font-policy.ts, for `replayFontSwaps`. */
  swapTable: FontSwapTable | null;
}

/** v{n}/work/render.json */
export interface RenderWork {
  /** Set when Word refused the final file, or the render failed for good. Prove then fails on its `render` check. */
  renderError: string | null;
  pagesAfter: number | null;
  plainPages: number;
  markedPages: number;
  firstDriftPage: number | null;
  driftPages: number;
  overlapPct: number | null;
  pairPct: number | null;
  timing: Record<string, number>;
  tocPresent: boolean;
  tocPage: number | null;
  pdfNumbers: string[];
  tocFill: { filled: number; expected: number } | null;
  bodyStartPage: number | null;
  /** Pages a generated divider starts on (`pagesToExempt`). */
  dividerPages: number[];
}

// In memory, between two calls in one process. A later process rebuilds them from the work file and storage.
export interface ResetOutput extends ResetWork { docx: Buffer; inv: Inventory }
export interface RegenOutput extends Omit<RegenWork, "events"> { ok: boolean; docx: Buffer; failedStep?: string }
export interface FinalRender extends RenderWork { docx: Buffer; pdf: Buffer; pageMap: PageMap; pdfText: PageText[]; inv: Inventory }

/**
 * What later stages need that fits in JSON. Bytes and block lists stay in storage; `work` names the file.
 * Every stage must be able to run from this and storage alone, in a process that ran nothing else.
 */
export interface RescueStageState {
  progress?: { stepKey: RescueStepKey; pagesReady: number; pagesTotal: number };
  stageSeconds?: Record<string, number>;
  wordConversions?: number;
  wordSeconds?: number;
  brainTasks?: number;
  /** Bytes written so far, across processes, for `RescueCost.storageBytes`. */
  storageBytes?: number;
  sourceDocHash?: string | null;
  /** What this version's publish wrote, saved right after the write, so a retry knows its own hash. */
  publishDocHash?: string;
  changedKeys?: string[];
  keptBlocks?: number;
  commentsStripped?: number;
  /** A `pack_rebuilt` re-run (P-48). */
  packOnly?: boolean;
  /** Earlier attempts of a v0 that staff retried (P-43). */
  priorFailures?: { failure: unknown; stageSeconds?: Record<string, number> }[];
  reset?: { work: string; docPath: string; inventoryPath: string };
  regenerate?: { work: string; docPath: string };
  render?: { work: string; docPath: string; pdfPath: string; pageMapPath: string; finalInventoryPath: string };
  /** `fixes` and `exempt` add up across rounds. An exemption names the block opening its page, so a re-render cannot point it at the wrong page. */
  review?: { round: number; pagesToRerender: number[]; fixes: { code: string; key: string | null }[]; exempt: { key: string; reason: string }[] };
  deposit?: { zipPath: string | null };
}

export interface RescueCost {
  brain: "session" | "model";
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  estDzd: number;
  brainTasks: number;
  wordConversions: number;
  wordSeconds: number;
  stageSeconds: Record<string, number>;
  storageBytes: number;
}
```

### 1.4 Endpoints

**Everything under `/api/rescue-v2`:** Supabase Bearer through the existing `authMiddleware`; `userId = c.get("userId")`; every row is owner-scoped and another student's id answers 404. Bodies are JSON unless marked raw. Errors are `{ "error": "<English, for logs>", "code": "<machine code>" }`; the app keys its copy on `code`. Every route except `/config` first checks `rescue.enabled` and answers 503 `rescue_disabled`. A `:vid` always means a version of a project the caller owns. `GET /versions/:a/compare/:b` takes both ids through `getOwnedVersion` and they must share a `project_id`, else 404.

| Method, path | Request | 2xx response | Errors (status `code`) |
|---|---|---|---|
| `GET /config` | | 200 `RescueConfigDTO` | |
| `GET /projects` | | 200 `{ projects: RescueProjectSummaryDTO[] }`, newest first | |
| `POST /projects` | `{ parts: [{ filename, sizeBytes }], source: "picker"\|"share" }` | 201 `RescueProjectDTO`, phase `uploading` | 400 `rescue_invalid_parts` (empty, more than 12, not `.docx`); 413 `rescue_too_large`; 409 `rescue_one_in_progress` + `projectId` (the client carries `projectId`, `missing` and `fieldId` from any error body, Task A1); 429 `rescue_daily_limit` (counted from `rescue_ledger`, P-59); 503 `rescue_busy` |
| `GET /projects/:id` | | 200 `RescueProjectDTO` | 404 `not_found` |
| `DELETE /projects/:id` | | 200 `{ deleted: true }` | 409 `rescue_has_thesis` (delete the thesis instead); 409 `rescue_payment_pending`; 409 `rescue_entitled` (an entitled project with no thesis, P-65) |
| `PUT /versions/:vid/parts/:index` | **raw** .docx bytes, `Content-Type: application/octet-stream` | 200 `RescueProjectDTO`; the last part starts the next stage | 400 `not_docx` (no zip magic, or `preflightDocx` refused it, P-56), `rescue_empty`; 411 `length_required`; 413 `rescue_too_large` (checked against the bytes already stored for this version); 409 `rescue_wrong_stage` |
| `DELETE /versions/:vid` | only a re-run still on `await_upload` | 200 `RescueProjectDTO` | 409 `rescue_wrong_stage` |
| `PUT /projects/:id/part-order` | `{ order: number[], continuesPrevious: number[] }` | 200 `RescueProjectDTO`, phase `reading` | 400 `rescue_invalid_order`; 409 `rescue_wrong_stage` |
| `PUT /projects/:id/setup` | `{ universityId?: string\|null, normProfileId?: string\|null }` | 200 `RescueProjectDTO` | 400 `rescue_unknown_university`; 409 `rescue_wrong_stage` |
| `PUT /projects/:id/guide` | **raw** PDF, JPEG or PNG, real `Content-Type`; the file name in header `x-file-name` (URL-encoded), never the query string, which the request log writes | 202 `RescueProjectDTO`, `setup.guide.state='reading'` | 400 `rescue_guide_type` (the first bytes must match the type); 411 `length_required`; 413 `rescue_too_large`; 409 `rescue_guide_reading`; 429 `rescue_guide_limit` |
| `DELETE /projects/:id/guide` | | 200 `RescueProjectDTO` | |
| `PUT /projects/:id/note` | `{ text: string, kind: "start"\|"supervisor" }`, text up to 2000 chars; empty text on `start` clears | 202 `RescueProjectDTO`, `note.state='parsing'` (200 and `none` when cleared) | 400 `rescue_note_too_long`; 409 `note_parsing`; 429 `rescue_note_limit`. The same text as the newest note is not appended again and starts no job (a retried request) |
| `DELETE /projects/:id/note/chips/:chipId` | | 200 `RescueProjectDTO` | |
| `POST /projects/:id/note/conflicts/:conflictId` | `{ choice: "note"\|"guide" }` | 200 `RescueProjectDTO` | 400 |
| `POST /projects/:id/diagnose` | | 202 `RescueProjectDTO`, phase `understanding` | 409 `note_parsing`, `guide_reading`, `note_conflict`, `rescue_wrong_stage` |
| `GET /versions/:vid/pages?from=1&to=12` | `to - from` at most 30 | 200 `{ count, pages: [{ page, hash, url }] }`; URLs live 1 h. Reads `version.pages` as it stands, so mid-stage it returns the pages uploaded so far | 404 |
| `GET /projects/:id/preview` | | 200 `{ cover: { afterUrl, beforeUrl }, chapter: { afterUrl, beforeUrl } \| null }` | 409 `rescue_wrong_stage` |
| `POST /projects/:id/continue` | | 200 `RescueProjectDTO`, entitled through the plan when `includedByPlan` | 402 `rescue_payment_required` + `priceDzd`, `forSale`; 402 `rescue_allowance_used` (a plan's included rescues are spent, P-58; the 402 path also sends the ready-email, P-69) |
| `PUT /projects/:id/rules` | `{ edits?: { [RescueRuleFieldId]: value }, confirm?: boolean }` | 200 `RescueProjectDTO` | 400 `rule_out_of_range` + `fieldId`; 402 `rescue_not_entitled` |
| `PUT /projects/:id/answers` | `{ key: string, answer: { role: string } \| { decide: true } }` | 200 `RescueProjectDTO` | 400 `rescue_unknown_question`, `rescue_invalid_role` |
| `PUT /projects/:id/cover` | `{ choice?: RescueCoverChoice, fields?: RescueCoverFieldsDTO }` | 200 `RescueProjectDTO` | 400 `rescue_cover_choice` (not in `allowedChoices`) |
| `POST /projects/:id/cover/samples` | | 202 `RescueProjectDTO`, `cover.samples='rendering'` | 402 `rescue_not_entitled` (P-24); 409 `rescue_cover_rendering`; 429 `rescue_samples_limit` |
| `GET /projects/:id/cover/samples` | | 200 `{ keep?: url, clean?: url, generated?: url }` | |
| `POST /projects/:id/rescue` | | 202 `RescueProjectDTO`, phase `repairing` | 402 `rescue_not_entitled`; 409 `rescue_run_active`, `rescue_wrong_stage`; 422 `cover_fields_missing` + `missing: string[]` |
| `POST /versions/:vid/review-request` | | 200 `RescueProjectDTO`; only on a version that failed `not_same_thesis`; opens a Support case once and sets `failure.reviewRequested` (P-57) | 409 `rescue_wrong_stage` |
| `GET /projects/:id/versions` | | 200 `{ versions: RescueVersionSummaryDTO[], edited: { edited: boolean, changedBlocks: number\|null, afterVersionN: number\|null } }`, newest first, original last | |
| `GET /versions/:vid` | | 200 `RescueVersionDetailDTO` | |
| `GET /versions/:vid/files/:kind` | `kind` = `pdf`, `docx`, `deposit`, or `part` with `?index=` (a part as uploaded, split theses, P-44) | 200 `{ url, filename, format, title }`, shaped for `downloadExport`; URL lives 1 h | 404 `rescue_no_file` |
| `GET /versions/:a/compare/:b?offset=0&limit=6` | | 200 `{ total, pages: [{ page, aUrl, bUrl, aHash, bHash }], changes: RescueChangeItemDTO[] }`, differing pages only. `changes`: `compareChanges`, Task S9 | 404 when either version is not the caller's or the two belong to different projects |
| `POST /versions/:vid/restore` | | 201 `RescueProjectDTO` | 400 `rescue_cannot_restore_original` (P-44), `rescue_not_done`; 409 `rescue_run_active`; 503 `rescue_locked` (lock wait ran out). Retried safely: when the newest version is already a restore of this target and the thesis hash matches it, that row is returned. The new row is a full copy and the project's standing choices reset to it (P-60) |
| `POST /projects/:id/reruns` | `{ source: "auto"\|"upload", parts?: [{ filename, sizeBytes }] }` | 201 `RescueProjectDTO`; for `upload` the parts follow through `PUT /versions/:vid/parts/:index` with `activeVersionId`. With `auto`, the server makes it a `pack_rebuilt` run when only the deposit rule changed or the last pack is not `ready` and nothing else did (P-48) | 402 `rescue_not_entitled`, `rescue_rerun_expired`; 409 `rescue_run_active`, `note_parsing`, `note_conflict`, `rescue_wrong_stage` (no done rescue yet), `rescue_refund_due` (P-63), `rescue_storage_full` (P-64); 422 `cover_fields_missing` + `missing`; 429 `rescue_rerun_daily_cap` |
| `GET /projects/:id/impact` | | 200 `RescueImpactDTO`, comparing the project's current settings with the last done version's snapshot, so it survives leaving H5 | 409 `rescue_wrong_stage` (no done version) |
| `POST /versions/:vid/resume` | | 202 `RescueProjectDTO`; copies the project's answers into this version's `settings.answers` in the same update | 409 `rescue_wrong_stage`, `rescue_questions_open` |
| `POST /versions/:vid/ack` | | 200 `RescueProjectDTO` | |

**Checkout, extended routes (`src/routes/payment.ts`, `src/routes/pay.ts`):**

| Method, path | Request | 2xx | Errors |
|---|---|---|---|
| `POST /api/payment/checkout` | adds `{ kind: "rescue", projectId, locale }` | 200 `{ checkoutUrl, checkoutId, amountDzd, mode }` | 404 `not_found`; 409 `rescue_already_entitled`, `rescue_not_for_sale`, `rescue_not_ready`; plus the existing 503s |
| `POST /api/payment/manual` | adds `{ kind: "rescue", projectId, base64, mimeType, referenceNumber }` | 200 `ManualPaymentRow`, `kind='rescue'`, `rescueProjectId` | the same 404/409s, plus the existing ones |
| `GET /api/payment/return?status=success&rescue=<id>` | | HTML; deep link `kwill://payment-success?rescue=<id>` | |
| `GET /pay?token=&lang=&project=<id>` | signed token | HTML with one rescue card | 403 bad token; 404 when the project is not the token's user's; 503 `unavailable` when not for sale |
| `GET /pay/go?token=&lang=&item=rescue&project=<id>` | | 302 to Chargily | same |

**Staff, under `/admin/rescue`:** `x-admin-token` through `requireAdmin`. Mounted before `/admin` in `src/index.ts`, like `/admin/manual-payments`.

| Method, path | Request | 2xx | Errors |
|---|---|---|---|
| `GET /settings` | | 200 `{ enabled: "off"\|"staff"\|"on", priceDzd: number\|null, freeDiagnosesPerDay: number, rerunWindowDays: number, planRescuesPer30d: number }` | |
| `PUT /settings` | any of those fields; `priceDzd: null` takes it off sale | 200 `{ saved: true }` | 400 `invalid_price` (not an integer 1..100000), `invalid_setting` |
| `GET /runs?status=&q=&limit=50&offset=0` | `status`: `running`, `waiting`, `done`, `failed`, `refund_due`; `q`: email substring | 200 `{ rows: RescueRunRow[], total }` | |
| `GET /runs/summary?days=7` | | 200 `RescueRunsSummary` | |
| `GET /refunds?status=due&limit=50&offset=0` | `status`: `due`, `done` | 200 `{ rows: RescueRefundRow[], total }`, read straight from `payments`: a double payment, or a payment whose project is gone, is on it | |
| `POST /payments/:id/refunded` | `{ refundedBy: uuid, note?: string, confirmDelivered?: boolean }` | 200 `{ refunded: true }` | 409 `not_refund_due`, `rescue_already_delivered` (a done rescue exists and `confirmDelivered` is not set, P-63) |
| `POST /versions/:id/retry` | `{ requestedBy: uuid, overrideSameThesis?: boolean }` | 201 `{ versionId }`; `overrideSameThesis` is for a `not_same_thesis` failure only and rebases the project's anchor (P-57) | 409 `rescue_run_active`, `rescue_not_failed`, `rescue_needs_override` |
| `POST /users/:id/rescue-sweep` | | 200 `{ removed: number }`, every rescue row and blob of that student; the dashboard calls it before deleting the account (P-34) | |

```ts
export interface RescueRunRow {
  versionId: string; projectId: string; n: number; kind: RescueVersionKind; trigger: RescueTrigger;
  status: RescueVersionStatus; stage: RescueStage;
  waitingReason: "converter" | "brain" | null;
  userId: string; userEmail: string | null;
  thesisId: string | null; title: string;
  pages: number | null; durationSeconds: number | null;
  cost: RescueCost | null;
  failureCode: RescueFailureCode | null; failurePage: number | null;
  entitlement: "purchase" | "subscription" | "staff" | null;
  paymentId: string | null; amountDzd: number | null; refundStatus: "due" | "done" | null;
  supportConversationId: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface RescueRefundRow {
  paymentId: string; userId: string; userEmail: string | null;
  projectId: string | null; projectTitle: string | null;
  amountDzd: number; gateway: string; reason: string | null;
  refundStatus: "due" | "done"; refundedAt: string | null; createdAt: string;
}
export interface RescueRunsSummary {
  days: number; running: number; waiting: number; done: number; failed: number; refundDue: number;
  avgCostFirstDzd: number | null; avgCostRerunDzd: number | null;
  avgSecondsFirst: number | null; avgSecondsRerun: number | null;
  wordReachable: boolean;
  /** The Mac's last canary: null before the first (P-54). */
  wordCanary: { ok: boolean; at: string; restarts24h: number } | null;
  /** Running versions with no job, or a lease lost twice (P-61). */
  stuck: number;
  /** Seconds the oldest running heavy job has run: the host's one slot (P-61). */
  oldestHeavySeconds: number | null;
  storageBytes: number;
}
```

### 1.5 The rules-screen fields

The server owns this table (`src/lib/rescue/rules/fields.ts`, Task S4) and sends options with each field; the app holds only labels. Editing a field writes `rule_edits`; effective rules are `default < catalogue < guide < note < edits` (`resolveRules`). Margins redraw on the page live on screen 10.

| `id` | Row | `RescueRules` path | Kind | Allowed values | Default (ar / fr, en) |
|---|---|---|---|---|---|
| `bodyFont` | font | `body.font` | enum | ar: Simplified Arabic, Traditional Arabic, Sakkal Majalla, Arabic Typesetting, Amiri, Noto Naskh Arabic. fr, en: Times New Roman, Arial, Calibri, Cambria, Liberation Serif | Simplified Arabic / Times New Roman |
| `bodySize` | font | `body.sizePt` | number | 10-18, step 1 | 14 / 12 |
| `secondFont` | font | `body.secondFont` | enum | the other script's list: on an Arabic thesis the fr, en list above, otherwise the ar list | Times New Roman / Simplified Arabic |
| `secondSize` | font | `body.secondSizePt` | number | 8-18, step 1 | 12 |
| `alignment` | spacing | `body.alignment` | enum | `justify`, `start` | `justify` |
| `lineSpacing` | spacing | `body.lineSpacing` | enum | 1, 1.15, 1.5, 2 | 1.5 |
| `h1Size` | headings | `headings.h1SizePt` | number | 12-28, step 1 | 18 / 16 |
| `h2Size` | headings | `headings.h2SizePt` | number | 11-24, step 1 | 16 / 14 |
| `h3Size` | headings | `headings.h3SizePt` | number | 10-22, step 1 | 14 / 13 |
| `headingBold` | headings | `headings.bold` | switch | | on |
| `marginTop` | margins | `page.marginTopCm` | number | 1.5-4.5, step 0.5 | 2.5 |
| `marginBottom` | margins | `page.marginBottomCm` | number | 1.5-4.5, step 0.5 | 2.5 |
| `marginBinding` | margins | `page.marginBindingCm` | number | 1.5-4.5, step 0.5 | 3 |
| `marginOpposite` | margins | `page.marginOppositeCm` | number | 1.5-4.5, step 0.5 | 2 |
| `bindingSide` | margins | `page.bindingSide` | enum | `left`, `right` | `right` / `left` |
| `frontMatter` | numbering | `pagination.frontMatter` | enum | `roman`, `letters`, `arabic`, `none` | `roman` |
| `pagePosition` | numbering | `pagination.position` | enum | `bottom-center`, `bottom-outside` (Prove reads the number at the foot, so `top-outside` is not offered) | `bottom-center` |
| `noNumberDedication` | numbering | `pagination.noNumberDedication` | switch | | off |
| `noNumberThanks` | numbering | `pagination.noNumberThanks` | switch | | off |
| `footnoteSize` | footnotes | `footnotes.sizePt` | number | 8-14, step 1 | 12 / 10 |
| `deposit` | deposit | `deposit` (virtual) | enum | `platform_pdf` (`{pdfOnly:true,cd:false}`), `pdf_word` (`{pdfOnly:false,cd:false}`), `copies_cd` (`{pdfOnly:false,cd:true}`) | `pdf_word` |
| `captionNumbers` | additions | `captions.addNumbers` | switch | D-22 | on |
| `dividers` | additions | `ornaments.dividers` | switch | D-24 | on / off |
| `frames` | additions | `ornaments.frames` | switch | D-24 | on / off |
| `referencesSort` | additions | `references.groupAndSort` | switch | D-26, §5.11 | off |
| `keepTables` | additions | `tables.keepAsIs` | switch | a note's "keep my tables as they are" | off |

A note or a guide may set any field in this table and nothing else. `parse_note` and `read_guide` answers are validated against it, so they can never skip a Prove check or change words (§6). Every field changes the file: Task S9a's table test fails on one that does not (P-45).

### 1.6 Storage layout (bucket `documents`, private)

`{root}` = `{userId}/rescue/{projectId}`.

```
{root}/parts/{index}.docx                 v0 parts, never deleted while the project lives
{root}/guide/guide.{pdf|jpg|png}          the department guide
{root}/pages/{sha1}.jpg                   every page image of every version, 800 px, q60, content-addressed
{root}/tmp/{sha256}.{docx|pdf}            handed to the Word service, removed after the job
{root}/samples/{keep|clean|generated}.jpg the cover pair for screen 12
{root}/v{n}/parts/{index}.docx            parts of an upload re-run
{root}/v{n}/source.docx                   this version's input (split theses, re-runs)
{root}/v{n}/source.pdf                    v0 only: the original rendered, v0's `pdf_path`
{root}/v{n}/inventory.json                inventory of source
{root}/v{n}/page-map.json                 page map of source (v0) or of the output (others)
{root}/v{n}/final-inventory.json          inventory of the output
{root}/v{n}/thesis.docx                   immutable output
{root}/v{n}/thesis.pdf                    the PDF Prove checked
{root}/v{n}/deposit.zip                   the whole pack; kept for the newest done version only, rebuilt on demand (P-64)
{root}/v{n}/deposit/{kind}.{ext}          each file of the pack that is not the thesis itself: `abstract-sheet.docx`. `thesis-pdf` and `thesis-docx` are references to `thesis.pdf` and `thesis.docx`, not copies (P-64)
{root}/v{n}/preview/{cover,chapter}.png   v0 only, watermarked
{root}/v{n}/work/...                      reset.docx, regenerated.docx, reset.json, regen.json, render.json, overview sheets; removed when the version ends
```

**Every key is ASCII.** Supabase Storage refuses anything outside `^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$`, and the pack's display names are Arabic on an Arabic thesis. A display name lives only in `deposit_files`, inside the zip, and in the signed URL's `download` filename. `fakeStorage` rejects a key that fails this pattern, so a test catches what the real store would refuse.

A first version of a 150-page thesis is about 20 MB of images plus the files. A re-run adds the pages that changed plus its `source.docx`, `thesis.docx` and `thesis.pdf`, which are whole-file objects and the real cost; a project stops at `rescue.project_max_mb` (P-64). A restore adds nothing: the new row points at the old paths. Everything goes with the project, and a tombstone covers what a running stage writes after the delete (Task S15, P-65). The cloud bucket's per-file limit and total allowance are unverified (local is 50 MiB). `rescue.max_object_mb` stays at 50 until §7 has checked them (P-10).

### 1.7 Settings and environment

| Key (`app_settings`) | Default | Meaning |
|---|---|---|
| `rescue.enabled` | unset = off | `"1"` opens the student routes and the tick; `"staff"` opens the routes to staff accounts only (P-68) |
| `rescue.price_dzd` | unset = not for sale | whole dinars |
| `rescue.free_diagnoses_per_day` | 3 | per student, per 24 h |
| `rescue.max_free_queue` | 20 | free jobs queued across the host |
| `rescue.max_object_mb` | 50 | the biggest object storage holds; a part and a whole upload may reach this ÷ 2.5 (P-10, P-64) |
| `rescue.project_max_mb` | 800 | all objects under one project; staff may raise it per project (P-64) |
| `rescue.max_pages` / `rescue.max_blocks` | 700 / 60000 | refused after the inventory with `rescue_too_big` (P-56) |
| `rescue.plan_rescues_per_30d` | 2 | rescues a plan includes per student in a rolling 30 days (P-58) |
| `rescue.notes_per_day` / `rescue.guides_per_day` / `rescue.samples_per_day` | 10 / 5 / 6 | per student, from `rescue_ledger` (P-59) |
| `rescue.rerun_window_days` | 365 | free re-runs after entitlement |
| `rescue.rerun_daily_cap` | 10 | per project, per 24 h |
| `rescue.same_thesis_min` | 0.4 | share of the anchor's long blocks a re-run must keep (P-57) |
| `rescue.same_thesis_traceable_min` | 0.6 | share of the new file's long blocks that must trace to the anchor or the last version (P-57) |
| `rescue.usd_to_dzd` | 253 | for `cost.estDzd`; `plans.ts` uses the same rate |

Read through `readSettingFresh` (Task S11), never `getSettingSync`: a value written by the dashboard reaches only the handling process's cache (P-20).

| Env | Where | Meaning |
|---|---|---|
| `RESCUE_BRAIN` | server | `session` on localhost; `model` from M7. Session refuses `NODE_ENV=production` and a non-local DB |
| `RESCUE_QUEUE_DIR` | server | session queue, default `lab/tasks` |
| `RESCUE_BRAIN_CONCURRENCY` | server | default 3 |
| `RESCUE_CONVERTER_WAIT_HOURS` | server | default 48 |
| `RESCUE_BRAIN_WAIT_HOURS` | server | default 6; a job waiting on the brain longer than this fails (P-61) |
| `RAG_INDEXING` | server | `off` on localhost (P-71) |
| `RESCUE_FORCE_FAIL` | server, dev only | `prove` forces an honest failure; ignored when `NODE_ENV=production` |
| `WORD_JOBS_SECRET` | server and Mac service | sent as `x-word-secret`; required on `/jobs`. The service refuses `/jobs` when it is unset, unless `WORD_JOBS_INSECURE=1` (a lab instance only) |
| `TASKS_TICK_SECRET` | server | existing; the cron's header |

### 1.8 Push payloads

`createNotification(userId, { type: "rescue", title, description, data })`. `type: "rescue"` is new in `NotifType` and the app's `NotificationType`, and is not in `TYPE_GATE`, so it always pushes when push is on. Titles go out as given, so `rescue-run/copy.ts` localises by `profiles.language` first (`ar`, `en`, else `fr`). Every `data` carries `route`, which `addNotificationListeners` pushes as is.

| Event | Sent when | `data.route` | ar title · body |
|---|---|---|---|
| `done` (screen 14) | a rescue or re-run publishes | `/(app)/rescue?projectId={id}` | «مذكرتك جاهزة ✓» · «الإصلاحات: {fixes} · الصفحات: {pages} · لم تتغيّر أي كلمة. اضغط لتحميلها.» |
| `failed` | a rescue or re-run fails | same | «لم نُكمل الإصلاح» · «ملفك الأصلي كما هو تمامًا. اضغط لمعرفة التفاصيل.» |
| `diagnosis_ready` | v0 finishes | same | «تشخيص مذكرتك جاهز» · «اضغط لترى ما سنصلحه.» |
| `parts_ready` | a stage ends on `await_part_order` | same | «رتّبنا أجزاء مذكرتك» · «تأكّد من الترتيب لنكمل.» |
| `setup_ready` | a stage ends on `await_setup` | same | «قرأنا صفحات مذكرتك» · «اختر قواعد كليتك لنبدأ التشخيص.» |
| `questions_waiting` | a stage ends on `await_answers` | same | «لدينا سؤال عن مذكرتك» · «أجب عنه لنكمل الإصلاح.» |
| `payment_ok` | a rescue purchase is granted | same | «وصلتنا دفعتك ✓» · «نكمل معًا خطوات الإصلاح.» |
| `payment_rejected` | staff reject a manual rescue payment | same | «لم نتمكن من تأكيد دفعتك» · «اضغط لمعرفة السبب وإعادة الإرسال.» |
| `refund_done` | staff mark the refund | same | «أعدنا لك المبلغ» · «ملفك الأصلي ما زال محفوظًا.» |

§9.1 says it is safe to leave at any point and a push brings the student back, so every state that waits on the student has one. The app shows no banner for a project whose screen is open (Task A9).

---

## 2. M4: the server

**Ends with:** a re-run after an edit is cheap and asks nothing twice, proved by Task S22 on a real corpus thesis through HTTP against localhost.

### Names to check when you start

M2b's integrator owns `regenerate/index.ts`, `prove/prove.ts`, `brain/tasks.ts`, `rules/rules.ts` and `cli.ts` until it reports done. Read them again at that commit. This plan assumes these names, as the M2b plan and the files on disk state them; where one differs, adapt `pipeline/stages-rescue.ts` only and leave the contract alone.

| Name | Assumed shape | Status at writing |
|---|---|---|
| `applyCover`, `rolesAfterCover`, `proveCover` | `cover/apply.ts` | exists, untracked |
| `buildReadCoverTask`, `validateReadCoverAnswer`, `missingCoverFields` | `cover/read-cover-task.ts` | exists, untracked |
| `CoverFields`, `CoverPolicy` | `cover/fields.ts` | exists, untracked |
| `buildCoverXml`, `coverFit` | `cover/generate.ts` | exists, untracked |
| `applyDividers`, `applyFrames`, `resolveOrnaments`, `pagesToExempt`, `generatedDividerStarts`, `GENERATED_STYLE` | `regenerate/dividers.ts` | exists, untracked |
| `applyReferences(engine, roles, lang, { group })`, `stripReferenceNumber` | `regenerate/references.ts` | stub at writing |
| `applyTypedNotes`, report `{ converted, skipped }` | `regenerate/typed-notes.ts` | exists, untracked |
| `applyCaptionPosition`, report `{ moved, notAdjacent, … }` | `regenerate/caption-position.ts` | exists, untracked |
| `applyFontPolicy`, `FontPolicyReport`, `defaultFontsDir` | `regenerate/font-policy.ts`, `regenerate/fonts.ts` | exists |
| `buildDepositPack(DepositPackInput)`, `zipDepositPack`, `abstractBlocksFromRoles` | `deposit/` | exists, untracked |
| `regenerate(input, hooks)` extended with `cover: { policy, fields, logo? }` and `references: { group }`, returning `moved`, `typedNotes: { proof, ledger }` and `report.fonts.swapTable` beside what it returns today | `regenerate/index.ts` | **not wired yet** |
| `proveDocx(input)` with `coverPolicy` and `coverFields` | `prove/prove.ts` | **not wired yet** |
| `reviewRound(input, brain)` → `{ issues, fixesApplied, pagesToRerender, exemptPages }`, `buildReviewTask`, `validateReviewAnswer`; Task S9b adds `studentNote` and `onlyPages` to the input | `review/` (M3 plan §1) | **no code yet** |

---

### Group S-A: foundations (one engineer, in this order: S0, S2, S1, S3, S4)

### Task S0: a local database that can run anything

`supabase start` gives an empty database. `~/kwill-server/supabase/` holds only `config.toml` and `templates`, it has no migrations, and the Docker volume the old test user lived in is gone. §1.2's SQL references `theses`, `universities`, `norm_profiles`, `support_conversations` and `payments`, which come from three other places (memory: `local-supabase`). Nothing below runs until they exist.

**Files:**
- Create: `scripts/rescue-local-db.sh`, `src/__tests__/setup-local-db-only.ts`, `src/__tests__/local-db-only.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: The guard (P-37), test first.** Existing DB suites `import "dotenv/config"` and skip only when the URL is absent, and `.env` holds the cloud pooler URL.
```ts
// src/__tests__/setup-local-db-only.ts — runs before every test file, so before any dotenv import.
// dotenv never overwrites a variable already set, even an empty one: a blank here keeps .env's cloud URL out.
export const isLocalDb = (url: string) => /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url);
if (!isLocalDb(process.env.DATABASE_URL ?? "")) process.env.DATABASE_URL = "";
```
`vitest.config.ts` gains `setupFiles: ["src/__tests__/setup-local-db-only.ts"]`. `local-db-only.test.ts`: `isLocalDb` over a table (the three local hosts true; a pooler URL and an empty string false), and after `await import("dotenv/config")` the variable is either blank or local.

- [ ] **Step 2: Run the whole suite with no `DATABASE_URL` on the command line.** `npx vitest run --testTimeout=60000`. DB suites now skip. A suite that fails because it reached for a database with no guard gets `describe.skipIf`, in its own commit: until now it was writing to production.

- [ ] **Step 3: `scripts/rescue-local-db.sh`.** Safe to re-run; each step is idempotent. If a `sql/` file fails on a fresh database, fix the order here, never the file.
```bash
#!/usr/bin/env bash
# A fresh local database for Rescue v2: schema, test accounts, one thesis. Never touches the cloud.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres

supabase start
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"

# 1. The Drizzle-owned tables: profiles, theses, universities, norm_profiles...
#    Only on an empty database: on a later run `push --force` would drop every table and column it does not describe.
if [ "$(psql "$DATABASE_URL" -Atc "select to_regclass('public.theses') is not null")" != t ]; then
  npx drizzle-kit push --force
fi

# 2. One boot: ensureSchema, the vector indexes, the seeds. /api/health answers only after them.
SUPABASE_URL="$API_URL" SUPABASE_SERVICE_KEY="$SERVICE_ROLE_KEY" NODE_ENV=development PORT=3999 npx tsx src/index.ts &
BOOT=$!
trap 'kill $BOOT 2>/dev/null || true' EXIT
until curl -sf localhost:3999/api/health >/dev/null; do sleep 2; done
kill $BOOT; wait $BOOT 2>/dev/null || true
trap - EXIT

# 3. What ensureSchema does not own, in date order: threads, tasks, billing, payments, support.
#    support-realtime.sql sorts before the support.sql it alters, so it goes last.
for f in $(ls sql/*.sql | grep -v support-realtime | sort) sql/2026-08-17-support-realtime.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

# 4. The profile trigger lives only in the app repo (memory: cloud-missing-profile-trigger).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$HOME/kwill/supabase/migrations/004_profile_oauth_identity.sql"

# 5. Accounts, password test1234. A second run finds them.
user() {
  curl -s -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"test1234\",\"email_confirm\":true}" >/dev/null
  psql "$DATABASE_URL" -Atc "select id from auth.users where email='$1'"
}
STUDENT=$(user rescue-student@kwill.local)
SUBSCRIBER=$(user rescue-subscriber@kwill.local)
STAFF=$(user rescue-staff@kwill.local)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
UPDATE profiles SET staff_role = 'super_admin' WHERE id = '$STAFF';
INSERT INTO theses (user_id, title, language, doc_mode)
  SELECT '$STUDENT', 'Local test thesis', 'ar', 'live-docx'
   WHERE NOT EXISTS (SELECT 1 FROM theses WHERE user_id = '$STUDENT');
SQL
if [ "$(psql "$DATABASE_URL" -Atc "select count(*) from subscriptions where user_id='$SUBSCRIBER' and status='active'")" = 0 ]; then
  SUPABASE_URL="$API_URL" SUPABASE_SERVICE_KEY="$SERVICE_ROLE_KEY" npx tsx -e "import('./src/lib/billing/subscriptions').then((m) => m.activatePlan({ userId: '$SUBSCRIBER', plan: 'monthly', gateway: 'manual', gatewayCheckoutId: 'local-seed', priceDzd: 0 })).then(() => process.exit(0))"
fi

# 6. Prove it.
for t in profiles theses universities norm_profiles app_settings payments subscriptions support_conversations ai_usage_log task_runs chat_threads; do
  [ "$(psql "$DATABASE_URL" -Atc "select to_regclass('public.$t') is not null")" = t ] || { echo "missing table: $t" >&2; exit 1; }
done
[ "$(psql "$DATABASE_URL" -Atc "select count(*) from universities")" -gt 0 ] || { echo "universities not seeded" >&2; exit 1; }
echo "local database ready: student, subscriber and staff accounts, one thesis"
```

- [ ] **Step 4: Run it twice, then the existing DB suites on it.**
```bash
cd ~/kwill-server && chmod +x scripts/rescue-local-db.sh && ./scripts/rescue-local-db.sh && ./scripts/rescue-local-db.sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/tasks/__tests__/claim.test.ts src/lib/billing/__tests__/manual-payments.test.ts src/lib/billing/__tests__/quota.test.ts
git commit -m "test(rescue): a local database built from nothing, and no DB test can reach the cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- scripts/rescue-local-db.sh src/__tests__/setup-local-db-only.ts src/__tests__/local-db-only.test.ts vitest.config.ts
```

### Task S1: the tables

**Files:**
- Create: `sql/2026-11-02-rescue-v2.sql`, `src/db/rescue-schema.ts`, `src/lib/rescue-run/__tests__/schema.test.ts`
- Modify: `src/db/index.ts` (one export line after `export * from "./support-schema";`)

- [ ] **Step 1: Write the SQL** exactly as §1.2.

- [ ] **Step 2: Apply it twice on local** to prove it is idempotent.
```bash
cd ~/kwill-server && ./scripts/rescue-local-db.sh    # S0; it already applies every file in sql/, this one included
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -f sql/2026-11-02-rescue-v2.sql
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -f sql/2026-11-02-rescue-v2.sql
```
Expected: the second run prints only `NOTICE … already exists, skipping`.

- [ ] **Step 3: Write the Drizzle description.** It only describes (same as `src/db/tasks-schema.ts`); `drizzle.config.ts` does not list it, and it must stay that way. `rescueProjects`, `rescueVersions`, `rescueJobs`, `rescueLedger`, `rescueTombstones`, one column per column of §1.2, `$type<>()` on the jsonb columns from `pipeline/contract.ts`, which Task S2 has already committed. Head comment: "The real DDL lives in sql/2026-11-02-rescue-v2.sql — ensureSchema() is dead on production." In `src/db/index.ts` add `export * from "./rescue-schema";`.

- [ ] **Step 4: Write the test.** `schema.test.ts`, local DB only (see Rules), deleting every row it makes:
  - each of the five tables has `rowsecurity=true` and zero rows in `pg_policies`;
  - inserting two `rescue_jobs` with `lane='heavy', status='running'` fails with code `23505`; two with `lane='brain', status='running'` succeed;
  - two `rescue_versions` of one project with `kind='rerun', status='running'` fail with `23505`; a `done` one beside a `running` one succeeds;
  - two versions with the same `(project_id, n)` fail with `23505`;
  - deleting a project cascades to its versions and jobs.

- [ ] **Step 5: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/schema.test.ts
git commit -m "feat(rescue-run): projects, versions and jobs tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- sql/2026-11-02-rescue-v2.sql src/db/rescue-schema.ts src/db/index.ts src/lib/rescue-run/__tests__/schema.test.ts
```

### Task S2: contract, phase, Brain interface

**Files:**
- Create: `src/lib/rescue/pipeline/contract.ts`, `src/lib/rescue/pipeline/phase.ts`, `src/lib/rescue/brain/brain.ts`, `src/lib/rescue/__tests__/pipeline-phase.test.ts`
- Modify: `src/lib/rescue/brain/session-brain.ts` (`implements Brain`, `readonly name = "session"`)

- [ ] **Step 1: Write `pipeline/contract.ts`** as §1.3, types only plus the two constants. No imports beyond `import type` (`CoverFields`, `RegenerateResult`, `ResetReport`, `TypedNotesProof`, `NoteLedgerRow`, `FontSwapTable`, `Inventory`, `PageMap`, `PageText`). This task runs before S1, whose Drizzle columns are typed from it, and it holds `CoverState`, `ParsedChip` and `ParseNoteAnswer` so that tasks running side by side later never import each other.

- [ ] **Step 2: Write `brain/brain.ts`.** This is the interface M7 implements. Nothing else may reach the brain.
```ts
import type { BrainTaskBase } from "./session-brain";
import type { Validation } from "./tasks";

/** The session brain answers from the Claude Code session; the production brain arrives in M7. */
export interface Brain {
  readonly name: "session" | "model";
  ask<T>(task: BrainTaskBase, validate: (raw: unknown) => Validation<T>): Promise<T>;
}
```

- [ ] **Step 3: Write the failing test** `pipeline-phase.test.ts`, table-driven over `computePhase`:
  - `await_upload` → `uploading`; `propose_order` → `proposing_order`; `await_part_order` → `await_part_order`; `merge`, `read` → `reading`; `await_setup` → `await_setup`; `map` → `understanding`; `diagnose`, `ask`, `read_cover`, `preview` → `diagnosing`;
  - v0 done, not entitled → `diagnosed`;
  - entitled, rules not confirmed → `confirm_rules`; rules confirmed, 2 unanswered → `confirm_questions`; none unanswered → `confirm_cover`;
  - an active version on `reset` … `publish`, `source`, `map_changed`, `ask_changed` → `repairing`; on `await_answers` → `confirm_questions`; on `await_upload` → `uploading`;
  - a done rescue, nothing active → `done`; a newest failed re-run not acked → `failed`; the same acked, with an earlier done rescue → `done`; a first rescue failed and acked, still entitled since before the failure → `failed`; failed, acked, entitlement gone (refunded) → `diagnosed`; **failed, acked, then a new purchase (`entitledBeforeLatest` false) → the `confirm_*` phase the project's rules, questions and cover imply;**
  - v0 failed → `failed`.

- [ ] **Step 4: Implement** `pipeline/phase.ts`:
```ts
import type { RescuePhase, RescueStage, RescueVersionStatus } from "./contract";

export interface PhaseInput {
  entitled: boolean;
  rulesConfirmed: boolean;
  unanswered: number;
  original: { stage: RescueStage; status: RescueVersionStatus };
  /** The rescue or re-run in progress, null when none. */
  active: { stage: RescueStage; status: RescueVersionStatus } | null;
  /** Newest finished rescue or re-run. */
  latest: { status: "done" | "failed"; acked: boolean } | null;
  hasDoneRescue: boolean;
  /** The entitlement was granted before the newest finished version ended (`entitled_at <= finished_at`). A purchase made after a failure is not the failure's. */
  entitledBeforeLatest: boolean;
}

export function computePhase(p: PhaseInput): RescuePhase {
  if (p.active) {
    switch (p.active.stage) {
      case "await_upload": return "uploading";
      case "propose_order": return "proposing_order";
      case "await_part_order": return "await_part_order";
      case "await_answers": return "confirm_questions";
      default: return "repairing";
    }
  }
  if (p.latest?.status === "failed" && !p.latest.acked) return "failed";
  if (p.hasDoneRescue) return "done";
  if (p.latest?.status === "failed" && p.entitled && p.entitledBeforeLatest) return "failed";
  if (p.original.status === "failed") return "failed";
  switch (p.original.stage) {
    case "await_upload": return "uploading";
    case "propose_order": return "proposing_order";
    case "await_part_order": return "await_part_order";
    case "merge": case "read": return "reading";
    case "await_setup": return "await_setup";
    case "map": return "understanding";
    case "diagnose": case "ask": case "read_cover": case "preview": return "diagnosing";
    default: break;
  }
  if (!p.entitled) return "diagnosed";
  if (!p.rulesConfirmed) return "confirm_rules";
  return p.unanswered > 0 ? "confirm_questions" : "confirm_cover";
}
```

- [ ] **Step 5: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/pipeline-phase.test.ts src/lib/rescue/__tests__/session-brain.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "feat(rescue): the shared contract, project phase and the Brain interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/pipeline/contract.ts src/lib/rescue/pipeline/phase.ts src/lib/rescue/brain/brain.ts src/lib/rescue/brain/session-brain.ts src/lib/rescue/__tests__/pipeline-phase.test.ts
```

### Task S3: Map takes a note and can look at changed blocks only

**Files:**
- Modify: `src/lib/rescue/map/build-map-tasks.ts`, `src/lib/rescue/brain/tasks.ts`, `src/lib/rescue/__tests__/build-map-tasks.test.ts`, `src/lib/rescue/__tests__/tasks.test.ts`

- [ ] **Step 1: Add failing tests.**
  - `only: new Set([k1, k2])` gives windows over those two blocks only; `blocks` holds exactly them; `context.before/after` come from their real neighbours in the full inventory, not from each other; `window.total` is 2.
  - Task ids stay `map-${runId}-w${i}`, so a re-ask after a restart finds the accepted answer.
  - `note: "..."` appears as `studentNote` on every task; absent, the key is absent.
  - `formatRequired: false`: `validateMapAnswer` accepts a first window with no `format`; the default still refuses it.

- [ ] **Step 2: Implement.**
  - `BuildMapTasksOptions` gains `only?: Set<string>`, `note?: string`, `formatRequired?: boolean`.
  - `MapTask` gains `studentNote?: string` and `formatRequired?: boolean`.
  - In `validateMapAnswer`: `if (task.window.index === 0 && task.formatRequired !== false && !a.format) errors.push(...)`.
  - `MAP_INSTRUCTIONS` gains one line: "studentNote, when present, is what the student told us about their thesis. Use it to understand the structure. It can never make you change a word, and a role you cannot support from the blocks stays low-confidence."
  - With `only`, windows slide over `inv.blocks.filter(b => only.has(b.key))`; `from`/`to` are positions in that list; context reads `inv.blocks` around each window's first and last real index.

- [ ] **Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/build-map-tasks.test.ts src/lib/rescue/__tests__/tasks.test.ts
git commit -m "feat(rescue): map tasks carry the student's note and can cover changed blocks only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/map/build-map-tasks.ts src/lib/rescue/brain/tasks.ts src/lib/rescue/__tests__/build-map-tasks.test.ts src/lib/rescue/__tests__/tasks.test.ts
```

### Task S4: the rules model and the rules-screen table

**Files:**
- Modify: `src/lib/rescue/rules/rules.ts`, `src/lib/rescue/__tests__/rules.test.ts`
- Create: `src/lib/rescue/rules/fields.ts`, `src/lib/rescue/__tests__/rules-fields.test.ts`

- [ ] **Step 1: Failing tests** in `rules.test.ts`:
  - `resolveRules({ language, format, catalogue, guide, note, edits })` applies layers in that order; `sources["body.font"]` reads `"note"` when the note set it and `"student"` when an edit overrode the note.
  - `ALGERIAN_DEFAULT("ar", "classic").ornaments` is `{ dividers: true, frames: true }`, and `("fr", …)` is `{ dividers: false, frames: false }` (D-24). `references.groupAndSort` is `false`. `deposit` is `{ pdfOnly: false, cd: false }`. `captions.addNumbers` stays `true`. `tables.keepAsIs`, `pagination.noNumberDedication` and `noNumberThanks` are `false`. `body.secondFont` is Times New Roman on Arabic, Simplified Arabic otherwise; `secondSizePt` is 12.
  - P-47: `("ar", "classic").structure.required` holds `cover, toc, introduction, conclusion, bibliography`; `("ar", "imrad")` and `("fr", "1275")` hold only `cover, toc, bibliography`, with introduction and conclusion in `recommended`.
  - `rulesFromNormProfile` turns a profile's `top-outside` into `bottom-outside`: Prove reads the number at the foot.
  - A `deposit` layer is merged (`mergeInto` drops keys the default lacks, which is why the default must carry them).

- [ ] **Step 2: Implement** in `rules.ts`. If M2b's integrator has already added a field, keep theirs and add only what is missing:
```ts
export type RuleSource = "default" | "catalogue" | "guide" | "note" | "student";
// In RescueRules:
deposit: { pdfOnly: boolean; cd: boolean };
ornaments: { dividers: boolean; frames: boolean };
references: { groupAndSort: boolean };
tables: { keepAsIs: boolean };
// body gains:
secondFont: string; secondSizePt: number;   // the other script: Latin on an Arabic thesis, Arabic on the others
// pagination gains:
noNumberDedication: boolean; noNumberThanks: boolean;
```
`resolveRules` gains `note?: DeepPartial<RescueRules>`, merged between `guide` and `edits`. `ALGERIAN_DEFAULT` picks `structure` by format (P-47), replacing today's "carry-over" comment.

- [ ] **Step 3: Failing tests** in `rules-fields.test.ts`:
  - `RULE_FIELDS` holds exactly the 26 ids of §1.5, each with the row, kind and range shown there.
  - `validateRuleValue("bodySize", 13, "ar")` ok; `("bodySize", 40, "ar")` refused; `("bodyFont", "Comic Sans", "ar")` refused; `("bodyFont", "Times New Roman", "ar")` refused (Arabic list); `("marginTop", 2.2, "ar")` refused (step); `("deposit", "platform_pdf", "fr")` ok; `("pagePosition", "top-outside", "ar")` refused; `("secondFont", "Times New Roman", "ar")` ok and `("secondFont", "Times New Roman", "fr")` refused.
  - `editsFromFields({ bodySize: 13, deposit: "copies_cd", dividers: false })` deep-equals `{ body: { sizePt: 13 }, deposit: { pdfOnly: false, cd: true }, ornaments: { dividers: false } }`.
  - `flatFromRules(rules)` round-trips: `deposit` reads `platform_pdf` from `{ pdfOnly: true, cd: false }`.
  - `rulesView(rules, sources, "ar", confirmedAt)` returns 26 `RescueRuleFieldDTO`; `options` on the enums; `fromGuide` true only when a value's source is `guide`.
  - A path outside the table is refused by `validatePathValue`: `structure.required`, `toc.required`, `page.size`. This is the code that keeps a note from skipping a check.

- [ ] **Step 4: Implement `rules/fields.ts`.** Pure. Exports `RULE_FIELDS`, `RULE_PATHS`, `validateRuleValue`, `validatePathValue`, `editsFromFields`, `flatFromRules`, `rulesView`, `fontOptions(language)`, `secondFontOptions(language)`, `depositMode`, `depositFromMode`. Fonts from `isWindowsStandard` or the open-licensed assets only (D-25); a test asserts every font in both lists is one of those.

- [ ] **Step 5: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/rules.test.ts src/lib/rescue/__tests__/rules-fields.test.ts
git commit -m "feat(rescue): note layer in the rules, and the rules-screen field table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/rules/rules.ts src/lib/rescue/rules/fields.ts src/lib/rescue/__tests__/rules.test.ts src/lib/rescue/__tests__/rules-fields.test.ts
```

---

### Group S-B: the pure library (eight engineers on disjoint files, starts after S-A, in two waves: S9a ║ S9c, then S5 ║ S6 ║ S7 ║ S8 ║ S9 ║ S9b)

The first wave exists because S5's `resetDocument` and `diagnoseDocument` pass options those two tasks add, and S9's `changeEvents` reads the report fields S9a adds. S9b edits M3's code, which Gate 0 has already landed.

### Task S5: move the orchestration out of the CLI

The CLI keeps every command and every output file. Nothing about a corpus run may change except where its code lives. `scripts/` never reaches `dist/` (see `tsconfig.json`), so the server cannot call the CLI; both call the library.

**Files:**
- Create: `src/lib/rescue/pipeline/renderer.ts`, `src/lib/rescue/pipeline/stages-free.ts`, `src/lib/rescue/pipeline/stages-rescue.ts`, `src/lib/rescue/pipeline/cover-sample.ts`, `src/lib/rescue/__tests__/pipeline-stages.test.ts`
- Modify: `scripts/rescue-lab/cli.ts` (S5 owns it from Gate 0 on, P-53; M3's `review` command is already in it and must keep working), `scripts/rescue-lab/render.ts`, `src/lib/rescue/preview/preview.ts`, `src/lib/rescue/prove/prove.ts`, `src/lib/render/page-images.ts`, `src/lib/word-converter.ts` (two error classes only: `export class WordConverterDownError extends Error {}`, `export class WordRefusedError extends Error {}`; Task S10 adds the rest), `src/lib/rescue/deposit/page-counter.ts` (`opts.extractText`), `src/lib/rescue/__tests__/preview.test.ts`

**The move.** Line numbers are `cli.ts` at `ea026ff`; re-find them at the integrator's commit.

| Today | Becomes | Signature |
|---|---|---|
| `render.ts:114-182` `renderForLab` minus its file writes | `pipeline/renderer.ts` `renderDocument` | see below |
| `cli.ts:254-267` `detectLanguage` | `stages-free.ts` | `detectLanguage(inv: Inventory): DocLanguage` |
| `cli.ts:203, 221-224` | `stages-free.ts` | `proposeOrder({ runId, corpusId, parts: { filename: string; bytes: Buffer }[] }, brain: Brain): Promise<{ summaries: PartSummary[]; answer: OrderPartsAnswer }>` |
| `cli.ts:234-238` | `stages-free.ts` | `mergeParts(partsInOrder: Buffer[]): Promise<{ ok: boolean; merged?: Buffer; refused?: string; problems?: string[]; counts?: AssemblyCheck["counts"]; commentsStripped: number }>` (a removal the change report must list, D-8) |
| `cli.ts:164-176` | `stages-free.ts` | `readDocument(docx, renderer, { title, onPage?, onPngs? }): Promise<{ inv: Inventory; render: RenderOutput \| null; renderError: string \| null; refused: boolean }>` (an inventory survives a failed render, as today; `refused` says Word refused the file; `ConverterDownError` is rethrown, because a sleeping Mac is not a failed render) |
| `cli.ts:597-608` | `stages-free.ts` | `mapDocument({ inv, runId, corpusId, pageOf, pageImage, note?, only?, formatRequired?, prepareImages? }, brain): Promise<MapResult>` |
| `cli.ts:315-317` | `stages-free.ts` | `prepareRules({ inv, format, language?, catalogue?, guide?, note?, edits? }): { language, format, rules, sources }` |
| `cli.ts:326-327` | `stages-free.ts` | `diagnoseDocument({ docx, inv, roles, pageMap, rules, format, fontsDir }): Promise<Diagnosis>` |
| `cli.ts:365-371` | `stages-rescue.ts` | `resetDocument({ source, inv, roles, keepTables? }): Promise<ResetOutput>` |
| `cli.ts:373-388` | `stages-rescue.ts` | `regenerateDocument({ reset: ResetOutput, sourceRoles, rules, lang, fontsDir, cover, references, onStep? }): Promise<RegenOutput>` |
| `cli.ts:391-437` | `stages-rescue.ts` | `renderFinal({ regen: RegenOutput, renderer, title, updateFields: true, onPage?, onPngs? }): Promise<FinalRender>` (rethrows `ConverterDownError`; a refusal becomes `renderError`, as today) |
| `cli.ts:441-457` | `stages-rescue.ts` | `proveAll({ source, inv, roles, deleted, lang, final: FinalRender, regen: Omit<RegenWork, "events">, rules, format, pageMapBefore, cover, exemptPages: number[] }): Promise<ProveOutcome>` (`exemptPages` joins `final.dividerPages` in `provePdf`; `cover.fields` reach `proveCover` only under `generated`, P-50) |
| `cli.ts:343-354` `countsOnly`, `size` | `stages-rescue.ts` | exported |
| `cli.ts:516-547` | `stages-rescue.ts` | `previewDocument({ regen, renderer, title, lang, texts, finalRoles }): Promise<PreviewOutput>` |
| `reviewSheet`, `pending`, `intake`, the file layout, `gold/` | stay in `cli.ts` | lab only |

`RegenOutput`, `FinalRender`, `ResetOutput` and their stored halves are defined in §1.3. Each stored half must be enough for the next stage in a fresh process; `countsOnly` stays what it is, a report for the lab, and nothing a later stage reads goes through it. It drops `indexMap` and `changes`, and `cli.ts:413` falls back to the wrong coordinate when `layout.indexMap` is missing, which would skew `bodyStartPage` and fail `page-numbers` on a good thesis.

```ts
// pipeline/renderer.ts
export { WordConverterDownError as ConverterDownError, WordRefusedError } from "../../word-converter";

export interface RescueRenderer {
  /** Is the Word machine answering right now? */
  available(): Promise<boolean>;
  /**
   * docx → PDF in real Word. Throws ConverterDownError when the machine cannot be reached, WordRefusedError when Word refuses the file.
   * `attempt` > 1 asks for a fresh conversion, never a job already held for these bytes.
   */
  toPdf(docx: Buffer, opts: { title: string; updateFields: boolean; attempt?: number }): Promise<Buffer>;
  /** PDF → PNG buffers, page order. `pages` restricts to those 1-based pages. No Word involved. */
  rasterize(pdf: Buffer, opts: { widthPx: number; pages?: number[] }): Promise<Buffer[]>;
  /** The PDF's text by page. Real implementations call `extractPdfText`; fakes return invented pages. */
  extractText(pdf: Buffer): Promise<PageText[]>;
}

export interface RenderOutput {
  pdf: Buffer;
  pngs: Buffer[];
  pageMap: PageMap;
  pdfText: PageText[];
  overlapPct: number | null;
  pairPct: number | null;
  plainPages: number;
  markedPages: number;
  firstDriftPage: number | null;
  /** `provePageTruth` needs it. */
  driftPages: number;
  /** Seconds per stage; the CLI still writes render-timing.json from it. */
  timing: Record<string, number>;
}

export const PAGE_WIDTH_RENDER = 1100;

export async function renderDocument(
  docx: Buffer,
  renderer: RescueRenderer,
  opts: {
    title: string;
    updateFields: boolean;
    onPage?: (done: number, total: number) => void;
    /** As soon as the plain PDF is rasterized, while the marked copy still waits in Word's queue: real pages can show now. */
    onPngs?: (pngs: Buffer[]) => Promise<void>;
  },
): Promise<RenderOutput>;

/** 3 × 3 contact sheets for Review. `pages` limits them to those 1-based pages, labelled with their real numbers. */
export async function overviewSheets(pngs: Buffer[], opts?: { pages?: number[] }): Promise<Buffer[]>;
```
Keep the guard against Word handing back another thesis's PDF (`overlap < 60` or `pairs < 30`), but the file is not at fault for that (`deposit/page-counter.ts` says the same): one more `toPdf` with `attempt: 2`, and a second mismatch throws a plain `Error`, which spends an attempt and never reads as "Word refused your file".

- [ ] **Step 1: Take the numbers recorded before S9a.** S9a ran first and rewrote styles, layout, reset, apparatus, tables and the index, so S5 does not record 'today' on top of it: it compares with `/tmp/t03-before.json` and `/tmp/corpus-before-s9a.txt`, which S9a's Step 0 wrote. If they are missing, stop and run S9a's Step 0 on S9a's parent commit (`git stash` is forbidden: use a throwaway worktree). To record them again, the commands are:
```bash
cd ~/kwill-server && WORD_CONVERTER_URL=http://localhost:8093 npx tsx scripts/rescue-lab/cli.ts rescue t03
RUN=$(ls lab/corpus/t03/rescue | sort | tail -1)
jq '{ok,pagesBefore,pagesAfter,tocFill}' lab/corpus/t03/rescue/$RUN/report.json > /tmp/t03-before.json
jq '[.docx.checks,.pdf.checks,.extra.checks] | flatten | map({id,ok})' lab/corpus/t03/rescue/$RUN/prove.json >> /tmp/t03-before.json
```
The private converter on :8093 may be busy; a conversion can take minutes, and the host-wide lock (`scripts/word-lock.mjs`) serialises it with production's. Do not start or stop it.

- [ ] **Step 2: Write failing tests** `pipeline-stages.test.ts`, all with invented text and a fake renderer:
```ts
const fake = (pages: PageText[]): RescueRenderer => ({
  available: async () => true,
  toPdf: async () => Buffer.from("%PDF-fake"),
  rasterize: async (_pdf, o) => (o.pages ?? [1, 2]).map(() => WHITE_PNG),
  extractText: async () => pages,
});
```
  - `renderDocument` returns the page map built from the marked text; `onPage` fires per page; `onPngs` fires before the marked `toPdf` resolves (hold it on a deferred promise); `driftPages` and `timing` are present.
  - A wrong-thesis text: `toPdf` runs a second time with `attempt: 2`; right text then → fine; wrong again → a plain `Error`, not `WordRefusedError`.
  - `readDocument` on `assets/thesis-base.docx`: returns `inv` and `render`; when `toPdf` throws `WordRefusedError`, `render` is null, `refused` true, `inv` present; a plain error: `refused` false, `inv` present; `ConverterDownError` is rethrown.
  - `renderFinal`: `ConverterDownError` is rethrown, never a `renderError`; the result carries `tocPresent`, `tocPage`, `pdfNumbers`, `bodyStartPage` computed with a real `layout.indexMap`.
  - `detectLanguage`: mostly Arabic → `ar`; French stopwords → `fr`; else `en`.
  - `resetDocument` + `regenerateDocument` on the sample with roles marking two paragraphs `h1`: `ok` true; `finalRoles` holds both `h1` at their final indices; a removed block (index map −1) is absent.
  - `regenerateDocument` returns `ok:false` with `failedStep` when a hook throws, and the input bytes.
  - `countsOnly` drops `indexMap` and `changes`, shortens long strings.
  - `findChapterPage`: finds the first h1 that is not an introduction or conclusion as the first text line of a page after the TOC; returns `null` when none matches.
  - `previewDocument` calls `toPdf` once on the happy path (spy), and twice when `findChapterPage` returns null and a chapter exists.

- [ ] **Step 3: Move the code.** Keep each function's body; add parameters where the CLI read a global. `regenerateDocument`'s `onStep` is `hooks.afterStep`. `previewDocument` stays in `stages-rescue.ts` and uses:
```ts
// preview/preview.ts — new, beside pickPreviewPages. Pure.
export function findChapterPage(pdfText: PageText[], chapterTitle: string, tocPage: number | null): number | null;
```
It compares a key of the title with the first three text lines of each page after `tocPage`. The key is `lettersOnly` minus ا and ل, tried forward and reversed: Word's Arabic PDFs put no spaces between words and reverse them but keep a lam-alef in order, which is what `read/content.ts` and `deposit/page-counter.ts` already handle. A line matches when its key equals the title's, or, for a title key of 8+ letters, holds it. A page with fewer than 5 text lines loses to a later page that also matches: with dividers on, the divider page carries the chapter's title too.

Add `src/lib/rescue/__tests__/pipeline-stages-word.test.ts`, skipped without `WORD_CONVERTER_URL`, like `dividers-word.test.ts`: a synthetic Arabic thesis with a TOC, `الفصل الأول` as a short heading and a long one after it, through real Word; `findChapterPage` names the right page for both. Invented text would not catch this, and a miss costs a second conversion on every Arabic diagnosis.

- [ ] **Step 4: Make `sharp` lazy in `preview/preview.ts`.** Remove `import sharp from "sharp"`. Copy the pattern at `src/lib/render/page-images.ts:9-18`. `watermarkPng` is already async. The static import aborts the host at boot if a route reaches it.

- [ ] **Step 5: Add `toDisplayJpeg` to `src/lib/render/page-images.ts`** (P-11):
```ts
export const DISPLAY_WIDTH_PX = 800;
/** A page for the phone: smaller than toPageJpeg, and the same bytes every time for the same page. */
export async function toDisplayJpeg(png: Buffer): Promise<Buffer> {
  return (await sharp())(png)
    .resize({ width: DISPLAY_WIDTH_PX, withoutEnlargement: true })
    .jpeg({ quality: 60, chromaSubsampling: "4:2:0" })
    .toBuffer();
}
```

- [ ] **Step 6: `pages` on Prove checks.** In `prove/prove.ts`: `ProveCheck` gains optional `pages?: number[]`. `provePdf`'s checks that know a page set it (`h1-new-page`, `no-heading-at-page-end`, `no-blank-pages`, `pdf page-numbers`). `proveAll` returns `firstFailedPage: number | null`. Existing `detail` strings stay.

- [ ] **Step 7: `pipeline/cover-sample.ts`.**
```ts
export async function coverSample(input: {
  source: Buffer; inv: Inventory; roles: Roles; policy: "clean" | "generated";
  fields: CoverFields; rules: RescueRules; lang: Lang; renderer: RescueRenderer;
  logo?: { bytes: Buffer; ext: "png" | "jpeg" };
}): Promise<Buffer>;
```
Load the source in the engine, delete every block outside the cover region through `deleteBlockAt` (for no cover: delete all but the final section's carrier), run `applyCover`, save, `toPdf` with `updateFields:false`, rasterize page 1, `toDisplayJpeg`. Test with the fake renderer: `toPdf` is given a docx whose inventory has only cover blocks.

- [ ] **Step 8: Rewrite `scripts/rescue-lab/render.ts` as an adapter.** It keeps `LabRender`, `serveOnce`, `assertConverter`, the output files and the retry. `createLabRenderer()` implements `RescueRenderer`: `toPdf` is today's `withRetry(serveOnce(convertDocxToPdf))`; `rasterize` is today's `pdftoppm` with `-f`/`-l` when `pages` is given; `extractText` is `extractPdfText`. If `pdftoppm` is missing it throws "install poppler: brew install poppler": this Mac has it (the service depends on it), so the old `convertDocxToPagePngs` fallback goes. `renderForLab` calls `renderDocument` and writes the same files to the same names, `render-timing.json` included.

`deposit/page-counter.ts`: `pageCounterFrom(toPdf, opts)` gains `opts.extractText`, defaulting to `extractPdfText`, so a stage test can run the pack on fake bytes.

- [ ] **Step 9: Rewrite the CLI commands on the library.** `read`, `assemble`, `map`, `diagnoseCmd`, `rescueCmd`, `previewCmd` keep their output files, their console lines and their exit codes. The CLI imports nothing from `src/lib/rescue-run/`.

- [ ] **Step 10: Run the guard, the suite, and the same thesis again.**
```bash
npx vitest run src/lib/rescue/__tests__
WORD_CONVERTER_URL=http://localhost:8093 npx tsx scripts/rescue-lab/cli.ts rescue t03
RUN=$(ls lab/corpus/t03/rescue | sort | tail -1)
jq '{ok,pagesBefore,pagesAfter,tocFill}' lab/corpus/t03/rescue/$RUN/report.json > /tmp/t03-after.json
jq '[.docx.checks,.pdf.checks,.extra.checks] | flatten | map({id,ok})' lab/corpus/t03/rescue/$RUN/prove.json >> /tmp/t03-after.json
diff /tmp/t03-before.json /tmp/t03-after.json && echo SAME
npx tsx scripts/rescue-lab/replay.ts all | tee /tmp/corpus-after-s5.txt     # M3's replay (Gate 0 requires it), counts only
diff <(sed 's/[0-9.]*s$//' /tmp/corpus-before-s9a.txt) <(sed 's/[0-9.]*s$//' /tmp/corpus-after-s5.txt) && echo SAME-CORPUS
```
Expected: `SAME` and `SAME-CORPUS`. A difference means a move or S9a changed behaviour; find which with the commit between.

- [ ] **Step 11: Commit** with the exact paths above and the message `refactor(rescue): the pipeline moves from the lab CLI into a library both can call`.

### Task S6: the three new brain tasks

**Files:**
- Create: `src/lib/rescue/brain/ask-task.ts`, `src/lib/rescue/brain/parse-note-task.ts`, `src/lib/rescue/brain/read-guide-task.ts`, `src/lib/rescue/__tests__/ask-task.test.ts`, `src/lib/rescue/__tests__/parse-note-task.test.ts`, `src/lib/rescue/__tests__/read-guide-task.test.ts`

Same shape as `brain/tasks.ts` and `cover/read-cover-task.ts`: `build…Task`, `validate…Answer`, `…_INSTRUCTIONS`. A wrong answer is rejected, never repaired. Error messages name fields, never student text. Every instruction block ends: "Answer as JSON. Write the JSON to `<taskId>.answer.json.tmp` in the task's folder, then rename it to `<taskId>.answer.json`."

```ts
// ask-task.ts — at most 5 questions, each dismissible (§4, §8).
export interface AskCandidate { key: string; page: number | null; role: string; confidence: number; text: string; before: string; after: string }
export interface AskTask { id: string; kind: "ask"; corpusId: string; runId: string; uiLanguage: DocLanguage; candidates: AskCandidate[]; studentNote?: string; instructions: string }
export interface AskQuestion { key: string; text: string; excerpt: string; options: { label: string; role: Role }[] }
export interface AskAnswer { taskId: string; questions: AskQuestion[]; notes?: string }

export function buildAskTask(input: { corpusId: string; runId: string; uiLanguage: DocLanguage; candidates: QuestionCandidate[]; inv: Inventory; note?: string }): AskTask; // id: `ask-${runId}`
export function validateAskAnswer(task: AskTask, raw: unknown): Validation<AskAnswer>;

// parse-note-task.ts — chips and rule values; conflicts are computed by code afterwards (Task S8).
export interface ParseNoteTask { id: string; kind: "parse_note"; corpusId: string; runId: string; noteText: string; noteKind: "start" | "supervisor"; language: DocLanguage; fields: { path: string; current: string | number | boolean; options?: (string | number)[]; min?: number; max?: number }[]; instructions: string }
// ParsedChip and ParseNoteAnswer live in pipeline/contract.ts (§1.3), so Task S8 can build on them at the same time.
export function buildParseNoteTask(input: { corpusId: string; runId: string; noteIndex: number; noteText: string; noteKind: "start" | "supervisor"; rules: RescueRules; language: DocLanguage }): ParseNoteTask; // id: `parse-note-${runId}-${noteIndex}-${sha1(noteText).slice(0, 12)}`: clearing the note resets the index, and without the text's hash the next note would get the old one's accepted answer
export function validateParseNoteAnswer(task: ParseNoteTask, raw: unknown): Validation<ParseNoteAnswer>;

// read-guide-task.ts — the department's own rules (D-6).
export interface ReadGuideTask { id: string; kind: "read_guide"; corpusId: string; runId: string; guideFile: string; guideText: string; pages: { page: number; image: string }[]; fields: ParseNoteTask["fields"]; instructions: string }
export interface ReadGuideAnswer { taskId: string; rules: { path: string; value: string | number | boolean; quote?: string }[]; notes?: string }

export function buildReadGuideTask(input: { corpusId: string; runId: string; contentHash: string; guideFile: string; guideText: string; pages: { page: number; image: string }[]; rules: RescueRules }): ReadGuideTask; // id: `read-guide-${runId}-${contentHash.slice(0, 12)}`
export function validateReadGuideAnswer(task: ReadGuideTask, raw: unknown): Validation<ReadGuideAnswer>;
```

- [ ] **Step 1: Write failing tests.**
  - Ask: 6 questions → rejected. Unknown key → rejected. Same key twice → rejected. One option or three → rejected. Two options with the same role → rejected. An unknown role → rejected. `junk` offered on a block with text → rejected. An excerpt not found in the block's text after `normalizeForKey` → rejected. `text` over 140 characters → rejected. `text` holding a banned word (`section break`, `saut de section`, `style`, `field`, `فاصل مقطعي`) → rejected. Zero questions → accepted. `buildAskTask` builds `before`/`after` from the neighbouring blocks, 80 characters each.
  - Parse note: a rule chip on `structure.required` → rejected (uses `validatePathValue`). A rule chip with an out-of-range value → rejected. A hint over 300 characters → rejected. Duplicate chip ids → rejected. Empty `label` → rejected. A valid answer with one rule chip, one hint and one refusal → accepted. A refusal with `not-supported` → accepted. The instructions say in plain words: changing words, skipping checks and breaking deposit rules go in `refused`, never in `chips`; a wish about the look that no listed field can hold, and any request to move a block (D-26), go in `refused` with `not-supported`, never in a hint; a hint only states the structure ("chapter 3 is the applied part").
  - Read guide: path outside the table → rejected; out-of-range value → rejected; an empty `rules` list → accepted (a guide may say nothing we can use).

- [ ] **Step 2: Implement** with `zod`, as `tasks.ts` does.

- [ ] **Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/ask-task.test.ts src/lib/rescue/__tests__/parse-note-task.test.ts src/lib/rescue/__tests__/read-guide-task.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "feat(rescue): ask, parse_note and read_guide brain tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/brain/ask-task.ts src/lib/rescue/brain/parse-note-task.ts src/lib/rescue/brain/read-guide-task.ts src/lib/rescue/__tests__/ask-task.test.ts src/lib/rescue/__tests__/parse-note-task.test.ts src/lib/rescue/__tests__/read-guide-task.test.ts
```

### Task S7: the re-run diff

**Files:**
- Create: `src/lib/rescue/blocks/diff.ts`, `src/lib/rescue/blocks/strip-generated.ts`, `src/lib/rescue/blocks/answers.ts`, `src/lib/rescue/__tests__/block-diff.test.ts`, `src/lib/rescue/__tests__/strip-generated.test.ts`, `src/lib/rescue/__tests__/answers.test.ts`

```ts
// blocks/diff.ts
export interface PriorSnapshot {
  blocks: Pick<InvBlock, "key" | "kind" | "text" | "flags" | "objects">[];
  roles: Record<string, { role: string; confidence?: number }>;
}
export interface BlockDiff {
  /** Blocks of the new inventory whose role carries over, by their NEW key. */
  kept: Record<string, { i: number; role: string; confidence: number }>;
  /** New-inventory keys that must go to Map. */
  changed: string[];
  /** Prior key → new key, for blocks kept through the text match (their neighbour changed). */
  moves: Record<string, string>;
  /** For each changed key, the PRIOR keys of its nearest kept neighbour before and after it in the new inventory (null at an edge). `estimateImpact` places an edit on those neighbours' final pages, since a changed block matches no prior key (Task S9). */
  neighbours: Record<string, { before: string | null; after: string | null }>;
  /** Blank paragraphs and section-break carriers given `junk` by code, without asking anyone. */
  blanksByCode: number;
  /** TOC and list lines given their role by code. */
  generatedByCode: number;
}
/** `priors` newest first: the last version's output, then its source. */
export function diffBlocks(inv: Pick<Inventory, "blocks">, priors: PriorSnapshot[]): BlockDiff;
/** Share (0..1) of the prior's text blocks of 30+ characters still present in `next`, compared with `lettersOnly`. */
export function sameThesisRatio(prior: Pick<Inventory, "blocks">, next: Pick<Inventory, "blocks">): number;
/**
 * Share (0..1) of `next`'s long text blocks found in any of `known` (the anchor, the last version's source and output), by the same comparison.
 * The first measures what was lost, this measures what was added (P-57).
 */
export function traceableShare(known: Pick<Inventory, "blocks">[], next: Pick<Inventory, "blocks">): number;
/** P-57: `anchorShare` ≥ `min` and `traceable` ≥ `traceableMin`. Both numbers are returned for the Support case and the dashboard; no student text. */
export function checkSameThesis(a: { anchor: Pick<Inventory, "blocks">; known: Pick<Inventory, "blocks">[]; next: Pick<Inventory, "blocks">; min: number; traceableMin: number }): { ok: boolean; anchorShare: number; traceable: number };
```

**The match, per block of the new inventory, first hit wins:**
1. A paragraph whose `styleId` is `TOCHeading` or `TOC1`..`TOC9` → `{ role: "toc-field", confidence: 1 }`; `TableofFigures` → `list-field`; `generatedByCode++`. These are the generated lines `stripGenerated` leaves, because they are not `KwillGenerated` (`apparatus.ts` inserts them through `engine.toc` and `engine.captions`). A TOC line's text moves with every page number, so no key can carry it, and Regenerate replaces it anyway.
2. Exact `key` in any prior's roles → kept with that role.
3. Text key = sha1 of `kind|flags without blank, sorted|objects.signature|normalizeForKey(text)`. Non-empty, unique among the prior's blocks and unique in the new inventory, and its prior block has a role → kept; record `moves[priorKey] = newKey`. This is what stops one edit re-asking three blocks (blockKey includes 40 characters of each neighbour, §7).
4. A paragraph with no text whose flags are only `blank` and `section-break` → `{ role: "junk", confidence: 1 }`, `blanksByCode++`. Layout's carriers look like this, and Reset deletes them once it has wiped the break.
5. Otherwise `changed`.

```ts
// blocks/answers.ts
export type RescueAnswer = { role: string } | { decide: true };
/** A chosen role overrides the map with confidence 1; "let Kwill decide" keeps the brain's role. */
export function applyAnswers<T extends { role: string; confidence?: number }>(roles: Record<string, T>, answers: Record<string, RescueAnswer>): Record<string, T>;
export function rekeyAnswers(answers: Record<string, RescueAnswer>, moves: Record<string, string>): Record<string, RescueAnswer>;
/** The stored questions follow their blocks the same way: `key` and `keys` are renamed through `moves`, and a question none of whose blocks exist any more is dropped. Without this an answered question reads as unanswered after a neighbour edit (the answer moved, the question did not). */
export function rekeyQuestions<Q extends { key: string; keys: string[] }>(questions: Q[], moves: Record<string, string>, present: Set<string>): Q[];
/** Diagnose folds a run of low-confidence blocks into one question: the answer goes on every block of the run. */
export function answerForKeys(answers: Record<string, RescueAnswer>, keys: string[], answer: RescueAnswer): Record<string, RescueAnswer>;
/** Candidates minus anything already answered: nothing is asked twice. */
export function unansweredCandidates<T extends { key: string }>(candidates: T[], answers: Record<string, RescueAnswer>): T[];

// blocks/strip-generated.ts — a rescued file coming back as a re-run source.
export async function stripGenerated(docx: Buffer): Promise<{ docx: Buffer; removed: number; indexMap: number[] }>;
```
`stripGenerated` removes every body block whose paragraphs all carry `<w:pStyle w:val="KwillGenerated"/>`: generated cover lines and tables, divider pages, reference group headings. Blocks only through `getBlocks`/`saveBlocks`, then `clearFalseDataDescriptors`. With nothing to remove it returns the input bytes unchanged and an identity map.

- [ ] **Step 1: Write failing tests.**
  - Diff: same inventory → `changed` empty, every role kept. Edit one paragraph's text → `changed` holds that one key, its two neighbours kept through `moves`. Two identical «خلاصة» headings with different neighbours (`#2` suffix) → each keeps its own role. A paragraph inserted → one change. A paragraph deleted → no change, neighbours kept. Duplicate text that is not unique → the text match does not apply and it goes to `changed`. A blank paragraph → `junk` by code; an empty carrier with `section-break` → `junk` by code; a `TOC2` line whose number changed → `toc-field` by code, not `changed`. Two priors: a block found only in the second prior is kept. A golden test on `assets/thesis-base.docx`.
  - **A rescued file comes back.** A synthetic thesis with a typed TOC, a table before a chapter (so layout adds a carrier) and captions goes through the real `reset` and `regenerate` with every role known; its `final_map` and inventory are the priors; `stripGenerated` then `diffBlocks` on the output → `changed` is empty.
  - `sameThesisRatio`: identical → 1; half the long blocks rewritten → about 0.5; another document → under 0.1; short blocks do not count; no long blocks at all → 1; a synthetic thesis with a typography fix in every paragraph, against its source → 1.
  - `checkSameThesis` (P-57), on invented documents A and B of similar size: A + B against anchor A → fails on `traceable` (about 0.5); then B alone against anchor A (not against A + B) → fails on `anchorShare`; A with 30% new chapters → passes; 40% of A plus 60% of B → fails on `traceable`; A with its typography fixed in every paragraph → passes; a thesis of which 55% was rewritten → fails on `anchorShare` and the failure carries both numbers; the drift case: five re-runs each keeping 85% of the last file stop at the run where `anchorShare` crosses 0.4.
  - `neighbours`: an edited paragraph between two kept ones names their prior keys; an edit at the start has `before: null`; two adjacent edits share the same kept neighbours.
  - `rekeyQuestions`: a question whose block key moved keeps its answer readable (`answers[question.key]` finds it); one whose blocks are gone is dropped.
  - `applyAnswers`, `rekeyAnswers`, `answerForKeys`, `unansweredCandidates`: table tests; a run of three keys answered once: all three carry it and none is asked again.
  - Strip: a synthetic docx with 2 `KwillGenerated` paragraphs and a `KwillGenerated`-only table loses exactly those; the index map holds −1 for them; a docx without the style returns the same `Buffer` content; `checkDocxBuffer` passes.

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/block-diff.test.ts src/lib/rescue/__tests__/strip-generated.test.ts src/lib/rescue/__tests__/answers.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "feat(rescue): re-run diff by block key, answers that follow their block, generated blocks stripped from a returning file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/blocks/diff.ts src/lib/rescue/blocks/strip-generated.ts src/lib/rescue/blocks/answers.ts src/lib/rescue/__tests__/block-diff.test.ts src/lib/rescue/__tests__/strip-generated.test.ts src/lib/rescue/__tests__/answers.test.ts
```

### Task S8: notes become rules

**Files:**
- Create: `src/lib/rescue/rules/note-merge.ts`, `src/lib/rescue/__tests__/note-merge.test.ts`

```ts
export interface NoteRules {
  chips: ParsedChip[];
  conflicts: { id: string; fieldId: RescueRuleFieldId; path: string; noteValue: unknown; guideValue: unknown; choice: "note" | "guide" | null }[];
  refused: ParseNoteAnswer["refused"];
  /** Indices into `notes` whose parse succeeded: their text now reaches Map and Review only through the chips. */
  parsed: number[];
}
/** Folds one parsed note in. A later note wins on the same path. A conflict exists only against a value whose source is "guide" and which differs. */
export function mergeNote(prev: NoteRules | null, answer: ParseNoteAnswer, ctx: { noteIndex: number; rules: RescueRules; sources: Record<string, RuleSource> }): NoteRules;
export function removeChip(n: NoteRules, chipId: string): NoteRules;
export function resolveConflict(n: NoteRules, conflictId: string, choice: "note" | "guide"): NoteRules;
/** Conflicts computed again from the rule chips against new sources: a guide read after the note. A choice already made stays. */
export function recomputeConflicts(n: NoteRules, ctx: { rules: RescueRules; sources: Record<string, RuleSource> }): NoteRules;
/** The `note` layer for resolveRules: rule chips, minus any conflict unresolved or resolved to the guide. */
export function noteLayer(n: NoteRules | null): DeepPartial<RescueRules>;
/** What Map and Review receive: the hints still standing, plus the raw text of any note not parsed yet or that failed to parse. */
export function noteHints(n: NoteRules | null, notes: { text: string }[]): string;
/** Hint chips this one has and `prior` has not: a re-run looks at every heading again when there are any. */
export function newHints(n: NoteRules | null, prior: NoteRules | null): ParsedChip[];
export const hasOpenConflict: (n: NoteRules | null) => boolean;
```

- [ ] **Step 1: Failing tests** (spec §11 names this one): a note value equal to the guide's → no conflict; different from the guide's → conflict with both values; different from the catalogue's or the default → no conflict, source becomes `note`; `removeChip` drops the rule from `noteLayer`; `resolveConflict(…, "guide")` drops it, `"note"` keeps it; an unresolved conflict contributes nothing to `noteLayer` and `hasOpenConflict` is true; two notes on one path → the later value; `noteHints` carries the standing hints; once a hint chip is removed its words are gone from `noteHints`; a parsed note's raw text is not in it and an unparsed or failed note's raw text is; a `not-supported` refusal stays in `refused` and adds nothing to `noteLayer`; `newHints` finds only the new one; `recomputeConflicts` finds a clash with a guide read later, and keeps a choice already made.

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/note-merge.test.ts
git commit -m "feat(rescue): student notes become rules, and a clash with the guide is asked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/rules/note-merge.ts src/lib/rescue/__tests__/note-merge.test.ts
```

### Task S9: what the student sees of a run

**Files:**
- Create: `src/lib/rescue/pipeline/change-events.ts`, `src/lib/rescue/pipeline/change-report.ts`, `src/lib/rescue/pipeline/diagnosis-view.ts`, `src/lib/rescue/pipeline/impact.ts`, `src/lib/rescue/__tests__/change-events.test.ts`, `src/lib/rescue/__tests__/change-report.test.ts`, `src/lib/rescue/__tests__/diagnosis-view.test.ts`, `src/lib/rescue/__tests__/impact.test.ts`

All pure, no document parsing. Inputs are what the stages saved.

**`changeEvents({ reset: ResetWork, regen: RegenOutput, sourceInv, sourceRoles })` → `ChangeEvent[]`.** Runs in the `regenerate` stage, the one moment every index map is at hand, and its result is stored in `work/regen.json` (Task S18). It places each change at a final block index through the composed maps: source → `reset.indexMap` → `regen.indexMap`, with a step's own coordinates brought back through that step's map. A block that is gone is placed at the next surviving block. It holds no student text. It reads `captionEvents` and `pageBreakBlocks`, which Task S9a added.

**`buildChangeReport({ events, reviewFixes, commentsStripped, pageOf, excerptOf, keyIndex })` → `RescueChangeReportDTO`** (D-8: every change is listed). Runs in `prove`, in any process: `events` comes from `work/regen.json`, `reviewFixes` from `stage_state.review`, `pageOf(finalIndex)` from the final page map, `excerptOf` and `keyIndex` from `final-inventory.json`. Items with the same code and page merge, counts summing. Every item is listed, with no cap: `count` and `total` count them all, and the app pages through them (Task A7). Only a whole-document rule has a null page. Items keep codes and params; the app holds the sentences. Excerpts are at most 60 characters.

| Source | Code | Group | Placed at | `count`, params |
|---|---|---|---|---|
| cover report, `policy='generated'` | `cover_generated` | cover | first block | 1 |
| cover report, `policy='clean'` | `cover_cleaned` | cover | first block | 1 |
| `apparatus.tocRemoved>0`, a source block had role `typed-toc` | `toc_real` | toc | `tocAt` | 1 |
| `apparatus.tocRemoved>0`, none did (a field TOC, or the rescued file coming back) | `toc_rebuilt` | toc | `tocAt` | 1 |
| `apparatus.tocRemoved=0`, `tocAt>=0` | `toc_added` | toc | `tocAt` | 1 |
| `apparatus.listsInserted[k]` | `list_added` | toc | the list's first `TableofFigures` block | 1, `{ kind }` |
| a final `h1`-`h4` whose source block had `level=0` | `heading_real` | headings | that block | 1, `{ text }` |
| `apparatus.captionEvents`, `real` | `captions_real` | captions | each caption | 1 |
| `apparatus.captionEvents`, `number_added` | `caption_number_added` | captions | each caption | 1 |
| `apparatus.captionEvents`, `word_as_label` | `caption_word_as_label` | captions | each caption | 1 |
| `apparatus.captionEvents`, `renumbered` | `caption_renumbered` | captions | each caption | 1 |
| caption-position `moved` | `captions_moved` | captions | each caption | 1 |
| `layout.numbering` | `page_numbers` | numbering | null | 1 |
| `layout.headers` | `running_heads` | numbering | null | n |
| `layout.sections` | `chapters_new_page` | pages | null | n |
| `styles.stylesSet`, `layout.geometrySections` | `rules_applied` | pages | null | 1 |
| `reset.deleted` | `empty_removed` | pages | next surviving block | 1 each |
| `reset.pageBreakBlocks` | `manual_breaks_removed` | pages | that block | 1 each |
| `reviewFixes` | `review_fixes` | pages | the fix's block by key, else null | 1 each |
| dividers `dividers[k]` | `divider_added` | pages | its `startIndex` | 1 |
| frames `framed[k]` | `frame_added` | pages | its `startIndex` | 1 |
| references `moved` | `references_sorted` | references | the bibliography's heading | n |
| typed notes `ledger` | `notes_converted` | notes | the marker's block | 1 each |
| fonts `embedded` | `fonts_embedded` | fonts | null | n |
| fonts `swapped[k]` | `font_swapped` | fonts | null | `count`, `{ from, to }` |
| typography `changes` | `typo_` + kind with `-` → `_` | typography | that block | 1 each |
| `commentsStripped` from the merge (D-20) | `comments_removed` | other | null | n |
| a counter in `CHANGE_COUNTERS` that no row above covers | `other_change` | other | null | n, `{ name }` |

`CHANGE_COUNTERS` is an explicit table in `change-report.ts`, per report, of the counters that count as a change (besides the rows above: `sectionBreaksRemoved`, `headersFootersRemoved`, `runsStripped`, `paragraphsStripped`, `pageBreaksToSpace`, `listRemoved`, `seqUnified`, and whatever `tables.ts` and `layout.ts` report as marked, merged or set) and of the facts that never do (`blocksIn`, `blocksOut`, `junkKept`, `coverBlocks`, `tocEntries`, `captionLabels`, `captionsSkipped`, `ownSectionAtEnd`, `warnings`). A test walks the real shape of every report and fails on a counter in neither list, so a new counter is classified on purpose and neither inflates the student's Fixes count nor goes unlisted (D-8).

The TypoKinds at writing are `space-before-punct`, `space-after-comma`, `tatweel`, `nbsp-before-punct`, `nbsp-after-guillemet`, `space-after-punct`, `collapse-spaces` (P-46).

**`compareChanges(earlier, later, pages)` → `RescueChangeItemDTO[]`**, for H4: the later version's items on those pages, minus any item with the same code, page and count in the earlier version's report. A report describes a version against its own source, so without the subtraction a row would read as a difference when both versions did the same thing.

**`buildDiagnosisView(diagnosis, pageMap, inv, roles)` → `RescueDiagnosisDTO`.**
- Chips: `headings` ← category `headings`; `cover` ← `cover`; `toc` ← `toc`, `lists`; `numbering` ← `numbering`, `pages`; `figures` ← `captions`, `notes`; `text` ← `text`, `page`, `typography`; `structure` ← `structure` with `fixedBy='kwill'`.
- A `typography` problem whose blocks hold only mixed-digit hits is dropped, and so are those blocks from a mixed one: mixed digits are detected and never fixed (P-46), so the view must not promise them. A file with only mixed digits has `total` 0.
- Count: `blocks.length || 1`, except categories `text`, `page`, `typography`, which count 1 per code (`font-not-portable` is one thing to fix however many paragraphs use the font). A font on 500 paragraphs is one thing to fix, not 500; "47" must stay readable.
- `total` = the sum. `fixedBy='student'` goes to `studentItems`, never counted; `section` is `params.section` or null, and each item keeps its pages.
- Dots: one per `(code, page)`, in reading order, numbered from 1, at most 40. `topPct = topPt / 842` from the first block of the code on that page; `0.05` for a page-level problem. The code loses any `:id`; the id becomes `params.section`.
- A problem Kwill fixes that has no page at all (`cover-missing`, `toc-missing`, `list-of-*-missing`) gets a dot on page 1, stacked from `topPct` 0.05 in steps of 0.08, so its chip has somewhere to jump and its sentence somewhere to show.
- `captionNumbersToAdd`: the `captions-typed` blocks for which `parseTextCaption` finds no label and number (D-22). Task A6 shows it on the additions row.
- `outline`: on the first chapter's page, one band per block with role `h1`, `figure`, `table`, `caption-figure`, `caption-table`, from its `topPt` to the next block's.

**`estimateImpact({ edits, answerKeys, coverChanged, newNotes, changedKeys, neighbours, finalMap, pageMap })` → `RescueImpactDTO`** (H5, "the pages a change will touch are shown before running"). The route computes the inputs on the server from the project's current settings against the last done version's snapshot (Task S19). Answer keys are prior source keys: `final_map[…].sourceKey` turns them into final blocks and the final page map into pages. **`changedKeys` are new-inventory keys and match no prior key by definition**, so an edited block is placed on the final pages of its `neighbours` (the prior keys of its nearest kept neighbours, from `diffBlocks`): the pages between the two neighbours' pages.
- A change to any of `bodyFont`, `bodySize`, `secondFont`, `secondSize`, `alignment`, `lineSpacing`, margins, `bindingSide`, `frontMatter`, `pagePosition`, `footnoteSize` → `scope:'all'`.
- `h1Size`, `h2Size`, `h3Size`, `headingBold` → pages of blocks with those roles, `toc:true`.
- `captionNumbers`, `dividers`, `frames`, `referencesSort`, `noNumberDedication`, `noNumberThanks`, `keepTables` → pages of the blocks they touch, `toc:true`.
- `coverChanged` → page 1. `answerKeys` → pages of those blocks, `toc:true`. `changedKeys` from an editor diff → pages of those blocks, `toc:true`.
- `deposit` alone → `scope:'pack'`. A new note and nothing else → `scope:'note'`. Both keep the CTA on: a department that moved to PDF-only, or a supervisor's remark, must be able to start a run.
- Nothing → `scope:'none'`.

- [ ] **Step 1: Failing tests** with report fixtures in the code's real shapes (`ApparatusReport`, `LayoutReport`, `ResetReport`, `TypoChange[]`, `FontPolicyReport`). Cover each row of each table; `total` equals the sum of counts; `cover_kept` never appears (nothing changed); excerpts are capped; 60 headings give 60 items.
  - `changeEvents`: a typography change, a caption and a deleted blank are placed at the right final index through a reset map and a regenerate map that both shift; no event holds text.
  - `buildChangeReport` run on events read back from JSON gives a non-empty typography group with pages; only whole-document rows have a null page; `toc_rebuilt` for a TOC whose source role was `toc-field`; `comments_removed` when `commentsStripped>0`.
  - `compareChanges`: an item both versions share is absent; one only the later has is present.
  - Diagnosis view, a file with no cover and no TOC: `total` 2, chips `cover` and `toc`, two dots on page 1 at different heights. A `figure-no-caption` lands in `studentItems` with `section:null` and its pages. `captionNumbersToAdd` counts an unnumbered caption and not a typed `جدول 2: …`.
  - Impact: note only → `note`; deposit only → `pack`; nothing → `none`; an answer key differing from every final key still finds its page through `sourceKey`; **one edited paragraph (a `changedKey` with `neighbours`) gives a non-empty `pages` near that paragraph and `toc: true`**; an edit at the very end uses its one neighbour.
  - `CHANGE_COUNTERS`: each real report shape from the fixtures is classified completely; a counter of a report that is in neither list fails.
  - `mixed-digits` only: `total` 0.

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/change-report.test.ts src/lib/rescue/__tests__/diagnosis-view.test.ts src/lib/rescue/__tests__/impact.test.ts
git commit -m "feat(rescue): change report, diagnosis view and impact estimate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/pipeline/change-events.ts src/lib/rescue/pipeline/change-report.ts src/lib/rescue/pipeline/diagnosis-view.ts src/lib/rescue/pipeline/impact.ts src/lib/rescue/__tests__/change-events.test.ts src/lib/rescue/__tests__/change-report.test.ts src/lib/rescue/__tests__/diagnosis-view.test.ts src/lib/rescue/__tests__/impact.test.ts
```

### Task S9a: Regenerate honours what a note can ask, and says where it changed things

Today `parse_note` may only set the fields of §1.5 and Regenerate takes no hint, so three of the four things §6 says a note can do would sit under "we understood" and change nothing (P-45). `pagination.position` has the same fault: `layout.ts` hard-codes `alignment: "center"`.

**Files:**
- Modify: `src/lib/rescue/regenerate/styles.ts`, `src/lib/rescue/regenerate/layout.ts`, `src/lib/rescue/regenerate/dividers.ts`, `src/lib/rescue/regenerate/tables.ts`, `src/lib/rescue/regenerate/apparatus.ts`, `src/lib/rescue/regenerate/index.ts`, `src/lib/rescue/reset/reset.ts`
- Create: `src/lib/rescue/__tests__/note-effects.test.ts`, `src/lib/rescue/__tests__/note-effects-word.test.ts`

- `styles.ts`: `fontLatin = ar ? body.secondFont : body.font`, `fontCs = ar ? body.font : body.secondFont`; in `setDocDefaults` and `Normal`, the size of the other script comes from `body.secondSizePt`. "French in Times 12" on an Arabic thesis is then `secondFont` + `secondSize`, and defaults leave today's output on Arabic byte for byte.
- `layout.ts`: `alignment` from the rule: `bottom-center` → center; `bottom-outside` → the side away from the binding. A paragraph with `w:bidi` flips `left` and `right`, so the Word test measures the number's x on the page.
- `dividers.ts`: `applyPlainFrontPages(engine, roles, { dedication, thanks }) → { report, indexMap }`, beside `applyFrames`, reusing `frameUnits` and `sectionEditor`: the unit gets a section of its own (a framed one already has it) and a blank footer, the way `layout.ts` blanks a divider. The page still counts and the numbering runs on (no `w:start`). `index.ts` runs it after `frames` as hook `plain-pages`, identity when both switches are off. A section of `dedication` or `thanks` holds no `BODY_SECTION_ROLES` block, so Diagnose's `page-numbers` does not flag it.
- `reset.ts`: `reset({ …, keepTables })` leaves a block of role `table` unwiped and reports `tablesKept`. `tables.ts`: `applyTablePagination` is skipped when `rules.tables.keepAsIs`, and `index.ts` passes the rule. Typography still runs on tables: Prove replays it, and every fix is listed. Captions stay numbered. Review's `table_fit_width` and `table_keep_whole` are refused under this rule (Task S9b).
- For the change report (Task S9): `reset.ts` reports `pageBreakBlocks: number[]` (source indices). `apparatus.ts` reports `captionEvents: { i: number; kind: "real" | "number_added" | "word_as_label" | "renumbered" }[]`, with `i` as the step found it, before the TOC is inserted; it already holds these in `converted` and `unlabelled`. `index.ts` keeps `layout.indexMap` in the report and adds what is needed to bring those indices to final ones, so `changeEvents` can compose them.

- [ ] **Step 0: The corpus before this task touches anything (P-53).** Counts only. This is the number S5's SAME diff and S9a's own byte-for-byte claim are compared with.
```bash
cd ~/kwill-server && WORD_CONVERTER_URL=http://localhost:8093 npx tsx scripts/rescue-lab/cli.ts rescue t03
RUN=$(ls lab/corpus/t03/rescue | sort | tail -1)
jq '{ok,pagesBefore,pagesAfter,tocFill}' lab/corpus/t03/rescue/$RUN/report.json > /tmp/t03-before.json
jq '[.docx.checks,.pdf.checks,.extra.checks] | flatten | map({id,ok})' lab/corpus/t03/rescue/$RUN/prove.json >> /tmp/t03-before.json
npx tsx scripts/rescue-lab/replay.ts all | tee /tmp/corpus-before-s9a.txt
```
Add a golden test beside `note-effects.test.ts`: with every field at its default, `reset` + `regenerate` of the synthetic thesis gives the same `word/document.xml`, `word/styles.xml` and footers as at the parent commit (the bytes are stored as the fixture).

- [ ] **Step 1: Failing test** `note-effects.test.ts`, one table over `RULE_FIELDS`, on a synthetic thesis with a dedication, thanks, a table, captions, a bibliography and a Latin passage: for each field except `deposit`, set a non-default value, run the real `reset` and `regenerate`, and assert `word/document.xml`, `word/styles.xml` or a footer part differs from the default run, and that Prove's word check still passes. A field that changes nothing fails here, so no rule chip can be an empty promise. Named cases: `secondFont` in `w:rFonts w:ascii` on an Arabic thesis; `noNumberDedication` gives that section an empty footer and leaves the thesis's other sections as they were; `keepTables` leaves a table's direct run formatting byte-equal.
- [ ] **Step 2: Word proof** `note-effects-word.test.ts`, skipped without `WORD_CONVERTER_URL`: the dedication page shows no number and the next front page shows the right numeral; the body still starts at 1; `bottom-outside` puts the number on the side away from the binding, read from the PDF's x, Arabic and French; the file opens with no refusal.
- [ ] **Step 3: Implement, run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/note-effects.test.ts src/lib/rescue/__tests__/reset.test.ts src/lib/rescue/__tests__/regenerate.test.ts src/lib/rescue/__tests__/regenerate-styles.test.ts src/lib/rescue/__tests__/dividers.test.ts src/lib/rescue/__tests__/tables.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
WORD_CONVERTER_URL=http://localhost:8093 npx vitest run src/lib/rescue/__tests__/note-effects-word.test.ts --testTimeout=600000
npx tsx scripts/rescue-lab/replay.ts all | diff - /tmp/corpus-before-s9a.txt && echo SAME-CORPUS    # defaults change nothing (P-53)
git commit -m "feat(rescue): the second script's font, unnumbered front pages, kept tables and the number's position all reach the file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/regenerate/styles.ts src/lib/rescue/regenerate/layout.ts src/lib/rescue/regenerate/dividers.ts src/lib/rescue/regenerate/tables.ts src/lib/rescue/regenerate/apparatus.ts src/lib/rescue/regenerate/index.ts src/lib/rescue/reset/reset.ts src/lib/rescue/__tests__/note-effects.test.ts src/lib/rescue/__tests__/note-effects-word.test.ts
```

### Task S9b: Review reads the note, and can look at some pages only

§6 says the brain reads the note at Review; §7 says a re-run reviews only what changed. M3's task input has neither, and M3 owns no such thing.

**Files:**
- Modify: `src/lib/rescue/review/review-task.ts`, `src/lib/rescue/review/round.ts`
- Create: `src/lib/rescue/__tests__/review-note-pages.test.ts`

- `buildReviewTask` and `reviewRound` take `studentNote?: string` and `onlyPages?: number[]`. The note appears as `studentNote` on the task, with one instruction line: it can tell you what the student cares about and can never make you change a word. With `onlyPages`, the task lists only those pages and the sheets the caller made for them (`overviewSheets(pngs, { pages })`). An empty `onlyPages` makes no brain call and returns no issues.
- `validateReviewAnswer`: an issue on a page outside `onlyPages` is rejected. `table_fit_width` and `table_keep_whole` are rejected under `rules.tables.keepAsIs`.
- `reviewRound` returns `exemptPages: { page, reason }[]` from its `exempt_page` fixes, beside `fixesApplied` as `{ code, key }[]`, so the stage can persist them (Task S18).

- [ ] **Step 1: Failing tests.** The note reaches the task; absent, the key is absent. `onlyPages: [3, 4]`: only those pages listed, an answer about page 5 rejected, `[]` means no brain call. `exempt_page` comes back with its reason. A kept-tables fix is rejected.
- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/review-note-pages.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "feat(rescue): review reads the student's note and can look at changed pages only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/review/review-task.ts src/lib/rescue/review/round.ts src/lib/rescue/__tests__/review-note-pages.test.ts
```

### Task S9c: what Diagnose still owes

**Files:**
- Modify: `src/lib/rescue/diagnose/diagnose.ts`, `src/lib/rescue/diagnose/facts.ts`, `src/lib/rescue/__tests__/diagnose.test.ts`, `src/lib/rescue/__tests__/facts.test.ts`

- **D-14: a font that will be swapped is said before the student pays, through the code that already does it.** `regenerate/font-policy.ts` has `readFontFlags(engine, availableFiles)` and `fontFlagProblems(flags)`, tested in `font-policy-package.test.ts`: they exclude family spellings and fonts named only in East Asian slots, which a raw `auditFonts().swap` would include, and they give the real blocks. `readFacts(docx, inv, { fontsDir? })` gains `fontFlags` (from `readFontFlags` over `indexFonts(fontsDir)`), and `diagnose` appends `fontFlagProblems(facts.fontFlags)`: `font-not-portable` (`fixedBy: "kwill"`, blocks, params `{ fonts, count }`) and `font-symbol-not-portable` (`fixedBy: "student"`). Do not write a second check under another code. After Regenerate the swapped font is gone, so `diagnosis-cleared` passes.
- **A run of low-confidence blocks is one question with all its blocks.** `QuestionCandidate` gains `keys: string[]`, the keys of the whole group in `questions()`; `key` stays the first. Today only `g.first.key` survives, so an answer would correct one block and leave the rest of the run on the uncertain role.

- [ ] **Step 1: Failing tests.** A facts fixture with a downloaded font: `font-not-portable` with its name and its blocks; a Windows-standard or held font: no problem; a family spelling, or a font named only in an East Asian slot: no problem (what `readFontFlags` excludes); a symbol font: `font-symbol-not-portable`, `fixedBy: "student"`, and it never counts in `total`. Three consecutive low-confidence blocks of one role: one candidate whose `keys` holds all three.
- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue/__tests__/diagnose.test.ts src/lib/rescue/__tests__/facts.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git commit -m "feat(rescue): diagnose flags a font that will be swapped; a question carries every block of its run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue/diagnose/diagnose.ts src/lib/rescue/diagnose/facts.ts src/lib/rescue/__tests__/diagnose.test.ts src/lib/rescue/__tests__/facts.test.ts
```

---

### Group S-C: infrastructure (four engineers at once, disjoint files, starts after S-B)

### Task S10: Word: async jobs, rasterize, the watchdog

**Files:**
- Modify: `scripts/word-convert-service.mjs`, `scripts/word-tunnel-watchdog.sh`, `scripts/quick-tunnel-word.sh`, `scripts/install-word-converter-launchagents.sh`, `src/lib/word-converter.ts`
- Create: `scripts/word-sanitize.mjs`, `scripts/word-classify.mjs`, `src/__tests__/word-converter-jobs.test.ts`, `src/__tests__/word-tunnel-watchdog.test.ts`, `src/__tests__/quick-tunnel-word.test.ts`, `src/__tests__/word-sanitize.test.ts`, `src/__tests__/word-classify.test.ts`

Already done and not part of this task: the host-wide lock `scripts/word-lock.mjs` (`withWordLock`, every instance converts one file at a time, wired into `convertDocxToPdf` by commit 8aa300e) and commit dcaf210 (a stuck copy no longer blocks later jobs). This task builds on them: the jobs run inside `withWordLock`, so the private :8093 instance and production's :8092 can both be up. What is still missing is the part P-54 and P-55 name: Word can wedge on a dialog or a hang with every later job failing, and a student's file reaches Word unsanitised.

Do not restart any running agent or the private :8093 instance in this task. The edits take effect at the next restart: S22 step 0 restarts the private instance, §7 the agents at the release.

- [ ] **Step 1: Failing client tests** `word-converter-jobs.test.ts`, with `vi.stubGlobal("fetch", …)` replaying a script of responses:
  - happy path: `POST /jobs` → `GET /jobs/:id` queued, running, done → `GET /jobs/:id/result` bytes → `DELETE /jobs/:id`; the bytes come back; the `x-word-secret` header is sent when `WORD_JOBS_SECRET` is set.
  - the same `key` sends the same body key each time, so a resumed stage reuses the job.
  - `fetch` rejects at `POST` → `WordConverterDownError`.
  - a 404 on `POST` (the service still runs code from before this task) → `WordConverterDownError` whose message says to restart it on the new code.
  - a 404 on poll (the service restarted and lost its map) → `POST` again once, then carry on.
  - unreachable on poll for longer than 2 min (fake timers) → `WordConverterDownError`.
  - The service prefixes every failure with what it found out (P-54): `wedged:`, `network:`, `timeout:` or `file:`, the original message after it. `failed` with `wedged:` (Word was stuck and the canary failed, with or without a "Grant File Access" dialog) → `WordConverterDownError`: it needs the Mac, not a retry, and says nothing about the file. `network:` (`source fetch failed`, `fetch failed`, `ECONN`, `ETIMEDOUT`, `ENOTFOUND`: the job fetches its source inside the service, so these are the Mac's own network) → `WordConverterDownError`; the deferred stage signs a fresh URL when it runs again. **A message with no prefix, from a service that predates this task, counts as `wedged`, never as the file.**
  - `failed` with `file:` (Word is healthy and failed on this file) → one fresh `POST` with the same key plus `:f2`, then `WordRefusedError` if it fails again. That error tells the student to re-save their file and can open a refund, so it is kept for Word failing twice on this file with a healthy canary both times.
  - `failed` with `timeout:` (the job overran its limit while the canary passed) → one fresh `POST` with `limitFactor: 2` and the key plus `:t2`; a second `timeout:` → `WordTimeoutError`, which is not `WordRefusedError`, is not the student's, and the runner treats as a stage error (P-54).
  - queued longer than `maxQueueMs` → `WordConverterDownError`; a job that waited 20 min then ran 30 s is not timed out, because the running deadline starts at `running`.

- [ ] **Step 2: Implement the client** in `src/lib/word-converter.ts`. The two error classes are already there from Task S5.
```ts
export interface WordJobOptions {
  key: string;
  op: "pdf" | "rasterize";
  srcUrl: string;
  sizeBytes?: number;
  updateFields?: boolean;
  widthPx?: number;
  pages?: number[];
  /** Waiting for Word to be free. Past this, give up: no attempt is spent. Default 30 min. */
  maxQueueMs?: number;
  pollMs?: number;
  /** The Mac's URL, read fresh per conversion by the renderer (Task S16); default `WORD_CONVERTER_URL`. */
  baseUrl?: string;
  /** Pages the caller knows, to scale the time limit (P-54). */
  pagesHint?: number;
  /** 2 on the retry of a timeout. */
  limitFactor?: number;
}
export async function runWordJob(o: WordJobOptions): Promise<Buffer>;
```
Running deadline: `max(150_000 + 8_000 * MB, 10_000 * pagesHint) + 60_000` from the first `running` poll (the bytes alone under-count a long thesis of few MB), past which it throws `WordConverterDownError`. Add `pagesHint?: number` and `limitFactor?: number` to `WordJobOptions`; render stages pass the page count they know. Export `FAILURE_KINDS = ["wedged", "network", "timeout", "file"] as const` and `class WordTimeoutError extends Error {}`; the old `RETRYABLE` and `NOT_THE_FILE` patterns are gone, the service classifies. `convertDocxToPdf` and `convertDocxToPagePngs` stay exactly as they are; PDF view and the AI render tools use them.

- [ ] **Step 3: Add the jobs API to the service.** After the `enqueue` function:
```js
// --- async jobs: a request never waits on Word, and a job outlives its caller ---
// id = sha256(key), so a client that lost its connection, or a stage that restarted, finds its own job.
const JOB_DIR = join(WORKDIR, "jobs");
await mkdir(JOB_DIR, { recursive: true });
const JOB_TTL_MS = 30 * 60_000;
const JOBS_SECRET = process.env.WORD_JOBS_SECRET || "";
const JOBS_INSECURE = process.env.WORD_JOBS_INSECURE === "1";   // a lab instance only; fails closed otherwise
if (!JOBS_SECRET && !JOBS_INSECURE) console.warn("[word] WORD_JOBS_SECRET is not set: /jobs answers 503");
const jobs = new Map();
// The in-memory map forgets every job on a restart, which launchd and the watchdog do routinely, and the results are theses.
for (const f of await readdir(JOB_DIR)) await unlink(join(JOB_DIR, f)).catch(() => {});

function startJob(spec) {
  const job = { id: spec.id, op: spec.op, status: "queued", createdAt: Date.now() };
  jobs.set(job.id, job);
  enqueue(async () => {
    if (jobs.get(job.id) !== job) return; // deleted while queued
    job.status = "running";
    job.startedAt = Date.now();
    // Fetched here, at its turn: a long queue must not hold every thesis in memory.
    const src = await fetch(spec.url);
    if (!src.ok) throw new Error(`source fetch failed: HTTP ${src.status}`);
    const input = Buffer.from(await src.arrayBuffer());
    // P-55: Word never sees the student's bytes, only the sanitised copy. `limitFactor` and `pagesHint` scale the AppleScript limit (P-54).
    const output = spec.op === "pdf"
      ? await convertDocxToPdf(sanitizeForWord(input).docx, spec.updateFields === true, { limitFactor: spec.limitFactor, pagesHint: spec.pagesHint })
      : await rasterizePdf(input, spec.widthPx, spec.pages);
    job.resultPath = join(JOB_DIR, `${job.id}.bin`);
    await writeFile(job.resultPath, output);
    job.bytes = output.length;
    job.status = "done";
    job.finishedAt = Date.now();
  }).catch((e) => {
    job.status = "failed";
    job.error = String(e?.message ?? e);
    job.finishedAt = Date.now();
  });
  return job;
}

// A thesis must not stay on this disk: results go on DELETE, or after the TTL. Judged from the directory by mtime, not from the map.
setInterval(async () => {
  for (const job of jobs.values()) if (job.finishedAt && Date.now() - job.finishedAt > JOB_TTL_MS) jobs.delete(job.id);
  for (const f of await readdir(JOB_DIR).catch(() => [])) {
    const st = await stat(join(JOB_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > JOB_TTL_MS) await unlink(join(JOB_DIR, f)).catch(() => {});
  }
}, 5 * 60_000).unref();
```
Split `renderPagePngs` so the zip step is reusable: `rasterizePdf(pdfBytes, widthPx, pages)` writes `src.pdf`, runs `pdftoppm -png -scale-to-x W -scale-to-y -1` once (all pages) or once per page with `-f P -l P`, names outputs `image{i}.png` in the order asked, zips, returns the zip, and deletes its folder. `renderPagePngs` becomes `convertDocxToPdf` + `rasterizePdf`.

In the request handler, before the `404`. The whole branch sits in a `try`, like the service's existing handlers: an unhandled rejection here would kill the process and the conversion running in it, which is what P-9 sets out to stop.
```js
const jobMatch = /^\/jobs(?:\/([a-f0-9]{32}))?(\/result)?$/.exec(req.url);
if (jobMatch) try {
  if (!JOBS_SECRET && !JOBS_INSECURE) { res.writeHead(503); res.end("jobs disabled: no secret set"); return; }
  if (JOBS_SECRET && req.headers["x-word-secret"] !== JOBS_SECRET) { res.writeHead(403); res.end("forbidden"); return; }
  const [, id, wantsResult] = jobMatch;
  if (req.method === "POST" && !id) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!b.key || !b.url || !["pdf", "rasterize"].includes(b.op)) { res.writeHead(400); res.end("bad job"); return; }
    const jobId = createHash("sha256").update(String(b.key)).digest("hex").slice(0, 32);
    const held = jobs.get(jobId);
    const job = held && held.status !== "failed" ? held : startJob({ ...b, id: jobId });
    res.writeHead(held && held.status !== "failed" ? 200 : 202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: job.id, status: job.status }));
    return;
  }
  const job = id && jobs.get(id);
  if (!job) { res.writeHead(404); res.end("no job"); return; }
  if (req.method === "GET" && wantsResult) {
    if (job.status !== "done") { res.writeHead(409); res.end("not done"); return; }
    const bytes = await readFile(job.resultPath);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    res.end(bytes);
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: job.id, status: job.status, error: job.error ?? null, bytes: job.bytes ?? null }));
    return;
  }
  if (req.method === "DELETE") {
    jobs.delete(job.id);
    if (job.resultPath) await unlink(job.resultPath).catch(() => {});
    res.writeHead(200); res.end("ok");
    return;
  }
} catch (e) {
  if (!res.headersSent) res.writeHead(e instanceof SyntaxError ? 400 : 500);
  res.end("job error");
  return;
}
```
Import `createHash` from `node:crypto`, and `readdir`, `stat` from `node:fs/promises`. `GET /status` (same secret) answers `{ lastCanary: { ok, at } | null, restarts24h, secretSet }` for `/admin/rescue/runs/summary` (P-54). Change the listen line to `server.listen(PORT, "127.0.0.1", …)` (P-9): `cloudflared` and the lab reach it locally, and nothing else should.

- [ ] **Step 3b: Sanitise, classify, restart (P-54, P-55).** Tests first: `word-sanitize.test.ts` and `word-classify.test.ts`.
  - `scripts/word-sanitize.mjs`: `sanitizeForWord(docx: Buffer): { docx: Buffer; removed: string[] }`, byte-safe (zip entries edited as strings, never xml2js, `w:pPr` and the rest left as they are). It removes the `w:updateFields` element of `word/settings.xml`; the `w:attachedTemplate` element and its relationship; every relationship in any `.rels` whose type ends in `/attachedTemplate`, `/subDocument`, `/oleObject` or `/aFChunk` or whose target is external and not a hyperlink; every macro part (`vbaProject.bin`, `vbaData.xml`) with its relationship and content-type override; and it unlinks the fields INCLUDETEXT, INCLUDEPICTURE, LINK, DDE, DDEAUTO and IMPORT, whether complex (`fldChar` begin / `instrText` / separate / end) or `w:fldSimple`: the instruction and the markers go, the result runs stay. With nothing to remove it returns the input bytes unchanged. Tests build each case from `assets/thesis-base.docx` with invented text: one document per case (INCLUDETEXT, INCLUDEPICTURE, LINK, DDE, `updateFields`, a remote `attachedTemplate`, `vbaProject.bin`, an `altChunk`), each asserted gone, the visible text identical, and the file still opens with the engine; an untouched document is returned byte for byte.
  - In the service, `updateFields` no longer means every field: the AppleScript loops `fields` and updates only those whose type is TOC, PAGEREF, PAGE, NUMPAGES, SEQ or REF, and turns Word's display alerts off before opening a file (check the exact AppleScript terms in Word's dictionary, `sdef /Applications/Microsoft\ Word.app`).
  - `scripts/word-classify.mjs`: `classifyFailure(err, { canary, restart, now })`, pure over injected functions. `source fetch failed|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND` → `network: …`. Otherwise it runs `canary()`: false → `restart()`, run `canary()` once more, record both, answer `wedged: …`; true → `timeout: …` when the message says it timed out, else `file: …`. The original message stays after the prefix, so a client that predates this task still matches its own patterns. Tests: network error → no canary run; AppleScript timeout with a failing canary → restart called once, `wedged`; the same with a passing canary → `timeout`, no restart; `-1728` with a passing canary → `file`; a failing canary that recovers after the restart still answers `wedged` for the job that found it.
  - In `word-convert-service.mjs` the function handed to `withWordLock` catches, calls `classifyFailure` and rethrows the prefixed error, so the canary and the restart run under the lock, never beside a student's job. The canary is a minimal docx the service builds with `adm-zip` at boot, a heading and one sentence of fixed text, so no student file is ever in it. `restart()` is `tell application "Microsoft Word" to quit saving no` with a 10 s timeout, then `pkill -x "Microsoft Word"`, a 3 s wait, nothing else: the next conversion opens a fresh Word. It logs the restart and counts it for `/status`.

- [ ] **Step 4: Prove the jobs API against real Word** on a throwaway instance, on a port nobody else uses. The host-wide lock serialises it with any lab render and with production, so it is safe to run now; it still may wait behind them.
```bash
cd ~/kwill-server && node scripts/word-convert-service.mjs 8094 &
SVC=$!
python3 -m http.server 8799 --directory assets &
WEB=$!
ID=$(curl -s -X POST localhost:8094/jobs -H 'content-type: application/json' \
  -d '{"key":"proof-1","op":"pdf","url":"http://127.0.0.1:8799/thesis-base.docx"}' | jq -r .id)
until [ "$(curl -s localhost:8094/jobs/$ID | jq -r .status)" = "done" ]; do sleep 2; done
curl -s localhost:8094/jobs/$ID/result | head -c 5   # %PDF-
curl -s -X DELETE localhost:8094/jobs/$ID
kill $SVC $WEB
# the fail-closed secret and a malformed body, on a second throwaway instance started without WORD_JOBS_SECRET:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8094/jobs -d '{}'                       # 503
# restarted with WORD_JOBS_SECRET=x:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8094/jobs -H 'x-word-secret: x' -d '{not json'   # 400, the process still answers
```

- [ ] **Step 5: Failing watchdog test** `word-tunnel-watchdog.test.ts`. It runs the script with stub `launchctl`, `curl` and `dig` first on `PATH`, each appending to a calls file, and with `TUNNEL_LOG`, `WATCHDOG_LOG`, `WATCHDOG_BACKOFF_FILE` pointing into a temp folder:
  - local healthcheck fails → both agents kicked (unchanged);
  - local healthy, tunnel unreachable → `com.kwill.word-tunnel` kicked, `com.kwill.word-convert-service` **not** kicked;
  - tunnel log whose only URL is `https://api.trycloudflare.com` → treated as no URL: tunnel kicked, service not;
  - tunnel log holding `429` → no kick, backoff file written about 900 s ahead;
  - backoff file in the future → no kick, no curl to the tunnel;
  - backoff file in the past → file removed and the normal check runs.

- [ ] **Step 6: Fix the watchdog.**
```bash
LOG="${WATCHDOG_LOG:-/tmp/word-tunnel-watchdog.log}"
TUNNEL_LOG="${TUNNEL_LOG:-/tmp/quick-tunnel-word.log}"
BACKOFF_FILE="${WATCHDOG_BACKOFF_FILE:-/tmp/word-tunnel-backoff-until}"
```
After step 1 (the local healthcheck) add:
```bash
# 1b) Cloudflare rate-limits quick-tunnel creation. Restarting again only keeps the limit alive.
now=$(date +%s)
if [ -f "$BACKOFF_FILE" ]; then
  if [ "$now" -lt "$(cat "$BACKOFF_FILE")" ]; then
    log "⏳ in 429 backoff — leaving the tunnel alone"
    exit 0
  fi
  rm -f "$BACKOFF_FILE"
elif tail -50 "$TUNNEL_LOG" 2>/dev/null | grep -qE '\b429\b|error code: 1015'; then
  echo $((now + 900)) > "$BACKOFF_FILE"
  log "⏳ Cloudflare 429 — backing off 15 minutes"
  exit 0
fi
```
URL line: `TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | grep -v '^https://api\.' | tail -1)`. In the final failure branch delete the `com.kwill.word-convert-service` kickstart and change the log text to "restarting the tunnel only": the service answered step 1, and killing it there is what kills conversions mid-job. In `scripts/quick-tunnel-word.sh` step 2, add `| grep -v '^https://api\.'` before `head -1`.

- [ ] **Step 6b: The backoff must live in the tunnel script, not only the watchdog.** `com.kwill.word-tunnel` has `KeepAlive` true with `ThrottleInterval` 15, and the script exits 1 when no URL appears, so launchd relaunches it about every 35 s and asks Cloudflare again whatever the watchdog's file says; and the script truncates its own log, so the watchdog's `tail | grep 429` can miss the evidence. Tests first, `quick-tunnel-word.test.ts`: the script runs with a stub `cloudflared` on `PATH` that prints a 429 (or no URL) and with `WATCHDOG_BACKOFF_FILE` and a counter file in a temp folder.
  - At start, when the backoff file holds a time in the future, the script `sleep`s until then and carries on, so launchd sees a running process and does not relaunch it (the stub test uses a past-by-1-second file and a fake `sleep` to see the call).
  - On a 429, or when no URL appears, it writes the next backoff to the file before it exits: 900 s, then doubling per consecutive failure up to 6 h (the counter file), and a success resets the counter. The backoff file is the evidence; it is not in the truncated log.
  - Three relaunches in a row against the failing stub: the second and third `cloudflared` calls happen no sooner than the file says.
  The watchdog keeps reading the same file (Step 6), so the two agree. `scripts/install-word-converter-launchagents.sh` keeps `KeepAlive`.

- [ ] **Step 6c: The installer carries the secret.** It rewrites the plist and today drops `WORD_JOBS_SECRET`, which with the old fail-open check silently opened `/jobs`. It reads `WORD_JOBS_SECRET` from the environment, else from `~/.config/kwill/word-jobs-secret` (mode 600), writes it into the service's `EnvironmentVariables`, and exits 1 with a message when neither exists (`--no-secret` skips it for a lab host). `/status` reports `secretSet`, which `/admin/rescue/runs/summary` surfaces, so a missing secret shows on the dashboard and not as a silent hole.

- [ ] **Step 7: Run and commit.**
```bash
npx vitest run src/__tests__/word-converter-jobs.test.ts src/__tests__/word-tunnel-watchdog.test.ts src/__tests__/quick-tunnel-word.test.ts src/__tests__/word-sanitize.test.ts src/__tests__/word-classify.test.ts src/lib/rescue/__tests__/no-model-client.test.ts
git add -- scripts/word-sanitize.mjs scripts/word-classify.mjs src/__tests__/word-sanitize.test.ts src/__tests__/word-classify.test.ts src/__tests__/quick-tunnel-word.test.ts
git commit -m "feat(word): async conversion jobs and rasterize; a sanitised copy; wedged Word told apart from a bad file; the watchdog stops killing live conversions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- scripts/word-convert-service.mjs scripts/word-tunnel-watchdog.sh scripts/quick-tunnel-word.sh scripts/install-word-converter-launchagents.sh scripts/word-sanitize.mjs scripts/word-classify.mjs src/lib/word-converter.ts src/__tests__/word-converter-jobs.test.ts src/__tests__/word-tunnel-watchdog.test.ts src/__tests__/quick-tunnel-word.test.ts src/__tests__/word-sanitize.test.ts src/__tests__/word-classify.test.ts
```

### Task S11: storage and settings for a run

**Files:**
- Modify: `src/lib/document-storage.ts`
- Create: `src/lib/rescue-run/config.ts`, `src/lib/rescue-run/storage.ts`, `src/lib/rescue-run/preflight.ts`, `src/lib/rescue-run/__tests__/storage.test.ts`, `src/lib/rescue-run/__tests__/config.test.ts`, `src/lib/rescue-run/__tests__/preflight.test.ts`

Additions to `document-storage.ts`:
```ts
/** Every object under `prefix`, at any depth. Folders come back from list() with id null. */
export async function listObjectsDeep(prefix: string): Promise<string[]>;
export async function removeObjects(paths: string[]): Promise<void>;   // chunks of 100, best-effort per chunk
export async function signMany(paths: string[], ttlSeconds = SIGNED_URL_TTL): Promise<Record<string, string>>; // createSignedUrls + toClientReachable
```
`signDownload(path, filename, opts)` gains `opts.ttlSeconds?: number` (the Word service fetches at its turn, so its source URL lives 6 h). `opts.forDocumentServer` stays as it is: Task S16 passes it for Word's source URLs.

`rescue-run/config.ts`:
```ts
/** P-10, P-64: `rescue.max_object_mb` ÷ 2.5 for a part and for the whole upload; the merged source and the PDF are one object each, and the pack's zip stores the docx and the PDF uncompressed. */
export async function uploadLimits(): Promise<{ partBytes: number; parts: 12; totalBytes: number; guideBytes: number }>;
/** Straight from the DB: a value the dashboard wrote reaches only the handling process's cache. */
export async function readSettingFresh(key: string): Promise<string | undefined>;
export type RescueAccess = "off" | "staff" | "on";
export async function rescueAccess(): Promise<RescueAccess>;       // 30 s in-process cache; `rescue.enabled`: unset → off, "staff", "1" → on (P-68)
export async function rescueEnabled(userId?: string): Promise<boolean>;   // on → true; staff → true only for a profile with `staff_role`; the tick passes no user and runs for "staff" and "on"
export async function rescuePriceDzd(): Promise<number | null>;
export async function rescueLimits(): Promise<{ freeDiagnosesPerDay: number; maxFreeQueue: number; maxObjectMb: number; projectMaxMb: number; maxPages: number; maxBlocks: number; rerunWindowDays: number; rerunDailyCap: number; sameThesisMin: number; sameThesisTraceableMin: number; planRescuesPer30d: number; notesPerDay: number; guidesPerDay: number; samplesPerDay: number; usdToDzd: number }>;
```

`rescue-run/storage.ts`:
```ts
export const rescueRoot = (userId: string, projectId: string) => `${userId}/rescue/${projectId}`;

export class RescueStorage {
  constructor(readonly userId: string, readonly projectId: string);
  readonly root: string;
  partPath(index: number, versionN?: number): string;   // v0 → {root}/parts/{i}.docx, else {root}/v{n}/parts/{i}.docx
  versionPath(n: number, rel: string): string;          // {root}/v{n}/{rel}
  samplePath(kind: "keep" | "clean" | "generated"): string;
  putBytes(path: string, bytes: Buffer, contentType: string): Promise<string>;
  getBytes(path: string): Promise<Buffer>;
  putJson(path: string, value: unknown): Promise<string>;
  getJson<T>(path: string): Promise<T>;
  /**
   * PNGs → display JPEGs under {root}/pages/{sha1}.jpg, in page order. Unchanged pages are not re-uploaded.
   * `onDone` fires as each page lands, with its place and its path, so a stage can publish it right then.
   */
  putPages(pngs: Buffer[], opts: { known?: Set<string>; onDone?: (index: number, path: string) => void }): Promise<string[]>;
  removeWork(n: number): Promise<void>;
  /** P-64: when version `n` finishes, the previous version's zip and `work/` go; its docx, PDF, pages and inventories stay. */
  pruneDerived(n: number): Promise<void>;
  /** Sum of every object under the root, for `rescue.project_max_mb` and `/runs/summary`. */
  usedBytes(): Promise<number>;
  /** Bytes written through this instance, for the cost record. */
  bytesWritten: number;
}
```
```ts
// rescue-run/preflight.ts — P-56. Reads only the zip's central directory (adm-zip's entry headers); nothing is inflated.
export type PreflightRefusal = "not_zip" | "not_docx" | "macro" | "too_many_entries" | "too_big_uncompressed" | "zip_bomb";
export function preflightDocx(buf: Buffer, caps?: { entries?: number; uncompressedBytes?: number; xmlPartBytes?: number; ratio?: number }): { ok: true } | { ok: false; reason: PreflightRefusal };
export function preflightGuide(buf: Buffer, contentType: string): { ok: true; kind: "pdf" | "jpg" | "png" } | { ok: false };   // the first bytes must match the declared type
```
Defaults: 5000 entries, 400 MB uncompressed, 100 MB for one XML part, ratio 200. `not_docx` is a zip with no `[Content_Types].xml` naming the WordprocessingML main part; `macro` is any `vbaProject.bin` or a macro-enabled main content type.

`putPages` runs 4 at a time. `sharp` stays lazy through `toDisplayJpeg`. `putBytes` and `putJson` refuse a key outside the §1.6 pattern before it reaches Supabase.

- [ ] **Step 1: Failing tests**, with `../supabase` mocked as in `src/lib/billing/__tests__/manual-payments.test.ts`:
  - `listObjectsDeep` follows `id:null` entries down; pages past 100; returns full paths.
  - `removeObjects` of 250 paths makes 3 calls.
  - `signMany` maps path → URL and rewrites a loopback host when `STORAGE_PUBLIC_HOST` is set.
  - `putPages`: two identical PNGs make one upload and two identical paths; a path in `known` makes no upload; order is kept; `onDone` gets each page's index and path as it lands, out of order when uploads finish out of order.
  - `putBytes` with an Arabic file name in the key throws; `{root}/v1/deposit/thesis-pdf.pdf` passes.
  - `uploadLimits`: unset → 20 MB; `rescue.max_object_mb=150` → 60 MB.
  - `preflightDocx` on invented zips built in the test: a real docx passes; an xlsx and a plain zip → `not_docx`; a 1000:1 entry made of zeros → `zip_bomb` with the test's tiny cap and nothing inflated (spy on `getData`); 6000 empty entries → `too_many_entries`; a `vbaProject.bin` → `macro`; bytes that are not a zip → `not_zip`. `preflightGuide`: `%PDF-` with `application/pdf` passes, a zip declared as a PDF fails, a PNG declared as a JPEG fails.
  - `rescueAccess`: `"staff"` opens `rescueEnabled(userId)` only for a profile with a `staff_role`; the tick (no user) runs for `"staff"`.
  - `pruneDerived(2)` removes version 1's zip and `work/` and leaves its `thesis.docx`, `thesis.pdf`, pages and inventories; `usedBytes` sums nested objects.
  - `rescuePriceDzd`: unset → null; `"2500"` → 2500; `"abc"`, `"0"`, `"2500.5"` → null. Local DB only for the real read; mock `pool` for the parse table.
  - `rescueEnabled`: `"1"` → true; unset → false; the cache holds for 30 s (fake timers).

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue-run/__tests__/storage.test.ts src/lib/rescue-run/__tests__/config.test.ts src/lib/rescue-run/__tests__/preflight.test.ts
git add -- src/lib/rescue-run/preflight.ts src/lib/rescue-run/__tests__/preflight.test.ts
git commit -m "feat(rescue-run): storage layout and settings read fresh from the database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/document-storage.ts src/lib/rescue-run/config.ts src/lib/rescue-run/storage.ts src/lib/rescue-run/preflight.ts src/lib/rescue-run/__tests__/storage.test.ts src/lib/rescue-run/__tests__/config.test.ts src/lib/rescue-run/__tests__/preflight.test.ts
```

### Task S12: repository and job queue

**Files:**
- Create: `src/lib/rescue-run/repo.ts`, `src/lib/rescue-run/jobs.ts`, `src/lib/rescue-run/__tests__/jobs.test.ts`, `src/lib/rescue-run/__tests__/repo.test.ts`

`jobs.ts`:
```ts
export const LEASE_MINUTES = 5;
export const HEARTBEAT_MS = 60_000;
export const MAX_STAGE_ATTEMPTS = 3;      // spent when a stage reports an error (P-61), never at claim
export const MAX_LEASE_LOSSES = 6;        // a process died or hung under the job; a poison stage must still end
export const MAX_BRAIN_TIMEOUTS = 4;

/** `tx` joins the caller's transaction (P-62): a version and its job, or a side state and its job, are written together. */
export async function enqueuePipeline(a: { projectId: string; versionId: string; stage: RescueStage; priority: 0 | 1 }, tx?: Tx): Promise<void>;
/** False when one of this kind is already queued or running for the project. */
export async function enqueueSide(a: { projectId: string; kind: Exclude<RescueJobKind, "pipeline">; payload: object; priority: 0 | 1 }, tx?: Tx): Promise<boolean>;
export async function claimJob(lane: RescueLane, owner: string, opts?: { brainLimit?: number }): Promise<RescueJobRow | null>;
export async function heartbeat(jobId: string, owner: string): Promise<boolean>;
/** Expired leases go back to `queued` with `lease_losses + 1`; `stage_attempts` is untouched (P-61). */
export async function releaseExpiredJobs(): Promise<number>;
export interface StageCommit {
  next: RescueStage;
  statePatch?: Partial<RescueStageState>;
  versionPatch?: Partial<typeof rescueVersions.$inferInsert>;
  projectPatch?: Partial<typeof rescueProjects.$inferInsert>;
}
/** Fenced: false when this owner no longer holds the lease, and then nothing was written. */
export async function commitStage(job: RescueJobRow, owner: string, c: StageCommit): Promise<boolean>;
/**
 * Fenced, and the patch is computed from the row as it stands NOW: `compute` runs inside the transaction with the project row
 * `SELECT … FOR UPDATE`, so a side job that waited minutes on the brain cannot write a stale copy over a note, a chip or a cover
 * field another job or the student saved meanwhile (P-62). The patch touches only the keys the job owns (`jsonb_set` for `cover.samples`).
 */
export async function commitSide(job: RescueJobRow, owner: string, compute: (fresh: RescueProjectRow) => Partial<typeof rescueProjects.$inferInsert>): Promise<boolean>;
/** `spendAttempt` is for a stage error and for a stage past its budget; waiting on Word or the brain spends nothing. `timeout` counts a brain timeout (`timeouts + 1`). */
export async function requeue(job: RescueJobRow, owner: string, o: { delayMs: number; spendAttempt?: boolean; timeout?: boolean; waitingReason?: "converter" | "brain"; lastError?: string }): Promise<void>;
export async function failJob(job: RescueJobRow, owner: string, lastError: string, tx?: Tx): Promise<boolean>;
```

The claim is one statement, like `claimDueRuns`:
```sql
UPDATE rescue_jobs SET status = 'running', lease_owner = $2,
       lease_until = now() + make_interval(mins => $3),
       updated_at = now()
 WHERE id = (
   SELECT id FROM rescue_jobs
    WHERE lane = $1 AND status = 'queued' AND not_before <= now()
      AND ($1 <> 'heavy' OR NOT EXISTS (SELECT 1 FROM rescue_jobs r WHERE r.lane = 'heavy' AND r.status = 'running'))
      AND ($1 <> 'brain' OR (SELECT count(*) FROM rescue_jobs r WHERE r.lane = 'brain' AND r.status = 'running') < $4)
    ORDER BY priority, (lease_losses >= 2), created_at   -- a job that has cost two lease losses runs after the others
    LIMIT 1
    FOR UPDATE SKIP LOCKED
 )
 RETURNING *;
```
A `23505` from `rescue_jobs_heavy_one_running` means another process won the race: return `null`.

`commitStage` runs in `db.transaction`:
1. `UPDATE rescue_jobs … WHERE id=$1 AND lease_owner=$2 AND status='running'`, setting per `next`:
   - `next` has a lane (`STAGE_LANE[next]`) → `stage=next, lane, status='queued', stage_attempts=0, lease_owner=NULL, lease_until=NULL, not_before=now(), waiting_reason=NULL, waiting_since=NULL`;
   - `next` is `await_*` or `done` → `status='done'`, lease cleared.
   No row back → return `false`.
2. `UPDATE rescue_versions`: `stage=next`; `status='waiting_student'` for `await_*`, `'done'` with `finished_at=now()` for `done`, else `'running'`; `stage_state = stage_state || $patch::jsonb`; `versionPatch`; `updated_at`.
3. `UPDATE rescue_projects`: `projectPatch` plus `updated_at`.

`requeue` with `spendAttempt`: `stage_attempts = stage_attempts + 1`; otherwise it is untouched. `waiting_since = COALESCE(waiting_since, now())` when a reason is given; cleared on the next commit. A job already `running` for a version whose `status` is not `running` is ended at claim by `endStale` (P-62).

`Tx` below is Drizzle's transaction type and `LedgerKind` is the `kind` list of `rescue_ledger` in §1.2.

`repo.ts` (Drizzle for rows):
```ts
export async function createProject(a: { userId: string; title: string; source: "picker" | "share"; parts: { filename: string; sizeBytes: number }[]; universityId: string | null; expiresAt: Date }): Promise<{ project: RescueProjectRow; original: RescueVersionRow }>;
export async function getOwnedProject(userId: string, id: string): Promise<RescueProjectRow | null>;
export async function getOwnedVersion(userId: string, vid: string): Promise<{ version: RescueVersionRow; project: RescueProjectRow } | null>;
export async function listProjects(userId: string): Promise<RescueProjectRow[]>;
export async function listVersions(projectId: string): Promise<RescueVersionRow[]>;     // n DESC
export async function getRunState(projectId: string): Promise<{ versions: RescueVersionRow[]; job: RescueJobRow | null }>;
export async function createVersion(a: {
  projectId: string; kind: RescueVersionKind; trigger: RescueTrigger; parentId: string | null;
  stage: RescueStage; status: RescueVersionStatus; settings: object; parts?: object[];
  /** A rescue or a retry starts on the input of the version it follows. A `pack_rebuilt` run also takes the parent's output (P-48). */
  copyFrom?: { sourcePath: string | null; inventoryPath: string | null; map: unknown; finalMap?: unknown; finalInventoryPath?: string | null; finalPageMapPath?: string | null; pages?: string[]; changes?: unknown; proof?: unknown; stats?: unknown; thesisDocHash?: string | null };
  stageState?: Partial<RescueStageState>;
  sourceKind?: "upload" | "working_copy" | "previous";
}, tx?: Tx): Promise<RescueVersionRow>; // n = max + 1; retries on 23505
/** A version and its pipeline job in ONE transaction (P-62): a crash leaves both or neither. Routes call this, never the two separately. */
export async function createVersionWithJob(a: Parameters<typeof createVersion>[0] & { job: { stage: RescueStage; priority: 0 | 1 } }): Promise<RescueVersionRow>;
/** The restore row (P-60): every input and output column of `target` (all `*_path`, `pages`, `map`, `final_map`, `changes`, `stats`, `proof`, `deposit_*`, `diagnosis`, `preview`, `settings`), `kind:'restore'`, `status:'done'`, `parent_id` = target. */
export async function copyVersionRow(target: RescueVersionRow, o: { thesisDocHash: string }, tx?: Tx): Promise<RescueVersionRow>;
/** The newest done version that is not a restore of the original, following `parent_id` past restore rows is NOT needed: a restore row is a full copy. */
export async function lastDoneVersion(projectId: string): Promise<RescueVersionRow | null>;
/** `rescue_ledger` (P-58, P-59): append-only, survives a deleted project. */
export async function appendLedger(a: { userId: string; projectId: string | null; kind: LedgerKind }, tx?: Tx): Promise<void>;
export async function countLedger(userId: string, kind: LedgerKind | LedgerKind[], sinceHours: number): Promise<number>;
export async function updateProject(id: string, patch: Partial<typeof rescueProjects.$inferInsert>): Promise<void>;
export async function updateVersion(id: string, patch: Partial<typeof rescueVersions.$inferInsert>): Promise<void>;
/** @deprecated name kept for the plan's readers: it is `countLedger(userId, "project", hours)`; live rows are NOT counted (P-59). */
export async function countRecentProjects(userId: string, hours: number): Promise<number>;
/** Not entitled, v0 running, or waiting on the student and touched in the last 24 h. An unfinished upload does not count: POST /projects deletes it and starts again. */
export async function findFreeFlowInProgress(userId: string): Promise<RescueProjectRow | null>;
export async function countQueuedFreeJobs(): Promise<number>;
export async function countRerunsToday(projectId: string): Promise<number>;
/** A manual `pending` row, or a Chargily `pending` row younger than CARD_PENDING_MINUTES (P-51). Lives here, not in entitlement.ts, so Task S15 and Task S14 never import each other's file. */
export const CARD_PENDING_MINUTES = 15;
export async function hasPendingPayment(projectId: string): Promise<boolean>;
```

- [ ] **Step 1: Failing tests on the local DB** (races cannot be tested against a fake, same reasoning as `src/lib/tasks/__tests__/claim.test.ts`):
  - `Promise.all` of 5 `claimJob("heavy", ownerN)` with 3 queued heavy jobs: exactly one claim, no thrown error.
  - With one heavy `running`, `claimJob("heavy")` → null. With an expired lease, `releaseExpiredJobs()` then claim works and `lease_losses` is 1 (`stage_attempts` stays 0).
  - Brain limit: `brainLimit: 3` with 5 queued → the fourth claim returns null.
  - Priority: a `priority 0` created after a `priority 1` is claimed first. `not_before` in the future is skipped.
  - Lease loss, not attempt (P-61): a killed process's job comes back with `lease_losses` 1 and `stage_attempts` 0; three kills and a clean run on one stage end in `done`; six lease losses stop being claimable (the runner then fails it); after two lease losses a younger job with none is claimed first.
  - `requeue` without `spendAttempt` leaves `stage_attempts`; with it adds one; `timeout:true` adds to `timeouts`.
  - `createVersionWithJob`: a failure between the two statements (the job insert throws) leaves no version row; `commitSide` with a function sees the fresh row: two side jobs on a stale copy cannot overwrite each other's keys (parse_note then read_guide, and cover_samples with a supervisor saved during it).
  - `copyVersionRow` copies every column listed above; a row built from it satisfies `lastDoneVersion` consumers.
  - `countLedger('project')` still counts after the project row is deleted; `hasPendingPayment` agrees with `purchaseState`'s window.
  - Fencing: after `releaseExpiredJobs`, the old owner's `commitStage` returns false and the version's `stage` and `stage_state` are unchanged. `heartbeat` returns false. The same holds when the job is claimed again under a new owner string in the same process, which is why Task S16 makes one per claim.
  - `commitStage` merges `stage_state` (keys from an earlier stage survive), sets `lane` from `STAGE_LANE`, resets attempts; to `await_setup` the job is `done` and the version `waiting_student`; to `done` the version gets `finished_at`.
  - `requeue` sets `waiting_since` once and keeps it on the second call.
  - `enqueueSide` twice for one kind → second false. `enqueuePipeline` twice for one version → the unique index throws, surfaced as an Error naming the version.
  - `createVersion` under `Promise.all` of 2 → `n` differs (the `rescue_versions_one_active` index refuses the second active one, so use `kind:'restore', status:'done'` for this case).

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/jobs.test.ts src/lib/rescue-run/__tests__/repo.test.ts
git commit -m "feat(rescue-run): repository and the durable job queue with leases and fencing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/repo.ts src/lib/rescue-run/jobs.ts src/lib/rescue-run/__tests__/jobs.test.ts src/lib/rescue-run/__tests__/repo.test.ts
```

### Task S13: Support cases, push, and the words the server says

**Files:**
- Create: `src/lib/support-cases.ts`, `src/lib/rescue-run/copy.ts`, `src/lib/rescue-run/notify.ts`, `src/lib/rescue-run/__tests__/copy.test.ts`, `src/lib/rescue-run/__tests__/notify.test.ts`, `src/__tests__/support-cases.test.ts`
- Modify: `src/lib/notifications.ts` (`NotifType` gains `"rescue"`), `src/routes/support.ts` (imports `identifyStudent` instead of its private `identify`, behaviour unchanged)

```ts
// src/lib/support-cases.ts — the system opens a thread for a student.
// POST /api/support/conversations is student-authenticated with a 429 cap, so it cannot serve this.
export async function identifyStudent(userId: string, authEmail: string, metaName: string): Promise<{ name: string; email: string }>;
export async function openSupportCase(input: {
  userId: string; subject: string; message: string; topic: string;
  language: "ar" | "fr" | "en"; thesisId?: string | null;
}): Promise<string>; // conversation id
```
The message is inserted with `sender: "staff"`, `authorName: "Kwill"`, `staffUnread: 1`, `studentUnread: 1`: it appears in the student's Support Center too, so it holds no internals.

`rescue-run/copy.ts`, the only place the server words anything to a student. `rescueLang(profileLang)`: `ar`, `en`, else `fr`. French in email is accentless, the house style (`quota-email.ts`).

```ts
export const RESCUE_COPY = {
  ar: {
    done: { title: "مذكرتك جاهزة ✓", body: "الإصلاحات: {fixes} · الصفحات: {pages} · لم تتغيّر أي كلمة. اضغط لتحميلها." },
    failed: { title: "لم نُكمل الإصلاح", body: "ملفك الأصلي كما هو تمامًا. اضغط لمعرفة التفاصيل." },
    diagnosisReady: { title: "تشخيص مذكرتك جاهز", body: "اضغط لترى ما سنصلحه." },
    partsReady: { title: "رتّبنا أجزاء مذكرتك", body: "تأكّد من الترتيب لنكمل." },
    setupReady: { title: "قرأنا صفحات مذكرتك", body: "اختر قواعد كليتك لنبدأ التشخيص." },
    questionsWaiting: { title: "لدينا سؤال عن مذكرتك", body: "أجب عنه لنكمل الإصلاح." },
    paymentOk: { title: "وصلتنا دفعتك ✓", body: "نكمل معًا خطوات الإصلاح." },
    paymentRejected: { title: "لم نتمكن من تأكيد دفعتك", body: "اضغط لمعرفة السبب وإعادة الإرسال." },
    refundDone: { title: "أعدنا لك المبلغ", body: "ملفك الأصلي ما زال محفوظًا." },
    supportSubject: "إصلاح مذكرتك",
    supportMessage: "لم نُكمل إصلاح مذكرتك، وملفك الأصلي كما هو تمامًا. فريق Kwill يراجع الملف وسيعود إليك هنا.",
    supportMessageRefund: "لم نُكمل إصلاح مذكرتك، وملفك الأصلي كما هو تمامًا. سنعيد لك المبلغ، وفريق Kwill يراجع الملف وسيعود إليك هنا.",
    email: {
      subject: "تشخيص مذكرتك في Kwill جاهز",
      heading: "تشخيص مذكرتك جاهز",
      lead: "قرأنا مذكرتك وعرفنا ما يجب إصلاحه حسب معايير كليتك. لإكمال الإصلاح، ادفع مرة واحدة ببطاقة CIB أو الذهبية، ويُفعَّل الإصلاح على حسابك مباشرة على كل أجهزتك. لن نغيّر أي كلمة من نصّك، وملفك الأصلي يبقى محفوظًا.",
      cta: "إكمال الإصلاح",
      note: "الرابط صالح لمدة 30 يوماً وخاص بحسابك — لا تشاركه مع أحد.",
    },
    pay: { title: "إصلاح مذكرتك", lead: "دفعة واحدة لهذه المذكرة، مع إعادة مجانية بعد تعديلات الأستاذ.", once: "دفعة واحدة", choose: "ادفع" },
  },
  fr: {
    done: { title: "Votre mémoire est prêt ✓", body: "Corrections : {fixes} · Pages : {pages} · Aucun mot n'a changé. Touchez pour le télécharger." },
    failed: { title: "Nous n'avons pas terminé la remise en forme", body: "Votre fichier d'origine est intact. Touchez pour en savoir plus." },
    diagnosisReady: { title: "Le diagnostic de votre mémoire est prêt", body: "Touchez pour voir ce que nous allons corriger." },
    partsReady: { title: "Les parties de votre mémoire sont en ordre", body: "Vérifiez l'ordre pour continuer." },
    setupReady: { title: "Nous avons lu les pages de votre mémoire", body: "Choisissez les règles de votre faculté pour lancer le diagnostic." },
    questionsWaiting: { title: "Une question sur votre mémoire", body: "Répondez-y pour que la remise en forme continue." },
    paymentOk: { title: "Paiement bien reçu ✓", body: "Continuons ensemble." },
    paymentRejected: { title: "Nous n'avons pas pu confirmer votre paiement", body: "Touchez pour voir la raison et renvoyer." },
    refundDone: { title: "Nous vous avons remboursé", body: "Votre fichier d'origine reste conservé." },
    supportSubject: "Remise en forme de votre mémoire",
    supportMessage: "Nous n'avons pas terminé la remise en forme de votre mémoire, et votre fichier d'origine est intact. L'équipe Kwill examine le fichier et vous répondra ici.",
    supportMessageRefund: "Nous n'avons pas terminé la remise en forme de votre mémoire, et votre fichier d'origine est intact. Nous allons vous rembourser ; l'équipe Kwill examine le fichier et vous répondra ici.",
    email: {
      subject: "Le diagnostic de votre memoire sur Kwill est pret",
      heading: "Le diagnostic de votre memoire est pret",
      lead: "Nous avons lu votre memoire et nous savons quoi corriger selon les regles de votre faculte. Pour terminer, payez une seule fois par carte CIB ou Edahabia : c'est active directement sur votre compte, sur tous vos appareils. Aucun mot de votre texte ne change, et votre fichier d'origine reste conserve.",
      cta: "Terminer la remise en forme",
      note: "Ce lien est valable 30 jours et personnel — ne le partagez pas.",
    },
    pay: { title: "Remise en forme de votre mémoire", lead: "Un seul paiement pour ce mémoire, avec une reprise gratuite après les corrections de votre encadreur.", once: "paiement unique", choose: "Payer" },
  },
  en: {
    done: { title: "Your thesis is ready ✓", body: "Fixes: {fixes} · Pages: {pages} · Not a word changed. Tap to download it." },
    failed: { title: "We didn't finish the repair", body: "Your original file is untouched. Tap for details." },
    diagnosisReady: { title: "Your thesis check is ready", body: "Tap to see what we'll fix." },
    partsReady: { title: "Your thesis parts are in order", body: "Check the order so we can carry on." },
    setupReady: { title: "We've read your thesis pages", body: "Pick your faculty's rules to start the check." },
    questionsWaiting: { title: "A question about your thesis", body: "Answer it so the repair can carry on." },
    paymentOk: { title: "Payment received ✓", body: "Let's finish this together." },
    paymentRejected: { title: "We couldn't confirm your payment", body: "Tap to see why and send it again." },
    refundDone: { title: "We returned your payment", body: "Your original file is still kept." },
    supportSubject: "Your thesis repair",
    supportMessage: "We didn't finish repairing your thesis, and your original file is untouched. The Kwill team is looking at the file and will reply here.",
    supportMessageRefund: "We didn't finish repairing your thesis, and your original file is untouched. We will return your payment; the Kwill team is looking at the file and will reply here.",
    email: {
      subject: "Your Kwill thesis check is ready",
      heading: "Your thesis check is ready",
      lead: "We read your thesis and know what to fix under your faculty's rules. To finish, pay once with a CIB or Edahabia card; it activates on your account directly, on every device. Not a word of your text changes, and your original file stays kept.",
      cta: "Finish the repair",
      note: "The link works for 30 days and is personal to your account — do not share it.",
    },
    pay: { title: "Repair your thesis", lead: "One payment for this thesis, with free re-runs after your supervisor's changes.", once: "one payment", choose: "Pay now" },
  },
} as const;
```

```ts
// rescue-run/notify.ts — never throws, like createNotification.
export type RescueEvent = "done" | "failed" | "diagnosisReady" | "partsReady" | "setupReady" | "questionsWaiting" | "paymentOk" | "paymentRejected" | "refundDone";
export async function notifyRescue(userId: string, projectId: string, event: RescueEvent, params?: { fixes?: number; pages?: number }): Promise<void>;
```
`notifyRescue` reads `profiles.language`, fills the template, calls `createNotification(userId, { type: "rescue", title, description, data: { route: `/(app)/rescue?projectId=${projectId}`, projectId } })`.

- [ ] **Step 1: Failing tests.**
  - Copy: three languages hold the same key tree; no banned word (`section break`, `field`, `saut de section`) in any string.
  - Notify: a profile with `language:'ar'` gets Arabic; `{fixes}`, `{pages}` are filled; a null profile falls to French; `data.route` is exact for each of the nine events; a DB error resolves without throwing.
  - `openSupportCase`, with `../db` mocked: writes a conversation with `topic`, `thesisId`, `staffUnread:1`, and one message with `sender:"staff"`; no cap check is reached.
  - `identifyStudent` keeps the route's fallback order: profile name → metadata → email local part.

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
npx vitest run src/lib/rescue-run/__tests__/copy.test.ts src/lib/rescue-run/__tests__/notify.test.ts src/__tests__/support-cases.test.ts
git commit -m "feat(rescue-run): system-opened support cases and localised push copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/support-cases.ts src/lib/rescue-run/copy.ts src/lib/rescue-run/notify.ts src/lib/notifications.ts src/routes/support.ts src/lib/rescue-run/__tests__/copy.test.ts src/lib/rescue-run/__tests__/notify.test.ts src/__tests__/support-cases.test.ts
```

---

### Group S-D: money and deletion (two engineers at once, starts after S-C)

### Task S14: the rescue purchase

**Files:**
- Create: `src/lib/rescue-run/entitlement.ts`, `src/lib/rescue-run/email.ts`, `src/lib/rescue-run/__tests__/entitlement.test.ts`, `src/lib/rescue-run/__tests__/email.test.ts`, `src/__tests__/payment-rescue.test.ts`, `src/__tests__/pay-rescue.test.ts`
- Modify: `src/lib/billing/open-checkout.ts`, `src/routes/payment.ts`, `src/lib/billing/manual-payments.ts`, `src/routes/pay.ts`, `src/lib/billing/__tests__/manual-payments.test.ts`

```ts
// rescue-run/entitlement.ts — imports pool and notify only: payment.ts reaches it at boot.
export class RescuePurchaseError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) { super(message); }
}
/** Rescue open, owner, v0 done, not entitled, price set. Returns the price read fresh from the DB. `rescue.enabled` is read first: before the release the tables are not on cloud (P-49). */
export async function assertRescuePurchasable(userId: string, projectId: string): Promise<{ amountDzd: number }>;
/** Called on the pending→paid edge. Never throws for a gone or already-entitled project: the money is real, so it becomes refund_due with a Support case. */
export async function grantRescuePurchase(a: { paymentId: string; userId: string; projectId: string | null }): Promise<void>;
/**
 * Entitlement through the student's plan (P-58). `free_plan`: nothing granted. `allowance_used`: the plan has already included
 * `rescue.plan_rescues_per_30d` rescues for this student in a rolling 30 days, counted from `rescue_ledger` (kind `grant_plan`),
 * so a deleted project gives nothing back. `granted` writes the ledger row in the same transaction as the entitlement.
 */
export async function grantByPlan(userId: string, projectId: string): Promise<"granted" | "free_plan" | "allowance_used">;
/** P-62: rescue payments that are paid (Chargily) or approved (manual) and that no project names as `purchase_id`: the process died between the claim and the grant. Calls `grantRescuePurchase` for each, which turns a gone project into refund due. Run by the tick. */
export async function grantUngrantedRescuePayments(): Promise<number>;
/** P-63: a delivery after a failed first rescue whose payment is `due`: `refund_status='waived'` with a note. */
export async function waiveRefund(paymentId: string, note: string): Promise<void>;
export async function markRefundDue(paymentId: string, reason: string): Promise<void>;
/**
 * Staff returned the money. When this payment is the one the project's entitlement rests on, the project loses the
 * entitlement, so the student may buy again later; a double payment's refund leaves it alone. The payment keeps its
 * `rescue_project_id`, so the run still shows its money. Today's `purchase_id` stays until a new purchase replaces it.
 * It sets `expires_at = now() + 30 days` when the project has no thesis, so a project that is no longer entitled reaches the
 * TTL (P-34); a grant clears it. It throws `RescuePurchaseError(409, "rescue_already_delivered")` when a done rescue exists and
 * `confirmDelivered` is not set (P-63).
 */
export async function markRefunded(paymentId: string, refundedBy: string, note?: string, o?: { confirmDelivered?: boolean }): Promise<{ userId: string; projectId: string | null } | null>;
export async function purchaseState(p: { id: string; userId: string; purchaseId: string | null }): Promise<RescueEntitlementDTO["purchase"]>;
// `hasPendingPayment` and `CARD_PENDING_MINUTES` are exported by `rescue-run/repo.ts` (Task S12), so Task S15 never imports this file; `purchaseState` here uses the same constant (P-51).
```
Grant statement:
```sql
UPDATE rescue_projects
   SET entitlement = 'purchase', purchase_id = $1, entitled_at = now(), expires_at = NULL,
       rerun_free_until = now() + make_interval(days => $4), updated_at = now()
 WHERE id = $2 AND user_id = $3 AND entitlement IS NULL
 RETURNING id
```
No row → `markRefundDue(paymentId, "project_gone_or_already_entitled")` and a Support case. A row → a `grant_purchase` ledger row in the same transaction, then `notifyRescue(userId, projectId, "paymentOk")`. **The claim in `payment.ts` and this grant are separate statements, and a recycle between them takes money with no entitlement: Chargily's redelivery then finds nothing pending and answers `duplicate`.** Two answers, both here: `/webhook` runs the claim and the rescue grant in one transaction when `kind='rescue'`, and the tick calls `grantUngrantedRescuePayments()` (P-62).

`purchaseState` reads the newest `payments` row with this `rescue_project_id` and maps, first hit wins: `refund_status='due'` → `refund_due`; `status='refunded'` → `refunded`; `paid` (a `refund_status='waived'` row included, P-63) → `paid`; manual `pending` → `pending_manual`; Chargily `pending` younger than 15 minutes → `pending_card`, older → `none`; `rejected` → `rejected_manual` with `reject_reason`; `failed`, `canceled`, no row → `none`.

**Plans and top-ups keep working on a schema without the new columns (P-49).** No statement they run names `rescue_project_id` or `refund_*`: every use below sits in a `kind='rescue'` branch.

- [ ] **Step 1: `open-checkout.ts`.**
```ts
export type CheckoutItem =
  | { plan: Exclude<PlanCode, "free"> }
  | { kind: "topup" }
  | { kind: "rescue"; projectId: string; amountDzd: number };
```
Replace `const buyingTopup = "kind" in item` with a three-way switch. For rescue: `description: "Kwill — thesis repair"`, `metadata: { user_id, kind: "rescue", project_id }`, `successUrl: ${base}/api/payment/return?status=success&rescue=${projectId}`, `failureUrl` the same with `status=failed`, and its own `INSERT` writes `rescue_project_id`. The statement for plans and top-ups stays byte for byte.

- [ ] **Step 2: `routes/payment.ts`.**
  - `/checkout`, before the plan validation:
```ts
if (kind === "rescue") {
  try {
    const { amountDzd } = await assertRescuePurchasable(userId, String(body.projectId ?? ""));
    const opened = await openCheckout({
      userId, item: { kind: "rescue", projectId: body.projectId, amountDzd },
      locale: locale === "fr" || locale === "en" ? locale : "ar", base,
    });
    return c.json({ ...opened, mode: chargilyMode() });
  } catch (e) {
    if (e instanceof RescuePurchaseError) return c.json({ error: e.message, code: e.code }, e.status);
    console.error("chargily checkout error:", (e as Error)?.message);
    return c.json({ error: "Could not open the payment page. Please try again." }, 502);
  }
}
```
  - `/manual`: pass `kind: kind === "topup" ? "topup" : kind === "rescue" ? "rescue" : undefined` and `projectId`. `ManualPaymentError` gains an optional `code` and the route answers `{ error, code }`, so `rescue_not_for_sale` and the other refusals reach the app by code.
  - `/return`: read `rescue`; when it is a uuid, the deep link becomes `kwill://payment-${status}?rescue=${id}`.
  - `/webhook`: **the trap.** Today an unknown kind takes the plan branch, stays `paid`, grants nothing and answers 200. Change:
```ts
const kind = meta.kind === "topup" ? "topup" : meta.kind === "rescue" ? "rescue" : "subscription";
// The claim's RETURNING stays as it is (P-49): the checkout's metadata carries the project.
if (row.kind === "rescue" || kind === "rescue") {
  const projectId = typeof meta.project_id === "string" ? meta.project_id : null;
  await grantRescuePurchase({ paymentId: row.id, userId, projectId });
  console.log(`[payment] rescue purchase granted`);
} else if (row.kind === "topup" || kind === "topup") {
```
  The rescue branch stays inside the existing `try`, so a DB error puts the row back to `pending` for Chargily's retry. For `kind='rescue'` the `UPDATE … status='paid'` claim and the grant share one `BEGIN … COMMIT` (a `pool` client), so a recycle between them rolls back to `pending` and the redelivery grants.

- [ ] **Step 3: `billing/manual-payments.ts`.**
  - `ManualPaymentRow.kind` adds `"rescue"`; adds `rescueProjectId: string | null`; `toRow` maps `r.rescue_project_id ?? null`. Shared `SELECT`s and `RETURNING`s stay as they are, and only rescue's own statements fill it.
  - `SubmitManualPaymentArgs.kind` adds `"rescue"`, adds `projectId?: string`.
  - In `submitManualPayment`, rescue reads `assertRescuePurchasable`, mapping `RescuePurchaseError` to `ManualPaymentError(e.message, e.status)`; the plan checks are skipped; `plan` is null; its own `INSERT … RETURNING` names `rescue_project_id`.
  - In `approveManualPayment`, before the plan branch: `if (row.kind === "rescue") { const projectId = await rescueProjectOf(id); await grantRescuePurchase({ paymentId: id, userId: row.user_id, projectId }); return; }`, where `rescueProjectOf` is a one-column `SELECT` used only here and below. The generic "your plan is active" notification must not go out; the grant sends its own. Today this call throws "Invalid plan".
  - `manualPaymentStatus` (the plans screen's 'under review' line) filters `kind <> 'rescue'`; a pending rescue payment must not hide every plan button. The rescue's own state is `purchaseState` (P-49: `kind` already exists).
  - In `rejectManualPayment`, the claim's `RETURNING` gains `kind`. `kind='rescue'` → `notifyRescue(user, await rescueProjectOf(id), "paymentRejected")` in place of today's notification, whose English title and no route lead nowhere near screen 9. `reject_reason` reaches the sheet through `purchaseState`.

- [ ] **Step 4: `routes/pay.ts`.** `payRoutes.get("/")` becomes `async`. When `?project=` is present: `rescueEnabled(userId)` false → the `unavailable` status page; otherwise look up the project's owner and title by id; a project that is not the token's user's → `c.notFound()`; `rescuePriceDzd()` null → the `unavailable` status page; otherwise a one-card page from `RESCUE_COPY[lang].pay` with the project's title, escaped, the price and `href="/pay/go?…&item=rescue&project=<id>"`. In `/go`: `item === "rescue"` → `assertRescuePurchasable(userId, project)` then `openCheckout`; a `RescuePurchaseError` → the `failed` status page. The expiry page of a link says, for a rescue link, to open the latest email (the app has no 'send me a fresh link' control).

- [ ] **Step 5: `rescue-run/email.ts`.**
```ts
/** On every platform, when the diagnosis finishes for a student without the rescue; and again at most once per 3 days (P-69) from the 402 path of POST /continue and from the tick. Fire-and-forget. */
export function maybeSendRescueReadyEmail(projectId: string, userId: string): void;
/** The tick's sweep: v0 done, not entitled, for sale, `email_sent_at` NULL (or older than 3 days when asked by the 402 path), at most 20 per call. */
export async function sweepRescueReadyEmails(): Promise<number>;
```
Same body shape as `maybeSendQuotaEmail`. The dedupe is durable: `UPDATE rescue_projects SET email_sent_at = now() WHERE id = $1 AND (email_sent_at IS NULL OR email_sent_at < now() - interval '3 days') AND entitlement IS NULL RETURNING id`, reset to the previous value when `sendMail` fails. Skipped when `!isMailerConfigured()`, no `PUBLIC_BASE_URL`, the student's plan currently includes the rescue (the allowance is not spent, P-58), or not for sale. Link: `${base}/pay?token=…&lang=…&project=${projectId}`. A skipped send is retried by the sweep, so a mailer that was down, an unset price or a plan that lapsed later no longer leave an iOS student without a way to pay.

- [ ] **Step 6: Failing tests, then make them pass.**
  - `assertRescuePurchasable`: not the owner → 404; v0 not done → 409 `rescue_not_ready`; entitled → 409 `rescue_already_entitled`; price unset → 409 `rescue_not_for_sale`; fine → `{ amountDzd }`.
  - `grantRescuePurchase` (local DB): sets all five columns; a second payment for an entitled project → `refund_status='due'`, a Support case, no second entitlement; a null project → `refund_due`.
  - `markRefunded`: `status='refunded'`, `refund_status='done'`, the project's `entitlement` cleared when `purchase_id` is this payment, and `expires_at` set to now + 30 days when the project has no thesis; not due → null. A double payment marked refunded: the entitlement stays, and the payment still names its project. With a done rescue → 409 `rescue_already_delivered` unless `confirmDelivered`. After a refund, a new grant clears `expires_at` again.
  - `grantByPlan` (local DB): free plan → `free_plan`; monthly plan twice in 30 days → `granted`, `granted`, the third (a different project, the first two deleted) → `allowance_used`; the ledger row survives a deleted project; a purchase and a staff grant never count against it.
  - `grantUngrantedRescuePayments`: a `paid` rescue row no project names, older than 2 minutes → granted once, a second call grants nothing; one whose project is gone → refund due and a Support case; the kill test: claim without grant, then the sweep grants. The webhook's claim and grant share a transaction (a throw in the grant leaves the row `pending`).
  - `waiveRefund`: sets `waived` with the note and the run list no longer shows `due`.
  - `purchaseState`: a Chargily row 14 minutes old → `pending_card`, 16 minutes old → `none`; `canceled`, `failed` → `none`; a manual `pending` 3 days old → `pending_manual`. `hasPendingPayment` agrees on each, and a late webhook on an old row still grants.
  - Webhook (`payment-rescue.test.ts`, in the style of `src/__tests__/payment-manual.test.ts`, `verifyWebhook` mocked): a `checkout.paid` with `kind:"rescue"` calls `grantRescuePurchase` once and not `activatePlan`; redelivery → `duplicate:true`, no second grant; `grantRescuePurchase` throwing → row back to `pending`, 500.
  - `/checkout` with `kind:"rescue"` → `openCheckout` called with the fresh price; `/return?status=success&rescue=<uuid>` carries it in the deep link; a non-uuid is ignored.
  - `manual-payments.test.ts`: submit with `kind:"rescue"`, amount from settings; approve grants; reject leaves the project alone and sends `paymentRejected`; a plan's rejection still sends today's notification.
  - **A schema without the columns** (`payment-rescue.test.ts`, `pool` mocked, every SQL string captured): a plan checkout, a top-up checkout, their webhook grants, a manual plan submit, approve, reject and status name neither `rescue_project_id` nor `refund_`. With `rescue.enabled` unset, `kind:"rescue"` at `/checkout` and `/manual` answers 409 `rescue_not_for_sale` and never reads `rescue_projects`.
  - `/pay?project=` for someone else's project → 404; `/pay/go?item=rescue` → 302; price unset → 503; the title is HTML-escaped.
  - Email: sends once; a second call within 3 days sends nothing; after 3 days the 402 path sends it again; a failed send restores the marker; a subscriber whose plan includes the rescue gets none; the sweep sends the one a down mailer skipped, once the mailer is back.

- [ ] **Step 7: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/entitlement.test.ts src/lib/rescue-run/__tests__/email.test.ts src/__tests__/payment-rescue.test.ts src/__tests__/pay-rescue.test.ts src/__tests__/payment-manual.test.ts src/lib/billing/__tests__/manual-payments.test.ts src/lib/__tests__/chargily.test.ts
git commit -m "feat(rescue-run): the one-time rescue purchase through Chargily, manual payment and /pay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/entitlement.ts src/lib/rescue-run/email.ts src/lib/billing/open-checkout.ts src/routes/payment.ts src/lib/billing/manual-payments.ts src/routes/pay.ts src/lib/billing/__tests__/manual-payments.test.ts src/lib/rescue-run/__tests__/entitlement.test.ts src/lib/rescue-run/__tests__/email.test.ts src/__tests__/payment-rescue.test.ts src/__tests__/pay-rescue.test.ts
```

### Task S15: the deletion sweep

**Files:**
- Create: `src/lib/rescue-run/sweep.ts`, `src/lib/rescue-run/__tests__/sweep.test.ts`
- Modify: `src/lib/thesis-delete.ts`, `src/routes/user.ts`, `src/mcp/tools/thesis.ts`

There are three ways a thesis dies, and all three must sweep: `deleteThesisCompletely` (the app), `DELETE /account`, and the MCP tool `delete_thesis` (Assist and Agent chat), which today does a bare `db.delete(theses)`: the FK cascade then removes the rescue rows and every blob under `{userId}/rescue/{projectId}` stays with nothing left to find it, student thesis included.

```ts
export async function sweepRescueRoot(root: string): Promise<number>;
/** P-65: written in the SAME transaction as the delete of the project, thesis or account. */
export async function writeTombstone(root: string, userId: string, tx?: Tx): Promise<void>;
/** The tick: tombstones older than the lease time (a stage that was running when the project went has stopped writing, or lost its lease) are swept again, then their rows are deleted. */
export async function sweepTombstones(limit?: number): Promise<number>;
export async function rescueRootsForThesis(thesisId: string): Promise<string[]>;
/** Hard delete of a diagnosis-only project: rows and blobs. */
export async function deleteDiagnosisProject(p: { id: string; userId: string }): Promise<void>;
/** Past expires_at, not entitled, no thesis, no pending payment (`hasPendingPayment` from `repo.ts`: S14 is not a dependency of this task, P-51). At most `limit` per call. */
export async function sweepExpiredDiagnoses(limit?: number): Promise<number>;
/**
 * Account deletion: user_id has no FK, so nothing cascades to a diagnosis-only project, and a cascade from the thesis
 * leaves blobs nothing can find. Removes every object under `{userId}/rescue/`, then every row. Returns objects removed.
 */
export async function sweepUserRescue(userId: string): Promise<number>;
```

- [ ] **Step 1: `thesis-delete.ts`.** Snapshot before the cascade, as `sourceRows` does at `:46-49`:
```ts
const rescueRoots = await rescueRootsForThesis(thesisId).catch(() => [] as string[]);
```
Before the delete, `writeTombstone(root, userId)` for each root, in the same transaction as the `db.delete(theses)`. After the existing storage cleanup: `for (const root of rescueRoots) await sweepRescueRoot(root).catch(() => {});`. The rows go by `ON DELETE CASCADE` from `theses`. In `src/mcp/tools/thesis.ts`, `delete_thesis` calls `deleteThesisCompletely(thesisId, { ownerUserId: userId })` instead of `db.delete(theses)`, keeping its ownership scoping and its "Thesis not found" answer.

- [ ] **Step 2: `routes/user.ts`.** In `DELETE /account`, first line inside the `try`: `await sweepUserRescue(userId).catch((e) => console.error("[account] rescue sweep failed:", e?.message));`, before `db.delete(profiles)`.

- [ ] **Step 3: A job running while its project is deleted.** `commitStage` then returns `false` or the heartbeat reports a lost lease, and `rescue_jobs` has cascaded away with the project, so nothing can be claimed to notice. Two answers: Task S16's runner checks whether the project still exists on every exit that is not a clean commit (`commit === false`, `LeaseLostError`, a stage error) and calls `sweepRescueRoot` when it does not; and the tombstone written with the delete is swept again by the tick after the lease time (`sweepTombstones`), for the case where that process died too.

- [ ] **Step 4: Failing tests.**
  - `sweepRescueRoot` lists deep and removes everything: `parts/`, `pages/`, `v0/`, `v1/deposit/`, `samples/`, `tmp/`.
  - `deleteThesisCompletely` on a thesis with a project calls the sweep after the row delete, with the root taken before it.
  - `sweepExpiredDiagnoses` skips a project with a thesis, an entitled one, one with a pending payment, one not yet expired; it sweeps one whose only payment is a Chargily `pending` older than 15 minutes (P-51).
  - `sweepUserRescue` removes a diagnosis-only project's rows and blobs, and a thesis-linked project's rows and blobs while its thesis still exists. Task S20 exposes it for the dashboard's staff delete.
  - The MCP `delete_thesis` on a thesis with a project: the root is swept (spy on `sweepRescueRoot`), another student's thesis → "Thesis not found" and nothing swept.
  - Tombstones: a delete writes one in its transaction; `sweepTombstones` ignores one younger than the lease time, sweeps an older one a second time (an object written after the first sweep is gone) and deletes the row; a project deleted while a fake stage is held and then writing ends with an empty root.

- [ ] **Step 5: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/sweep.test.ts
git commit -m "feat(rescue-run): deleting a thesis or an account sweeps every rescue blob, whichever door it goes through

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/sweep.ts src/lib/thesis-delete.ts src/routes/user.ts src/mcp/tools/thesis.ts src/lib/rescue-run/__tests__/sweep.test.ts
```

---

### Group S-E: the runner core (one engineer, starts after S-D)

### Task S16: runner, tick, renderer, brain factory, failure, cost

**Files:**
- Create: `src/lib/rescue-run/runner.ts`, `src/lib/rescue-run/tick.ts`, `src/lib/rescue-run/kick.ts`, `src/lib/rescue-run/stage-context.ts`, `src/lib/rescue-run/stages/index.ts`, `src/lib/rescue-run/stages/free.ts`, `src/lib/rescue-run/stages/rescue.ts`, `src/lib/rescue-run/stages/side.ts`, `src/lib/rescue-run/renderer.ts`, `src/lib/rescue-run/brain-factory.ts`, `src/lib/rescue-run/failure.ts`, `src/lib/rescue-run/cost.ts`, `src/lib/rescue-run/rules-state.ts`, `src/lib/rescue-run/catalogue.ts`, `src/lib/rescue-run/reconcile.ts`, `src/lib/rescue-run/__tests__/reconcile.test.ts`, `src/lib/rescue-run/__tests__/kick.test.ts`, `src/lib/rescue-run/__tests__/catalogue.test.ts`, `src/lib/rescue-run/__tests__/runner.test.ts`, `src/lib/rescue-run/__tests__/failure.test.ts`, `src/lib/rescue-run/__tests__/cost.test.ts`, `src/lib/rescue-run/__tests__/brain-factory.test.ts`, `src/lib/rescue-run/__tests__/rules-state.test.ts`, `src/lib/rescue-run/__tests__/fakes.ts`
- Modify: `src/routes/tasks.ts`

`rules-state.ts` is one function, used by the stages and the routes alike:
```ts
/** Every layer for resolveRules: the norm profile through rulesFromNormProfile, guide_rules, noteLayer(note_rules), rule_edits. Then the resolved rules and sources. */
export async function resolveProjectRules(project: RescueProjectRow, o: { language: DocLanguage; format: DocFormat }): Promise<ResolvedRules>;
/**
 * D-6's middle rung, for POST /diagnose, once the language is known: a profile of this university in this language whose `discipline` is `generic`, or null.
 * A science or law-humanities profile is never applied by itself (P-70): `catalogueProfileOffer` returns it for screen 4 to ask about.
 */
export async function catalogueProfileFor(universityId: string, language: DocLanguage): Promise<string | null>;
export async function catalogueProfileOffer(universityId: string, language: DocLanguage): Promise<{ id: string; name: string } | null>;
```

`catalogue.ts` is D-4's "from the university catalogue":
```ts
/** The university's name in the thesis's language: name_ar, name_fr, name_en falling back to name_fr. */
export async function universityCoverFields(universityId: string | null, language: DocLanguage): Promise<{ university?: string }>;
/** The logo for the generated cover, through downloadUniversityLogo. PNG and JPEG as they are; anything else through a lazy `sharp` to PNG; null when there is none or it cannot be read. Never throws: a cover with no logo is still a cover. */
export async function loadUniversityLogo(universityId: string | null): Promise<{ bytes: Buffer; ext: "png" | "jpeg" } | null>;
```

`stages/free.ts`, `rescue.ts`, `side.ts` start with every stage throwing `new Error("stage <name> is built in Task S17/S18")`, so the registry compiles. Tests here inject fake stages. `__tests__/fakes.ts` is shared by the stage tests of S17 and S18: `fakeStorage()` (an in-memory `RescueStorage`, refusing a key outside the §1.6 pattern as the real store does), `fakeRenderer(pdfTextPages)` (its `extractText` returns those pages, so no fake bytes ever reach pdf.js), `fakeBrain(answersById)` (counts its calls).

```ts
// stage-context.ts
export class RescueStageError extends Error {
  constructor(readonly code: RescueFailureCode, readonly o: { retriable?: boolean; page?: number | null; detail?: string } = {}) { super(code); }
}
export class LeaseLostError extends Error {}

export interface StageContext {
  job: RescueJobRow;
  project: RescueProjectRow;
  version: RescueVersionRow | null;   // null on side jobs
  storage: RescueStorage;
  renderer: RescueRenderer;
  brain: Brain;
  /** Throttled to one write per 2 s. */
  progress(p: { stepKey?: RescueStepKey; pagesReady?: number; pagesTotal?: number }): void;
  /**
   * A page just landed in storage: `rescue_versions.pages[index] = path`. Fenced by the lease, batched with `progress`,
   * flushed before the stage returns. This is what `GET /versions/:vid/pages` reads while the stage runs (§9.1).
   */
  publishPage(index: number, path: string): void;
  /** Fenced, written at once: what a retry of this stage must find if the process dies before the commit. */
  saveState(patch: Partial<RescueStageState>): Promise<void>;
  /** The row `version.parentId` names; null on v0. */
  parentVersion(): Promise<RescueVersionRow | null>;
  /** Local copies of page images for a brain task; returns absolute paths. */
  localPages(pages: { page: number; storagePath: string }[]): Promise<Map<number, string>>;
  /** Throws LeaseLostError when another process took the job over. */
  checkpoint(): void;
}
export interface StageResult extends StageCommit {}
export type StageFn = (ctx: StageContext) => Promise<StageResult>;
/** `patch` is computed from the project row as it is when the job commits, under `FOR UPDATE` (Task S12 `commitSide`), never from `ctx.project`, which is the copy loaded at claim and a brain wait can make minutes old. */
export type SideFn = (ctx: StageContext) => Promise<{ patch: (fresh: RescueProjectRow) => Partial<typeof rescueProjects.$inferInsert> }>;

export interface StageDef {
  usesWord: boolean;
  run: StageFn;
  /** P-61: the whole stage, Word and brain waits excluded (they have their own limits). Default 15 min + 10 s per page of the version. A hung stage is requeued with an attempt spent. */
  budgetMs?: (r: { pages: number }) => number;
}
export class StageBudgetError extends Error {}
```

```ts
// runner.ts
export async function runClaimed(job: RescueJobRow, owner: string, deps = realDeps): Promise<void> {
  const lease = startHeartbeat(job, owner, deps);          // setInterval(HEARTBEAT_MS); false → lease.lost = true
  const started = Date.now();
  let run: Awaited<ReturnType<typeof deps.load>> = null;
  try {
    if (job.leaseLosses >= MAX_LEASE_LOSSES) {              // P-61: a poison stage that kills or hangs its process must still end
      await deps.failFromJob(job, owner, "stage_crashed", { detail: `lease_losses:${job.leaseLosses}` });
      return;
    }
    if (job.stageAttempts >= MAX_STAGE_ATTEMPTS) {          // attempts are spent by errors only (P-61)
      // P-48: Prove passed, so a pack that cannot be built never holds the thesis back. Screen 15 says so and offers a rebuild.
      if (job.stage === "deposit") { await deps.commit(job, owner, packGaveUp()); return; }
      await deps.failFromJob(job, owner, "stage_crashed", { detail: `attempts:${job.stageAttempts}` });
      return;
    }
    run = await deps.load(job);                            // project + version; project gone → sweep the root, end the job
    if (!run) { await deps.endOrphan(job, owner); return; }
    // P-62: a version that is not `running` (failed by a crashed earlier pass, or done) never runs a stage again, and its
    // commit would set `status='running'` on a row the contract calls immutable.
    if (run.version && run.version.status !== "running") { await deps.endStale(job, owner); return; }
    const def = deps.stages[job.stage];
    const ctx = deps.context(job, owner, run, lease);
    if (def.usesWord && !(await ctx.renderer.available())) {
      await deps.deferForConverter(job, owner);
      return;
    }
    const result = await withBudget(                        // Promise.race: a promise that never settles must not keep renewing the lease for ever
      runWithAiContext(
        // A side job has no version: its payload names the turn, so `snapshotCost` can still count it.
        { feature: `rescue.${job.stage}`, userId: run.project.userId, thesisId: run.project.thesisId ?? undefined, turnId: run.version?.id ?? job.payload.turnId },
        () => def.run(ctx),
      ),
      (def.budgetMs ?? defaultBudgetMs)({ pages: run.pagesHint }),
      () => { lease.stop(); ctx.expire(); },                // after this every ctx write and checkpoint() is refused
      job.stage,
    );
    const committed = await deps.commit(job, owner, withTimings(result, job.stage, started, run));
    if (committed) await deps.afterCommit(job, run, result);
  } catch (e) {
    if (e instanceof LeaseLostError) return;
    if (e instanceof ConverterDownError) { await deps.deferForConverter(job, owner); return; }
    if (e instanceof BrainTimeoutError || e instanceof BrainUnavailableError) { await deps.deferForBrain(job, owner, e); return; }
    if (e instanceof WordRefusedError) { await failSafely(deps, job, owner, "word_refused", { detail: "word refused the file" }); return; }
    if (e instanceof RescueStageError && !e.o.retriable) { await failSafely(deps, job, owner, e.code, e.o); return; }
    // A plain error, a WordTimeoutError and a StageBudgetError all spend an attempt: this is where attempts go.
    await requeue(job, owner, { delayMs: 30_000 * (job.stageAttempts + 1), spendAttempt: true, lastError: safeError(e) });
  } finally {
    lease.stop();
    // P-65: every exit that is not a clean commit (false commit, lost lease, stage error) asks whether the project is still there.
    // `rescue_jobs` cascades with the project, so nothing else would ever notice, and the blobs this pass wrote would stay.
    await deps.sweepIfGone(job, run).catch(logRunnerError);
    deps.kick();
  }
}
```
`packGaveUp()` is `{ next: "publish", statePatch: { deposit: { zipPath: null } }, versionPatch: { depositFiles: { zipName: null, files: [], omitted: [{ kind: "pack", reason: "render-failed" }] } } }`.

`failFromJob` on a pipeline job: `failVersion`, whose effects and the job's ending are one transaction (below). `failSafely` wraps it: if it throws, nothing was half-done, so the job is requeued 60 s later with `lastError` and no attempt spent, and the next pass fails it again; a `failVersion` that throws can no longer loop opening a Support case each time (the case is a follow-up, below). On a side job, which has no version: `read_guide` → `guide_state='failed'`, `parse_note` → `note_state='failed'`, `cover_samples` → `cover.samples='failed'`, then `failJob`, in one transaction. None of those stops the student.

`deferForConverter`: `requeue` with `delayMs:60_000, waitingReason:"converter"` (no attempt spent, none was taken); when `waiting_since` is older than `RESCUE_CONVERTER_WAIT_HOURS` it fails with `converter_unavailable` instead.

`deferForBrain(job, owner, e)` (P-61): `requeue` with `delayMs` 60 s for a timeout and 5 min for "unavailable", `waitingReason:"brain"`, `timeout: true`. When `waiting_since` is older than `RESCUE_BRAIN_WAIT_HOURS` (default 6) a pipeline job fails as `brain_failed` (the refund rules of `failVersion` apply) and a side job goes to its `failed` state, which the app already treats as non-blocking and which releases `POST /diagnose` and the screen 5 CTA. After `MAX_BRAIN_TIMEOUTS` timeouts of one job every further one also spends an attempt, so a single task that always times out cannot bill the model for ever. The Brain contract M7 implements says the same: a wait ends.

`withBudget(promise, ms, onExpire, stage)` is `Promise.race` against a timer that rejects `StageBudgetError(stage)`; on expiry `onExpire` stops the heartbeat and marks the context expired, the hung promise is abandoned (a thread cannot be cancelled; its writes are refused), the stage name is logged and `/runs/summary` counts it. `defaultBudgetMs = ({pages}) => 15 * 60_000 + 10_000 * pages`; the Word stages (`read`, `preview`, `render`, `review_render`, `deposit`) add the sum of their jobs' running deadlines (Task S10) because Word has its own limit.

`sweepIfGone(job, run)`: when `run` is set and the project row no longer exists, `sweepRescueRoot(rescueRoot(userId, projectId))`. `endStale(job, owner)` ends a job whose version is not `running` without running anything. Both are in `realDeps`. `safeError` keeps the error's name and a code, up to 200 characters, and strips anything that is not ASCII, so `last_error` can never hold student text.

**Never hold `withThesisLock` here.** The only lock in the run is inside the `publish` stage (Task S18), around `persistThesisDocx`, never across a brain turn or a conversion.

```ts
// tick.ts
/**
 * One per claim, not per process: a process that claims its own expired job again must not let the old run's heartbeat
 * and commit through. That is the fence §8 relies on.
 */
const newOwner = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let ticking = false;
let tickStartedAt = 0;
let lastSweep = 0;
const TICK_DEADLINE_MS = 120_000;   // a hung query must not leave `ticking` true and stop this process's runner without a word (the pool has no timeout of its own)

export async function rescueTick(): Promise<{ started: number }> {
  if (ticking && Date.now() - tickStartedAt < TICK_DEADLINE_MS) return { started: 0 };
  ticking = true;
  tickStartedAt = Date.now();
  try {
    return await Promise.race([tickBody(), new Promise<{ started: number }>((_, rej) => setTimeout(() => rej(new Error("rescue tick deadline")), TICK_DEADLINE_MS).unref())]);
  } catch (e) {
    logRunnerError(e);
    return { started: 0 };
  } finally {
    ticking = false;
  }
}

async function tickBody(): Promise<{ started: number }> {
    if (!(await rescueEnabled())) return { started: 0 };
    await releaseExpiredJobs();
    void reconcile().catch(logRunnerError);        // once a minute at most, each step on its own: orphan versions, orphan side states, ungranted payments, ready-emails, follow-ups of failures, tombstones (P-62, P-65)
    let started = 0;
    const heavyOwner = newOwner();
    const heavy = await claimJob("heavy", heavyOwner);
    if (heavy) { started++; void runClaimed(heavy, heavyOwner).catch(logRunnerError); }
    const limit = Number(process.env.RESCUE_BRAIN_CONCURRENCY) || 3;
    for (let i = 0; i < limit; i++) {
      const owner = newOwner();
      const job = await claimJob("brain", owner, { brainLimit: limit });
      if (!job) break;
      started++;
      void runClaimed(job, owner).catch(logRunnerError);
    }
    if (Date.now() - lastSweep > 3_600_000) { lastSweep = Date.now(); void sweepExpiredDiagnoses().catch(logRunnerError); }
    return { started };
}
```
```ts
// reconcile.ts — every step is idempotent and wrapped in its own try, so one failing step stops no other (P-62).
export async function reconcile(): Promise<void>;
```
1. **Orphan versions.** A `running` version whose stage has a lane (`STAGE_LANE`), no `queued` or `running` pipeline job, and `updated_at` older than 2 minutes: `enqueuePipeline` it. This is what a crash between the two writes of an older route, or a pooler blip, would have left as 'repairing' for ever; `createVersionWithJob` makes it rare, the reconciler makes it harmless.
2. **Orphan side states.** `note_state='parsing'`, `guide_state='reading'` or `cover.samples='rendering'` with no queued or running job of that kind and `updated_at` older than 2 minutes → `failed`, which the app treats as non-blocking and which frees `POST /diagnose`, `PUT /note` and the screen 5 CTA.
3. `grantUngrantedRescuePayments()` (Task S14).
4. `sweepRescueReadyEmails()` (Task S14).
5. **Follow-ups of failures.** Failed versions finished in the last 7 days whose `failure` lacks `followedUp`: open the Support case when `support_conversation_id IS NULL` (claimed by that `UPDATE … WHERE support_conversation_id IS NULL RETURNING`, so two passes cannot both open one), send the push, `snapshotCost`, then set `failure.followedUp = true`.
6. `sweepTombstones()` (Task S15).
```ts
// kick.ts — routes import this one, statically, at boot. Lazy: the render graph under tick.ts must stay out of the boot graph.
import { AsyncResource } from "node:async_hooks";

/**
 * Made at module load, outside any request. Running inside it leaves the request's AsyncLocalStorage stores behind:
 * a kick from a BYOK student's request starts a tick that can claim ANY student's job, and an ALS follows every
 * promise started under it. `runWithAiContext` replaces the AI context only (P-33).
 */
const outsideAnyRequest = new AsyncResource("rescue-kick");

/** After an enqueue or a commit: the student should not wait for the next cron minute. */
export const kickRunner = (): void => {
  outsideAnyRequest.runInAsyncScope(() => {
    void import("./tick").then((m) => m.rescueTick()).catch((e) => console.error("[rescue] kick failed:", e?.message ?? e));
  });
};
```

`routes/tasks.ts`, inside `/tick` after the existing loop:
```ts
// Rescue v2 shares this one cron: it is also the keep-alive that stops Passenger idling a run out.
kickRunner();
```

```ts
// renderer.ts — RescueRenderer through storage and the Mac's job API.
export function createWordRenderer(storage: RescueStorage, counters: { add(ms: number): void }): RescueRenderer;
```
`toPdf`: sha256 the bytes; upload to `{root}/tmp/{sha}.docx`; `signDownload(path, "document.docx", { ttlSeconds: 6 * 3600, forDocumentServer: true })`, because this URL is for the Mac and not for a phone, and `STORAGE_PUBLIC_HOST` would otherwise send it to whatever LAN address that variable last held; `runWordJob({ key: `pdf:${sha}:${updateFields ? 1 : 0}${attempt > 1 ? `:a${attempt}` : ""}`, op: "pdf", srcUrl, sizeBytes, updateFields, pagesHint })` (`pagesHint` is the page count the caller already knows: the previous version's `pages.length`, or the source's page map; unset on the first read); remove the tmp object in `finally`; count the conversion and its seconds. `rasterize`: the same with `{root}/tmp/{sha}.pdf`, `op:"rasterize"`, `key: `raster:${sha}:${widthPx}:${pages ?? "all"}``, then `unzipPagePngs`. `available`: `isWordConverterReachable`. `extractText`: `extractPdfText`. The Mac's URL is read per conversion through `readSettingFresh("env.WORD_CONVERTER_URL")`, falling back to the environment variable, and passed as `baseUrl` (a new optional field of `WordJobOptions`, Task S10): a tunnel rotation then needs no restart of the app, and no running stage is killed by one (P-61).

```ts
// brain-factory.ts
export class BrainUnavailableError extends Error {}
export function createBrain(runId: string): Brain {
  const mode = process.env.RESCUE_BRAIN ?? "session";
  if (mode === "session") {
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !local) throw new BrainUnavailableError("the session brain runs on localhost only");
    return new SessionBrain({ dir: join(process.env.RESCUE_QUEUE_DIR ?? "lab/tasks", runId) });
  }
  // M7 adds: if (mode === "model") return new ModelBrain(...). It lives in this folder, never in src/lib/rescue/.
  throw new BrainUnavailableError(`no brain for RESCUE_BRAIN=${mode}`);
}
```
On a machine with no brain the job waits, no attempt spent, which is the honest state until M7.

```ts
// failure.ts — invariant 5: no file, a clear message, the money, the original untouched.
export async function failVersion(a: {
  project: RescueProjectRow; version: RescueVersionRow; code: RescueFailureCode;
  stage: RescueStage; page?: number | null; detail?: string;
}): Promise<void>;
```
`failVersion`, in two parts (P-62). Invariant 5's money, the failure and the job's ending are **one transaction**, so a crash between them cannot leave a student reading 'we will return your payment' with no refund row, nor a failed version whose job is still `running` and gets claimed again:
1. In one `db.transaction`: `failure = { code, stage, page, refund, detail }`, `status='failed'`, `finished_at`, nothing published, `doc_path`, `pdf_path` and `deposit_path` null; `refund`: `'due'` only when `version.kind='rescue'`, `project.entitlement='purchase'` and no earlier done rescue, with `markRefundDue(project.purchase_id, code)` inside the same transaction (it takes `tx`), otherwise `'none'` (`not_same_thesis` is always `'none'`); the job `failed` (`failJob(…, tx)`).
2. Follow-ups, each idempotent and re-driven by the reconciler (Task S16, `reconcile` step 5) if the process dies after the commit: for a rescue or re-run except `not_same_thesis`, `openSupportCase` with `topic:"rescue_failure"` and the `supportMessageRefund` text when `refund='due'`, only while `support_conversation_id IS NULL`; `notifyRescue(user, project, "failed")`, except `not_same_thesis`, which the student is looking at; `snapshotCost`; remove `v{n}/work/`; then `failure.followedUp = true`. The source and the parts stay. A `not_same_thesis` failure also carries `reviewable: true` (P-57).

```ts
// cost.ts
export async function snapshotCost(version: RescueVersionRow, brainName: "session" | "model"): Promise<RescueCost>;
```
Tokens and dollars by raw SQL, since `turn_id` is not on the Drizzle table and rows prune at 30 days, which is why this copy exists:
```sql
SELECT COALESCE(SUM(prompt_tokens),0)::int AS tin, COALESCE(SUM(completion_tokens),0)::int AS tout,
       COALESCE(SUM(cost_usd) FILTER (WHERE NOT byok),0)::float AS usd
  FROM ai_usage_log WHERE turn_id = ANY($1::uuid[])
```
`$1` is the version's id plus `settings.costTurnIds`. Who tags what: a start note and the guide run with `payload.turnId` = v0's id, so they count on v0. A supervisor note has no version yet: `PUT /note` makes a fresh uuid, sends it as `payload.turnId` and appends it to `pending_turn_ids`; the re-run that follows copies those into `settings.costTurnIds` and clears the column. `estDzd = Math.round(usd * rescueLimits().usdToDzd)`. Conversions, seconds and bytes come from `stage_state`; `withTimings` adds each stage's `storage.bytesWritten` to `stage_state.storageBytes`, since an instance lasts one process. A query error (a DB without that column) → tokens 0, one log line. Called from `afterCommit` on `done` and from `failVersion`.

`afterCommit`, by `result.next`:
- `await_part_order` → `notifyRescue(…, "partsReady")`; `await_setup` → `"setupReady"`; `await_answers` → `"questionsWaiting"`. Screen 3 and screen 13 say "we'll notify you", so a run that stops for the student must.
- `done`, v0: if not entitled: `maybeSendRescueReadyEmail`, and `notifyRescue(…, "diagnosisReady")`; if the mail was skipped, the tick's `sweepRescueReadyEmails` retries it (P-69).
- `done`, other versions: `notifyRescue(…, "done", { fixes, pages })`, `storage.removeWork(n)`, `storage.pruneDerived(n)` (the previous version's zip and `work/`, P-64), session task folder removed (`rm -rf RESCUE_QUEUE_DIR/<id>`). When this is a first rescue (`kind='rescue'`) and the project's payment is `refund_status='due'` (a staff retry delivered it), `waiveRefund(paymentId, "delivered after a retry")` first (P-63), so the done push is the student's notice.
- `done`, both: `snapshotCost` written to the row.

- [ ] **Step 1: Failing tests** `runner.test.ts`, with `deps` faked and a stage registry of small functions:
  - a stage returning `{ next }` commits and kicks;
  - a stage on `usesWord` with `available()` false → `deferForConverter`, stage not run, no attempt spent;
  - `ConverterDownError` mid-stage → same;
  - `BrainTimeoutError` → requeued 60 s, no attempt spent, `waiting_reason='brain'`, `timeouts + 1`; past `RESCUE_BRAIN_WAIT_HOURS` a pipeline job fails `brain_failed` and a side job goes to `failed`; the fourth timeout of one job spends an attempt;
  - a plain throw, a `WordTimeoutError` and a `StageBudgetError` → requeued with backoff, one attempt spent;
  - **a stage whose promise never settles** (fake timers): `withBudget` rejects, the heartbeat stops, the context refuses further writes, the stage is requeued with an attempt spent, and the heavy slot is free again;
  - `RescueStageError` non-retriable → `failFromJob` with its code and page;
  - `stageAttempts` 3 on claim → `stage_crashed`, stage not run; 3 on `deposit` → commits to `publish` with an empty pack and an omission, no failure (P-48); `leaseLosses` 6 → `stage_crashed`; three lease losses and then a clean run end in `done`;
  - **a job whose version is `failed` or `done`** is ended by `endStale` and runs nothing (a re-claim after a half-finished `failVersion`); `failFromJob` throwing → the job is requeued, no second Support case;
  - lost lease: the stage's `checkpoint()` throws `LeaseLostError` → nothing committed, no failure written;
  - `commit` returning false → no `afterCommit`; and when the project row is gone, `sweepRescueRoot` runs for its root (also after `LeaseLostError` and after a stage error), checked by deleting the project inside a held fake stage;
  - heartbeat interval cleared in every path;
  - the stage runs inside `runWithAiContext` with `turnId` = the version id, and on a side job `payload.turnId` (read `currentAiContext()` inside the fake stage);
  - `afterCommit`: `await_part_order`, `await_setup`, `await_answers` each send their event with the project's route; `done` on v0 and on a re-run send theirs;
  - same process, same job: a re-claim gets a different owner, and the old run's heartbeat and commit return false.
  `kick.test.ts`: `tick` mocked; `kickRunner()` called inside `runWithByok(creds, …)` and inside an AI context: in the mocked `rescueTick`, `currentByok()` is `undefined` and `currentAiContext()` equals `{}` (it returns an empty object when no context is set, never `undefined`).
  `reconcile.test.ts` (local DB): a `running` version on `reset` with no job, 3 minutes old → one job is enqueued, and a second pass enqueues none; `note_state='parsing'` with no job → `failed`; a failed version without `followedUp` gets exactly one Support case over two passes; a paid rescue payment no project names is granted; a hung step does not stop the next (each wrapped).
  `tick`: a `claimJob` that never resolves → after the deadline `ticking` is false and the next tick runs. `S21`'s guard scan skips `__tests__`.
  `catalogue.test.ts`: the university's name by language, `name_fr` when `name_en` is blank; a PNG and a JPEG logo pass as they are; no `logo_path` or a failed download → null, no throw.
  `failure.test.ts` (local DB): a throw injected between each pair of steps of part 1 leaves either nothing or everything (the version, the refund row and the job agree); a throw in part 2 is re-driven once by `reconcile`; a first rescue, purchased → `refund_status='due'`, a conversation, `failure.refund='due'`; a subscriber → `refund:'none'`, a conversation, no payment touched; a re-run failing → `refund:'none'`; `not_same_thesis` → no conversation, no push; `original_paths` objects never removed (spy on `removeObjects`).
  `cost.test.ts`: sums rows by `turn_id`, excludes `byok`; a session version → zeros with conversions filled; a `parse_note` row tagged with v0's id counts on v0, and one tagged with a pending turn id counts on the re-run that adopted it.
  `brain-factory.test.ts`: session with a cloud `DATABASE_URL` → throws; `NODE_ENV=production` → throws; local → `SessionBrain` in the right dir; `model` → throws until M7.
  `rules-state.test.ts`: all four layers reach `resolveRules`; a removed chip's value is gone; `rulesFromNormProfile` is used for the catalogue; no norm profile → the default; `catalogueProfileFor` with a university holding only an Arabic `generic` profile: `ar` finds it, `fr` → null; with only a science or law-humanities profile: `null` in both languages and `catalogueProfileOffer` returns it (an Arabic science thesis at a faculty whose only Arabic profile is law-humanities is diagnosed on the default unless the student says yes, P-70).

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/kick.test.ts src/lib/rescue-run/__tests__/catalogue.test.ts src/lib/rescue-run/__tests__/runner.test.ts src/lib/rescue-run/__tests__/failure.test.ts src/lib/rescue-run/__tests__/cost.test.ts src/lib/rescue-run/__tests__/brain-factory.test.ts src/lib/rescue-run/__tests__/rules-state.test.ts src/lib/rescue-run/__tests__/reconcile.test.ts src/lib/tasks/__tests__/tick-auth.test.ts
git commit -m "feat(rescue-run): the runner: one stage per claim, resumes after any crash, fails honestly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/runner.ts src/lib/rescue-run/tick.ts src/lib/rescue-run/kick.ts src/lib/rescue-run/stage-context.ts src/lib/rescue-run/stages/index.ts src/lib/rescue-run/stages/free.ts src/lib/rescue-run/stages/rescue.ts src/lib/rescue-run/stages/side.ts src/lib/rescue-run/renderer.ts src/lib/rescue-run/brain-factory.ts src/lib/rescue-run/failure.ts src/lib/rescue-run/cost.ts src/lib/rescue-run/rules-state.ts src/lib/rescue-run/catalogue.ts src/lib/rescue-run/reconcile.ts src/routes/tasks.ts src/lib/rescue-run/__tests__/reconcile.test.ts src/lib/rescue-run/__tests__/kick.test.ts src/lib/rescue-run/__tests__/catalogue.test.ts src/lib/rescue-run/__tests__/runner.test.ts src/lib/rescue-run/__tests__/failure.test.ts src/lib/rescue-run/__tests__/cost.test.ts src/lib/rescue-run/__tests__/brain-factory.test.ts src/lib/rescue-run/__tests__/rules-state.test.ts src/lib/rescue-run/__tests__/fakes.ts
```

---

### Group S-F: stages and routes (four engineers at once, starts after S16)

### Task S17: the free stages and the side jobs

**Files:**
- Modify: `src/lib/rescue-run/stages/free.ts`, `src/lib/rescue-run/stages/side.ts`
- Create: `src/lib/rescue-run/__tests__/stages-free.test.ts`, `src/lib/rescue-run/__tests__/stages-side.test.ts`

Each stage reads its inputs from storage, writes its outputs, and returns a `StageResult`. It calls `ctx.checkpoint()` before each long step, so a process that lost its lease stops working. A re-run of a stage overwrites the same paths. Task ids use the version id as `runId` and the project id as `corpusId`, so a re-ask after a restart returns the accepted answer. Session task images are local copies from `ctx.localPages`.

| Stage | Reads | Calls | Writes and returns |
|---|---|---|---|
| `propose_order` | `version.parts[].path` | `proposeOrder` | `parts[]` with `role`, `continuesPrevious`, `openingText`; project `part_order` (proposal); `next: "await_part_order"` |
| `merge` | parts in `project.part_order.order` | `mergeParts`; `refused` or `!ok` → `RescueStageError("merge_refused")` | `v{n}/source.docx`, `source_path`, `stage_state.commentsStripped`; `next: "read"` (v0) or `"source"` (re-run) |
| `read` | `source_path` | `readDocument` with `onPngs` → `storage.putPages`, whose `onDone` calls `ctx.publishPage` and `ctx.progress`; `readInventory` that cannot parse the file → `RescueStageError("not_docx", { retriable: false })` (the route's preflight did not catch it, P-56); more than `rescue.max_blocks` blocks or `rescue.max_pages` pages → `RescueStageError("too_big", { retriable: false })`; `refused` → `RescueStageError("word_refused")` (only what `WordRefusedError` means, P-54); any other `renderError`, `WordTimeoutError` included → a plain throw, which spends an attempt; `ConverterDownError` goes up to the runner; `detectLanguage` | `inventory.json`, `page-map.json`, `source.pdf` as `pdf_path`, `pages`, stats `pagesBefore`; project `language`; `next: "await_setup"` |
| `map` | inventory, page map, notes | `mapDocument` with `note: noteHints(...)`, `prepareImages` through `ctx.localPages`; every block must be covered, else `RescueStageError("brain_failed")` | `map`; project `format`; `next: "diagnose"` |
| `diagnose` | inventory, page map, source, map, norm profile, guide, note, edits | `resolveProjectRules`, `diagnoseDocument` with `fontsDir: defaultFontsDir()`, `buildDiagnosisView` | `diagnosis` = `{ raw, view }`, so the poll never re-reads a page map; project `rules`, `rule_sources`, `format`; `next: "ask"` |
| `ask` | diagnosis `questions`, inventory, notes, `profiles.language` | none when no candidates; else `buildAskTask`, `brain.ask`, `validateAskAnswer` | project `questions` (with page and `topPct` from the page map, and the candidate's `keys`, so one answer reaches every block of its run); `next: "read_cover"` |
| `read_cover` | inventory, map, the image of the cover's first page, thanks block | The cover's page comes from the page map through `coverRegion`'s first block (D-3: a cover need not start at block 0 or on page 1; a blank or basmala page first must not become the brain's cover). `buildReadCoverTask` with cover and thanks text; `brain.ask`; `validateReadCoverAnswer`; then **the keep-or-clean decision (D-5, D-23): load the source on a throwaway engine and run `applyCover(engine, { policy: "clean", fields: readFields, … })` as a dry run on the cover region; `alreadyClean` = `emptiesRemoved`, `paragraphsRestyled` and `pageBreaksRemoved` are all 0; `hasCover` = the region is non-empty; `allowedChoices` / `defaultChoice` follow §1.3's three cases (no cover → `["generated"]`; clean → `["keep","generated"]`, default `keep`; messy → `["clean","generated"]`, default `clean`).** This is CPU in the API's event loop on the brain lane's turn; it is a single pass over the cover's blocks and reads no Word. Then fill what is still empty: `universityCoverFields(project.universityId, language)`, tagged `catalogue`, so the university on screen 4 and the one on the cover agree; then the student's own `profiles` row (`university`, `department`, `academicYear`, `fullName` as the student), tagged `profile`. Screen 4 is behind us by now, so this reads the choice the student made | project `cover` (`CoverState`), `readFields` holding only what the file gave; `next: "preview"` |
| `preview` | source, inventory, map, rules, cover | Reset and Regenerate on the defaults, with `loadUniversityLogo(project.universityId)` for a generated cover, `previewDocument`; a failed regenerate here is **not** a failure of the diagnosis: `preview` stays null, `previewReady:false`, and screen 8 says so. `ConverterDownError` still goes up: a sleeping Mac is a wait, not a missing preview | `v0/preview/*.png`, `preview` = `{ coverPath, chapterPath, beforeChapterPage }`, the last being the v0 page of the chapter heading's source block; `next: "done"` |

`CoverState` is in §1.3. Default preview cover: `defaultChoice`; when it is `generated` and no title was found, the project's title stands in for this watermarked image only.

**Side jobs.**
- `parse_note`, payload `{ noteIndex, turnId }`: resolve current rules with `resolveRules` (language from the project, format `classic` until known), `buildParseNoteTask`, `brain.ask`, `mergeNote`. Commits through `commitSide` with a function over the fresh row: `note_rules` merged for this note only, `note_state='ready'`, **and, when `rules` already exists, `rules` and `rule_sources` recomputed with `resolveProjectRules` from that fresh row**, so a supervisor note that finishes parsing after the project was diagnosed is in the rules the next `POST /reruns` snapshots and `GET /impact` compares. (Resolving them only in the `PUT /rules` handler left a chip on screen whose rule the file never got.) On a thrown brain error after attempts: `note_state='failed'`; the note stays saved and still reaches Map as text, because `noteHints` passes on the raw text of any note it has not parsed.
- `read_guide`, payload `{ contentHash, turnId }`: PDF → `extractPdfText` plus `renderer.rasterize(pdf, { widthPx: 1100, pages: 1..12 })` when the text is under 200 characters; image → that one image. `buildReadGuideTask`, `brain.ask`. A PDF guide is refused beyond 40 pages (P-56), and its first bytes were checked by the route. Writes `guide_rules` from the flat list, `guide_state='read'`, and re-checks conflicts with `recomputeConflicts` from Task S8, committing through `commitSide` with a function that recomputes `note_rules` and the conflicts from the fresh row, so it never wipes the chips a `parse_note` that finished during its brain wait wrote. Failure → `guide_state='failed'`; the rest of the flow continues without it.
- `cover_samples`: for each of `allowedChoices`: `keep` → copy the cover's own first page of v0 (the page `read_cover` found, not page 1 by assumption) to `samples/keep.jpg`, no Word; `clean` → `coverSample` with `readFields`; `generated` → `coverSample` with `fields` and `loadUniversityLogo(project.universityId)`. **`buildCoverXml` throws without a title**, and a thesis with no cover usually has none read: until a title exists the generated sample uses the project's title, as `preview` does (the stand-in appears on the sample only), so the screen's first action never burns three attempts. It commits through `commitSide` with a function that sets only `cover.samples` and the sample paths (`jsonb_set`), never the whole `cover` from the claim-time copy: a supervisor name the student saved while it rendered is kept, and `cover.dirty` (set by `PUT /cover` while `samples='rendering'`) makes the job render once more before it ends, instead of the follow-up POST answering 409 for good. Sets `cover.samples='ready'`; on failure `'failed'`, and screen 12 falls back to labels only.

- [ ] **Step 1: Failing tests** with `__tests__/fakes.ts` (the brain returns canned valid answers), invented text, `assets/thesis-base.docx` as the document:
  - `read` writes pages in order and sets language and `pdf_path`; `merge` returning `refused` → `RescueStageError` non-retriable; `merge` saves `commentsStripped`.
  - **Pages arrive mid-stage.** Hold the third `putPages` upload on a deferred promise: `version.pages` already has the first two and `GET /versions/:vid/pages` would return them, while the marked conversion has not finished. No `onPngs` page → `pagesReady` stays 0 during the conversion.
  - `read`: `ConverterDownError` from `toPdf` goes up, with no failure written; `WordRefusedError` → `word_refused`; a plain error and a `WordTimeoutError` → a plain throw, not `word_refused`; a renamed xlsx that passed the magic bytes → `not_docx`, non-retriable, no attempt burned; a docx with more blocks than the cap → `too_big`.
  - `map` passes the note and asks with stable ids; running it twice with a brain that counts calls → the second run re-asks the same ids.
  - `diagnose` layers rules: catalogue < guide < note < edit, seen in `rule_sources`.
  - `ask` with no candidates makes no brain call; with 7 candidates the validator's limit holds; a run of three blocks is one question whose stored `keys` holds all three.
  - `read_cover`: a value not in the text is rejected and re-asked; a value the file gave stays and is tagged `cover`; with no cover in the file, `university` comes from the catalogue row of `project.universityId` in the thesis's language, tagged `catalogue`, ahead of the profile; other profile values fill only what is missing and are tagged. `readFields` holds only what the file gave.
  - `read_cover` keep-or-clean: three fixtures, no cover → `hasCover:false`, `["generated"]`; a clean cover (empties, restyling and page breaks all 0 on the dry run) → `alreadyClean:true`, `["keep","generated"]`, default `keep`; a messy one → `["clean","generated"]`, default `clean`; a blank first page before the cover → the brain is given the cover's page, not page 1.
  - `cover_samples`: `generated` gets the logo bytes, `clean` gets `readFields`; no title anywhere → the project's title stands in, no throw; a supervisor name saved during the render survives the commit, and the job renders again.
  - `preview`: `toPdf` once; a failed regenerate → `next: "done"`, `preview` null, no throw; `ConverterDownError` goes up.
  - Side: `parse_note` with a guide clash → one conflict; `read_guide` finishing after the note → the conflict appears. **Both races (P-62):** `read_guide` claimed first and `parse_note` finishing during its brain wait → the chips survive `read_guide`'s commit; `parse_note` finishing after `rules` exist → `project.rules` holds the note's value, tagged `note`.
  - No stage imports `withThesisLock` (a text scan of `stages/free.ts` and `stages/side.ts`).

- [ ] **Step 2: Implement. Step 3: Run and commit** the two stage files and two tests.
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/stages-free.test.ts src/lib/rescue-run/__tests__/stages-side.test.ts
git commit -m "feat(rescue-run): the free stages, parse_note, read_guide and the cover samples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/stages/free.ts src/lib/rescue-run/stages/side.ts src/lib/rescue-run/__tests__/stages-free.test.ts src/lib/rescue-run/__tests__/stages-side.test.ts
```

### Task S18: the paid stages and re-runs

**Files:**
- Modify: `src/lib/rescue-run/stages/rescue.ts`
- Create: `src/lib/rescue-run/__tests__/stages-rescue.test.ts`, `src/lib/rescue-run/__tests__/stages-rerun.test.ts`

All settings come from `version.settings`, never from the project: a later edit must not change a running version. `settings` is `{ rules, ruleSources, notes, noteRules, answers, cover, language, format, universityId, costTurnIds }`, written when the version is created. Two things refresh it, each in the same update as the project: `source` writes the rekeyed answers to both, and `POST /versions/:vid/resume` copies the project's answers across, because `await_answers` exists to collect them.

Each stage rebuilds what it needs from storage and `stage_state`, in a process that ran nothing before it. `loadReset`, `loadRegen` and `loadFinal` in this file read the §1.3 work files; `loadFinal` runs `renderer.extractText` on the stored PDF.

| Stage | Reads | Calls | Writes and returns |
|---|---|---|---|
| `source` | see "Re-run source" below | `stripGenerated`, `readInventory`, `diffBlocks`, `checkSameThesis` | `v{n}/source.docx`, `inventory.json`, `map` (the kept part: `{ keyVersion, corpusId, runId, inventoryHash, fingerprint, format, roles }` with `roles` holding the kept blocks only and `inventoryHash` / `fingerprint` of the NEW inventory; everything that reads `map` reads `map.roles`, and `map_changed` fills the rest), `stage_state.changedKeys`, `stage_state.neighbours`, `sourceDocHash`, `source_kind`, stats `keptBlocks`, `changedBlocks`; **answers and stored questions rekeyed (`rekeyAnswers`, `rekeyQuestions`) on the project and in `settings`, in the same update**, so a question answered before a neighbour edit still reads as answered, `POST /resume` does not 409, and H5 can still flip the old answer; `next: "map_changed"` |
| `map_changed` | inventory, `changedKeys`, notes | `mapDocument` with `formatRequired:false`, `only` = `changedKeys`, plus every block whose kept role is a heading when `newHints(settings.noteRules, parent.settings.noteRules)` is not empty, and `note: noteHints(...)`. No page images: `pageOf` is empty, because a new block has no page yet and the last version's pages cannot show it. Nothing to look at → no brain call | full `map` (kept + answered); `next: "ask_changed"` |
| `ask_changed` | low-confidence among `changedKeys` | `unansweredCandidates`, `buildAskTask`; none → no brain call | new `questions` appended to the project with `page: null`, `topPct: null` and their `keys`; `next: "await_answers"` if any, else `"reset"` |
| `reset` | source, inventory, `map`, `settings.answers`, rules | `applyAnswers`, `resetDocument` with `keepTables: rules.tables.keepAsIs` | `work/reset.docx`, `work/reset.json`, `stage_state.reset` (paths); `next: "regenerate"` |
| `regenerate` | `work/reset.docx`, `work/reset.json`, source inventory, rules, cover, fonts, logo | `regenerateDocument` with `onStep` → `ctx.progress`, `defaultFontsDir()`, `cover: { policy, fields, logo }` where `fields` is `readFields` under `clean` (P-50) and `logo` is `loadUniversityLogo(settings.universityId)`; `ok:false` → `RescueStageError("regenerate_failed", { detail: failedStep })`; then `changeEvents` | `work/regenerated.docx`, `work/regen.json` (`RegenWork`: full index maps, moved lists, notes proof, swap table, typography reduced to `i` and `kind`), `stage_state.regenerate` (paths), `final_map` draft; `next: "render"` |
| `render` | `work/regenerated.docx`, `work/regen.json` | `renderFinal` with `onPngs` → `putPages` (`known` = this project's existing pages), each page through `ctx.publishPage`, and `overviewSheets` to `work/overview/`, on a re-run only for the pages `review` will look at. `ConverterDownError` goes up. A `renderError` from a refusal carries on, and Prove fails on it; any other is a plain throw | `thesis.pdf`, `thesis.docx` (TOC numbers filled), `page-map.json`, `final-inventory.json`, `work/render.json` (`RenderWork`), `final_map` with `sourceKey`, `pages`, `stage_state.render` (paths); `next: "review"` |
| `review` | overview sheets, pages, final roles, notes | `reviewRound` from `review/round.ts`, with `studentNote: noteHints(...)` and, on a re-run, `onlyPages` = the positions where `pages` differs from the last done version's plus the pages of changed blocks (Task S9b); none → no brain call | fixes applied and written to a NEW key per round, `work/regenerated.r{round}.docx`, with `stage_state.regenerate.docPath` pointing at it in the same commit (a retry after a crash between the upload and the commit starts from the previous round's file and re-applies the same fixes to the same keys, instead of applying them twice to a file whose blocks already moved); `stage_state.review`, adding this round's `fixes` and `exempt` to what is there, an exemption stored by the key of the block opening its page; `next: "review_render"` if `pagesToRerender` and round < 3, else `"prove"`. A `set_role` fix (M3) corrects `map` and sends `next: "reset"`, counted as a round |
| `review_render` | regenerated | `renderFinal`, `putPages` | as `render`; `next: "review"` |
| `prove` | source, inventory, map, the three work files, cover, rules | `proveAll` from a rebuilt `FinalRender`, with `exemptPages` = this run's `exempt` plus the last done version's `proof.exempt`, each resolved to its page by key, and a key no longer in the final inventory dropped; `proveCover` for `generated` only (P-50); `RESCUE_FORCE_FAIL=prove` outside production forces it; `ok:false` → `RescueStageError("prove_failed", { page: firstFailedPage })` | `proof` with `exempt`, `changes` (`buildChangeReport` from `regen.events`, `stage_state.review.fixes`, `stage_state.commentsStripped`), stats `pagesAfter`, `fixes` (= `changes.total`), `changedPages` (positions where `pages` differs from the last done version's; null on a first rescue); `next: "deposit"` |
| `deposit` | `stage_state.render.docPath`, `pdfPath`, cover fields, `final_map`, rules | `buildDepositPack`, `zipDepositPack`, as below. A form Word refuses is omitted by the pack; any other throw spends an attempt, and past 3 the runner goes on with no pack (P-48). **The zip is sized before it is stored (P-64):** `thesis-pdf` and `thesis-docx` are references to `thesis.pdf` and `thesis.docx`, not copies, and the zip stores them uncompressed; when its size passes `rescue.max_object_mb`, the pack records `omitted: [{ kind: "zip", reason: "zip-too-large" }]`, the files ship one by one, and `pack.state` is `ready` with no rebuild offered (a rebuild could never succeed) | `deposit/{kind}.{ext}` for files that are not the thesis, `deposit.zip` (unless too large), `deposit_files` with display names and `zipName`, `stage_state.deposit`; `next: "publish"` |
| `publish` | `stage_state.render`, `stage_state.deposit` | below | in one `versionPatch`: `doc_path`, `pdf_path`, `deposit_path`, `final_inventory_path`, `final_page_map_path`, `thesis_doc_hash`, `published`; project `thesis_id`; `next: "done"` |

**`deposit`'s page counter.** `pack.ts` turns every error into an omission, so a sleeping Mac would ship a pack with no forms. The stage catches that one first, and `pack.ts` stays as it is:
```ts
let down: unknown = null;
const toPdf = async (d: Buffer) => {
  try { return await ctx.renderer.toPdf(d, { title: "form", updateFields: false }); }
  catch (e) { if (e instanceof ConverterDownError) down = e; throw e; }
};
const pack = await buildDepositPack({ ...input, measurePages: pageCounterFrom(toPdf, { extractText: ctx.renderer.extractText }) });
if (down) throw down;   // the runner defers: no attempt spent, no form lost
```

**A `pack_rebuilt` re-run** (P-48) is created by `POST /reruns` at `stage:"deposit"`, with its parent's output in `copyFrom` and `stage_state: { packOnly: true, render: { … } }` naming the parent's paths. Its `publish` writes nothing to the thesis: `doc_path`, `pdf_path`, `thesis_doc_hash` and `published` are the parent's, and only the pack is new.

**Re-run source (P-28, P-67).** Decided when the version is created, resolved in `source`:
1. An upload → `v{n}/source.docx` from its part or its `merge`; `source_kind='upload'`.
2. Else the thesis's `doc_hash` differs from the last done version's `thesis_doc_hash` → download `theses.doc_path`; `source_kind='working_copy'`.
3. Else the last done version's `source_path`; `source_kind='previous'`.
Case 1 and 2 go through `stripGenerated`. Priors for the diff, newest first: the last done version's `final-inventory.json` + `final_map`, then its `inventory.json` + `map.roles`. **Same-thesis check (P-57), cases 1 and 2:** `checkSameThesis({ anchor: the anchor version's inventory.json (project.anchor_version_id, else v0), known: [the last done version's inventory and final inventory], next: the new inventory, min, traceableMin })`; not ok → `RescueStageError("not_same_thesis", { retriable: false, detail: "anchor:0.31 traceable:0.55" })`, the numbers only; `failVersion` marks it `reviewable`. When the version carries `settings.overrideSameThesis` (a staff retry) the check is skipped and the project's `anchor_version_id` becomes this version. Case 3 skips the check. In case 1, `sourceDocHash` is still recorded as the current `theses.doc_hash`, because publish must know whether the thesis moved while this ran; and when the thesis was also edited in Kwill since the last version, publish pins the snapshot (below).

**`publish`:**
```ts
const state = version.stageState;
const parent = await ctx.parentVersion();
// One patch, so a version is never half-published. These columns stay null until now.
const paths = {
  docPath: state.render!.docPath, pdfPath: state.render!.pdfPath, depositPath: state.deposit?.zipPath ?? null,
  finalInventoryPath: state.render!.finalInventoryPath, finalPageMapPath: state.render!.pageMapPath,
};
// P-48: a pack rebuild never touches the thesis.
if (state.packOnly) return { next: "done", versionPatch: { ...paths, thesisDocHash: parent!.thesisDocHash, published: parent!.published } };
// `doc_path` is null until the patch below: the bytes are where `render` left them.
const finalDocx = await ctx.storage.getBytes(state.render!.docPath);
// One transaction, so a crash leaves no thesis or a bound one, never an orphan. No allowance check (P-14).
const thesisId = project.thesisId ?? await db.transaction(async (tx) => {
  const [locked] = await tx.select({ thesisId: rescueProjects.thesisId }).from(rescueProjects).where(eq(rescueProjects.id, project.id)).for("update");
  if (locked.thesisId) return locked.thesisId;
  const [t] = await tx.insert(theses).values({
    userId: project.userId, title: settings.cover?.fields?.title ?? project.title,
    language: settings.language, docMode: "live-docx", normProfileId: project.normProfileId,
  }).returning({ id: theses.id });
  await tx.update(rescueProjects).set({ thesisId: t.id }).where(eq(rescueProjects.id, project.id));
  return t.id;
});
const outcome = await withThesisLock(thesisId, async () => {
  const [row] = await db.select({ docHash: theses.docHash }).from(theses).where(eq(theses.id, thesisId));
  // A retry must know its own write: the hash saved below, or these very bytes when the heal changed nothing.
  if (row?.docHash && (row.docHash === state.publishDocHash || row.docHash === hashOf(finalDocx))) return { published: true, docHash: row.docHash };
  // A student's newer edit outranks a background job (P-15).
  // A missing hash on a project that has a thesis is not 'safe to overwrite' (P-67): a staff retry once skipped this check and overwrote days of edits.
  const expected = state.sourceDocHash;
  if (row?.docHash && (expected === undefined || row.docHash !== expected)) return { published: false, docHash: row.docHash };
  const h = await persistThesisDocx({
    thesisId, userId: project.userId, buffer: finalDocx,
    extra: { docPath: `${project.userId}/${thesisId}.docx` },
    label: `Rescue v${version.n}`, source: "import",
    // P-67: a chosen file wins over editor edits made since the last version; keep them reachable by undo, as restore does (P-52).
    pinSnapshot: version.sourceKind === "upload" && state.editedSinceLast === true,
  });
  await ctx.saveState({ publishDocHash: h.docHash });
  return { published: true, docHash: h.docHash };
});
return {
  next: "done",
  versionPatch: { ...paths, thesisDocHash: outcome.published ? outcome.docHash : parent?.thesisDocHash ?? null, published: outcome.published },
};
```
`state.editedSinceLast` is set by `source` when the thesis's `doc_hash` moved from the last version's `thesis_doc_hash` while the chosen file was used. Reading `sourceDocHash` happens in `source`, before anything is downloaded for the working copy, never after. This is the only `withThesisLock` in the pipeline, and it wraps one write. `published:false` keeps the old value in `thesis_doc_hash`. One window stays open: a process dying between the persist and `saveState`, on bytes the heal changed, makes the retry read a moved hash and report `published:false` while the thesis already holds the rescue. The version is still in History and nothing is lost, so it is not worth a two-phase write.

- [ ] **Step 1: Failing tests** with `__tests__/fakes.ts`:
  - The full chain with canned brain answers reaches `done`, in order, committing `stage_state` per stage.
  - **Resume, every stage.** Run the chain with each stage in a fresh context, as a recycled process would, holding nothing but fake storage and `stage_state`, on a real `regenerate` with a real `layout.indexMap`: every stage finishes, and `bodyStartPage`, `exemptPages` and `provePageTruth`'s four numbers equal a one-process run's. `stage_state` holds no index map and no block list. Run `regenerate` twice: outputs overwrite, no duplicates.
  - **The change report from a fresh context.** Run `regenerate`, then `prove` in a fresh context: `changes` has a non-empty typography group whose items have pages, and a `review_fixes` count from `stage_state.review`, equal to what the fixes were.
  - **An exemption survives.** A `review` round returns `exempt_page` for a full-page figure; `prove` in a fresh context passes `page-numbers` with that page exempt, also after a `review_render` that moved the page. A re-run that does not review that page keeps the exemption through `proof.exempt`.
  - `ConverterDownError` from `toPdf` at `render` → goes up, Prove never runs. A refusal at `render` → Prove fails on its `render` check. A plain render error → a plain throw.
  - **Pages arrive mid-stage**, as in `read`: `version.pages` grows before `render` returns.
  - **What a note did.** A rule chip for `pagination.noNumberDedication` reaches `regenerate`'s rules and changes the output. A hint chip reaches Map's `studentNote` and Review's. After `removeChip`, neither carries it. A `not-supported` refusal changes nothing and is still shown.
  - **The three cover policies, each with an edited supervisor.** `generated`: the value is on the cover and `proveCover` passes. `keep`: cover blocks byte-equal, the value on the forms, no `proveCover`. `clean`: words unchanged, title found from `readFields`, the value on the forms, no `proveCover`. Prove passes on all three.
  - `settings` snapshot: changing `project.rules` after creation does not change the regenerate input.
  - Prove forced to fail (`RESCUE_FORCE_FAIL=prove`) → `RescueStageError("prove_failed")`, `thesis_id` stays null, `persistThesisDocx` never called, no `doc_path` visible on the DTO.
  - `publish`: reads `stage_state.render.docPath` while `doc_path` is null; first time inserts the thesis with no call to `thesisAllowance` (spy), holds the lock only around persist (spy order: `getBytes` before lock); `doc_path`, `pdf_path`, `deposit_path`, `final_inventory_path` and `final_page_map_path` are all set by its one patch; a retried publish reuses `thesis_id`; a throw between the thesis insert and the bind leaves no thesis row; a moved `doc_hash` → `published:false`, no persist; a retry after a successful persist on a re-run → `published:true`, no second persist.
  - `deposit`, Arabic thesis: stored keys are ASCII (`fakeStorage` refuses others) and `deposit_files` holds the Arabic display names. One form failing is omitted and the stage still moves on. `ConverterDownError` from a form goes up, nothing is written, no attempt spent. A thesis with no abstracts → `no-abstracts`, DTO `pack.state='ready'`. A total failure → the version publishes, `pack.state='missing'`, and `GET /files/deposit` is never offered.
  - A `pack_rebuilt` run: starts at `deposit`, same `doc_path` and `pdf_path` as its parent, a new zip, `persistThesisDocx` never called, the thesis's `doc_hash` unchanged.
  - A text scan: `withThesisLock` appears once in `stages/rescue.ts`, and `brain.ask` / `reviewRound` never inside it.
  Re-runs (`stages-rerun.test.ts`):
  - Source choice: upload > moved hash > last source.
  - An unedited last source → `changedKeys` empty, no brain call on `map_changed` or `ask_changed`.
  - One edited paragraph → exactly one key to Map, with no page images; its neighbours kept; its answer rekeyed if it had one, on the project and in `settings`.
  - A new structure hint and no edit → every heading goes to Map, and body blocks do not.
  - A different document → `not_same_thesis` with `reviewable` and no refund, no attempt spent. The rescued file with a typography fix in every paragraph → not refused. **A + B then B (P-57):** v1 is the thesis A. A re-run uploading A + B with B as long as A stops on `traceable` (about 0.5, under 0.6); with B a quarter of A it passes, and a following re-run of B alone stops on `anchorShare` (0), whatever the last version was; an override retry passes and rebases the anchor.
  - **Rekeyed questions.** A project with an answered question whose block key moves (a neighbour edited) and one new low-confidence block: after `source` the stored question reads as answered under the new key, only the new question is asked, `POST /resume` succeeds, and the old answer can still be flipped.
  - **Editor edits and a chosen file (P-67).** Edit in Kwill, upload a file, run to publish: `source_kind='upload'`, the snapshot taken at publish is pinned and holds the edit, and `undoThesis` brings it back. A retry version created at `source` with no `sourceDocHash` on a project with a thesis → `published:false`, thesis untouched.
  - `deposit` with a 30 MB docx and 35 MB PDF fixture (fake sizes): the zip would pass the object limit → `zip-too-large`, per-kind files present, `pack.state='ready'`, no `pack_rebuilt` offered. `review`: a crash after the upload and before the commit, then a retry → the same fixes land once.
  - A new low-confidence block → `await_answers` and only that question appended, with `page:null`; an already answered key is not asked. The answer saved on the project, after `resume`, changes the role `resetDocument` receives.
  - `stripGenerated` runs for an upload and for an editor copy, not for case 3.

- [ ] **Step 2: Implement. Step 3: Run and commit.**
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run src/lib/rescue-run/__tests__/stages-rescue.test.ts src/lib/rescue-run/__tests__/stages-rerun.test.ts
git commit -m "feat(rescue-run): the paid stages and cheap re-runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/rescue-run/stages/rescue.ts src/lib/rescue-run/__tests__/stages-rescue.test.ts src/lib/rescue-run/__tests__/stages-rerun.test.ts
```

### Task S19: student routes

**Files:**
- Create: `src/routes/rescue-v2.ts`, `src/lib/rescue-run/dto.ts`, `src/__tests__/rescue-v2-routes.test.ts`, `src/lib/rescue-run/__tests__/dto.test.ts`
- Modify: `src/lib/thesis-history.ts` (`persistThesisDocx` gains `pinSnapshot?: boolean`, passed to `snapshotFromState`, which then sets `pinned`). The file already has someone else's hunk: commit only yours (see Rules).
- Modify: `src/routes/thesis/blocks.ts` (P-66): `POST /:id/ops` reads an optional `If-Match` and answers 412 with the same `ifMatchAllows` the docx PUT uses (`src/lib/docx-etag`); absent means today's behaviour, so an older binary still works. Its existing test file gains the 412 case.

One router, §1.4, every row owner-scoped. A small `guard` middleware answers 503 `rescue_disabled` through `rescueEnabled(userId)` (so `rescue.enabled=staff` admits staff accounts only, P-68) on everything except `/config`. `dto.ts` is pure over rows, so it can be tested:

```ts
export function projectDTO(input: {
  project: RescueProjectRow; versions: RescueVersionRow[]; job: RescueJobRow | null;
  purchase: RescueEntitlementDTO["purchase"]; includedByPlan: boolean; forSale: boolean; priceDzd: number | null;
  universityName: string | null; thesisDocHash: string | null; profileUniversityId: string | null;
  profileOffer: { id: string; name: string } | null;   // P-70
}): RescueProjectDTO;
export function progressDTO(version: RescueVersionRow, job: RescueJobRow | null): RescueProgressDTO | null;
export function versionSummaryDTO(v: RescueVersionRow, parent: RescueVersionRow | null): RescueVersionSummaryDTO;
```
- `parts` are sorted by `part_order.order` once an order exists (the proposal included), each with its `order`, so screen 2 shows the brain's proposal and the student can confirm it knowingly. `projectSummaryDTO` sets `canDelete = !(entitlement && !thesisId)`.
- `waiting`: from `job.waiting_reason`; also `"brain"` when the job is on a brain lane and the brain is the session one, so localhost shows the calm line instead of a fake ETA.
- `etaSeconds` (P-39): `null` when `waiting` is set; else `pages * SECONDS_PER_PAGE[stage]`, with `{ read: 1.2, reset: 6, regenerate: 5.5, render: 5, review: 2, review_render: 2, prove: 1, deposit: 0.5, publish: 0.2 }`.
- `resumeOnOpen`: phase in `proposing_order`, `await_part_order`, `reading`, `await_setup`, `understanding`, `diagnosing`, `confirm_rules`, `confirm_questions`, `confirm_cover`, `repairing`, and `updated_at` within 24 h. Not `uploading`: the file is on the phone and a killed app has lost the upload, so the student starts it again from the home card or the drawer.
- `editedInKwill`: `thesisDocHash` differs from the current version's `thesis_doc_hash`.
- `editedBefore`: this version's `stage_state.sourceDocHash` is set and differs from its parent's `thesis_doc_hash`. `changedBlocks` from `stats`. A re-run absorbing the edit keeps the grey step on the timeline this way.
- `pack`, from `deposit_files`: `omitted` minus `pdf-only` and `not-required`; `missing` when `files` is empty; `partial` when `omitted` holds `render-failed` or `missing`; otherwise `ready`, since `no-abstracts` is nothing a rebuild could add. null on the original and while running.
- Note chips: a rule chip's `path` becomes `ruleField` through `RULE_PATHS`.
- `failure`: the newest failed version's; `refund` becomes `'done'` when `purchase.state='refunded'`; `reviewable` and `reviewRequested` from `failure`. A payment with `refund_status='waived'` reads as `paid` in `purchaseState`.
- Never put a signed URL, a block index, `stage_state` or a storage path in a DTO. A test walks the DTO and fails on any key named `i`, `index` (except `parts[].index`), `path`, or on a value matching `/\/rescue\//`.

Key handlers (the rest are direct from §1.4):
```ts
rescueV2Routes.put("/versions/:vid/parts/:index", async (c) => {
  const userId = c.get("userId");
  const found = await getOwnedVersion(userId, c.req.param("vid"));
  if (!found) return c.json({ error: "not found", code: "not_found" }, 404);
  const { version, project } = found;
  if (version.stage !== "await_upload") return c.json({ error: "not uploading", code: "rescue_wrong_stage" }, 409);
  const index = Number(c.req.param("index"));
  const part = (version.parts as PartRow[]).find((p) => p.index === index);
  if (!part) return c.json({ error: "no such part", code: "rescue_invalid_parts" }, 400);
  // P-56. Content-Length is required: `Number(undefined)` is NaN and would skip the pre-read refusal, and arrayBuffer() would read whatever arrives.
  const limits = await uploadLimits();
  const declared = Number(c.req.header("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) return c.json({ error: "length required", code: "length_required" }, 411);
  if (declared > limits.partBytes) return c.json({ error: "too large", code: "rescue_too_large" }, 413);
  // The whole upload is checked against the sizes already STORED for this version plus this part, never the sizes the client declared in POST /projects.
  const stored = (version.parts as PartRow[]).filter((p) => p.uploaded && p.index !== index).reduce((n, p) => n + p.sizeBytes, 0);
  if (stored + declared > limits.totalBytes) return c.json({ error: "too large", code: "rescue_too_large" }, 413);
  if (await projectBytesOver(project)) return c.json({ error: "storage full", code: "rescue_storage_full" }, 409);
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length === 0) return c.json({ error: "empty", code: "rescue_empty" }, 400);
  if (raw.length > limits.partBytes || raw.length > declared + 1024) return c.json({ error: "too large", code: "rescue_too_large" }, 413);
  // The zip's central directory only; nothing is inflated. A renamed xlsx, a zip bomb or a macro file ends here, not as three crashed attempts.
  if (!preflightDocx(raw).ok) return c.json({ error: "not a docx", code: "not_docx" }, 400);
  // … store under storage.partPath(index, version.n), set uploaded + sha256 …
  // Last part: one part → source_path = its path, next `read` (v0) or `source`; several → `propose_order`.
  // v0: original_paths on the project gets every part. kickRunner().
  return c.json(await loadProjectDTO(userId, project.id));
});
```
- `POST /projects`: delete any of this student's projects whose v0 is still on `await_upload`, with `deleteDiagnosisProject` (an upload that never finished; it does NOT give the day's count back). Then check `findFreeFlowInProgress`, the day's `countLedger(userId, "project", 24)` and `countQueuedFreeJobs`, each from `rescueLimits()`; success appends a `project` ledger row (P-59). Title `titleFromFilename(parts[0].filename)` from `src/lib/thesis-parts.ts`. `universityId` from `profiles`. `expiresAt` now + 30 days.
- `DELETE /versions/:vid`: only a re-run on `await_upload`, an upload the student gave up on. Removes the row and any parts. 409 `rescue_wrong_stage` otherwise.
- `PUT /projects/:id/setup`: stores `universityId`, and `normProfileId` only when the body names one; changing the university clears a profile chosen before. It looks nothing up: the language is not known yet, and most students never call this route, because screen 4's CTA just moves on.
- `PUT /projects/:id/guide`: the file name from header `x-file-name` (URL-decoded; the query string is logged by `requestLog`), `Content-Length` required, `preflightGuide` on the first bytes, `countLedger("guide_read")` against `rescue.guides_per_day` (429 `rescue_guide_limit`), then `guide_state='reading'` and `enqueueSide("read_guide", { contentHash, turnId: v0.id })` in one transaction, and a ledger row.
- `PUT /projects/:id/note`: over 2000 characters → 400 `rescue_note_too_long`. Appends to `notes` (unless the text equals the newest note: a retried request appends nothing and starts no job), `note_state='parsing'` and `enqueueSide("parse_note", { noteIndex, turnId })` in one transaction (P-62), a `note_parse` ledger row against `rescue.notes_per_day` (429 `rescue_note_limit`), `kickRunner()`. `turnId` is v0's id on `start`; on `supervisor` a fresh uuid, also appended to `pending_turn_ids` (Task S16, cost). Empty text on `start` → clears `notes` and `note_rules`, `note_state='none'`.
- `PUT /projects/:id/cover` also sets `cover.dirty=true` while `cover.samples='rendering'`, so the job renders again (Task S17). `POST /projects/:id/cover/samples`: not entitled → 402 `rescue_not_entitled` (P-24), the day's `cover_render` ledger rows against `rescue.samples_per_day` (429), the state and the job in one transaction.
- `PUT /projects/:id/answers`: writes the answer through `answerForKeys` on every key of the question's stored `keys`.
- `PUT /projects/:id/rules`: each key through `validateRuleValue`, merged into `rule_edits`; `confirm:true` sets `rules_confirmed_at`. Any change to edits, notes, chips, conflicts or the guide once `rules` exists: recompute `rules` and `rule_sources` with `resolveProjectRules`, so the screen and the next version read the same thing.
- `POST /projects/:id/diagnose`: checks §1.4's 409s. Then D-6's middle rung, the one point every student passes with the language known: when `norm_profile_id` is null and `university_id` is set, `norm_profile_id = catalogueProfileFor(university_id, project.language)`. A French thesis at Biskra, whose only seeded profile is `biskra-ar-law`, therefore gets the Algerian default and not an Arabic font at size 16. **`catalogueProfileFor` applies a profile only when its `discipline` is `generic` (P-70):** an Arabic science thesis at Biskra would otherwise be diagnosed and rebuilt on the law faculty's 16 pt body and 26 pt headings. A discipline-specific profile is offered instead (`setup.profileOffer`, screen 4 asks 'Use the rules of {name}?') and `normProfileId` is set only when the student says yes, through `PUT /setup`. Then it moves v0 to `map` (`status='running'`) and enqueues, in one transaction (`status` update + `enqueuePipeline({ priority: 1 })`).
- `POST /projects/:id/continue`: already entitled → DTO. `grantByPlan` → `granted`: DTO. `allowance_used`: 402 `rescue_allowance_used`. `free_plan`: 402 `rescue_payment_required` with `priceDzd`, `forSale`. Either 402 calls `maybeSendRescueReadyEmail` (rate-limited by `email_sent_at`, P-69), so a subscriber whose plan lapsed before tapping Continue, and an iOS student, are mailed. `currentPlanCode` only (P-16). `includedByPlan` in the DTO is the same read plus the allowance, cached 60 s per user.
- `POST /projects/:id/rescue`: checks entitlement, cover (`generated` with no title or no students → 422 `cover_fields_missing`). Writes `cover.choice = defaultChoice` when unset. `createVersionWithJob({ kind:"rescue", trigger:"first_rescue", parentId: v0.id, stage:"reset", status:"running", settings, copyFrom: { sourcePath: v0.sourcePath, inventoryPath: v0.inventoryPath, map: v0.map }, stageState: { commentsStripped: v0.stageState.commentsStripped }, job: { stage:"reset", priority: 0 } })`: the version and its job are one transaction, so a crash leaves a run or nothing (P-62). Then `kickRunner()`.
- `POST /projects/:id/reruns`: not entitled → 402; `now > rerun_free_until` → 402 `rescue_rerun_expired`; no done rescue yet → 409 `rescue_wrong_stage` (a first rescue is `POST /rescue`); the project's payment `refund_status='due'` → 409 `rescue_refund_due` (P-63); `usedBytes` over `rescue.project_max_mb` → 409 `rescue_storage_full`; a generated cover with no title or no students → 422 `cover_fields_missing` (the same check as `POST /rescue`); `countRerunsToday` over the cap → 429; open note conflict → 409. **The snapshot is resolved fresh:** `settings.rules` and `ruleSources` come from `resolveProjectRules` at this moment, never from the stored `project.rules` a late-finishing `parse_note` may not have reached (C3), and the same call feeds `GET /impact`. Trigger: `upload` → `new_file`; a `supervisor` note newer than the last version → `supervisor_note`, even when the student also edited, since that is what the run is for and `editedBefore` keeps the edit on the timeline; hash moved → `edited_in_kwill`; else `rules_edited`. `upload` creates the version on `await_upload` with `parts` and returns. With `auto`: nothing changed but the deposit rule, or the last version's `pack.state` is not `ready` and nothing else changed → `trigger:"pack_rebuilt"`, as Task S18 describes; otherwise it starts at `source`. The version and its job are written by `createVersionWithJob` (an `upload` re-run has no job until its last part). `settings.costTurnIds` takes `pending_turn_ids`, and the column is cleared in the same update.
- `POST /versions/:vid/resume`: `settings.answers = project.answers` and the job, in one update, then `kickRunner()`.
- `POST /versions/:vid/restore`, inside `withThesisLock` (P-60): download the target's `doc_path`, `persistThesisDocx({ label: "Restore v…", source: "restore", pinSnapshot: editedInKwill })`, so edits made since the last version outlive the undo ring (P-52); then in one transaction `copyVersionRow(target, { thesisDocHash })` (a full copy: every `*_path`, `pages`, `map`, `final_map`, `changes`, `stats`, `proof`, `deposit_*`, `diagnosis`, `preview` and the target's `settings`; `kind:"restore"`, `trigger:"restored"`, `status:"done"`, `stage:"done"`, `parent_id` = target, `published:true`) **and the project's standing choices reset to the target's snapshot**: `rule_edits` from `settings`' edits, `answers`, `cover`, the notes' chips (`note_rules`), `rules`, `rule_sources`, so the next re-run does not silently undo the restore and H5 shows what the restored version really used. A retried request (lost response) finds the newest version already a restore of this target with a matching thesis hash and returns it. The lock's 30-s timeout → 503 `rescue_locked`. Nothing is copied in storage.
- `GET /versions/:vid/files/:kind`: `pdf` → `pdfPath`; `docx` → `docPath`, or `sourcePath` on the original; `deposit` → `depositPath`, 404 `rescue_no_file` when null; `part` with `?index=` → that entry of `version.parts`, its own filename, the original or an upload re-run (P-44). Neutral file names from `DEPOSIT_FILE_NAMES` by the project's language, never a student's name; the zip's from `deposit_files.zipName`. They reach the student as the signed URL's `download` filename, never as a storage key. `format`: `pdf`, `docx`, `zip`; `title`: the same file name.
- `GET /versions/:a/compare/:b`: both ids through `getOwnedVersion`, and the two must share a `project_id`, else 404 (an implementation that checked `:a` alone would sign URLs for another student's pages). Align by page index, keep positions where the two paths differ, including extra pages on either side; sign only the slice asked for; `changes` = `compareChanges(earlier.changes, later.changes, the slice's pages)`.
- `GET /projects/:id/impact`, on the server so it survives leaving H5 and returning: against the last done version's `settings`, `edits` = fields where `flatFromRules` differs, `answerKeys` = answers that differ, `coverChanged` from `choice` and `fields`, `newNotes` = notes added since. `final_map` and `page-map.json` place them through `estimateImpact`, an edited block through `diffBlocks().neighbours`. With an edited thesis: download, `stripGenerated`, `readInventory`, `diffBlocks` for `changedKeys`, `neighbours` and `changedBlocks`, kept in an in-process LRU of 20 entries keyed by `thesisId:docHash`, because parsing a thesis takes seconds and the answer never changes for one hash.
- `POST /versions/:vid/review-request` (P-57): only on a version that failed `not_same_thesis`; opens one Support case (`topic:"rescue_review"`, the two numbers from `failure.detail`, no student text) and sets `failure.reviewRequested`; a second call returns the DTO unchanged.
- `DELETE /projects/:id`: 409 `rescue_has_thesis`, `rescue_payment_pending`, and 409 `rescue_entitled` for an entitled project with no thesis (P-65); otherwise `deleteDiagnosisProject`, which writes the tombstone with the delete.
- `GET /projects/:id/versions`, `edited.changedBlocks`: reads that LRU; `null` when not measured yet, and the timeline then shows `timeline.edited` without a count.

- [ ] **Step 1: Failing route tests** in the style of `src/__tests__/docx-put-route.test.ts`: a `Hono` with `userId` set by a stub middleware, `../lib/rescue-run/repo`, `jobs`, `storage`, `entitlement`, `config` mocked. Every row of §1.4 has at least one test for its success code and one per listed error. Named cases:
  - another student's project → 404 on every `:id` and `:vid` route;
  - `rescue.enabled` unset → 503 everywhere except `/config`;
  - upload: wrong magic, empty, too large by header, too large by body, wrong stage; the last part enqueues exactly once; **no `Content-Length` → 411; twelve 18 MB parts against a 20 MB total, each under the part limit and each declaring a small size in `POST /projects` → refused at the part that passes the stored total; a renamed xlsx, a macro file and a zip bomb (the test's tiny caps) → 400 `not_docx` with nothing stored; a project over `rescue.project_max_mb` → 409 `rescue_storage_full`** (`usedBytes` of the fake storage);
  - four projects in a day → 429, **also when the first three were deleted in between** (the ledger counts them, P-59); a free flow in progress → 409 with `projectId`; the eleventh note parse of a day → 429; the sixth guide → 429; `POST /cover/samples` on a project not entitled → 402; the guide's file name arrives in `x-file-name` and appears in no log line (spy on the request log); the same note text twice → one job;
  - `diagnose` while a note parses → 409 `note_parsing`; with an open conflict → 409 `note_conflict`;
  - D-6's main path: prefilled university with a `generic` profile, no `PUT /setup`, `POST /diagnose` → `norm_profile_id` set and, after the `diagnose` stage, `rule_sources` shows `catalogue`; a French thesis at a university with only an Arabic profile → null, the default; **an Arabic science thesis at a university whose only Arabic profile is law-humanities → `norm_profile_id` null, `setup.profileOffer` names it, and `PUT /setup` with its id applies it (P-70)**;
  - `answers` on a question with three keys writes all three; `resume` copies them into `settings.answers`;
  - `continue`: free plan → 402 with price and a ready-email; monthly plan → entitled; **a monthly account's third project in 30 days (the first two deleted) → 402 `rescue_allowance_used` (P-58)**;
  - `rescue` not entitled → 402; second call while running → 409; cover missing → 422 with `missing`; a crash between the version insert and the job insert leaves neither (`createVersionWithJob`);
  - `reruns` past the window → 402; over the cap → 429; with no done rescue → 409 `rescue_wrong_stage`; while the payment is `due` → 409 `rescue_refund_due`; a generated cover with its title cleared → 422 `cover_fields_missing`; a supervisor note whose `parse_note` finished after `rules` existed: the version's `settings.rules` holds the note's value (resolved fresh, C3);
  - `restore` of the original → 400; while running → 409; a done version → 201 and a new row sharing paths **and every column of the target** (`source_path`, `inventory_path`, `page_map_path`, `final_*`, `proof`, `settings`). Restore v1 after a v2 with different rules, then `reruns` with `source:"auto"` and no file: it reaches `done`, from v1's source, with v1's rules, the diff has priors, `GET /impact` compares against v1's snapshot (not an empty `{}`), a `pack_rebuilt` run has its paths and `proof.exempt` survives (P-60). The project's `rule_edits`, answers and cover equal v1's after the restore. A lost-response retry returns the same row, not a second one. After a restore and then a re-run, every object every earlier version names still exists (§11: nothing deleted).
  - `restore` after an editor edit: `pinSnapshot` true; the pinned snapshot holds the edit and `undoThesis` brings it back;
  - `compare` of two versions with one shared page → that page absent; `changes` holds only what the later one did on the differing pages; **`:a` mine and `:b` another student's → 404; `:a` and `:b` in two of my projects → 404**;
  - `DELETE /projects/:id` on an entitled project with no thesis → 409 `rescue_entitled`; on a diagnosis-only one → rows and tombstone gone; `canDelete` agrees in the summary;
  - `POST /versions/:vid/review-request` on a `not_same_thesis` failure → one Support case, a second call none; on any other version → 409;
  - `POST /api/thesis/:id/ops` with a stale `If-Match` after a publish → 412 and nothing applied; without the header → as today;
  - `files/deposit` on the original → 404; `files/part?index=1` on a split original → that part's own bytes and filename; an out-of-range index → 404;
  - `impact`: a note and nothing else → `note`; a deposit change alone → `pack`; rules saved, leave, ask again → the same answer, never `none`; `reruns` after `pack` → `trigger:"pack_rebuilt"`, stage `deposit`;
  - a re-run where the student edited and also left a supervisor note → `supervisor_note`, and its summary has `editedBefore`.
  DTO tests: `parts` arrive sorted by `order` with the proposal; `canDelete`; phase from rows via `computePhase`, including a purchase made after a failed first rescue → a `confirm_*` phase; `resumeOnOpen` at 23 h and 25 h; `etaSeconds` null while waiting; `refund:'done'` after a refund; `pack` for a full pack, `no-abstracts`, a failed form, none at all, and `pdf-only`; the no-machinery walk above.

- [ ] **Step 2: Implement. Step 3: Run and commit** `src/routes/rescue-v2.ts`, `src/lib/rescue-run/dto.ts`, your hunk of `src/lib/thesis-history.ts` and both tests. Message: `feat(rescue-v2): the student API`.

### Task S20: staff routes

**Files:**
- Create: `src/routes/admin-rescue.ts`, `src/__tests__/admin-rescue.test.ts`

As in `src/routes/admin-manual-payments.ts`: `adminRescueRoutes.use("*", requireAdmin)`.

- `GET /settings`, `PUT /settings`: through `readSettingFresh` and `setSetting`. `priceDzd`: integer 1..100000, or `null` which `deleteSetting`s the key. `enabled`: `"off"` (deletes the key), `"staff"` or `"on"` (`"1"`) (P-68). `freeDiagnosesPerDay` 1..50. `rerunWindowDays` 1..1825. `planRescuesPer30d` 0..20 (P-58).
- `GET /runs`, one `pool.query`, because PostgREST refuses aggregates (PGRST123) and this needs a join:
```sql
SELECT v.id AS version_id, v.project_id, v.n, v.kind, v.trigger, v.status, v.stage, v.cost, v.failure,
       v.support_conversation_id, v.created_at, v.finished_at, COALESCE(array_length(v.pages,1),0) AS pages,
       p.user_id, p.thesis_id, p.title, p.entitlement,
       pr.email AS user_email, pay.id AS payment_id, pay.amount_dzd, pay.refund_status, j.waiting_reason,
       count(*) OVER () AS total
  FROM rescue_versions v
  JOIN rescue_projects p ON p.id = v.project_id
  LEFT JOIN profiles pr ON pr.id = p.user_id
  -- By the payment's own link, a due one first: `purchase_id` misses a double payment.
  LEFT JOIN LATERAL (
    SELECT id, amount_dzd, refund_status FROM payments
     WHERE rescue_project_id = p.id
     ORDER BY (refund_status = 'due') DESC NULLS LAST, created_at DESC
     LIMIT 1
  ) pay ON true
  LEFT JOIN rescue_jobs j ON j.version_id = v.id AND j.status IN ('queued','running')
 WHERE ($1::text IS NULL
        OR ($1 = 'waiting' AND j.waiting_reason IS NOT NULL)
        OR ($1 = 'refund_due' AND pay.refund_status = 'due')
        OR ($1 NOT IN ('waiting','refund_due') AND v.status = $1))
   AND ($2::text IS NULL OR pr.email ILIKE '%' || $2 || '%')
 ORDER BY v.created_at DESC
 LIMIT $3 OFFSET $4
```
  Escape `%`, `_`, `\` in `q`. `limit` is capped at 100. No student text in the response except `title` and email, which staff already see elsewhere.
- `GET /refunds?status=due`: `SELECT … FROM payments pay LEFT JOIN rescue_projects p ON p.id = pay.rescue_project_id LEFT JOIN profiles pr ON pr.id = pay.user_id WHERE pay.kind = 'rescue' AND pay.refund_status = $1 ORDER BY pay.created_at`. It reads `payments` first on purpose: a payment whose project is gone has no run to show on, and the money is still owed (§8).
- `GET /runs/summary?days=7`: counts by status; `refundDue` from `payments`, the same reading as `/refunds`; `avgCostFirstDzd`, `avgCostRerunDzd` from `cost->>'estDzd'` (NULL when no row has it, which is every row until M7); average seconds; `wordReachable` from `isWordConverterReachable()`; `wordCanary` from the service's `/status` (`lastCanary`, `restarts24h`), null when the call fails (P-54); `stuck` = running versions with no job for over 2 minutes plus jobs with `lease_losses >= 2`; `oldestHeavySeconds` = the oldest running heavy job's age; `storageBytes` = the sum of `RescueStorage.usedBytes()` over projects touched in the period (a per-project figure is on `RescueRunRow`). Exclude `original` versions from the averages.
- `POST /payments/:id/refunded`: `markRefunded(…, { confirmDelivered })`, then `notifyRescue(…, "refundDone")` when it has a project; 409 `not_refund_due`; 409 `rescue_already_delivered` when a done rescue exists and `confirmDelivered` is not true (P-63).
- `POST /users/:id/rescue-sweep`: `sweepUserRescue(id)`, for the dashboard's staff delete (Task D4).
- `POST /versions/:id/retry`: the version must be `failed`, with no active run on the project.
  - A failed v0, which has no place on the timeline yet (P-43): append its `failure` and `stageSeconds` to `stage_state.priorFailures`, then set it back to `status='running'`, `failure=NULL`, `failure_acked_at=NULL`, same `stage`; enqueue priority 0.
  - A failed rescue or re-run: `createVersionWithJob({ kind:"rerun", trigger:"staff_retry", parentId: failed.id, settings: failed.settings, stage, status:"running", copyFrom, job })`. **A failed first rescue (`kind='rescue'`, nothing delivered before) restarts at `reset` on its own input, as before. A failed re-run restarts at `source` (P-67)**, so the working-copy hash and the source are read fresh and a newer student edit outranks the retry (starting at `reset` from `failed.sourcePath` left `sourceDocHash` unset and overwrote days of edits); `stageState` is then empty and publish refuses to overwrite without a hash. A `not_same_thesis` failure takes `overrideSameThesis: true`, which sets `settings.overrideSameThesis` and rebases the anchor in `source` (P-57); without the flag a retry of it answers 409 `rescue_needs_override`.
  - If the project's entitlement was refunded: `entitlement='staff'`, `entitled_at=now()`, a `grant_staff` ledger row. When the payment is still `due` and the retry delivers, `afterCommit` waives it (P-63). Enqueue priority 0, kick.

- [ ] **Step 1: Failing tests**: 403 with no token; price validation (0, -1, 1.5, "abc", 100001 refused; 2500 saved; `null` deleted); runs filter values reach the SQL params (`pool` mocked); `q` escaped; `limit` capped; refund on a non-due payment → 409; retry on a running version → 409; retry of a refunded project sets `staff`; retry of a failed v0 keeps the earlier failure in `priorFailures`; **retry of a failed re-run starts at `source` and, after the student edited in the meantime, leaves the edit in place; retry of `not_same_thesis` needs `overrideSameThesis` and rebases the anchor; a retry that delivers a `due` first rescue leaves `refund_status='waived'` and `markRefunded` then answers 409 unless `confirmDelivered`.** A local-DB case: a double payment and a payment whose project was deleted are both on `/refunds` and can be marked; after marking, the run shows `refundStatus:'done'` and its amount; a run with no payment shows none; `rescue-sweep` removes a student's rows and calls `sweepUserRescue`.

- [ ] **Step 2: Implement. Step 3: Run and commit** both files. Message: `feat(admin): rescue settings, runs, refund mark and retry`.

---

### Group S-G: wiring and proof (one engineer, in this order, after S-F)

### Task S21: mount, boot, guard, docs

**Files:**
- Modify: `src/index.ts`, `DEPLOY_OCTENIUM.md`, `scripts/rescue-lab/README.md`, `src/lib/rescue-run/stages/index.ts` (only if a name moved), and, in `~/kwill`, `docs/superpowers/specs/2026-11-02-rescue-v2-design.md` (its own commit there)
- Create: `src/lib/rescue-run/__tests__/guard.test.ts`, `src/__tests__/rescue-boot-graph.test.ts`

- [ ] **Step 1: Mount.** `app.route("/api/rescue-v2", rescueV2Routes);` after `/api/rescue`. `app.route("/admin/rescue", adminRescueRoutes);` before `app.route("/admin", adminLogRoutes)`.

- [ ] **Step 2: Failing boot-graph test.** esbuild `bundle:true, metafile:true, packages:"external"` from `src/routes/rescue-v2.ts`, `src/routes/admin-rescue.ts`, `src/routes/payment.ts`, `src/routes/pay.ts`, as the guard does. Assert: among `metafile.inputs[*].imports`, none with `kind: "import-statement"` has `path` `sharp` or `@resvg/resvg-js` (a dynamic `import()` shows as `dynamic-import` and is fine). Files already reached by other routes today that import them statically must be fixed if the test finds them.

- [ ] **Step 3: Failing guard test** `guard.test.ts`, a text scan of `src/lib/rescue-run/**` (`__tests__` aside) and `src/routes/rescue-v2.ts`: no import of `lib/ai/` except `lib/ai/usage-log`; no `featureClient`, `getProvider`, `openai`, `@openrouter/sdk`. M7 relaxes it for `rescue-run/model-brain.ts` only. A transitive check is not possible here, because `persistThesisDocx` reaches RAG embeddings by design (P-71).

- [ ] **Step 4: Docs.** In `DEPLOY_OCTENIUM.md`, replace the cron block with the safe one and say why:
```bash
/usr/bin/flock -n /home/hccfdkmc/modakerati/tmp/tick.lock \
  curl -fsS --max-time 20 -X POST https://modakerati.greenpedal.net/api/tasks/tick \
  -H "x-tasks-secret: $TASKS_TICK_SECRET" > /dev/null 2>&1
```
"Unlocked overlapping crons wedged this account at 98/100 processes; `flock -n` plus `--max-time 20` makes that impossible. Rescue v2 and scheduled tasks share this one cron." **Amend the spec in the repo `~/kwill`, one dated entry each in the way D-22 to D-27 were added**, because this plan departs from it in writing and the spec must not say the opposite: P-26 (text mini pages, §9.2 #2), P-27 (the device recogniser, §6), P-29 (screen 11 on a re-run), P-34 (the 30-day TTL, §7), P-41 (and rewrite §11's 'redoes only changed pages' row and §7's 'cost scales with what changed'), P-42 (indices in work files, §7), P-44 (original never restorable, D-18), P-46 (D-8's narrower typography), P-47 (§4's one structure check), P-57 (the anchor), P-58 and P-59 (limits, §1 pricing), P-64 (the upload limit and pruning, §7). Each entry names its P-number and the reason in one line.

In `scripts/rescue-lab/README.md`: the CLI and the server share `src/lib/rescue/pipeline/`; the CLI still uses the sync converter endpoints; session tasks from the running server land in `lab/tasks/<versionId>/`, listed by `cli.ts pending`. The README also says the lab and the walks may use :8093 beside production's :8092, because `scripts/word-lock.mjs` serialises every conversion on the Mac.

- [ ] **Step 5: Run the full gate and commit.**
```bash
npx tsc --noEmit
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres npx vitest run --testTimeout=60000    # S0's database, S0's guard: never the cloud (P-37)
git commit -m "feat(rescue-v2): mount the routes; boot and guard tests; the safe cron

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/index.ts DEPLOY_OCTENIUM.md scripts/rescue-lab/README.md src/lib/rescue-run/__tests__/guard.test.ts src/__tests__/rescue-boot-graph.test.ts
```

### Task S22: the milestone proof on localhost

**Files:**
- Create: `scripts/rescue-e2e/run.ts`, `scripts/rescue-e2e/auto-answer.ts`, `scripts/rescue-e2e/stub-converter.ts`, `scripts/rescue-e2e/README.md`, `scripts/rescue-lab/replay-rerun.ts`

These live outside `scripts/rescue-lab/` so the guard stays true of the lab (they use the running server through HTTP, and `auto-answer` touches no DB).

`auto-answer.ts <versionId> <tNN>` answers session tasks in `lab/tasks/<versionId>/` from the corpus's own gold. `order_parts` from the corpus's `assembled/assembly.json` (`order`, `roles`, `continuesPrevious`), or a split run would hang at `proposing_order`. `map` by key from `gold/map.json`; an unknown key (a re-run's edit) → role `body`, confidence 0.9. `ask` → zero questions, or one when `--ask` is passed. `read_cover` → empty fields. `review` → no issues. It writes `.answer.json.tmp`, renames, and prints counts only. It exists so this proof repeats without Claude; the real walk (§6) uses Claude.

`run.ts <tNN>`, against `http://localhost:3000` with S0's `rescue-student@kwill.local`:
1. `PUT` settings: `rescue.enabled=1`, `rescue.price_dzd=2500`, `rescue.free_diagnoses_per_day=50` (through `/admin/rescue/settings`): each pass makes at least two projects, for two theses, repeated while defects are fixed, and the walks add more, so the default of 3 a day would stop a repeat run at 429. The server runs with `RAG_INDEXING=off` (P-71).
2. Upload the thesis; wait for `await_setup`; `POST /diagnose`; wait for `diagnosed`. Assert: `summary` present, `previewReady` true, at most 5 questions, 3 Word conversions on v0.
3. Approve a manual payment through the admin route, or `UPDATE … entitlement='staff'` when no proof image is at hand; `PUT /rules {confirm:true}`; answer questions; **when `cover.missing` is not empty (a thesis with no cover blocks gives `read_cover` empty fields and only the `generated` choice, and the test account has no name or university), `PUT /cover` with an invented title and an invented student before the next call; assert that title is on the generated cover through `proveCover`**; `POST /rescue`; wait for `done`.
4. Assert: `proof.ok`, `thesisId` set, thesis doc exists, `cost.wordConversions` recorded, page images present, `GET /files/*` signed and fetchable.
5. **Re-run cheap, nothing asked twice.** Edit one paragraph in a copy of the rescued file with the engine, upload it as a re-run. Count: files `map-*.task.json` under the new version id; blocks across them ≤ 3; no `ask` question whose key was answered. Assert `proof.ok`, pages within ±1, `changedPages` small, `stats.keptBlocks` ≥ 95% of blocks. P-41's target, with nothing else in Word's queue: the re-run's `stageSeconds` come to at most 1.5 × 6 s per page, and a re-run with nothing changed spends zero brain tasks.
6. **Idempotence.** Re-run with the rescued file unedited: no map task at all, same page count, no second set of dividers (`generatedDividerStarts` count equal), no doubled captions.
7. **Crash resume.** During a re-run on `render`, `kill -9` the server and restart it. The dead process's lease stays valid for up to 5 minutes, so `run.ts` calls the tick every 30 s, up to 7 minutes, until the job is claimed again: `curl -X POST localhost:3000/api/tasks/tick -H "x-tasks-secret: $TASKS_TICK_SECRET"`. Assert: finishes `done`, `lease_losses` was 1 and `stage_attempts` 0 on that stage (a recycle is not an attempt, P-61), no duplicate version.
8. **History.** Restore v1: a new top version, same `pdf_path`, thesis `doc_hash` equals v1's published copy after heal. Compare v1 and the restored one: `total=0`. Compare v1 and the edited re-run: only differing pages. `listObjectsDeep(root)` still holds every object every earlier version names. Edit in Kwill, restore, then undo in the editor: the edit is back (P-52).
9. **Honest failure.** Restart with `RESCUE_FORCE_FAIL=prove`; a new project through to `POST /rescue`: `phase='failed'`, `failure.code='prove_failed'`, `refund:'due'` for a purchase, a `support_conversations` row, `thesis_id` null, the original part's hash unchanged, no `doc_path`.
10. **Delete.** `DELETE /api/thesis/:id`: rows gone, `listObjectsDeep(root)` empty. Also while a re-run is on `render`: delete the thesis, wait for the stage to end, assert the root is empty after the tombstone sweep (P-65).
11. **Word not working is not the student's file (P-54).** Point the server at a stub converter that answers `wedged: …` for the first N polls (`scripts/rescue-e2e/stub-converter.ts`, started by `run.ts`), run a re-run: it waits with `waiting_reason='converter'`, spends no attempt, and finishes `done` when the stub recovers; the same with `timeout:` twice → `stage_crashed`, never `word_refused`. A stub answering `file:` twice → `word_refused`.
12. **Hostile files (P-55, P-56).** Upload, as re-runs of a rescued thesis: an invented docx carrying an INCLUDETEXT field, one with `w:updateFields`, one with a remote `attachedTemplate`, and one with `vbaProject.bin` (built by S10's sanitize fixtures): each either completes with the visible text unchanged and no dialog on the Mac, or is refused at upload; a renamed xlsx → 400 `not_docx`; a zip bomb at the test caps → refused before a byte is stored; nothing leaves the Mac's disk after the jobs end.

Run it for `t03` (Arabic, single file, small) and `t19` (split). t19 has an answer key and an assembly that agree. t17 has no `gold/map.json`, and t18's key matches an order M3 says is wrong until it is re-assembled. Print a table of numbers only. Update `SECONDS_PER_PAGE` in `dto.ts` from the measured `stageSeconds`.

**`scripts/rescue-lab/replay-rerun.ts <tNN>|all`, the corpus's re-run test (§11).** Beside M3's `replay.ts`, private corpus, this Mac only, no brain. For each thesis with an answer key: take its accepted output, add one invented sentence to a body paragraph near the middle with the engine, `stripGenerated`, `diffBlocks` against the priors, give changed blocks role `body`, then `resetDocument`, `regenerateDocument`, `renderFinal`, `proveAll`. Passes when: at most 3 keys changed, no candidate that was answered before comes back, Prove is green, pages within ±1, and an unedited run changes no key at all. Prints numbers only.

- [ ] **Step 0: The environment.** The private instance on :8093 runs code from before Task S10, so `POST /jobs` answers 404. Restart it on the new code, in a shell with `WORD_JOBS_INSECURE=1` (no secret on a lab instance: the service refuses `/jobs` otherwise). The instances share a work dir and the host-wide lock (`scripts/word-lock.mjs`) serialises them, so production's :8092 may stay up and the run only waits its turn; M3's fix loop is finished by Gate 0 (P-53) and is not using Word:
```bash
pkill -f "word-convert-service.mjs 8093"; cd ~/kwill-server && WORD_JOBS_INSECURE=1 nohup node scripts/word-convert-service.mjs 8093 >/tmp/word-8093.log 2>&1 &
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8093/jobs -d '{}'    # 400, never 404
```

- [ ] **Step 1: Write the scripts and the README.** The README holds the exact startup:
```bash
cd ~/kwill-server && ./scripts/rescue-local-db.sh    # Task S0
set -a; . ./.env.local.bak; set +a      # the local values; dotenv never overwrites what is already set
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
export SUPABASE_URL=http://127.0.0.1:54331
export STORAGE_PUBLIC_HOST=$(ipconfig getifaddr en0)     # .env.local.bak's is an old network's; phones fetch page images through it
export WORD_CONVERTER_URL=http://localhost:8093 RESCUE_BRAIN=session TASKS_TICK_SECRET=local ADMIN_API_TOKEN=local NODE_ENV=development RAG_INDEXING=off RESCUE_BRAIN_WAIT_HOURS=48    # the session brain is a person; the 6 h default would fail a slow walk
npx tsx watch src/index.ts
```
`.env.local.bak` dates from August: compare its service key with `supabase status`, and never start this with a shell that skipped those `export`s, because plain `.env` is the cloud (P-37). The session brain refuses to run if it is.

- [ ] **Step 2: Run on t03, fix what it finds.** Each defect becomes a regression test beside the module it belongs to, in the owner task's files. **M4 is not done until steps 2-12 pass on t03 and on t19.**

- [ ] **Step 3: Run `replay.ts all` and `replay-rerun.ts all`** (P-53) on every thesis holding an answer key at that moment; the first must equal `/tmp/corpus-before-s9a.txt` from S9a's Step 0 (counts only) unless a defect fix explains the difference, the second is this plan's. They take hours, and Word's lock lets production go on meanwhile. Same rule for defects: run both again after every fix.

- [ ] **Step 4: Commit** `scripts/rescue-e2e/*`, `scripts/rescue-lab/replay-rerun.ts` and the constant. Message: `test(rescue-v2): end-to-end proof on localhost: cheap re-run, resume, restore, honest failure, delete`.

---

## 3. M5: the app

**Ends with:** a full localhost walk with the session brain (§6).

**One screen.** The student's own pages fill the top half; one sheet below changes per step; nothing navigates between steps. Route tree:

```
app/(app)/rescue/_layout.tsx     Stack, no gestures, drawer swipe off (P-36); the shell draws the way out of every step (Task A3)
app/(app)/rescue/index.tsx       the living screen: screens 1-13, 15-18, H2-H5. Params: projectId?, view?, share?
app/(app)/rescue/library.tsx     H1
```

**Traps every screen in this section obeys** (memory: `rn-new-arch-render-traps`, `gorhom-bottomsheet`, `screen-skeletons`, `turn-survives-background`):
- Never `Pressable style={({pressed}) => …}`: it can apply nothing on Fabric. Static styles; `TouchableOpacity` or an inner `View` for visuals.
- `numberOfLines={1}`, never a `maxHeight` clip with a layout transition.
- Animate children with a shared stable `key`; per-branch `entering`/`exiting` on same-type roots never fire.
- Every `withRepeat` has `return () => cancelAnimation(sv)`.
- A `Gesture.Pan()` callback has an explicit `"worklet";` first line if the chain is split.
- A translateX view in RTL needs `direction: "ltr"` on the moving node and the anchor `I18nManager.isRTL ? { right: 0 } : { left: 0 }`.
- Directional icons swap glyph (`isRTL ? ChevronLeft : ChevronRight`), never `scaleX: -1`.
- Picker sheets are `components/BottomSheet.tsx` (modal): conditionally unmounted, presented on the next frame, unmounted only after `onDismiss`. The living sheet is a persistent `BottomSheet`, not a modal, so the unmount rule does not apply to it.
- Skeletons are layout-shaped, under ONE driver per screen, `colors.bgSurface`, first load only: never replace real content on a refresh.
- Select primitives from the store, never a fresh object literal.
- Colours from `useThemeColors()`, rows with `visualRow`, labels with `visualTextAlign` (`lib/rtl-layout.ts`). Content direction from `getTextDirection`/`firstStrongDirection` (`lib/text-direction.ts`): an Arabic thesis stays RTL in a French UI.
- `PURCHASES_HIDDEN` (`lib/purchases.ts`) gates every word about money. Screen 18 is the one place iOS still states what happens to a payment made elsewhere, in status words with no amount, method or link, because invariant 5 owes the student that sentence (Task A7).

---

### Group A-A: foundation (one engineer, in this order; can start once S2 and S4 are merged, since it needs only the contract)

### Task A1: types, API client, store, pure modules, tokens

**Files:**
- Create: `types/rescue-v2.ts`, `lib/rescue-v2-enabled.ts`, `lib/rescue-v2-api.ts`, `lib/rescue-v2-screen.ts`, `lib/rescue-v2-screen.test.ts`, `lib/rescue-v2-layout.ts`, `lib/rescue-v2-layout.test.ts`, `lib/rescue-v2-upload.ts`, `lib/rescue-v2-page-cache.ts`, `lib/rescue-v2-fixtures.ts`, `stores/rescue-v2-store.ts`, `hooks/useRescuePolling.ts`
- Modify: `constants/colors.ts`, `lib/api.ts` (`export` on `apiPut`; a new exported `apiDeleteJson<T>`, because `apiDelete` returns `void` and `apiDeleteWithBody` is private and sends a body; the `startCheckout` and `submitManualPayment` unions; `ManualPaymentStatus.kind` adds `"rescue"`; **`decorateApiError` (at `lib/api.ts:63-85`) copies only `code`, `reason`, `quota`, `plan`, `limit` and `used`, so it also copies `projectId`, `missing`, `fieldId` and `priceDzd`** into `error.info`: without them `rescue_one_in_progress` leaves the student on screen 1 with no project to open, and `cover_fields_missing` cannot name the field), `vitest.config.ts` (add `lib/rescue-v2-screen.test.ts`, `lib/rescue-v2-layout.test.ts`)

- [ ] **Step 1: `types/rescue-v2.ts`.** §1.3's first block, word for word.

- [ ] **Step 2: `lib/rescue-v2-enabled.ts`.**
```ts
/**
 * Every way into Rescue v2 goes through this one constant (D-19: one release).
 * `: boolean`, not the inferred literal: typed wide, both states are checked by tsc,
 * the same reasoning as lib/tasks-enabled.ts. The release commit sets this to `true`.
 */
export const RESCUE_V2_ENABLED: boolean = __DEV__;
```

- [ ] **Step 3: Colour tokens.** In `constants/colors.ts`, in both palettes; `rgbTriplet` is already declared above `colors`:
```ts
// dark
rescueStageTop: "#17172A", rescueStageBottom: "#1B1B30", rescuePaper: "#FCFBF8",
brandWash: `rgba(${rgbTriplet(brand.primary)},0.18)`, successWash: "rgba(51,214,166,0.16)",
// light
rescueStageTop: "#ECECF3", rescueStageBottom: "#F4F4F8", rescuePaper: "#FCFBF8",
brandWash: `rgba(${rgbTriplet(brand.primary)},0.13)`, successWash: "rgba(38,184,140,0.13)",
```
The paper stays light in dark mode: it is paper.

- [ ] **Step 4: Failing test** `lib/rescue-v2-screen.test.ts`, then implement. Pure: imports types only.
```ts
import type { RescuePhase, RescueProjectDTO } from "@/types/rescue-v2";

export type RescueScreen =
  | "start" | "parts" | "reading" | "rules_choice" | "notes" | "understood"
  | "diagnosis" | "preview" | "payment" | "rules" | "question" | "cover"
  | "repairing" | "result" | "changed" | "revisions" | "failure"
  | "timeline" | "version" | "compare" | "edit_rerun";

export type RescueOverlay = "changed" | "revisions" | "timeline" | "version" | "compare" | "edit_rerun";

export interface RescueNav {
  setupStep: "rules_choice" | "notes";
  diagnosisTab: "before" | "after";
  paying: boolean;
  overlay: RescueOverlay | null;
  versionId: string | null;
  compareWithId: string | null;
}
export const INITIAL_NAV: RescueNav = { setupStep: "rules_choice", diagnosisTab: "before", paying: false, overlay: null, versionId: null, compareWithId: null };

const RUNNING: ReadonlySet<RescuePhase> = new Set(["uploading", "proposing_order", "reading", "understanding", "diagnosing", "repairing"]);
export const isRunning = (phase: RescuePhase | undefined): boolean => !!phase && RUNNING.has(phase);
/** Also true on the quiet screens while something finishes behind them: a note, a guide, the cover samples, a payment under review. */
export function needsPolling(p: Pick<RescueProjectDTO, "phase" | "note" | "setup" | "cover" | "entitlement"> | null): boolean {
  if (!p) return false;
  return isRunning(p.phase)
    || p.note.state === "parsing"
    || p.setup.guide.state === "reading"
    || p.cover?.samples === "rendering"
    || p.entitlement.purchase.state === "pending_card"
    || p.entitlement.purchase.state === "pending_manual"
    || p.entitlement.purchase.state === "paid" && p.entitlement.kind === null;   // paid but not yet granted: 'confirming' must end by itself (P-62)
}

/** The way out of a step, as a nav patch; null means leave the route. The shell's BackPill and Android's back both use it. */
/**
 * `"ack"` (C8): `revisions` forced by `not_same_thesis` has no overlay to close, so back would do nothing for ever on both platforms.
 * The caller runs `ackVersion(failure.versionId)`, after which the phase falls to `done` (a previous version exists) and the screen to `result`.
 */
export function backFor(screen: RescueScreen, nav: RescueNav, project?: Pick<RescueProjectDTO, "phase" | "failure"> | null): Partial<RescueNav> | "ack" | null {
  switch (screen) {
    case "notes": return { setupStep: "rules_choice" };
    case "preview": return { diagnosisTab: "before" };
    case "payment": return { paying: false };
    case "changed": return { overlay: nav.versionId ? "version" : null };
    case "revisions": return project?.phase === "failed" && project.failure?.code === "not_same_thesis" ? "ack" : { overlay: null };
    case "timeline": return { overlay: null };
    case "version": case "edit_rerun": return { overlay: "timeline" };
    case "compare": return { overlay: "version" };
    default: return null;
  }
}

export function screenFor(project: Pick<RescueProjectDTO, "phase" | "failure"> | null, nav: RescueNav): RescueScreen {
  if (!project) return "start";
  switch (project.phase) {
    case "uploading": return nav.overlay === "revisions" ? "revisions" : "reading";
    case "proposing_order": case "await_part_order": return "parts";
    case "reading": return "reading";
    case "await_setup": return nav.setupStep;
    case "understanding": case "diagnosing": return "understood";
    case "diagnosed": return nav.paying ? "payment" : nav.diagnosisTab === "after" ? "preview" : "diagnosis";
    case "confirm_rules": return "rules";
    case "confirm_questions": return "question";
    case "confirm_cover": return "cover";
    case "repairing": return "repairing";
    case "failed": return project.failure?.code === "not_same_thesis" ? "revisions" : "failure";
    case "done": return nav.overlay ?? "result";
  }
}
```
Tests: one row per line of the table in §1.1; `overlay` is ignored while `repairing`; `paying` beats `diagnosisTab`; `not_same_thesis` → `revisions`; `needsPolling` true for a running phase, a parsing note, a guide being read, samples rendering, a pending payment, and false on a quiet `confirm_rules`; `backFor` for every screen, with `changed` going back to `version` when it was opened from there, and `revisions` with phase `failed` and `not_same_thesis` returning `"ack"` (every other `revisions` returns the overlay patch); `needsPolling` true for `paid` with no entitlement yet; `uploading` with `overlay='revisions'` stays on `revisions`.

- [ ] **Step 5: Failing test** `lib/rescue-v2-layout.test.ts`, then implement. The mock is 222 wide; everything scales by `width / 222`.
```ts
/** Top of the sheet as % of the screen, measured off the mocks. */
export const SHEET_TOP_PCT: Record<Exclude<RescueScreen, "failure">, number> = {
  start: 42, parts: 24, reading: 49, rules_choice: 24, notes: 15, understood: 49,
  diagnosis: 49, preview: 49, payment: 23, rules: 24, question: 49, cover: 49,
  repairing: 49, result: 49, changed: 22, revisions: 42,
  timeline: 29, version: 33, compare: 55, edit_rerun: 21,
};
export type StageLayout =
  | { kind: "three"; mid: [number, number]; side: [number, number] }
  | { kind: "pair"; each: [number, number] }
  | { kind: "big"; page: [number, number] }
  | { kind: "none" };
/** Mock sizes, before scaling. */
export const STAGE_LAYOUT: Record<Exclude<RescueScreen, "failure">, StageLayout> = {
  start: { kind: "three", mid: [122, 170], side: [84, 120] },
  parts: { kind: "none" },
  reading: { kind: "three", mid: [122, 170], side: [84, 120] },
  rules_choice: { kind: "three", mid: [80, 112], side: [56, 80] },
  notes: { kind: "three", mid: [42, 58], side: [42, 58] },
  understood: { kind: "three", mid: [122, 170], side: [84, 120] },
  diagnosis: { kind: "three", mid: [122, 170], side: [84, 120] },
  preview: { kind: "three", mid: [122, 170], side: [84, 120] },
  payment: { kind: "three", mid: [70, 98], side: [70, 98] },
  rules: { kind: "big", page: [86, 120] },
  question: { kind: "big", page: [150, 200] },
  cover: { kind: "pair", each: [96, 136] },
  repairing: { kind: "three", mid: [122, 170], side: [84, 120] },
  result: { kind: "three", mid: [122, 170], side: [84, 120] },
  changed: { kind: "big", page: [56, 80] },
  revisions: { kind: "three", mid: [122, 170], side: [84, 120] },
  timeline: { kind: "three", mid: [66, 92], side: [52, 72] },
  version: { kind: "three", mid: [76, 106], side: [60, 84] },
  compare: { kind: "big", page: [150, 200] },
  edit_rerun: { kind: "three", mid: [52, 72], side: [52, 72] },
};
export const scaleFor = (screenWidth: number) => screenWidth / 222;
export const SHEET_RADIUS = 22;
```
Tests: every `RescueScreen` except `failure` has both entries; `scaleFor(390)` is about 1.757; every sheet top is between 0 and 100.

- [ ] **Step 6: `lib/rescue-v2-api.ts`.** One typed wrapper per row of §1.4, over `apiGet`, `apiPost`, `apiPut`, `apiDelete`, and `apiDeleteJson` for the three DELETE routes that answer with a `RescueProjectDTO` (`deleteUploadVersion`, `removeGuide`, `removeNoteChip`): `getRescueConfig`, `listRescueProjects`, `createRescueProject`, `getRescueProject`, `deleteRescueProject`, `deleteUploadVersion`, `confirmPartOrder`, `updateSetup`, `uploadGuide`, `removeGuide`, `sendNote`, `removeNoteChip`, `resolveNoteConflict`, `startDiagnosis`, `getVersionPages`, `getRescuePreview`, `continueRescue`, `saveRules`, `saveAnswer`, `saveCover`, `renderCoverSamples`, `getCoverSamples`, `startRescue`, `listVersions`, `getVersion`, `getVersionFile`, `compareVersions`, `restoreVersion`, `createRerun`, `getImpact`, `resumeVersion`, `ackVersion`. Errors carry `.status`, `.code` and, after the change above, `.info` (`projectId`, `missing`, `fieldId`, `priceDzd`). Also `requestRescueReview(versionId)` for `POST /versions/:vid/review-request` (P-57), and `uploadGuide` sends the file name in the `x-file-name` header, URL-encoded, never in the query string (§1.4).

- [ ] **Step 7: `lib/rescue-v2-upload.ts`.** Raw bytes per part (P-10). `expo-file-system` is imported inside the function: no web-reachable module imports it at module scope (`feat/web-version`'s rule).
```ts
export async function uploadPart(versionId: string, index: number, fileUri: string, onProgress: (fraction: number) => void): Promise<RescueProjectDTO> {
  const FileSystem = await import("expo-file-system/legacy");
  const headers = await getAuthHeader();
  const task = FileSystem.createUploadTask(
    `${process.env.EXPO_PUBLIC_API_URL}/api/rescue-v2/versions/${versionId}/parts/${index}`,
    fileUri,
    { httpMethod: "PUT", uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: { ...headers, "Content-Type": "application/octet-stream" } },
    (p) => onProgress(p.totalBytesExpectedToSend > 0 ? p.totalBytesSent / p.totalBytesExpectedToSend : 0),
  );
  // iOS's default background session never FAILS when the server or the connection is down: it retries. A timer that sees no progress
  // for 45 s cancels the task, so the bar cannot hang with no message and no way out.
  let last = Date.now(); let stalled = false;
  const watch = setInterval(() => { if (Date.now() - last > 45_000) { stalled = true; void task.cancelAsync(); } }, 5_000);
  try {
    const res = await task.uploadAsync();
    if (stalled || !res) throw Object.assign(new Error("upload stalled"), { code: "upload_stalled" });
    // A proxy's own error page (nginx's 413, a gateway's 502) is not JSON: read it by status, never let JSON.parse throw a bare SyntaxError.
    let body: any = {};
    try { body = JSON.parse(res.body || "{}"); } catch { /* by status below */ }
    if (res.status >= 400) {
      const code = body?.code ?? (res.status === 413 ? "rescue_too_large" : res.status === 411 ? "length_required" : undefined);
      throw Object.assign(new Error(body?.error || "upload failed"), { status: res.status, code, info: body });
    }
    return body as RescueProjectDTO;
  } finally {
    clearInterval(watch);
  }
}
```
(`onProgress` also sets `last = Date.now()`.) Tests, with the module's `FileSystem` mocked: a 413 with an HTML body → `code: "rescue_too_large"`; a 400 JSON `{code:"not_docx"}` → that code; no progress for 45 s (fake timers) → `upload_stalled` and `cancelAsync` called.
`uploadGuide` uses the same helper with the guide's URL and its real `Content-Type`.

- [ ] **Step 8: `lib/rescue-v2-page-cache.ts`** (P-12).
```ts
const inflight = new Map<string, Promise<string>>();
/** One download per page, ever: the hash names the bytes, and a signed URL changes at every signing. */
export function localPageUri(hash: string, url: string): Promise<string> {
  const held = inflight.get(hash);
  if (held) return held;
  const p = (async () => {
    const { Directory, File, Paths } = await import("expo-file-system");
    const dir = new Directory(Paths.cache, "rescue-pages");
    if (!dir.exists) dir.create({ intermediates: true });
    const file = new File(dir, `${hash}.jpg`);
    if (file.exists) return file.uri;
    return (await File.downloadFileAsync(url, file)).uri;
  })().finally(() => inflight.delete(hash));
  inflight.set(hash, p);
  return p;
}
```

- [ ] **Step 9: `stores/rescue-v2-store.ts`.** Copy the shape of `stores/billing-store.ts`, primitive hooks at the end.
```ts
interface RescueV2State {
  config: RescueConfigDTO | null;
  projectId: string | null;
  project: RescueProjectDTO | null;
  /** True only for the first load of a project. A refresh never swaps real content for a skeleton. */
  firstLoad: boolean;
  /** The last machine code from the server, for the sheet to word; `network` for a request that never got an answer. */
  errorCode: string | null;
  /** `error.info` of that failure: `projectId`, `missing`, `fieldId`. */
  errorInfo: { projectId?: string; missing?: string[]; fieldId?: string } | null;
  nav: RescueNav;
  /** Set before the first request and cleared after the last part, so a null here during `uploading` can only mean a cold start lost the upload. */
  upload: { fraction: number; fileName: string | null; sizeBytes: number; parts: number } | null;
  /** The living screen is mounted. Task A9 drops a push's banner for the project on it. */
  screenOpen: boolean;
  pages: Record<string, { count: number; byPage: Record<number, { hash: string; url: string }> }>;
  versions: RescueVersionSummaryDTO[];
  edited: { edited: boolean; changedBlocks: number | null; afterVersionN: number | null } | null;
  details: Record<string, RescueVersionDetailDTO>;

  loadConfig(): Promise<void>;
  /** `fixture` is dev only (Step 11). */
  open(projectId: string | null, fixture?: RescuePhase): Promise<void>;
  refresh(): Promise<void>;
  setNav(patch: Partial<RescueNav>): void;
  /** Picker or Share: creates the project, uploads every part. Returns false when refused. */
  begin(files: { uri: string; name: string; size: number }[], source: "picker" | "share"): Promise<boolean>;
  /** Screen 17: first `flushOps(thesisId)` (the thesis' queued index-addressed edits go to the server before the re-run can shift every index, P-66), then sets `upload` and `overlay='revisions'`, then `createRerun`, then every part against `activeVersionId`. No files: `source: "auto"`. */
  beginRerun(files: { uri: string; name: string; size: number }[]): Promise<boolean>;
  setScreenOpen(open: boolean): void;
  loadPages(versionId: string, from: number, to: number): Promise<void>;
  loadVersions(): Promise<void>;
  loadDetail(versionId: string): Promise<void>;
  /** Wraps a mutation: keeps the DTO it returns, or records its `code` and `info` (a thrown error with no code is `network`). Cleared by the next success. */
  apply(call: () => Promise<RescueProjectDTO>): Promise<boolean>;
  reset(): void;
}
export const useRescuePhase = () => useRescueV2Store((s) => s.project?.phase ?? null);
export const useRescueScreen = () => useRescueV2Store((s) => screenFor(s.project, s.nav));
export const useRescueProjectId = () => useRescueV2Store((s) => s.projectId);
export const useRescuePagesReady = () => useRescueV2Store((s) => s.project?.progress?.pagesReady ?? 0);
export const usePageMeta = (versionId: string | null, page: number) =>
  useRescueV2Store((s) => (versionId ? s.pages[versionId]?.byPage[page]?.hash ?? null : null));
```
`refresh` writes the store only when `JSON.stringify` of the new DTO differs. Whenever `phase` changes, `refresh` and `apply` clear `nav.overlay` and `nav.paying`, so a finished re-run lands on the result and a granted payment moves on. The one exception is a change **to** `uploading`, which keeps `overlay='revisions'`: screen 17 stays up during a re-run's upload (§1.1). `loadPages` asks in windows of 12 and skips pages already held; a URL older than 50 minutes is re-asked; a page the server did not have yet is asked again when `pagesReady` moves.

- [ ] **Step 10: `hooks/useRescuePolling.ts`** (P-13).
```ts
export function useRescuePolling() {
  const polling = useRescueV2Store((s) => needsPolling(s.project));
  const refresh = useRescueV2Store((s) => s.refresh);
  // Re-read on every return: a run may have finished, or a payment landed, while the app slept. Never re-POST anything.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refresh(); });
    return () => sub.remove();
  }, [refresh]);
  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => void refresh(), 3000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
    return () => { stop(); sub.remove(); };
  }, [polling, refresh]);
}
```

- [ ] **Step 11: `lib/rescue-v2-fixtures.ts`, dev only.** `export const RESCUE_FIXTURES: Record<RescuePhase, RescueProjectDTO>`, one believable DTO per phase with invented text. `store.open` reads it when `__DEV__` and the route has `?fixture=<phase>`, so Group A-B can build every screen before the server exists. Task A11 deletes the file and the branch.

- [ ] **Step 12: Run and commit.**
```bash
cd ~/kwill && npx tsc --noEmit && npx vitest run
git commit -m "feat(rescue-v2): types, client, store and the state-to-screen mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- types/rescue-v2.ts lib/rescue-v2-enabled.ts lib/rescue-v2-api.ts lib/rescue-v2-screen.ts lib/rescue-v2-screen.test.ts lib/rescue-v2-layout.ts lib/rescue-v2-layout.test.ts lib/rescue-v2-upload.ts lib/rescue-v2-page-cache.ts lib/rescue-v2-fixtures.ts stores/rescue-v2-store.ts hooks/useRescuePolling.ts constants/colors.ts lib/api.ts vitest.config.ts
```

### Task A2: the words

**Files:**
- Modify: `locales/ar.json`, `locales/fr.json`, `locales/en.json`, `vitest.config.ts`
- Create: `lib/rescue-v2-locales.test.ts`

The locale files hold duplicate keys: `json.load`/`json.dump` silently drops them, so **never round-trip them**. Each file has the line `  "errors": {` (line 1582 today). Insert the block before it with the Edit tool (old_string `  "errors": {`, new_string the block + `,\n  "errors": {`). Check with `git diff --stat -- locales` that each file only adds lines.

- [ ] **Step 1: Write the parity test.** `fs.readFileSync` + `JSON.parse` (the last duplicate wins, and `rescueV2` is unique); the same leaf paths in all three; the same `{{placeholders}}` per leaf; no banned word in any leaf (`section break`, `saut de section`, `فاصل مقطعي`, `field`, `champ`, `erreur`, `error`, `violation`, `مخالف`, `خطأ`), with the check limited to `rescueV2`. Add the file to `vitest.config.ts`'s `include`.

- [ ] **Step 2: Insert these three blocks.**

`locales/ar.json`:
```json
  "rescueV2": {
    "drawerRow": "أنقذ مذكرتك",
    "unavailable": "الإصلاح غير متاح الآن. جرّب لاحقًا.",
    "common": {
      "back": "رجوع",
      "retry": "أعد المحاولة",
      "cancel": "إلغاء",
      "contactSupport": "تواصل مع الدعم",
      "page": "الصفحة {{page}}",
      "pageOf": "الصفحة {{page}} من {{total}}",
      "version": "النسخة {{n}}",
      "somethingWrong": "حدث خلل من جهتنا، وملفك في أمان. أعد المحاولة بعد قليل.",
      "waitingWord": "دورك قادم. يمكنك إغلاق التطبيق، وسنرسل لك إشعارًا.",
      "waitingBrain": "نقرأ مذكرتك بعناية. قد يستغرق هذا بضع دقائق، ويمكنك إغلاق التطبيق بأمان.",
      "etaMinutes": "حوالي {{minutes}} د",
      "etaSoon": "أقل من دقيقة",
      "langAr": "العربية",
      "langFr": "Français",
      "langEn": "English"
    },
    "card": {
      "title": "أنقذ تنسيق مذكرتك",
      "body": "ارفع ملف Word وشاهد ما سنصلحه، مجانًا.",
      "bodyStatus": "ارفع ملف Word وشاهد ما سنصلحه.",
      "cta": "ابدأ",
      "continue": "تابع إصلاح مذكرتك",
      "ready": "مذكرتك جاهزة"
    },
    "start": {
      "title": "أنقذ تنسيق مذكرتك",
      "body": "ارفع ملف Word، ونشخّصه مجانًا حسب معايير كليتك.",
      "bodyStatus": "ارفع ملف Word، ونشخّصه حسب معايير كليتك.",
      "trustFree": "التشخيص مجاني",
      "trustFreeStatus": "تشخيص كامل حسب معايير كليتك",
      "trustWords": "لن نغيّر أي كلمة من نصّك",
      "trustOriginal": "ملفك الأصلي يبقى محفوظًا",
      "cta": "اختر ملف المذكرة",
      "severalHint": "مذكرتك مقسّمة إلى عدة ملفات؟ اخترها كلها معًا.",
      "share": "أو شاركه مباشرة من واتساب أو تيليغرام",
      "notDocx": "هذا الملف ليس بصيغة Word (.docx). احفظه بهذه الصيغة ثم أعد المحاولة.",
      "tooLarge": "هذا الملف كبير جدًا (الحد {{mb}} م.ب).",
      "tooMany": "يمكن رفع 12 جزءًا كحد أقصى.",
      "dailyLimit": "بلغت عدد التشخيصات المتاحة اليوم. عد غدًا وسنكون بانتظارك.",
      "busy": "الضغط كبير الآن. جرّب بعد قليل.",
      "inProgress": "لديك مذكرة قيد التشخيص. نكملها أولًا."
    },
    "parts": {
      "title": "أجزاء مذكرتك",
      "body": "رتّبناها كما نعتقد. اسحب أي جزء لتغيير مكانه.",
      "proposing": "نقرأ بداية كل جزء لنقترح الترتيب…",
      "continues": "يكمل الجزء السابق",
      "cta": "الترتيب صحيح، تابع",
      "nothingAdded": "ندمج الأجزاء دون إضافة أي شيء.",
      "roles": {
        "cover": "الغلاف",
        "front-matter": "الصفحات الأولى",
        "introduction": "المقدمة",
        "chapter": "فصل",
        "conclusion": "الخاتمة",
        "bibliography": "المراجع",
        "annex": "الملاحق",
        "other": "جزء آخر"
      }
    },
    "reading": {
      "title": "نقرأ مذكرتك",
      "fileSize": "{{mb}} م.ب",
      "stepUpload": "رفع الملف",
      "stepRead": "قراءة الصفحات",
      "stepUnderstand": "فهم البنية",
      "merging": "ندمج الأجزاء دون إضافة أي شيء",
      "converting": "نحوّل ملفك إلى صفحات",
      "uploadLost": "لم يكتمل رفع الملف، ولم نحتفظ بشيء منه. اختره من جديد.",
      "uploadAgain": "اختر الملف من جديد"
    },
    "whichRules": {
      "title": "نقارنها بمعايير أي كلية؟",
      "fromProfile": "من ملفك الشخصي",
      "change": "تغيير",
      "pickUniversity": "اختر جامعتك",
      "guideTitle": "لديك دليل القسم؟",
      "guideBody": "صوّره أو ارفعه لتشخيص أدق",
      "optional": "اختياري",
      "profileOffer": "هل نطبّق قواعد {{name}}؟",
      "profileYes": "نعم، طبّقها",
      "profileNo": "لا، القواعد العامة",
      "guideCamera": "التقط صورة",
      "guideFile": "اختر ملفًا",
      "guideReading": "نقرأ الدليل…",
      "guideRead": "قرأنا الدليل ✓",
      "guideFailed": "لم نستطع قراءة الدليل. جرّب صورة أوضح، أو تابع بدونه.",
      "guideRemove": "إزالة",
      "cta": "شخّص مذكرتي مجانًا",
      "ctaStatus": "شخّص مذكرتي"
    },
    "notes": {
      "title": "أخبر Kwill عن مذكرتك",
      "placeholder": "مثال: الإهداء والشكر بدون ترقيم. المشرف يريد عناوين الفصول بخط 18.",
      "understood": "فهمنا من ملاحظتك",
      "parsing": "نقرأ ملاحظتك…",
      "parseFailed": "لم نستطع قراءة ملاحظتك الآن. ستبقى محفوظة وسنأخذها بعين الاعتبار.",
      "conflict": "{{label}}: الدليل {{guide}} · ملاحظتك {{note}}",
      "conflictMine": "ملاحظتي ({{value}})",
      "conflictGuide": "دليل القسم ({{value}})",
      "pickOne": "اختر قيمة واحدة لنتابع",
      "refusedWords": "لا نغيّر كلماتك أبدًا، لذلك لن نطبّق: {{label}}",
      "refusedChecks": "نتحقق من كل مذكرة دائمًا، لذلك لن نطبّق: {{label}}",
      "refusedDeposit": "هذا لا يوافق شروط الإيداع، لذلك لن نطبّق: {{label}}",
      "refusedUnsupported": "سجّلنا هذا، لكن لا نستطيع تطبيقه: {{label}}",
      "waitGuide": "ننتهي من قراءة الدليل…",
      "cta": "متابعة",
      "skip": "تخطَّ"
    },
    "understood": {
      "titleWorking": "نفهم مذكرتك…",
      "title": "فهمنا مذكرتك",
      "pages": "صفحات",
      "chapters": "فصول",
      "figures": "أشكال",
      "tables": "جداول",
      "footnotes": "هوامش",
      "cover": "غلاف",
      "typeLine": "النوع: {{format}} · نقارنها الآن بمعايير كليتك…",
      "format": { "classic": "مذكرة كلاسيكية", "imrad": "مذكرة IMRAD", "1275": "مذكرة مؤسسة ناشئة (1275)" }
    },
    "diagnosis": {
      "title": "نقاط سنصلحها: {{count}}",
      "sub": "حسب معايير كليتك · اضغط أي نقطة لتراها",
      "before": "قبل",
      "after": "بعد",
      "cta": "أصلح مذكرتي",
      "ctaStatus": "متابعة",
      "fine": "دفعة واحدة · إعادة مجانية بعد تعديلات الأستاذ",
      "yours": "يبقى لك:",
      "chips": {
        "headings": "العناوين",
        "cover": "الغلاف",
        "toc": "الفهرس",
        "numbering": "الترقيم",
        "figures": "الأشكال",
        "text": "الخط",
        "structure": "البنية"
      },
      "problems": {
        "margins": "الهوامش لا توافق معايير كليتك. سنضبطها.",
        "page-size": "مقاس الصفحة ليس A4. سنضبطه.",
        "body-font": "خط النص ليس الخط المطلوب ({{expected}}). سنوحّده.",
        "body-size": "حجم الخط ليس المطلوب ({{expected}}). سنضبطه.",
        "line-spacing": "تباعد الأسطر ليس المطلوب ({{expected}}). سنضبطه.",
        "alignment": "بعض الفقرات غير مضبوطة الحواف. سنوحّدها.",
        "headings-not-real": "هذا العنوان مكتوب كنص عادي. سنجعله عنوانًا حقيقيًا.",
        "heading-skip": "تسلسل العناوين يقفز مستوى هنا. سنلفت نظرك إليه.",
        "heading-size": "حجم العنوان ليس المطلوب. سنضبطه.",
        "toc-missing": "لا يوجد فهرس. سنضيف فهرسًا قابلًا للنقر.",
        "toc-typed": "الفهرس مكتوب يدويًا. سنجعله فهرسًا حقيقيًا قابلًا للنقر.",
        "captions-typed": "هذا التعليق مكتوب يدويًا. سنجعله تعليقًا مرقّمًا حقيقيًا.",
        "caption-position": "هذا التعليق ليس في مكانه المعتاد. سنضعه في مكانه.",
        "figure-no-caption": "هذا الشكل بلا تعليق. نلفت نظرك إليه.",
        "table-no-caption": "هذا الجدول بلا تعليق. نلفت نظرك إليه.",
        "list-of-figures-missing": "لا توجد قائمة أشكال. سنضيفها.",
        "list-of-tables-missing": "لا توجد قائمة جداول. سنضيفها.",
        "typed-notes": "هذا الهامش مكتوب في آخر الصفحة كنص عادي. سنجعله هامشًا حقيقيًا.",
        "page-numbers": "ترقيم الصفحات لا يوافق المعايير. سنضبطه.",
        "blank-pages": "هذه صفحة فارغة. سنزيلها.",
        "heading-at-page-end": "هذا العنوان بقي وحده في أسفل الصفحة. سنبقيه مع ما بعده.",
        "spacing-by-empty-lines": "المسافات هنا مصنوعة بأسطر فارغة. سننظّفها.",
        "cover-missing": "لا يوجد غلاف. سننشئ لك واحدًا.",
        "section-missing": "ينقص هذا القسم: {{sectionName}}. سنضيفه إن أمكن.",
        "section-empty": "هذا القسم فارغ: {{sectionName}}. كتابته تبقى لك.",
        "font-not-portable": "الخط {{fonts}} قد لا يظهر في حاسوب المطبعة. سنستبدله بخط مناسب.",
        "font-symbol-not-portable": "الخط {{fonts}} خط رموز قد لا يظهر في حاسوب المطبعة. راجع الأماكن التي يظهر فيها.",
        "typography": "مسافات علامات الترقيم تحتاج ضبطًا. سننظّفها دون تغيير كلماتك."
      },
      "sections": {
        "cover": "الغلاف",
        "dedication": "الإهداء",
        "thanks": "الشكر",
        "abstract": "الملخص",
        "toc": "الفهرس",
        "list-of-figures": "قائمة الأشكال",
        "list-of-tables": "قائمة الجداول",
        "abbreviations": "قائمة المختصرات",
        "introduction": "المقدمة",
        "conclusion": "الخاتمة",
        "bibliography": "قائمة المراجع",
        "annexes": "الملاحق"
      }
    },
    "preview": {
      "title": "هكذا ستبدو مذكرتك",
      "body": "صفحتان حقيقيتان من ملفك بعد الإصلاح: الغلاف وبداية الفصل الأول.",
      "bodyCoverOnly": "صفحة حقيقية من ملفك بعد الإصلاح: الغلاف.",
      "unavailable": "لم نتمكن من تجهيز المعاينة هذه المرة. التشخيص أعلاه يبقى صحيحًا.",
      "pill": "نفس كلماتك، تنسيق كليتك"
    },
    "payment": {
      "title": "إصلاح مذكرة واحدة",
      "price": "{{price}} دج",
      "once": "دفعة واحدة",
      "inc1": "تنسيق كامل حسب معايير كليتك",
      "inc2": "الغلاف ونسخة PDF جاهزة للإيداع",
      "inc3": "الاستمارتان وورقة الملخص",
      "inc4": "إعادة مجانية حتى يوم المناقشة",
      "manual": "بريدي موب / CCP",
      "manualSub": "تحويل",
      "card": "الذهبية / CIB",
      "cardSub": "بطاقة",
      "cta": "ادفع وابدأ",
      "subscriber": "مشترك؟ الإصلاح مشمول في اشتراكك",
      "safe": "لن نغيّر أي كلمة من نصّك · ملفك الأصلي يبقى محفوظًا",
      "confirming": "نتأكد من دفعتك…",
      "underReviewTitle": "دفعتك قيد المراجعة",
      "underReviewBody": "سنرسل لك إشعارًا فور تأكيدها، ثم نكمل معًا.",
      "rejectedTitle": "لم نتمكن من تأكيد دفعتك",
      "tryAgain": "أعد الإرسال",
      "cardNotFinished": "لم تكتمل عملية الدفع، ولم يُخصم شيء.",
      "cardRetry": "لم تكمل الدفع؟ أعد المحاولة",
      "notForSale": "الإصلاح غير متاح الآن. جرّب لاحقًا.",
      "statusTitle": "إصلاح هذه المذكرة غير مفعّل بعد",
      "statusBody": "حالة الإصلاح مرتبطة بحسابك في Kwill وتتبعك على كل أجهزتك.",
      "statusRefresh": "تحديث الحالة",
      "statusBack": "العودة"
    },
    "rules": {
      "title": "قواعد كليتك",
      "fromGuide": "مقروءة من دليل قسمك ✓",
      "fromNote": "من ملاحظتك",
      "cta": "صحيح، تابع",
      "rows": {
        "font": "الخط",
        "headings": "عناوين الفصول",
        "spacing": "تباعد الأسطر",
        "margins": "الهوامش (سم)",
        "numbering": "الترقيم",
        "footnotes": "الهوامش السفلية",
        "deposit": "الإيداع",
        "additions": "إضافات"
      },
      "fields": {
        "bodyFont": "نوع الخط",
        "bodySize": "حجم الخط",
        "alignment": "محاذاة النص",
        "lineSpacing": "تباعد الأسطر",
        "h1Size": "عناوين الفصول",
        "h2Size": "العناوين الفرعية",
        "h3Size": "العناوين الأصغر",
        "headingBold": "عناوين بخط عريض",
        "marginTop": "أعلى",
        "marginBottom": "أسفل",
        "marginBinding": "جهة التجليد",
        "marginOpposite": "الجهة المقابلة",
        "bindingSide": "التجليد من",
        "frontMatter": "الصفحات الأولى",
        "pagePosition": "مكان الرقم",
        "footnoteSize": "حجم الهوامش السفلية",
        "deposit": "طريقة الإيداع",
        "captionNumbers": "ترقيم تعليقات الأشكال والجداول",
        "dividers": "صفحة فاصلة قبل كل فصل",
        "frames": "إطار لصفحتي الإهداء والشكر",
        "referencesSort": "ترتيب المراجع وتجميعها",
        "secondFont": "خط اللغة الثانية",
        "secondSize": "حجم خط اللغة الثانية",
        "noNumberDedication": "الإهداء بلا رقم صفحة",
        "noNumberThanks": "الشكر بلا رقم صفحة",
        "keepTables": "إبقاء جداولي كما هي"
      },
      "hints": {
        "captionNumbers": "نضيف رقمًا لكل تعليق بلا رقم، دون تغيير كلماتك.",
        "dividers": "لن نضيفها إذا كانت لديك صفحات فاصلة.",
        "frames": "لن نضيفه إذا كان في الصفحة رسم.",
        "referencesSort": "كتب، مقالات، مذكرات، مواقع. لن نغيّر أي كلمة.",
        "captionNumbersCount": "تعليقات سنضيف لها رقمًا: {{count}}",
        "keepTables": "لا نغيّر شكل جداولك، وتبقى تعليقاتها مرقّمة."
      },
      "values": {
        "justify": "مضبوطة الحواف",
        "start": "من بداية السطر",
        "left": "اليسار",
        "right": "اليمين",
        "roman": "i ii iii ثم 1 2 3",
        "letters": "أ ب ج ثم 1 2 3",
        "arabic": "1 2 3 من البداية",
        "none": "بلا ترقيم قبل المتن",
        "bottom-center": "أسفل الوسط",
        "bottom-outside": "أسفل الطرف",
        "platform_pdf": "PDF عبر المنصة",
        "pdf_word": "PDF و Word",
        "copies_cd": "نسخ مطبوعة وقرص"
      },
      "outOfRange": "هذه القيمة خارج المجال المعتاد."
    },
    "question": {
      "counter": "سؤال {{n}} من {{total}}",
      "decide": "لست متأكدًا — دع Kwill يقرّر"
    },
    "cover": {
      "title": "تأكّد من بيانات الغلاف",
      "titleMissing": "نحتاج بعض البيانات للغلاف",
      "keep": "غلافك كما هو ✓",
      "clean": "غلافك بعد التنظيف",
      "generated": "النموذج الجزائري للغلاف",
      "fieldTitle": "العنوان",
      "fieldStudents": "الطالب",
      "fieldSupervisor": "المشرف",
      "fieldYear": "السنة",
      "fieldUniversity": "الجامعة",
      "fieldFaculty": "الكلية",
      "fieldDepartment": "القسم",
      "fieldDegree": "الشهادة",
      "fieldSpecialty": "التخصص",
      "fieldSubtitle": "العنوان الفرعي",
      "fieldField": "الشعبة",
      "fieldCoSupervisor": "المشرف المساعد",
      "fieldJury": "لجنة المناقشة",
      "formsOnly": "غلافك يبقى كما كتبته. هذه البيانات تُستخدم في استمارات الإيداع فقط. لتغيير الغلاف اختر النموذج الجزائري.",
      "more": "بيانات أخرى",
      "add": "أضف",
      "fromProfile": "من ملفك",
      "fromCatalogue": "من قائمة الجامعات",
      "editTitle": "عدّل: {{label}}",
      "save": "حفظ",
      "cta": "ابدأ الإصلاح",
      "needed": "أضف {{label}} لنتابع"
    },
    "repairing": {
      "title": "نبني التنسيق الجديد",
      "stepOf": "الخطوة {{n}} من {{total}}",
      "safe": "أغلق التطبيق بأمان — سنرسل لك إشعارًا",
      "steps": {
        "prepare": "نجهّز نسخة العمل",
        "styles": "الخطوط والعناوين",
        "typography": "تصحيحات طباعية",
        "sections": "الأقسام وأرقام الصفحات",
        "cover": "الغلاف والصفحات الفاصلة",
        "toc": "الفهرس وقائمة الأشكال",
        "captions": "تعليقات الأشكال والمراجع",
        "check": "نتحقق من كل صفحة"
      }
    },
    "result": {
      "title": "مذكرتك جاهزة",
      "stats": "الصفحات: {{pages}} · الإصلاحات: {{fixes}} · تحققنا من كل صفحة",
      "words": "لم تتغيّر أي كلمة من نصّك · ملفك الأصلي يبقى محفوظًا",
      "packTitle": "حزمة الإيداع",
      "packFiles": {
        "thesis-pdf": "PDF",
        "thesis-docx": "Word",
        "abstract-sheet": "ورقة الملخص",
        "integrity-declaration": "تصريح النزاهة",
        "deposit-authorisation": "ترخيص الإيداع",
        "cd-note": "ملاحظة القرص"
      },
      "packNoAbstracts": "بلا ورقة ملخص: لم نجد ملخصات في مذكرتك.",
      "packOmitted": "لم نتمكن من تجهيز: {{files}}. يمكنك إعادة بنائها.",
      "packMissing": "لم نتمكن من تجهيز حزمة الإيداع هذه المرة. مذكرتك جاهزة وسليمة.",
      "packRebuild": "أعد بناء الحزمة",
      "share": "شارك",
      "changed": "ما الذي تغيّر؟ ({{count}})",
      "open": "افتح في Kwill لمتابعة الكتابة",
      "history": "السجل",
      "revisions": "لديك تعديلات من الأستاذ؟",
      "notPublished": "عدّلت مذكرتك أثناء عملنا، فأبقينا تعديلاتك. هذه النسخة محفوظة في السجل.",
      "downloadFailed": "لم يكتمل التحميل. أعد المحاولة."
    },
    "changed": {
      "title": "ما الذي تغيّر",
      "more": "اعرض المزيد",
      "groups": {
        "cover": "الغلاف",
        "toc": "الفهرس والقوائم",
        "headings": "العناوين",
        "captions": "تعليقات الأشكال والجداول",
        "numbering": "الترقيم",
        "pages": "الصفحات",
        "references": "المراجع",
        "notes": "الهوامش",
        "fonts": "الخطوط",
        "typography": "تصحيحات طباعية",
        "other": "تغييرات أخرى"
      },
      "items": {
        "cover_generated": "أنشأنا غلافًا بالنموذج الجزائري",
        "cover_cleaned": "وسّطنا أسطر الغلاف بخط واحد",
        "toc_real": "فهرس حقيقي قابل للنقر بدل المكتوب يدويًا",
        "toc_added": "أضفنا فهرسًا قابلًا للنقر",
        "toc_rebuilt": "أعدنا بناء الفهرس بأرقام الصفحات الجديدة",
        "caption_word_as_label": "صارت كلمة «جدول» أو «شكل» في بداية التعليق عنوانًا له · العدد: {{count}}",
        "comments_removed": "أزلنا تعليقات المراجعة من الأجزاء · العدد: {{count}}",
        "list_added": "أضفنا قائمة الأشكال أو الجداول",
        "heading_real": "«{{text}}» أصبح عنوانًا حقيقيًا",
        "captions_real": "تعليقات أصبحت مرقّمة حقيقية · العدد: {{count}}",
        "caption_number_added": "أضفنا رقمًا لتعليقات بلا رقم · العدد: {{count}}",
        "caption_renumbered": "صحّحنا أرقام تعليقات · العدد: {{count}}",
        "captions_moved": "وضعنا تعليقات في مكانها · العدد: {{count}}",
        "page_numbers": "ضبطنا ترقيم الصفحات",
        "running_heads": "أضفنا عنوان الفصل في رأس الصفحة · الأقسام: {{count}}",
        "chapters_new_page": "كل فصل يبدأ في صفحة جديدة · الأقسام: {{count}}",
        "rules_applied": "طبّقنا الخط والتباعد والهوامش حسب معايير كليتك",
        "empty_removed": "أزلنا أسطرًا فارغة · العدد: {{count}}",
        "manual_breaks_removed": "أزلنا فواصل صفحات يدوية · العدد: {{count}}",
        "review_fixes": "راجعنا الصفحات وضبطنا تفاصيل · العدد: {{count}}",
        "divider_added": "أضفنا صفحة فاصلة قبل الفصل",
        "frame_added": "أضفنا إطارًا للصفحة",
        "references_sorted": "رتّبنا المراجع وجمعناها · العدد: {{count}}",
        "notes_converted": "هوامش مكتوبة أصبحت حقيقية · العدد: {{count}}",
        "fonts_embedded": "ضمّنّا الخطوط في الملف · العدد: {{count}}",
        "font_swapped": "استبدلنا خط {{from}} بخط {{to}}",
        "typo_space_before_punct": "مسافة قبل علامة الترقيم · المواضع: {{count}}",
        "typo_space_after_comma": "مسافة بعد الفاصلة · المواضع: {{count}}",
        "typo_tatweel": "أزلنا التمديد · المواضع: {{count}}",
        "typo_nbsp_before_punct": "مسافة قبل العلامات الفرنسية · المواضع: {{count}}",
        "typo_nbsp_after_guillemet": "مسافة بعد علامة الاقتباس · المواضع: {{count}}",
        "typo_space_after_punct": "مسافة بعد علامة الترقيم · المواضع: {{count}}",
        "typo_collapse_spaces": "مسافات زائدة · المواضع: {{count}}",
        "other_change": "تغييرات أخرى · العدد: {{count}}"
      }
    },
    "revisions": {
      "title": "نسخة جديدة من مذكرتك",
      "free": "مجانًا",
      "body": "نراجع الصفحات التي تغيّرت فقط، وتبقى إجاباتك كما هي.",
      "changedPages": "الصفحات التي تغيّرت: {{count}}",
      "editedInKwill": "عدّلتَ مذكرتك في Kwill، وسنأخذ تعديلاتك.",
      "pickFile": "ارفع النسخة الجديدة",
      "fileChosen": "{{name}}",
      "supervisorLabel": "ماذا طلب الأستاذ؟",
      "supervisorPlaceholder": "مثال: عناوين الفصول بخط 18، والهوامش السفلية بخط 12.",
      "keepAnswers": "لن نسألك من جديد عمّا أجبت عنه",
      "cta": "أعد الإصلاح مجانًا",
      "ctaStatus": "أعد الإصلاح",
      "differentThesis": "يبدو أن هذا الملف مذكرة أخرى. لإصلاحها ابدأ إصلاحًا جديدًا.",
      "startNew": "ابدأ إصلاحًا جديدًا",
      "editedNotInFile": "عدّلتَ مذكرتك في Kwill. هذه التعديلات ليست في الملف الذي اخترته، وسنحتفظ بها في السجل.",
      "askReview": "اطلب منا مراجعته",
      "reviewSent": "وصلنا طلبك، وسيراجع الفريق الملف.",
      "expired": "انتهت فترة الإعادة لهذه المذكرة.",
      "dailyCap": "أعدت الإصلاح كثيرًا اليوم. عد غدًا."
    },
    "failure": {
      "title": "لم نُكمل الإصلاح",
      "body": "وجدنا ما لم نستطع إصلاحه بأمان. لن نسلّمك ملفًا ناقصًا.",
      "bodyPage": "وجدنا في الصفحة {{page}} ما لم نستطع إصلاحه بأمان. لن نسلّمك ملفًا ناقصًا.",
      "bodyOpen": "لم نستطع فتح هذا الملف. احفظه من Word بصيغة .docx ثم أعد المحاولة.",
      "bodyBig": "هذه المذكرة أكبر مما نستطيع معالجته الآن. سيساعدك فريق Kwill.",
      "bodyMerge": "لم نستطع دمج الأجزاء دون تغيير شيء منها. سيساعدك فريق Kwill.",
      "bodyWait": "لم نتمكن من إكمال العمل في الوقت المناسب. سيساعدك فريق Kwill.",
      "trustOriginal": "ملفك الأصلي كما هو تمامًا",
      "refundDue": "سنعيد لك المبلغ",
      "refundDone": "أعدنا لك المبلغ",
      "refundDueStatus": "سيتواصل معك فريق Kwill بخصوص ما دفعته لهذه المذكرة",
      "refundDoneStatus": "سوّينا ما دفعته لهذه المذكرة",
      "noCharge": "لم يُخصم منك شيء",
      "previousSafe": "نسختك السابقة (النسخة {{n}}) كما هي",
      "team": "فريق Kwill يراجع الملف",
      "ok": "حسنًا",
      "tryAnother": "جرّب ملفًا آخر"
    },
    "library": {
      "title": "مذكراتي",
      "versionMeta": "النسخة {{n}} · {{date}}",
      "ready": "جاهزة للإيداع",
      "diagnosed": "التشخيص جاهز",
      "working": "قيد العمل",
      "failed": "لم يكتمل",
      "history": "السجل",
      "open": "افتح",
      "rerun": "أعد الإصلاح",
      "new": "مذكرة جديدة",
      "continue": "تابع",
      "draftMeta": "آخر تعديل {{date}}",
      "hint": "ويمكن فتح السجل أيضًا من شاشة النتيجة أو من القائمة الجانبية",
      "delete": "احذف هذا التشخيص",
      "deleteConfirm": "سنحذف الملف والتشخيص نهائيًا."
    },
    "timeline": {
      "title": "سجل مذكرتك",
      "current": "الحالية",
      "badgeCurrent": "النسخة {{n}} · الحالية",
      "badge": "النسخة {{n}} · {{date}}",
      "edited": "عدّلتَ في محرر Kwill",
      "editedBlocks": "عدّلتَ في محرر Kwill · الفقرات: {{count}}",
      "original": "الملف الأصلي",
      "originalKept": "محفوظ دائمًا",
      "originalMeta": "{{date}} · كما رفعته",
      "triggers": {
        "first_diagnosis": "الملف الأصلي",
        "first_rescue": "الإصلاح الأول",
        "rules_edited": "بعد تعديل القواعد",
        "supervisor_note": "بعد ملاحظات الأستاذ",
        "new_file": "بعد رفع نسخة جديدة",
        "edited_in_kwill": "بعد تعديلاتك في Kwill",
        "restored": "استرجاع النسخة {{n}}",
        "staff_retry": "إعادة من فريق Kwill",
        "pack_rebuilt": "إعادة بناء حزمة الإيداع"
      },
      "meta": "{{date}} · الإصلاحات: {{fixes}}",
      "metaPages": "{{date}} · الصفحات التي تغيّرت: {{count}}",
      "metaFailed": "{{date}} · لم تكتمل",
      "cta": "عدّل وأعد الإصلاح",
      "fine": "مجانًا حتى يوم المناقشة"
    },
    "version": {
      "meta": "{{date}} · الإصلاحات: {{fixes}} · الصفحات: {{pages}}",
      "pdf": "تحميل PDF",
      "word": "تحميل Word",
      "wordMerged": "تحميل الملف المدمج (Word)",
      "partsTitle": "الأجزاء كما رفعتها",
      "compare": "قارن بنسخة أخرى",
      "changed": "ما الذي تغيّر ({{count}})",
      "open": "افتح في Kwill للتعديل",
      "restore": "استرجع هذه النسخة",
      "pickCompare": "اختر نسخة للمقارنة"
    },
    "compare": {
      "title": "النسخة {{a}} ← النسخة {{b}}",
      "changedCount": "الصفحات التي تغيّرت: {{count}}",
      "pager": "الصفحة {{page}} · {{i}} من {{total}}",
      "same": "لا فرق بين هاتين النسختين."
    },
    "editRerun": {
      "title": "عدّل ثم أعد الإصلاح",
      "rules": "القواعد",
      "notes": "ملاحظاتك",
      "notesCount": "الملاحظات: {{count}}",
      "answers": "إجاباتك",
      "answersCount": "الإجابات: {{count}}",
      "cover": "الغلاف",
      "edit": "تعديل",
      "close": "إغلاق",
      "impactAll": "يتغيّر: كل الصفحات",
      "impactPages": "يتغيّر: الصفحات {{pages}}",
      "impactToc": "والفهرس",
      "impactNone": "لم تغيّر شيئًا بعد",
      "impactPack": "يتغيّر: حزمة الإيداع فقط",
      "impactNote": "نراجع مذكرتك حسب ملاحظتك، وتظهر الصفحات التي تغيّرت بعد الانتهاء.",
      "nextVersion": "نسخة جديدة ({{n}})",
      "cta": "أعد الإصلاح مجانًا",
      "ctaStatus": "أعد الإصلاح"
    },
    "restore": {
      "title": "استرجاع النسخة {{n}}؟",
      "body": "ستصبح نسخة جديدة ({{next}}) في أعلى السجل. النسخ الأخرى تبقى كما هي.",
      "bodyEdited": "عدّلتَ مذكرتك في Kwill بعد آخر نسخة. نحفظ تعديلاتك، ويمكنك استعادتها بزر التراجع في المحرر.",
      "confirm": "استرجع",
      "cancel": "إلغاء",
      "failed": "لم نتمكن من الاسترجاع الآن. جرّب بعد قليل."
    }
  }
```

`locales/fr.json`:
```json
  "rescueV2": {
    "drawerRow": "Sauver mon mémoire",
    "unavailable": "La remise en forme n'est pas disponible pour le moment. Réessayez plus tard.",
    "common": {
      "back": "Retour",
      "retry": "Réessayer",
      "cancel": "Annuler",
      "contactSupport": "Contacter le support",
      "page": "Page {{page}}",
      "pageOf": "Page {{page}} sur {{total}}",
      "version": "Version {{n}}",
      "somethingWrong": "Un souci de notre côté, votre fichier est en sécurité. Réessayez dans un instant.",
      "waitingWord": "Votre tour approche. Vous pouvez fermer l'application : nous vous préviendrons.",
      "waitingBrain": "Nous lisons votre mémoire avec soin. Cela peut prendre quelques minutes, vous pouvez fermer l'application.",
      "etaMinutes": "environ {{minutes}} min",
      "etaSoon": "moins d'une minute",
      "langAr": "العربية",
      "langFr": "Français",
      "langEn": "English"
    },
    "card": {
      "title": "Sauvez la mise en page de votre mémoire",
      "body": "Envoyez votre fichier Word et voyez ce que nous corrigerons, gratuitement.",
      "bodyStatus": "Envoyez votre fichier Word et voyez ce que nous corrigerons.",
      "cta": "Commencer",
      "continue": "Reprendre la remise en forme",
      "ready": "Votre mémoire est prêt"
    },
    "start": {
      "title": "Sauvez la mise en page de votre mémoire",
      "body": "Envoyez votre fichier Word : nous le diagnostiquons gratuitement selon les règles de votre faculté.",
      "bodyStatus": "Envoyez votre fichier Word : nous le diagnostiquons selon les règles de votre faculté.",
      "trustFree": "Le diagnostic est gratuit",
      "trustFreeStatus": "Un diagnostic complet selon les règles de votre faculté",
      "trustWords": "Aucun mot de votre texte ne change",
      "trustOriginal": "Votre fichier d'origine reste conservé",
      "cta": "Choisir le fichier du mémoire",
      "severalHint": "Votre mémoire est en plusieurs fichiers ? Choisissez-les tous ensemble.",
      "share": "ou partagez-le directement depuis WhatsApp ou Telegram",
      "notDocx": "Ce fichier n'est pas au format Word (.docx). Enregistrez-le dans ce format puis réessayez.",
      "tooLarge": "Ce fichier est trop volumineux ({{mb}} Mo maximum).",
      "tooMany": "12 parties au maximum.",
      "dailyLimit": "Vous avez utilisé les diagnostics disponibles aujourd'hui. Revenez demain, nous serons là.",
      "busy": "Beaucoup de monde en ce moment. Réessayez dans un instant.",
      "inProgress": "Un mémoire est déjà en cours de diagnostic. Terminons-le d'abord."
    },
    "parts": {
      "title": "Les parties de votre mémoire",
      "body": "Voici l'ordre que nous proposons. Faites glisser une partie pour la déplacer.",
      "proposing": "Nous lisons le début de chaque partie pour proposer un ordre…",
      "continues": "Suite de la partie précédente",
      "cta": "L'ordre est bon, continuer",
      "nothingAdded": "Nous fusionnons les parties sans rien ajouter.",
      "roles": {
        "cover": "Page de garde",
        "front-matter": "Premières pages",
        "introduction": "Introduction",
        "chapter": "Chapitre",
        "conclusion": "Conclusion",
        "bibliography": "Bibliographie",
        "annex": "Annexes",
        "other": "Autre partie"
      }
    },
    "reading": {
      "title": "Nous lisons votre mémoire",
      "fileSize": "{{mb}} Mo",
      "stepUpload": "Envoi du fichier",
      "stepRead": "Lecture des pages",
      "stepUnderstand": "Compréhension de la structure",
      "merging": "Nous fusionnons les parties sans rien ajouter",
      "converting": "Nous transformons votre fichier en pages",
      "uploadLost": "L'envoi du fichier n'est pas allé au bout, et nous n'en avons rien gardé. Choisissez-le à nouveau.",
      "uploadAgain": "Choisir à nouveau le fichier"
    },
    "whichRules": {
      "title": "Selon les règles de quelle faculté ?",
      "fromProfile": "Depuis votre profil",
      "change": "Changer",
      "pickUniversity": "Choisissez votre université",
      "guideTitle": "Vous avez le guide du département ?",
      "guideBody": "Photographiez-le ou envoyez-le pour un diagnostic plus précis",
      "optional": "Facultatif",
      "profileOffer": "Appliquer les règles de {{name}} ?",
      "profileYes": "Oui, les appliquer",
      "profileNo": "Non, règles générales",
      "guideCamera": "Prendre une photo",
      "guideFile": "Choisir un fichier",
      "guideReading": "Nous lisons le guide…",
      "guideRead": "Guide lu ✓",
      "guideFailed": "Nous n'avons pas pu lire le guide. Essayez une photo plus nette, ou continuez sans.",
      "guideRemove": "Retirer",
      "cta": "Diagnostiquer mon mémoire gratuitement",
      "ctaStatus": "Diagnostiquer mon mémoire"
    },
    "notes": {
      "title": "Parlez à Kwill de votre mémoire",
      "placeholder": "Exemple : dédicace et remerciements sans numéro. Mon encadreur veut les titres de chapitre en taille 18.",
      "understood": "Ce que nous avons compris",
      "parsing": "Nous lisons votre note…",
      "parseFailed": "Nous n'avons pas pu lire votre note pour l'instant. Elle reste enregistrée et nous en tiendrons compte.",
      "conflict": "{{label}} : guide {{guide}} · votre note {{note}}",
      "conflictMine": "Ma note ({{value}})",
      "conflictGuide": "Guide du département ({{value}})",
      "pickOne": "Choisissez une valeur pour continuer",
      "refusedWords": "Nous ne changeons jamais vos mots, nous n'appliquerons donc pas : {{label}}",
      "refusedChecks": "Nous vérifions toujours chaque mémoire, nous n'appliquerons donc pas : {{label}}",
      "refusedDeposit": "Cela ne respecte pas les règles de dépôt, nous n'appliquerons donc pas : {{label}}",
      "refusedUnsupported": "C'est noté, mais nous ne pouvons pas l'appliquer : {{label}}",
      "waitGuide": "Nous finissons de lire le guide…",
      "cta": "Continuer",
      "skip": "Passer"
    },
    "understood": {
      "titleWorking": "Nous comprenons votre mémoire…",
      "title": "Nous avons compris votre mémoire",
      "pages": "pages",
      "chapters": "chapitres",
      "figures": "figures",
      "tables": "tableaux",
      "footnotes": "notes",
      "cover": "page de garde",
      "typeLine": "Type : {{format}} · nous le comparons aux règles de votre faculté…",
      "format": { "classic": "mémoire classique", "imrad": "mémoire IMRAD", "1275": "mémoire start-up (1275)" }
    },
    "diagnosis": {
      "title": "Points à corriger : {{count}}",
      "sub": "Selon les règles de votre faculté · touchez un point pour le voir",
      "before": "Avant",
      "after": "Après",
      "cta": "Corriger mon mémoire",
      "ctaStatus": "Continuer",
      "fine": "Un seul paiement · reprise gratuite après les corrections de votre encadreur",
      "yours": "Il vous reste :",
      "chips": {
        "headings": "Titres",
        "cover": "Page de garde",
        "toc": "Sommaire",
        "numbering": "Numérotation",
        "figures": "Figures",
        "text": "Police",
        "structure": "Structure"
      },
      "problems": {
        "margins": "Les marges ne suivent pas les règles de votre faculté. Nous les ajusterons.",
        "page-size": "La page n'est pas au format A4. Nous l'ajusterons.",
        "body-font": "La police du texte n'est pas celle demandée ({{expected}}). Nous l'unifierons.",
        "body-size": "La taille du texte n'est pas celle demandée ({{expected}}). Nous l'ajusterons.",
        "line-spacing": "L'interligne n'est pas celui demandé ({{expected}}). Nous l'ajusterons.",
        "alignment": "Certains paragraphes ne sont pas justifiés. Nous les unifierons.",
        "headings-not-real": "Ce titre est écrit comme du texte normal. Nous en ferons un vrai titre.",
        "heading-skip": "Les niveaux de titre sautent un niveau ici. Nous vous le signalons.",
        "heading-size": "La taille de ce titre n'est pas celle demandée. Nous l'ajusterons.",
        "toc-missing": "Il n'y a pas de sommaire. Nous en ajouterons un, cliquable.",
        "toc-typed": "Le sommaire est tapé à la main. Nous en ferons un vrai sommaire cliquable.",
        "captions-typed": "Cette légende est tapée à la main. Nous en ferons une vraie légende numérotée.",
        "caption-position": "Cette légende n'est pas à sa place habituelle. Nous l'y mettrons.",
        "figure-no-caption": "Cette figure n'a pas de légende. Nous vous le signalons.",
        "table-no-caption": "Ce tableau n'a pas de légende. Nous vous le signalons.",
        "list-of-figures-missing": "Il n'y a pas de liste des figures. Nous l'ajouterons.",
        "list-of-tables-missing": "Il n'y a pas de liste des tableaux. Nous l'ajouterons.",
        "typed-notes": "Cette note est tapée en bas de page comme du texte. Nous en ferons une vraie note.",
        "page-numbers": "La numérotation ne suit pas les règles. Nous l'ajusterons.",
        "blank-pages": "Cette page est vide. Nous la retirerons.",
        "heading-at-page-end": "Ce titre reste seul en bas de page. Nous le garderons avec la suite.",
        "spacing-by-empty-lines": "Ces espaces sont faits de lignes vides. Nous les nettoierons.",
        "cover-missing": "Il n'y a pas de page de garde. Nous en créerons une.",
        "section-missing": "Il manque cette partie : {{sectionName}}. Nous l'ajouterons si possible.",
        "section-empty": "Cette partie est vide : {{sectionName}}. Sa rédaction vous revient.",
        "font-not-portable": "La police {{fonts}} risque de ne pas s'afficher sur le PC de l'imprimerie. Nous la remplacerons par une police adaptée.",
        "font-symbol-not-portable": "La police {{fonts}} est une police de symboles qui risque de ne pas s'afficher à l'imprimerie. Vérifiez les endroits où elle apparaît.",
        "typography": "Les espaces autour de la ponctuation sont à ajuster. Nous les nettoierons sans changer vos mots."
      },
      "sections": {
        "cover": "page de garde",
        "dedication": "dédicace",
        "thanks": "remerciements",
        "abstract": "résumé",
        "toc": "sommaire",
        "list-of-figures": "liste des figures",
        "list-of-tables": "liste des tableaux",
        "abbreviations": "liste des abréviations",
        "introduction": "introduction",
        "conclusion": "conclusion",
        "bibliography": "bibliographie",
        "annexes": "annexes"
      }
    },
    "preview": {
      "title": "Voici à quoi ressemblera votre mémoire",
      "body": "Deux vraies pages de votre fichier après correction : la page de garde et le début du premier chapitre.",
      "bodyCoverOnly": "Une vraie page de votre fichier après correction : la page de garde.",
      "unavailable": "Nous n'avons pas pu préparer l'aperçu cette fois. Le diagnostic ci-dessus reste juste.",
      "pill": "Vos mots, la mise en page de votre faculté"
    },
    "payment": {
      "title": "Remise en forme d'un mémoire",
      "price": "{{price}} DA",
      "once": "paiement unique",
      "inc1": "Mise en page complète selon les règles de votre faculté",
      "inc2": "Page de garde et PDF prêt pour le dépôt",
      "inc3": "Les deux formulaires et la fiche des résumés",
      "inc4": "Reprise gratuite jusqu'à la soutenance",
      "manual": "BaridiMob / CCP",
      "manualSub": "virement",
      "card": "Edahabia / CIB",
      "cardSub": "carte",
      "cta": "Payer et commencer",
      "subscriber": "Abonné ? La remise en forme est incluse",
      "safe": "Aucun mot de votre texte ne change · votre fichier d'origine reste conservé",
      "confirming": "Nous vérifions votre paiement…",
      "underReviewTitle": "Votre paiement est en cours de vérification",
      "underReviewBody": "Nous vous préviendrons dès qu'il sera confirmé, puis nous continuerons ensemble.",
      "rejectedTitle": "Nous n'avons pas pu confirmer votre paiement",
      "tryAgain": "Renvoyer",
      "cardNotFinished": "Le paiement n'est pas allé au bout, rien n'a été débité.",
      "cardRetry": "Paiement non terminé ? Réessayer",
      "notForSale": "La remise en forme n'est pas disponible pour le moment. Réessayez plus tard.",
      "statusTitle": "La remise en forme de ce mémoire n'est pas encore activée",
      "statusBody": "Son état est lié à votre compte Kwill et vous suit sur tous vos appareils.",
      "statusRefresh": "Actualiser l'état",
      "statusBack": "Retour"
    },
    "rules": {
      "title": "Les règles de votre faculté",
      "fromGuide": "Lues dans le guide de votre département ✓",
      "fromNote": "De votre note",
      "cta": "C'est bon, continuer",
      "rows": {
        "font": "Police",
        "headings": "Titres de chapitre",
        "spacing": "Interligne",
        "margins": "Marges (cm)",
        "numbering": "Numérotation",
        "footnotes": "Notes de bas de page",
        "deposit": "Dépôt",
        "additions": "Ajouts"
      },
      "fields": {
        "bodyFont": "Police",
        "bodySize": "Taille",
        "alignment": "Alignement du texte",
        "lineSpacing": "Interligne",
        "h1Size": "Titres de chapitre",
        "h2Size": "Sous-titres",
        "h3Size": "Petits titres",
        "headingBold": "Titres en gras",
        "marginTop": "Haut",
        "marginBottom": "Bas",
        "marginBinding": "Côté reliure",
        "marginOpposite": "Côté opposé",
        "bindingSide": "Reliure à",
        "frontMatter": "Premières pages",
        "pagePosition": "Place du numéro",
        "footnoteSize": "Taille des notes",
        "deposit": "Mode de dépôt",
        "captionNumbers": "Numéroter les légendes",
        "dividers": "Une page de séparation avant chaque chapitre",
        "frames": "Un cadre sur la dédicace et les remerciements",
        "referencesSort": "Trier et regrouper les références",
        "secondFont": "Police de l'autre langue",
        "secondSize": "Taille de l'autre langue",
        "noNumberDedication": "Dédicace sans numéro de page",
        "noNumberThanks": "Remerciements sans numéro de page",
        "keepTables": "Garder mes tableaux tels quels"
      },
      "hints": {
        "captionNumbers": "Nous ajoutons un numéro aux légendes qui n'en ont pas, sans changer vos mots.",
        "dividers": "Pas ajoutées si vous avez déjà les vôtres.",
        "frames": "Pas ajouté si la page contient un dessin.",
        "referencesSort": "Ouvrages, articles, mémoires, sites. Aucun mot ne change.",
        "captionNumbersCount": "Légendes qui recevront un numéro : {{count}}",
        "keepTables": "Nous ne touchons pas à l'aspect de vos tableaux ; leurs légendes restent numérotées."
      },
      "values": {
        "justify": "Justifié",
        "start": "Aligné au début",
        "left": "Gauche",
        "right": "Droite",
        "roman": "i ii iii puis 1 2 3",
        "letters": "a b c puis 1 2 3",
        "arabic": "1 2 3 dès le début",
        "none": "Sans numéro avant le corps",
        "bottom-center": "En bas au centre",
        "bottom-outside": "En bas à l'extérieur",
        "platform_pdf": "PDF sur la plateforme",
        "pdf_word": "PDF et Word",
        "copies_cd": "Exemplaires et CD"
      },
      "outOfRange": "Cette valeur sort de l'habituel."
    },
    "question": {
      "counter": "Question {{n}} sur {{total}}",
      "decide": "Je ne sais pas, Kwill décide"
    },
    "cover": {
      "title": "Vérifiez les informations de la page de garde",
      "titleMissing": "Il nous manque quelques informations",
      "keep": "Votre page de garde telle quelle ✓",
      "clean": "Votre page de garde nettoyée",
      "generated": "Modèle algérien standard",
      "fieldTitle": "Titre",
      "fieldStudents": "Étudiant",
      "fieldSupervisor": "Encadreur",
      "fieldYear": "Année",
      "fieldUniversity": "Université",
      "fieldFaculty": "Faculté",
      "fieldDepartment": "Département",
      "fieldDegree": "Diplôme",
      "fieldSpecialty": "Spécialité",
      "fieldSubtitle": "Sous-titre",
      "fieldField": "Filière",
      "fieldCoSupervisor": "Co-encadreur",
      "fieldJury": "Membres du jury",
      "formsOnly": "Votre page de garde reste telle que vous l'avez écrite. Ces informations servent seulement aux formulaires de dépôt. Pour la changer, choisissez le modèle algérien.",
      "more": "Autres informations",
      "add": "Ajouter",
      "fromProfile": "De votre profil",
      "fromCatalogue": "De la liste des universités",
      "editTitle": "Modifier : {{label}}",
      "save": "Enregistrer",
      "cta": "Lancer la remise en forme",
      "needed": "Ajoutez : {{label}}"
    },
    "repairing": {
      "title": "Nous construisons la nouvelle mise en page",
      "stepOf": "Étape {{n}} sur {{total}}",
      "safe": "Vous pouvez fermer l'application : nous vous préviendrons",
      "steps": {
        "prepare": "Préparation d'une copie de travail",
        "styles": "Polices et titres",
        "typography": "Corrections typographiques",
        "sections": "Parties et numéros de page",
        "cover": "Page de garde et pages de séparation",
        "toc": "Sommaire et liste des figures",
        "captions": "Légendes et références",
        "check": "Vérification de chaque page"
      }
    },
    "result": {
      "title": "Votre mémoire est prêt",
      "stats": "Pages : {{pages}} · Corrections : {{fixes}} · chaque page vérifiée",
      "words": "Aucun mot de votre texte n'a changé · votre fichier d'origine reste conservé",
      "packTitle": "Dossier de dépôt",
      "packFiles": {
        "thesis-pdf": "PDF",
        "thesis-docx": "Word",
        "abstract-sheet": "Fiche des résumés",
        "integrity-declaration": "Déclaration d'intégrité",
        "deposit-authorisation": "Autorisation de dépôt",
        "cd-note": "Note pour le CD"
      },
      "packNoAbstracts": "Pas de fiche des résumés : nous n'avons pas trouvé de résumé dans votre mémoire.",
      "packOmitted": "Nous n'avons pas pu préparer : {{files}}. Vous pouvez les reconstruire.",
      "packMissing": "Nous n'avons pas pu préparer le dossier de dépôt cette fois. Votre mémoire est prêt et vérifié.",
      "packRebuild": "Reconstruire le dossier",
      "share": "Partager",
      "changed": "Qu'est-ce qui a changé ? ({{count}})",
      "open": "Ouvrir dans Kwill pour continuer à écrire",
      "history": "Historique",
      "revisions": "Des corrections de votre encadreur ?",
      "notPublished": "Vous avez modifié votre mémoire pendant notre travail, nous gardons vos modifications. Cette version reste dans l'historique.",
      "downloadFailed": "Le téléchargement n'a pas abouti. Réessayez."
    },
    "changed": {
      "title": "Ce qui a changé",
      "more": "Afficher plus",
      "groups": {
        "cover": "Page de garde",
        "toc": "Sommaire et listes",
        "headings": "Titres",
        "captions": "Légendes",
        "numbering": "Numérotation",
        "pages": "Pages",
        "references": "Références",
        "notes": "Notes",
        "fonts": "Polices",
        "typography": "Corrections typographiques",
        "other": "Autres changements"
      },
      "items": {
        "cover_generated": "Page de garde créée sur le modèle algérien",
        "cover_cleaned": "Lignes de la page de garde centrées, une seule police",
        "toc_real": "Un vrai sommaire cliquable à la place du sommaire tapé",
        "toc_added": "Sommaire cliquable ajouté",
        "toc_rebuilt": "Sommaire refait avec les nouveaux numéros de page",
        "caption_word_as_label": "Le mot « Tableau » ou « Figure » en tête de légende est devenu son libellé : {{count}}",
        "comments_removed": "Commentaires de relecture retirés des parties : {{count}}",
        "list_added": "Liste des figures ou des tableaux ajoutée",
        "heading_real": "« {{text}} » est devenu un vrai titre",
        "captions_real": "Légendes devenues de vraies légendes numérotées : {{count}}",
        "caption_number_added": "Numéro ajouté à des légendes : {{count}}",
        "caption_renumbered": "Numéros de légende corrigés : {{count}}",
        "captions_moved": "Légendes remises à leur place : {{count}}",
        "page_numbers": "Numérotation des pages ajustée",
        "running_heads": "Titre du chapitre en haut de page, parties : {{count}}",
        "chapters_new_page": "Chaque chapitre commence sur une nouvelle page, parties : {{count}}",
        "rules_applied": "Police, interligne et marges selon les règles de votre faculté",
        "empty_removed": "Lignes vides retirées : {{count}}",
        "manual_breaks_removed": "Sauts de page manuels retirés : {{count}}",
        "review_fixes": "Pages relues et détails ajustés : {{count}}",
        "divider_added": "Page de séparation ajoutée avant le chapitre",
        "frame_added": "Cadre ajouté à la page",
        "references_sorted": "Références triées et regroupées : {{count}}",
        "notes_converted": "Notes tapées devenues de vraies notes : {{count}}",
        "fonts_embedded": "Polices intégrées au fichier : {{count}}",
        "font_swapped": "Police {{from}} remplacée par {{to}}",
        "typo_space_before_punct": "Espace avant la ponctuation, endroits : {{count}}",
        "typo_space_after_comma": "Espace après la virgule, endroits : {{count}}",
        "typo_tatweel": "Étirements retirés, endroits : {{count}}",
        "typo_nbsp_before_punct": "Espace avant la ponctuation française, endroits : {{count}}",
        "typo_nbsp_after_guillemet": "Espace après le guillemet, endroits : {{count}}",
        "typo_space_after_punct": "Espace après la ponctuation, endroits : {{count}}",
        "typo_collapse_spaces": "Espaces en trop, endroits : {{count}}",
        "other_change": "Autres changements : {{count}}"
      }
    },
    "revisions": {
      "title": "Une nouvelle version de votre mémoire",
      "free": "Gratuit",
      "body": "Nous ne revérifions que les pages qui ont changé, et vos réponses restent.",
      "changedPages": "Pages modifiées : {{count}}",
      "editedInKwill": "Vous avez modifié votre mémoire dans Kwill : nous en tiendrons compte.",
      "pickFile": "Envoyer la nouvelle version",
      "fileChosen": "{{name}}",
      "supervisorLabel": "Qu'a demandé votre encadreur ?",
      "supervisorPlaceholder": "Exemple : titres de chapitre en taille 18, notes de bas de page en 12.",
      "keepAnswers": "Nous ne reposerons pas les questions déjà répondues",
      "cta": "Reprendre gratuitement",
      "ctaStatus": "Reprendre",
      "differentThesis": "Ce fichier semble être un autre mémoire. Pour le remettre en forme, commencez une nouvelle remise en forme.",
      "startNew": "Commencer une nouvelle remise en forme",
      "editedNotInFile": "Vous avez modifié votre mémoire dans Kwill. Ces modifications ne sont pas dans le fichier choisi ; nous les gardons dans l'historique.",
      "askReview": "Demander à l'équipe de regarder",
      "reviewSent": "Demande reçue, l'équipe examine le fichier.",
      "expired": "La période de reprise de ce mémoire est terminée.",
      "dailyCap": "Beaucoup de reprises aujourd'hui. Revenez demain."
    },
    "failure": {
      "title": "Nous n'avons pas terminé",
      "body": "Nous avons trouvé quelque chose que nous ne pouvions pas corriger sans risque. Nous ne vous livrerons pas un fichier incomplet.",
      "bodyPage": "À la page {{page}}, nous avons trouvé quelque chose que nous ne pouvions pas corriger sans risque. Nous ne vous livrerons pas un fichier incomplet.",
      "bodyOpen": "Nous n'avons pas pu ouvrir ce fichier. Enregistrez-le depuis Word au format .docx puis réessayez.",
      "bodyBig": "Ce mémoire est plus volumineux que ce que nous pouvons traiter pour l'instant. L'équipe Kwill vous aidera.",
      "bodyMerge": "Nous n'avons pas pu fusionner les parties sans rien y changer. L'équipe Kwill vous aidera.",
      "bodyWait": "Nous n'avons pas pu terminer à temps. L'équipe Kwill vous aidera.",
      "trustOriginal": "Votre fichier d'origine est intact",
      "refundDue": "Nous allons vous rembourser",
      "refundDone": "Nous vous avons remboursé",
      "refundDueStatus": "L'équipe Kwill vous contactera au sujet de ce que vous avez réglé pour ce mémoire",
      "refundDoneStatus": "Ce que vous aviez réglé pour ce mémoire a été rendu",
      "noCharge": "Rien ne vous a été débité",
      "previousSafe": "Votre version précédente (version {{n}}) reste intacte",
      "team": "L'équipe Kwill examine le fichier",
      "ok": "D'accord",
      "tryAnother": "Essayer un autre fichier"
    },
    "library": {
      "title": "Mes mémoires",
      "versionMeta": "Version {{n}} · {{date}}",
      "ready": "Prêt pour le dépôt",
      "diagnosed": "Diagnostic prêt",
      "working": "En cours",
      "failed": "Non terminé",
      "history": "Historique",
      "open": "Ouvrir",
      "rerun": "Reprendre",
      "new": "Nouveau mémoire",
      "continue": "Continuer",
      "draftMeta": "Modifié {{date}}",
      "hint": "L'historique s'ouvre aussi depuis l'écran de résultat ou le menu latéral",
      "delete": "Supprimer ce diagnostic",
      "deleteConfirm": "Le fichier et le diagnostic seront supprimés définitivement."
    },
    "timeline": {
      "title": "Historique de votre mémoire",
      "current": "actuelle",
      "badgeCurrent": "Version {{n}} · actuelle",
      "badge": "Version {{n}} · {{date}}",
      "edited": "Modifié dans l'éditeur Kwill",
      "editedBlocks": "Modifié dans l'éditeur Kwill · paragraphes : {{count}}",
      "original": "Le fichier d'origine",
      "originalKept": "toujours conservé",
      "originalMeta": "{{date}} · tel que vous l'avez envoyé",
      "triggers": {
        "first_diagnosis": "Le fichier d'origine",
        "first_rescue": "Première remise en forme",
        "rules_edited": "Après modification des règles",
        "supervisor_note": "Après les remarques de l'encadreur",
        "new_file": "Après l'envoi d'une nouvelle version",
        "edited_in_kwill": "Après vos modifications dans Kwill",
        "restored": "Restauration de la version {{n}}",
        "staff_retry": "Reprise par l'équipe Kwill",
        "pack_rebuilt": "Dossier de dépôt reconstruit"
      },
      "meta": "{{date}} · Corrections : {{fixes}}",
      "metaPages": "{{date}} · Pages modifiées : {{count}}",
      "metaFailed": "{{date}} · non terminée",
      "cta": "Modifier et reprendre",
      "fine": "Gratuit jusqu'à la soutenance"
    },
    "version": {
      "meta": "{{date}} · Corrections : {{fixes}} · Pages : {{pages}}",
      "pdf": "Télécharger le PDF",
      "word": "Télécharger le Word",
      "wordMerged": "Télécharger le fichier fusionné (Word)",
      "partsTitle": "Les parties telles que vous les avez envoyées",
      "compare": "Comparer à une autre version",
      "changed": "Ce qui a changé ({{count}})",
      "open": "Ouvrir dans Kwill pour modifier",
      "restore": "Restaurer cette version",
      "pickCompare": "Choisissez une version à comparer"
    },
    "compare": {
      "title": "Version {{a}} → version {{b}}",
      "changedCount": "Pages modifiées : {{count}}",
      "pager": "Page {{page}} · {{i}} sur {{total}}",
      "same": "Aucune différence entre ces deux versions."
    },
    "editRerun": {
      "title": "Modifier puis reprendre",
      "rules": "Règles",
      "notes": "Vos notes",
      "notesCount": "Notes : {{count}}",
      "answers": "Vos réponses",
      "answersCount": "Réponses : {{count}}",
      "cover": "Page de garde",
      "edit": "Modifier",
      "close": "Fermer",
      "impactAll": "Change : toutes les pages",
      "impactPages": "Change : pages {{pages}}",
      "impactToc": "et le sommaire",
      "impactNone": "Rien de modifié pour l'instant",
      "impactPack": "Ce qui change : le dossier de dépôt seulement",
      "impactNote": "Nous reprenons votre mémoire selon votre note ; les pages modifiées s'afficheront à la fin.",
      "nextVersion": "Nouvelle version ({{n}})",
      "cta": "Reprendre gratuitement",
      "ctaStatus": "Reprendre"
    },
    "restore": {
      "title": "Restaurer la version {{n}} ?",
      "body": "Elle deviendra une nouvelle version ({{next}}) en haut de l'historique. Les autres restent telles quelles.",
      "bodyEdited": "Vous avez modifié votre mémoire dans Kwill depuis la dernière version. Nous gardons ces modifications : le bouton Annuler de l'éditeur les ramène.",
      "confirm": "Restaurer",
      "cancel": "Annuler",
      "failed": "La restauration n'a pas abouti. Réessayez dans un instant."
    }
  }
```

`locales/en.json`:
```json
  "rescueV2": {
    "drawerRow": "Rescue my thesis",
    "unavailable": "The repair isn't available right now. Please try later.",
    "common": {
      "back": "Back",
      "retry": "Try again",
      "cancel": "Cancel",
      "contactSupport": "Contact support",
      "page": "Page {{page}}",
      "pageOf": "Page {{page}} of {{total}}",
      "version": "Version {{n}}",
      "somethingWrong": "Something went wrong on our side, and your file is safe. Please try again shortly.",
      "waitingWord": "Your turn is coming. You can close the app; we'll notify you.",
      "waitingBrain": "We're reading your thesis carefully. This can take a few minutes, and you can safely close the app.",
      "etaMinutes": "about {{minutes}} min",
      "etaSoon": "under a minute",
      "langAr": "العربية",
      "langFr": "Français",
      "langEn": "English"
    },
    "card": {
      "title": "Rescue your thesis formatting",
      "body": "Upload your Word file and see what we'd fix, for free.",
      "bodyStatus": "Upload your Word file and see what we'd fix.",
      "cta": "Start",
      "continue": "Continue your thesis repair",
      "ready": "Your thesis is ready"
    },
    "start": {
      "title": "Rescue your thesis formatting",
      "body": "Upload your Word file and we'll check it for free against your faculty's rules.",
      "bodyStatus": "Upload your Word file and we'll check it against your faculty's rules.",
      "trustFree": "The check is free",
      "trustFreeStatus": "A full check against your faculty's rules",
      "trustWords": "We won't change a word of your text",
      "trustOriginal": "Your original file stays kept",
      "cta": "Choose your thesis file",
      "severalHint": "Thesis in several files? Choose them all together.",
      "share": "or share it directly from WhatsApp or Telegram",
      "notDocx": "This file isn't a Word file (.docx). Save it in that format and try again.",
      "tooLarge": "This file is too large ({{mb}} MB at most).",
      "tooMany": "12 parts at most.",
      "dailyLimit": "You've used today's checks. Come back tomorrow, we'll be here.",
      "busy": "It's busy right now. Please try again shortly.",
      "inProgress": "You already have a thesis being checked. Let's finish that first."
    },
    "parts": {
      "title": "Your parts",
      "body": "Here's the order we suggest. Drag any part to move it.",
      "proposing": "We're reading the start of each part to suggest an order…",
      "continues": "Continues the part above",
      "cta": "The order is right, continue",
      "nothingAdded": "We join the parts without adding anything.",
      "roles": {
        "cover": "Cover",
        "front-matter": "First pages",
        "introduction": "Introduction",
        "chapter": "Chapter",
        "conclusion": "Conclusion",
        "bibliography": "Bibliography",
        "annex": "Annexes",
        "other": "Other part"
      }
    },
    "reading": {
      "title": "We're reading your thesis",
      "fileSize": "{{mb}} MB",
      "stepUpload": "Uploading the file",
      "stepRead": "Reading the pages",
      "stepUnderstand": "Understanding the structure",
      "merging": "Joining the parts without adding anything",
      "converting": "Turning your file into pages",
      "uploadLost": "The upload didn't finish, and we kept nothing of it. Please choose the file again.",
      "uploadAgain": "Choose the file again"
    },
    "whichRules": {
      "title": "Against which faculty's rules?",
      "fromProfile": "From your profile",
      "change": "Change",
      "pickUniversity": "Choose your university",
      "guideTitle": "Have your department's guide?",
      "guideBody": "Photograph or upload it for a sharper check",
      "optional": "Optional",
      "profileOffer": "Use the rules of {{name}}?",
      "profileYes": "Yes, use them",
      "profileNo": "No, the general rules",
      "guideCamera": "Take a photo",
      "guideFile": "Choose a file",
      "guideReading": "We're reading the guide…",
      "guideRead": "Guide read ✓",
      "guideFailed": "We couldn't read the guide. Try a clearer photo, or continue without it.",
      "guideRemove": "Remove",
      "cta": "Check my thesis for free",
      "ctaStatus": "Check my thesis"
    },
    "notes": {
      "title": "Tell Kwill about your thesis",
      "placeholder": "Example: no page numbers on the dedication and thanks. My supervisor wants chapter titles in size 18.",
      "understood": "What we understood",
      "parsing": "We're reading your note…",
      "parseFailed": "We couldn't read your note just now. It stays saved and we'll take it into account.",
      "conflict": "{{label}}: guide {{guide}} · your note {{note}}",
      "conflictMine": "My note ({{value}})",
      "conflictGuide": "Department guide ({{value}})",
      "pickOne": "Pick one value to continue",
      "refusedWords": "We never change your words, so we won't apply: {{label}}",
      "refusedChecks": "We always check every thesis, so we won't apply: {{label}}",
      "refusedDeposit": "This breaks the deposit rules, so we won't apply: {{label}}",
      "refusedUnsupported": "Noted, but we can't apply this: {{label}}",
      "waitGuide": "We're finishing reading the guide…",
      "cta": "Continue",
      "skip": "Skip"
    },
    "understood": {
      "titleWorking": "We're understanding your thesis…",
      "title": "We understand your thesis",
      "pages": "pages",
      "chapters": "chapters",
      "figures": "figures",
      "tables": "tables",
      "footnotes": "footnotes",
      "cover": "cover",
      "typeLine": "Type: {{format}} · now comparing it with your faculty's rules…",
      "format": { "classic": "classic thesis", "imrad": "IMRAD thesis", "1275": "start-up thesis (1275)" }
    },
    "diagnosis": {
      "title": "Things we'll fix: {{count}}",
      "sub": "Under your faculty's rules · tap any dot to see it",
      "before": "Before",
      "after": "After",
      "cta": "Fix my thesis",
      "ctaStatus": "Continue",
      "fine": "One payment · free re-run after your supervisor's changes",
      "yours": "Left for you:",
      "chips": {
        "headings": "Headings",
        "cover": "Cover",
        "toc": "Contents",
        "numbering": "Numbering",
        "figures": "Figures",
        "text": "Font",
        "structure": "Structure"
      },
      "problems": {
        "margins": "The margins don't match your faculty's rules. We'll set them.",
        "page-size": "The page isn't A4. We'll set it.",
        "body-font": "The text font isn't the one asked for ({{expected}}). We'll make it one.",
        "body-size": "The text size isn't the one asked for ({{expected}}). We'll set it.",
        "line-spacing": "The line spacing isn't the one asked for ({{expected}}). We'll set it.",
        "alignment": "Some paragraphs aren't justified. We'll even them out.",
        "headings-not-real": "This heading is typed as plain text. We'll make it a real heading.",
        "heading-skip": "The heading levels jump here. We'll point it out to you.",
        "heading-size": "This heading's size isn't the one asked for. We'll set it.",
        "toc-missing": "There's no table of contents. We'll add one you can tap.",
        "toc-typed": "The table of contents is typed by hand. We'll make it a real one you can tap.",
        "captions-typed": "This caption is typed by hand. We'll make it a real numbered caption.",
        "caption-position": "This caption isn't in its usual place. We'll put it there.",
        "figure-no-caption": "This figure has no caption. We're pointing it out to you.",
        "table-no-caption": "This table has no caption. We're pointing it out to you.",
        "list-of-figures-missing": "There's no list of figures. We'll add it.",
        "list-of-tables-missing": "There's no list of tables. We'll add it.",
        "typed-notes": "This note is typed at the foot of the page as text. We'll make it a real footnote.",
        "page-numbers": "The page numbers don't match the rules. We'll set them.",
        "blank-pages": "This page is empty. We'll remove it.",
        "heading-at-page-end": "This heading sits alone at the foot of the page. We'll keep it with what follows.",
        "spacing-by-empty-lines": "This spacing is made of empty lines. We'll clean it up.",
        "cover-missing": "There's no cover. We'll make one for you.",
        "section-missing": "This part is missing: {{sectionName}}. We'll add it where we can.",
        "section-empty": "This part is empty: {{sectionName}}. Writing it stays with you.",
        "font-not-portable": "The font {{fonts}} may not show on the print shop's PC. We'll swap it for a suitable one.",
        "font-symbol-not-portable": "The font {{fonts}} is a symbol font that may not show at the print shop. Check the places where it appears.",
        "typography": "The spacing around punctuation needs tidying. We'll clean it without changing your words."
      },
      "sections": {
        "cover": "cover",
        "dedication": "dedication",
        "thanks": "thanks",
        "abstract": "abstract",
        "toc": "table of contents",
        "list-of-figures": "list of figures",
        "list-of-tables": "list of tables",
        "abbreviations": "list of abbreviations",
        "introduction": "introduction",
        "conclusion": "conclusion",
        "bibliography": "bibliography",
        "annexes": "annexes"
      }
    },
    "preview": {
      "title": "This is how your thesis will look",
      "body": "Two real pages from your file after the repair: the cover and the start of the first chapter.",
      "bodyCoverOnly": "A real page from your file after the repair: the cover.",
      "unavailable": "We couldn't prepare the preview this time. The check above still holds.",
      "pill": "Your words, your faculty's layout"
    },
    "payment": {
      "title": "Repair one thesis",
      "price": "{{price}} DA",
      "once": "one payment",
      "inc1": "Full layout under your faculty's rules",
      "inc2": "The cover and a PDF ready to deposit",
      "inc3": "The two forms and the abstract sheet",
      "inc4": "Free re-runs until your defense",
      "manual": "BaridiMob / CCP",
      "manualSub": "transfer",
      "card": "Edahabia / CIB",
      "cardSub": "card",
      "cta": "Pay and start",
      "subscriber": "Subscribed? The repair is included in your plan",
      "safe": "We won't change a word of your text · your original file stays kept",
      "confirming": "We're confirming your payment…",
      "underReviewTitle": "Your payment is being checked",
      "underReviewBody": "We'll notify you as soon as it's confirmed, then we'll carry on together.",
      "rejectedTitle": "We couldn't confirm your payment",
      "tryAgain": "Send again",
      "cardNotFinished": "The payment didn't finish, and nothing was charged.",
      "cardRetry": "Didn't finish paying? Try again",
      "notForSale": "The repair isn't available right now. Please try later.",
      "statusTitle": "The repair isn't active for this thesis yet",
      "statusBody": "Its status is linked to your Kwill account and follows you on every device.",
      "statusRefresh": "Refresh status",
      "statusBack": "Back"
    },
    "rules": {
      "title": "Your faculty's rules",
      "fromGuide": "Read from your department's guide ✓",
      "fromNote": "From your note",
      "cta": "Looks right, continue",
      "rows": {
        "font": "Font",
        "headings": "Chapter titles",
        "spacing": "Line spacing",
        "margins": "Margins (cm)",
        "numbering": "Numbering",
        "footnotes": "Footnotes",
        "deposit": "Deposit",
        "additions": "Additions"
      },
      "fields": {
        "bodyFont": "Font",
        "bodySize": "Size",
        "alignment": "Text alignment",
        "lineSpacing": "Line spacing",
        "h1Size": "Chapter titles",
        "h2Size": "Subheadings",
        "h3Size": "Smaller headings",
        "headingBold": "Bold headings",
        "marginTop": "Top",
        "marginBottom": "Bottom",
        "marginBinding": "Binding side",
        "marginOpposite": "Opposite side",
        "bindingSide": "Bound on the",
        "frontMatter": "First pages",
        "pagePosition": "Where the number goes",
        "footnoteSize": "Footnote size",
        "deposit": "How you deposit",
        "captionNumbers": "Number the captions",
        "dividers": "A divider page before each chapter",
        "frames": "A frame on the dedication and thanks",
        "referencesSort": "Sort and group the references",
        "secondFont": "Font for the other language",
        "secondSize": "Size for the other language",
        "noNumberDedication": "No page number on the dedication",
        "noNumberThanks": "No page number on the thanks",
        "keepTables": "Keep my tables as they are"
      },
      "hints": {
        "captionNumbers": "We add a number to captions that have none, without changing your words.",
        "dividers": "Not added if you already have your own.",
        "frames": "Not added if the page holds a drawing.",
        "referencesSort": "Books, articles, theses, websites. Not a word changes.",
        "captionNumbersCount": "Captions that will get a number: {{count}}",
        "keepTables": "We leave the look of your tables alone; their captions stay numbered."
      },
      "values": {
        "justify": "Justified",
        "start": "From the line start",
        "left": "Left",
        "right": "Right",
        "roman": "i ii iii then 1 2 3",
        "letters": "a b c then 1 2 3",
        "arabic": "1 2 3 from the start",
        "none": "No numbers before the body",
        "bottom-center": "Bottom centre",
        "bottom-outside": "Bottom outer edge",
        "platform_pdf": "PDF on the platform",
        "pdf_word": "PDF and Word",
        "copies_cd": "Printed copies and a CD"
      },
      "outOfRange": "That value is outside the usual range."
    },
    "question": {
      "counter": "Question {{n}} of {{total}}",
      "decide": "Not sure, let Kwill decide"
    },
    "cover": {
      "title": "Check the details on your cover",
      "titleMissing": "We need a few details for the cover",
      "keep": "Your cover as it is ✓",
      "clean": "Your cover, cleaned",
      "generated": "Algerian standard cover",
      "fieldTitle": "Title",
      "fieldStudents": "Student",
      "fieldSupervisor": "Supervisor",
      "fieldYear": "Year",
      "fieldUniversity": "University",
      "fieldFaculty": "Faculty",
      "fieldDepartment": "Department",
      "fieldDegree": "Degree",
      "fieldSpecialty": "Specialty",
      "fieldSubtitle": "Subtitle",
      "fieldField": "Programme",
      "fieldCoSupervisor": "Co-supervisor",
      "fieldJury": "Jury members",
      "formsOnly": "Your cover stays as you wrote it. These details only go on the deposit forms. To change the cover, pick the Algerian standard.",
      "more": "More details",
      "add": "Add",
      "fromProfile": "From your profile",
      "fromCatalogue": "From the university list",
      "editTitle": "Edit: {{label}}",
      "save": "Save",
      "cta": "Start the repair",
      "needed": "Add: {{label}}"
    },
    "repairing": {
      "title": "We're building the new layout",
      "stepOf": "Step {{n}} of {{total}}",
      "safe": "You can safely close the app; we'll notify you",
      "steps": {
        "prepare": "Preparing a working copy",
        "styles": "Fonts and headings",
        "typography": "Typographic fixes",
        "sections": "Parts and page numbers",
        "cover": "Cover and divider pages",
        "toc": "Contents and list of figures",
        "captions": "Captions and references",
        "check": "Checking every page"
      }
    },
    "result": {
      "title": "Your thesis is ready",
      "stats": "Pages: {{pages}} · Fixes: {{fixes}} · every page checked",
      "words": "Not a word of your text changed · your original file stays kept",
      "packTitle": "Deposit pack",
      "packFiles": {
        "thesis-pdf": "PDF",
        "thesis-docx": "Word",
        "abstract-sheet": "Abstract sheet",
        "integrity-declaration": "Integrity declaration",
        "deposit-authorisation": "Deposit authorisation",
        "cd-note": "CD note"
      },
      "packNoAbstracts": "No abstract sheet: we found no abstracts in your thesis.",
      "packOmitted": "We couldn't prepare: {{files}}. You can rebuild them.",
      "packMissing": "We couldn't build your deposit pack this time. Your thesis is ready and checked.",
      "packRebuild": "Rebuild the pack",
      "share": "Share",
      "changed": "What changed? ({{count}})",
      "open": "Open in Kwill to keep writing",
      "history": "History",
      "revisions": "Changes from your supervisor?",
      "notPublished": "You edited your thesis while we worked, so we kept your edits. This version stays in your history.",
      "downloadFailed": "The download didn't finish. Please try again."
    },
    "changed": {
      "title": "What changed",
      "more": "Show more",
      "groups": {
        "cover": "Cover",
        "toc": "Contents and lists",
        "headings": "Headings",
        "captions": "Captions",
        "numbering": "Numbering",
        "pages": "Pages",
        "references": "References",
        "notes": "Footnotes",
        "fonts": "Fonts",
        "typography": "Typographic fixes",
        "other": "Other changes"
      },
      "items": {
        "cover_generated": "Made a cover on the Algerian standard",
        "cover_cleaned": "Centred the cover's lines in one font",
        "toc_real": "A real contents you can tap, instead of the typed one",
        "toc_added": "Added a contents you can tap",
        "toc_rebuilt": "Rebuilt the contents with the new page numbers",
        "caption_word_as_label": "The word \"Table\" or \"Figure\" opening a caption became its label: {{count}}",
        "comments_removed": "Review comments removed from the parts: {{count}}",
        "list_added": "Added a list of figures or tables",
        "heading_real": "“{{text}}” became a real heading",
        "captions_real": "Captions turned into real numbered ones: {{count}}",
        "caption_number_added": "Number added to captions: {{count}}",
        "caption_renumbered": "Caption numbers corrected: {{count}}",
        "captions_moved": "Captions put in their place: {{count}}",
        "page_numbers": "Set the page numbers",
        "running_heads": "Chapter title at the top of the page, parts: {{count}}",
        "chapters_new_page": "Each chapter starts on a new page, parts: {{count}}",
        "rules_applied": "Font, spacing and margins under your faculty's rules",
        "empty_removed": "Empty lines removed: {{count}}",
        "manual_breaks_removed": "Hand-made page breaks removed: {{count}}",
        "review_fixes": "Pages looked over and details set: {{count}}",
        "divider_added": "Added a divider page before the chapter",
        "frame_added": "Added a frame to the page",
        "references_sorted": "References sorted and grouped: {{count}}",
        "notes_converted": "Typed notes turned into real footnotes: {{count}}",
        "fonts_embedded": "Fonts embedded in the file: {{count}}",
        "font_swapped": "Font {{from}} replaced by {{to}}",
        "typo_space_before_punct": "Space before punctuation, places: {{count}}",
        "typo_space_after_comma": "Space after a comma, places: {{count}}",
        "typo_tatweel": "Stretched letters removed, places: {{count}}",
        "typo_nbsp_before_punct": "Space before French punctuation, places: {{count}}",
        "typo_nbsp_after_guillemet": "Space after a French quote mark, places: {{count}}",
        "typo_space_after_punct": "Space after punctuation, places: {{count}}",
        "typo_collapse_spaces": "Extra spaces, places: {{count}}",
        "other_change": "Other changes: {{count}}"
      }
    },
    "revisions": {
      "title": "A new version of your thesis",
      "free": "Free",
      "body": "We only re-check the pages that changed, and your answers stay.",
      "changedPages": "Pages that changed: {{count}}",
      "editedInKwill": "You edited your thesis in Kwill, and we'll include your edits.",
      "pickFile": "Upload the new version",
      "fileChosen": "{{name}}",
      "supervisorLabel": "What did your supervisor ask for?",
      "supervisorPlaceholder": "Example: chapter titles in size 18, footnotes in size 12.",
      "keepAnswers": "We won't ask again what you've already answered",
      "cta": "Redo it for free",
      "ctaStatus": "Redo it",
      "differentThesis": "This file looks like a different thesis. To repair it, start a new repair.",
      "startNew": "Start a new repair",
      "editedNotInFile": "You edited your thesis in Kwill. Those edits are not in the file you chose; we keep them in your history.",
      "askReview": "Ask us to look at it",
      "reviewSent": "Got it, the team will look at the file.",
      "expired": "The re-run period for this thesis has ended.",
      "dailyCap": "That's a lot of re-runs for one day. Come back tomorrow."
    },
    "failure": {
      "title": "We didn't finish the repair",
      "body": "We found something we couldn't repair safely. We won't hand you an incomplete file.",
      "bodyPage": "On page {{page}} we found something we couldn't repair safely. We won't hand you an incomplete file.",
      "bodyOpen": "We couldn't open this file. Save it from Word as .docx and try again.",
      "bodyBig": "This thesis is bigger than we can process right now. The Kwill team will help you.",
      "bodyMerge": "We couldn't join the parts without changing them. The Kwill team will help you.",
      "bodyWait": "We couldn't finish in time. The Kwill team will help you.",
      "trustOriginal": "Your original file is untouched",
      "refundDue": "We will return your payment",
      "refundDone": "We returned your payment",
      "refundDueStatus": "The Kwill team will contact you about what you paid for this thesis",
      "refundDoneStatus": "What you paid for this thesis was returned",
      "noCharge": "Nothing was charged",
      "previousSafe": "Your previous version (version {{n}}) is as it was",
      "team": "The Kwill team is looking at the file",
      "ok": "OK",
      "tryAnother": "Try another file"
    },
    "library": {
      "title": "My theses",
      "versionMeta": "Version {{n}} · {{date}}",
      "ready": "Ready to deposit",
      "diagnosed": "Check ready",
      "working": "In progress",
      "failed": "Not finished",
      "history": "History",
      "open": "Open",
      "rerun": "Redo",
      "new": "New thesis",
      "continue": "Continue",
      "draftMeta": "Edited {{date}}",
      "hint": "You can also open the history from the result screen or the side menu",
      "delete": "Delete this check",
      "deleteConfirm": "The file and the check will be permanently deleted."
    },
    "timeline": {
      "title": "Your thesis's history",
      "current": "current",
      "badgeCurrent": "Version {{n}} · current",
      "badge": "Version {{n}} · {{date}}",
      "edited": "Edited in the Kwill editor",
      "editedBlocks": "Edited in the Kwill editor · paragraphs: {{count}}",
      "original": "The original file",
      "originalKept": "always kept",
      "originalMeta": "{{date}} · as you uploaded it",
      "triggers": {
        "first_diagnosis": "The original file",
        "first_rescue": "First repair",
        "rules_edited": "After editing the rules",
        "supervisor_note": "After your supervisor's notes",
        "new_file": "After uploading a new version",
        "edited_in_kwill": "After your edits in Kwill",
        "restored": "Restored version {{n}}",
        "staff_retry": "Redone by the Kwill team",
        "pack_rebuilt": "Deposit pack rebuilt"
      },
      "meta": "{{date}} · Fixes: {{fixes}}",
      "metaPages": "{{date}} · Pages that changed: {{count}}",
      "metaFailed": "{{date}} · not finished",
      "cta": "Edit and redo",
      "fine": "Free until your defense"
    },
    "version": {
      "meta": "{{date}} · Fixes: {{fixes}} · Pages: {{pages}}",
      "pdf": "Download PDF",
      "word": "Download Word",
      "wordMerged": "Download the merged file (Word)",
      "partsTitle": "The parts as you uploaded them",
      "compare": "Compare with another version",
      "changed": "What changed ({{count}})",
      "open": "Open in Kwill to edit",
      "restore": "Bring this version back",
      "pickCompare": "Choose a version to compare"
    },
    "compare": {
      "title": "Version {{a}} → version {{b}}",
      "changedCount": "Pages that changed: {{count}}",
      "pager": "Page {{page}} · {{i}} of {{total}}",
      "same": "These two versions are the same."
    },
    "editRerun": {
      "title": "Edit, then redo",
      "rules": "Rules",
      "notes": "Your notes",
      "notesCount": "Notes: {{count}}",
      "answers": "Your answers",
      "answersCount": "Answers: {{count}}",
      "cover": "Cover",
      "edit": "Edit",
      "close": "Close",
      "impactAll": "Changes: every page",
      "impactPages": "Changes: pages {{pages}}",
      "impactToc": "and the contents",
      "impactNone": "Nothing changed yet",
      "impactPack": "What changes: only the deposit pack",
      "impactNote": "We'll go back through your thesis with your note; the pages that change show at the end.",
      "nextVersion": "New version ({{n}})",
      "cta": "Redo it for free",
      "ctaStatus": "Redo it"
    },
    "restore": {
      "title": "Bring back version {{n}}?",
      "body": "It becomes a new version ({{next}}) at the top of the history. The others stay as they are.",
      "bodyEdited": "You edited your thesis in Kwill since the last version. We keep those edits: the undo button in the editor brings them back.",
      "confirm": "Bring it back",
      "cancel": "Cancel",
      "failed": "We couldn't bring it back just now. Please try again shortly."
    }
  }
```

- [ ] **Step 3: Check and commit.**
```bash
cd ~/kwill && git diff --stat -- locales   # insertions only, the same count in all three
npx vitest run lib/rescue-v2-locales.test.ts && npx tsc --noEmit
git commit -m "feat(rescue-v2): the words, in Arabic, French and English

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- locales/ar.json locales/fr.json locales/en.json lib/rescue-v2-locales.test.ts vitest.config.ts
```

The banned-word test will catch `error`/`خطأ` if one slips in. The `problems` and `failure` copy was written to pass it.

### Task A3: the living screen's shell

**Files:**
- Create: `app/(app)/rescue/_layout.tsx`, `app/(app)/rescue/index.tsx`, `app/(app)/rescue/library.tsx`, `components/rescue/LivingScreen.tsx`, `components/rescue/RescueStage.tsx`, `components/rescue/LivingSheet.tsx`, `components/rescue/PageImage.tsx`, `components/rescue/PageCarousel.tsx`, `components/rescue/SkeletonPage.tsx`, `components/rescue/ui.tsx`, `components/rescue/StageChrome.tsx`, `components/rescue/CountUp.tsx`, `components/skeletons/RescueSkeleton.tsx`, `hooks/useDrawerSwipeLock.ts`, `hooks/useRescueBack.ts`, stubs of the three shared pieces later tasks import (`components/rescue/NoteChips.tsx`, `VoiceMic.tsx`, `ShareInbox.tsx`, right props, rendering null), and one stub per step in `components/rescue/steps/`: `StartStep.tsx`, `PartsStep.tsx`, `ReadingStep.tsx`, `WhichRulesStep.tsx`, `NotesStep.tsx`, `UnderstoodStep.tsx`, `DiagnosisStep.tsx`, `PreviewStep.tsx`, `PaymentStep.tsx`, `RulesStep.tsx`, `QuestionStep.tsx`, `CoverStep.tsx`, `RepairingStep.tsx`, `ResultStep.tsx`, `ChangedStep.tsx`, `RevisionsStep.tsx`, `FailureStep.tsx`, `TimelineStep.tsx`, `VersionStep.tsx`, `CompareStep.tsx`, `EditRerunStep.tsx`, `index.ts`
- Modify: `app/(app)/_layout.tsx` (add `<Stack.Screen name="rescue" />`), `stores/bottom-sheet-store.ts` (`SheetName` gains `"rescue-university" | "rescue-guide" | "rescue-rule-picker" | "rescue-cover-field"`)

Each stub exports `{ Stage, Sheet, Foot? }` rendering `null`, so `tsc` passes and Group A-B's engineers own one file each, with no merge conflicts. `FailureStep.tsx` alone is a plain component rendering `null`: screen 18 is a full page with no sheet, and `LivingScreen` renders it directly.

```ts
// components/rescue/steps/index.ts
export interface RescueStep {
  /** The top half. */
  Stage: React.ComponentType;
  /** The sheet's content. */
  Sheet: React.ComponentType;
  /** Pinned at the sheet's foot (the CTA), null for none. */
  Foot?: React.ComponentType | null;
  /** The sheet's content scrolls (long lists). */
  scrollable?: boolean;
  /** The content handles its own drags (screen 2's reorderable list): gorhom's content pan stays off and it brings its own scrolling. */
  ownsGestures?: boolean;
}
export const RESCUE_STEPS: Record<Exclude<RescueScreen, "failure">, RescueStep> = {
  start: StartStep, parts: PartsStep, reading: ReadingStep, rules_choice: WhichRulesStep, notes: NotesStep,
  understood: UnderstoodStep, diagnosis: DiagnosisStep, preview: PreviewStep, payment: PaymentStep,
  rules: RulesStep, question: QuestionStep, cover: CoverStep, repairing: RepairingStep, result: ResultStep,
  changed: ChangedStep, revisions: RevisionsStep, timeline: TimelineStep, version: VersionStep,
  compare: CompareStep, edit_rerun: EditRerunStep,
};
```

```tsx
// hooks/useDrawerSwipeLock.ts — P-36. The drawer reads swipeEnabled from its focused screen, (app).
export function useDrawerSwipeLock() {
  const navigation = useNavigation();
  useFocusEffect(useCallback(() => {
    // The navigation object whose state is the drawer's is the (app) screen's: its options are the ones the drawer reads.
    let holder = navigation.getParent();
    while (holder && holder.getState()?.type !== "drawer") holder = holder.getParent();
    holder?.setOptions({ swipeEnabled: false });
    return () => holder?.setOptions({ swipeEnabled: true });
  }, [navigation]));
}
```
Walk W1 checks that an edge swipe on `/rescue` opens no drawer and an edge swipe in the chat still does.

```tsx
// components/rescue/LivingSheet.tsx — persistent, never dismissed; same props as WorkspaceComposerSheet.tsx:555.
export function LivingSheet({ screen, step, animatedPosition }: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const top = SHEET_TOP_PCT[screen];
  // One detent, changed per step: gorhom re-targets on a snap-point change, and that move IS the spring.
  const snapPoints = useMemo(() => [`${100 - top}%`], [top]);
  const animationConfigs = useBottomSheetSpringConfigs({ damping: 26, stiffness: 240, mass: 1, overshootClamping: false });
  const renderFooter = useCallback((p: BottomSheetFooterProps) => step.Foot ? (
    <BottomSheetFooter {...p} bottomInset={insets.bottom}><step.Foot /></BottomSheetFooter>
  ) : null, [step, insets.bottom]);
  // gorhom's BottomSheetView is absolutely positioned with no bottom edge and honours only `style`: `contentContainerStyle` belongs to the
  // scroll views alone. A step that owns its gestures or scrolls itself (screen 2's reorderable list, the university picker) gets a plain
  // `flex: 1` View, so its list has a bounded height and can scroll, and `enableFooterMarginAdjustment` keeps the Foot off the last rows.
  const bodyProps = step.scrollable
    ? { Body: BottomSheetScrollView, props: { contentContainerStyle: styles.body, enableFooterMarginAdjustment: true } }
    : step.ownsGestures
      ? { Body: View, props: { style: [styles.body, { flex: 1 }] } }
      : { Body: BottomSheetView, props: { style: styles.body, enableFooterMarginAdjustment: true } };
  const Body = bodyProps.Body as React.ComponentType<any>;
  return (
    <GorhomBottomSheet
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}   // MUST stay false: see WorkspaceComposerSheet's note
      enablePanDownToClose={false}
      enableOverDrag={false}
      enableContentPanningGesture={!step.ownsGestures}
      animatedPosition={animatedPosition}
      animationConfigs={animationConfigs}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{ backgroundColor: colors.bgCard, borderTopLeftRadius: SHEET_RADIUS * scale, borderTopRightRadius: SHEET_RADIUS * scale }}
      handleIndicatorStyle={{ backgroundColor: colors.borderDefault }}
      footerComponent={renderFooter}
    >
      {/* key: one stable identity per screen, so children's entering animations fire. */}
      <Body key={screen} {...bodyProps.props}><step.Sheet /></Body>
    </GorhomBottomSheet>
  );
}
```
Text fields in the sheet use `BottomSheetTextInput`; gorhom's keyboard handling only reacts to those.

```tsx
// components/rescue/RescueStage.tsx — the top half follows the sheet.
export function RescueStage({ animatedPosition, children }: Props) {
  const colors = useThemeColors();
  const style = useAnimatedStyle(() => ({ height: Math.max(0, animatedPosition.value) + 22 }));
  return (
    <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" }, style]}>
      <LinearGradient colors={[colors.rescueStageTop, colors.rescueStageBottom]} style={StyleSheet.absoluteFill} />
      {children}
    </Animated.View>
  );
}
```
`PageImage`: props `{ versionId, page, width, height, dim?: boolean }`. Selects `hash` and `url` as primitives from the store, calls `loadPages(versionId, page, page + 11)` when missing and again whenever `pagesReady` moves, since a page can land while the stage runs, `localPageUri(hash, url)`, fades in on `onLoad` with Reanimated. Draws on a `colors.rescuePaper` `View` with radius 3 and the mock's shadow. No URI yet → `SkeletonPage`. `dim` → opacity 0.45 (the grey pages of screen 13).

`SkeletonPage`: paper-shaped, with a shimmer: a `LinearGradient` translated by one shared value owned by the stage (one driver per screen, per the skeleton rule), `withRepeat`, `cancelAnimation` on unmount.

`PageCarousel`: props `{ versionId, page, layout: StageLayout, onChange?, interactive?, overlay? }`. A row with `direction: "ltr"`, so the page order is physical. For an RTL thesis (`project.language === "ar"`), the next page is on the left: `[next, current, prev]`; otherwise `[prev, current, next]`. `interactive` adds a horizontal `Gesture.Pan().activeOffsetX([-12, 12])`; each callback starts with `"worklet";`; past 40 px it calls `runOnJS(onChange)`. `layoutSpring` from `lib/motion.ts` on the page boxes, so size changes between steps spring.

`ui.tsx`: `SheetTitle`, `SheetBody`, `TrustList` (green check rows), `StepList` (done, current, pending rows with an ETA slot; a spinning ring with `cancelAnimation` on unmount), `Pill`, `ChipRow`, `Chip`, `WashCard`, `CloseButton` (✕ → `router.dismissTo("/(app)/chat")`), `BackPill` (← → `const r = backFor(screen, nav, project); r === "ack" ? void ackVersion(failure.versionId) : setNav(r)`), all static styles, all from `useThemeColors`, rows through `visualRow`.

**The way out is the shell's, never a step's.** iOS has no hardware back, this Stack has no gesture and the drawer swipe is off (P-36), and §9.1 says it is safe to leave at any point, including to keep working in the app during a repair. `StageChrome` sits at the top leading corner of the stage, under the safe area, on every screen: `backFor(screen, nav, project)` not null → `BackPill`; null → `CloseButton`. No step draws its own. `StageChrome` also draws the one **error line** for the whole route (C16): when `errorCode` is set it shows `rescueV2.common.somethingWrong` (or the code's own word where a step has one) with a `common.retry` that re-runs the last mutation, and clears on the next success. A CTA that fails on a dropped connection therefore never appears to do nothing, on screens 10-12, H5 and the rest (§9.1: calm, never stuck). Leaving during an upload keeps it running while the app lives; a killed app has lost it, and screen 3 says so.

`LivingScreen.tsx`:
```tsx
export function LivingScreen({ projectId, view, share, fixture }: { projectId?: string; view?: string; share?: boolean; fixture?: RescuePhase }) {
  useRescuePolling();
  const screen = useRescueScreen();
  const firstLoad = useRescueV2Store((s) => s.firstLoad);
  const animatedPosition = useSharedValue(0);
  useEffect(() => { useRescueV2Store.getState().setScreenOpen(true); return () => useRescueV2Store.getState().setScreenOpen(false); }, []);
  // The view is applied after `open` resolves, not beside it: `open` is a phase change, and a phase change clears overlays (A1),
  // so the first project load would erase it and the student would land on the result instead of the timeline. Tested from a cold load.
  useEffect(() => {
    const s = useRescueV2Store.getState();
    void s.loadConfig();
    void s.open(projectId ?? null, fixture).then(() => {
      if (view === "history") useRescueV2Store.getState().setNav({ overlay: "timeline" });
      if (view === "revisions") useRescueV2Store.getState().setNav({ overlay: "revisions" });   // the library's Redo chip
    });
  }, [projectId, fixture, view]);
  useRescueBack();                       // Android back: previous local step, else router.back()
  if (firstLoad) return <RescueSkeleton />;
  if (screen === "failure") return <FailureStep />;   // full page, no sheet
  const step = RESCUE_STEPS[screen];
  return (
    <View style={{ flex: 1 }}>
      <RescueStage animatedPosition={animatedPosition}><step.Stage /><StageChrome screen={screen} /></RescueStage>
      <LivingSheet screen={screen} step={step} animatedPosition={animatedPosition} />
      {share && <ShareInbox />}
    </View>
  );
}
```
`hooks/useRescueBack.ts`: `BackHandler` applying `backFor(screen, nav, project)` (Task A1, the one order, tested; `"ack"` runs `ackVersion`), and `router.back()` when it returns null. Android only by nature, which is why `StageChrome` exists. Leaving a running screen is safe.

- [ ] **Step 1: Build the shell with stubs.** `app/(app)/rescue/index.tsx` reads `useLocalSearchParams` and renders `LivingScreen`, inside a `RESCUE_V2_ENABLED` check that redirects to chat when off. `library.tsx` renders a stub until Task A8.

- [ ] **Step 2: Check.** `npx tsc --noEmit`. On the simulator: `/rescue` shows the skeleton, then an empty stage and an empty sheet at 42%. Dark and light. `xcrun simctl io booted screenshot /tmp/a3.png`.

- [ ] **Step 3: Commit** every file above. Message: `feat(rescue-v2): the living screen's shell: stage, sheet, pages, skeleton`.

---

### Group A-B: the screens (A4, A5, A6, A7 at once, one file per step, after A3; then A8, which reuses their rows)

For every step below: **Stage** is the top half; **Sheet** is its content, with its top % from `SHEET_TOP_PCT`; **State** is what it reads and calls; **iOS** is what changes under `PURCHASES_HIDDEN`. All keys are under `rescueV2.`. The test for layout work is `npx tsc --noEmit` plus the named walk in §6.

### Task A4: screens 1-6, the free road in

**Files:** `components/rescue/steps/StartStep.tsx`, `PartsStep.tsx`, `ReadingStep.tsx`, `WhichRulesStep.tsx`, `NotesStep.tsx`, `UnderstoodStep.tsx`; `components/rescue/NoteChips.tsx`, `VoiceMic.tsx`, `ShareInbox.tsx` (replacing A3's stubs); create `components/rescue/MiniTextPage.tsx`; and **`components/UniversityPicker.tsx`**, which A4 owns for this task (a sheet mode, below).

**Screen 1, Start** (`StartStep`). Sheet top 42%.
- Stage: a dashed page outline (`borderStyle:"dashed"`, 2 px, `colors.borderDefault`), centred orange square with an up arrow (`ArrowUp`, tint `colors.brandPrimary`), two `SkeletonPage` sides at 0.5 opacity.
- Sheet: `start.title`; `start.body` (iOS: `start.bodyStatus`); `TrustList` of `start.trustFree` (iOS: `start.trustFreeStatus`), `start.trustWords`, `start.trustOriginal`.
- Foot: CTA `start.cta`; fine print `start.share`, then `start.severalHint`.
- CTA: `DocumentPicker.getDocumentAsync({ type: [DOCX_MIME], multiple: true, copyToCacheDirectory: true })` (the mime and flags `stores/combine-store.ts:215` uses in production). Keep only `.docx`. None → stay. Over 12 → `start.tooMany`. A file over `config.limits.partMb`, or the files together over `totalMb` → `start.tooLarge` with `mb`. Then `store.begin(files, "picker")`.
- `begin`: sets `store.upload`, then `createRescueProject`, then `uploadPart` one by one, summing progress in `upload`; on `code` map to `start.notDocx`, `start.tooLarge` (`rescue_too_large`, also from a proxy's 413 page, A1), `start.dailyLimit`, `start.busy`, and `reading.uploadLost` for `upload_stalled`; on `rescue_one_in_progress` open `errorInfo.projectId` (A1 carries it through `decorateApiError`; `begin` falls back to `listRescueProjects` and opens the project in progress when the id is missing) and show `start.inProgress`. Any other failure, `network` included, shows the shell's error line with a retry (A3).
- `config.enabled === false`: CTA disabled, `unavailable` under it.
- Do **not** call `guardThesisLimit`: a rescue needs no free thesis slot (P-14).
- `hSelection` on tap.

**Screen 2, Your parts** (`PartsStep`). Sheet top 24%. Undrawn; specified here (§9.2, D-20). `ownsGestures: true`, `scrollable: false`: the library nests inside a scroller only through `ScrollViewContainer` and `NestedReorderableList`, and gorhom's content pan would fight the drag, so a plain list owns the scrolling here. `LivingSheet` gives such a step a plain `flex: 1` View (A3), because gorhom's `BottomSheetView` has no bottom edge and would let the list grow to its content and never scroll; the list's bottom padding is the Foot's measured height (`onLayout` on the Foot), so with the allowed 12 parts the last rows are not behind the CTA.
- Stage: empty gradient with the three small mini pages of the first three parts.
- Sheet: `parts.title`, `parts.body`. `ReorderableList` from `react-native-reorderable-list` (as `app/(app)/combine-arrange.tsx:404`, a top-level list there) of rows: `MiniTextPage` (a 42×58 paper with `part.openingText`, 5 pt, serif look from the system font, direction from `firstStrongDirection`), the filename with `numberOfLines={1}`, the role from `parts.roles.<role>`, a drag handle. A part with `continuesPrevious` draws joined to the row above (no gap, one shared border) with the pill `parts.continues`, and a tap on the pill toggles it. Local order lives in a `useState` seeded from the DTO.
- `phase='proposing_order'`: the same layout from `parts[]` in upload order, role replaced by `SkeletonBlock`, title `parts.proposing`, handle hidden.
- Foot: CTA `parts.cta` → `store.apply(() => confirmPartOrder(id, order, continuesPrevious))`; fine print `parts.nothingAdded`.
- `hLight` on drop.

**Screen 3, Reading** (`ReadingStep`). Sheet top 49%. No CTA.
- Stage: `PageCarousel` on `project.originalVersionId`, `page = max(1, pagesReady)`, next page a skeleton; label `common.pageOf` from `progress`. Until `pagesReady>0`: three skeletons. Pages come through `GET /versions/:vid/pages` as each one lands (Task S17).
- During Word's conversion no page exists and `pagesTotal` is 0: the three skeletons, `reading.converting` under the `stepRead` row, and the bar as a shimmer, never a percentage. Word's PDF arrives whole, so this can last minutes, and it is what "never a blank spinner" means here.
- Sheet: `reading.title`. File card: blue DOCX tile, filename (`numberOfLines={1}`), `reading.fileSize`. A progress bar: upload fraction in `uploading`, `pagesReady/pagesTotal` in `reading`. `StepList`: `reading.stepUpload`, `reading.stepRead` (ETA `common.etaSoon` or `common.etaMinutes` from `progress.etaSeconds`), `reading.stepUnderstand`. Current from `progress.stepKey`; `phase='reading'` on a split thesis shows `reading.merging` under the first row. `waiting='converter'`: `common.waitingWord` instead of the ETA.
- `phase='uploading'` with `store.upload` null means a cold start lost the upload: show `reading.uploadLost` and CTA `reading.uploadAgain` → `deleteRescueProject(id)` (v0) or `deleteUploadVersion(vid)` (a re-run), then back to the picker.
- When the phase reaches `await_setup` the sheet springs to 24%: nothing else moves.

**Screen 4, Which rules** (`WhichRulesStep`). Sheet top 24%.
- Stage: three pages of v0, small.
- Sheet: `whichRules.title`. University card from `setup` (name, `whichRules.fromProfile` when `fromProfile`), `whichRules.change` opens `UniversityPicker` in a `BottomSheet` named `rescue-university` with fixed snap points; no university: `whichRules.pickUniversity`. `UniversityPicker` gains a `sheet` prop: its root is `flex: 1` and its `FlatList` and `TextInput` are plain, which inside gorhom's auto-height `BottomSheetView` collapses to nothing, nests a list in a scroller and leaves the field unknown to gorhom's keyboard handling; with `sheet` it renders `BottomSheetFlatList` and `BottomSheetTextInput` and a bounded height (the A4 test: open it, type, scroll, pick, with the keyboard up). On pick: `updateSetup({ universityId })`. **`setup.profileOffer` (P-70)**: when the university has a faculty-specific profile, a card under the university asks `whichRules.profileOffer` with the profile's name and two buttons, yes → `updateSetup({ normProfileId })`, no → nothing (the default ladder stays); the card is absent when none is offered or a generic profile already applies by itself. The prefilled university needs no call: the server picks the norm profile at `POST /diagnose`, by university and language, or leaves it null for the default ladder (Task S19).
- Guide card, dashed: `whichRules.guideTitle`, `whichRules.guideBody`, pill `whichRules.optional`. A tap opens a small sheet `rescue-guide`: `whichRules.guideCamera` (`ImagePicker.launchCameraAsync`) or `whichRules.guideFile` (`DocumentPicker`, PDF and images). Then `uploadGuide`. States from `setup.guide.state`: `guideReading` with a spinner ring, `guideRead` pill, `guideFailed` line, `guideRemove`.
- Foot: CTA `whichRules.cta` (iOS: `ctaStatus`) → `setNav({ setupStep: "notes" })`. Nothing starts yet.

**Screen 5, Your notes** (`NotesStep`). Sheet top 15%.
- Stage: three 42×58 mini pages of v0.
- `NoteChips`: the chips, refusals and conflict cards below, in one component, so screen 17 and H5 show the same thing.
- Sheet (`scrollable`): `notes.title`. `BottomSheetTextInput` multiline, `notes.placeholder`, orange border while focused, direction from `getTextDirection(text)`, `VoiceMic` in the corner. `VoiceMic` wraps `useVoiceDictation` (`lib/voice.ts`), appends to the text on final results, hidden when `supported` is false (P-27). A small pill beside it switches between `common.langAr` and `common.langFr`, with `common.langEn` too on an English thesis, and passes `lang` to `start` (`ar-SA`, `fr-FR`, `en-US`). It defaults to `project.language`, so a student with an Arabic UI can dictate "French quotes in Times 12" and one with a French UI can dictate in Arabic.
- On blur with changed text: `store.apply(() => sendNote(id, text, "start"))`. `note.state='parsing'`: `notes.parsing`. `failed`: `notes.parseFailed`, not blocking.
- `notes.understood`, then chips from `note.chips`: green wash, a ✕ → `removeNoteChip`. `note.refused`: muted lines from `notes.refusedWords`, `refusedChecks`, `refusedDeposit`, `refusedUnsupported` by `reason`, under the chips and never under `notes.understood` (P-45).
- Each conflict: a warm wash card with `notes.conflict`, using `rules.fields.<fieldId>` as `label`, and two buttons `notes.conflictMine`, `notes.conflictGuide` → `resolveNoteConflict`. `hLight` on a choice.
- Foot: CTA `notes.cta` → `startDiagnosis(id)`, disabled while `parsing`, while a conflict is open (with `notes.pickOne` under it) and while `setup.guide.state='reading'` (with `notes.waitGuide`). Link `notes.skip` → the same call with the text as sent, disabled the same way.
- `note_parsing` or `guide_reading` from the server → stay here, keep the text, show the same line.

**Screen 6, Understood** (`UnderstoodStep`). Sheet top 49%. No CTA.
- Stage: `PageCarousel` on v0 at `diagnosis.outline.page` when known. Soft outlines from `outline.bands` (absolute `View`s, `topPct`/`heightPct`, 1.5 px borders: `h1` orange, `figure`/`table` green, captions blue). A brand-coloured shimmer over the middle page while `phase='diagnosing'`.
- Sheet: `understanding`: `understood.titleWorking`, `common.waitingBrain` when `waiting='brain'`, six stat skeletons. `diagnosing` with `summary`: `understood.title`, 3×2 grid with `CountUp` numbers and the labels `pages`, `chapters`, `figures`, `tables`, `footnotes`, and `cover` (✓ or —); `understood.typeLine` with `understood.format.<format>`; a progress bar over the remaining stages.
- When the phase reaches `diagnosed`: `hSuccess`.

**`ShareInbox`** (mounted by `LivingScreen` when `share=1`, Task A10 enables it):
```tsx
export function ShareInbox() {
  const { resolvedSharedPayloads, isResolving, clearSharedPayloads } = useIncomingShare();
  const begin = useRescueV2Store((s) => s.begin);
  useEffect(() => {
    if (isResolving || resolvedSharedPayloads.length === 0) return;
    const files = resolvedSharedPayloads
      .filter((p) => p.contentType === "file" && p.contentUri && /\.docx$/i.test(p.originalName ?? ""))
      .map((p) => ({ uri: p.contentUri!, name: p.originalName!, size: p.contentSize ?? 0 }));
    clearSharedPayloads();
    if (files.length) void begin(files, "share");
    else useRescueV2Store.setState({ errorCode: "not_docx" });   // the shell's error line words it as start.notDocx (A3)
  }, [isResolving, resolvedSharedPayloads]);
  return null;
}
```

- [ ] **Step 1: Build the six steps and the three helpers.** Copy from `locales`, never hardcode.
- [ ] **Step 2: Check.** `npx tsc --noEmit`, then walk W2.
- [ ] **Step 3: Commit** the exact paths. Message: `feat(rescue-v2): screens 1 to 6: upload, parts, reading, rules, notes, understood`.

### Task A5: screens 7-9, the decision and the money

**Files:** `components/rescue/steps/DiagnosisStep.tsx`, `PreviewStep.tsx`, `PaymentStep.tsx`; create `components/rescue/DiagnosisDots.tsx`, `components/rescue/SweepFade.tsx`, `components/rescue/SegSwitch.tsx`. Modify `app/(app)/payment-manual.tsx`, `app/(app)/payment-manual-submitted.tsx`, `app/(app)/payment-success.tsx`, `app/(app)/payment-failed.tsx`.

**Screen 7, Diagnosis** (`DiagnosisStep`). Sheet top 49%.
- Stage: `SegSwitch` `diagnosis.before` / `diagnosis.after` (`after` disabled when `!previewReady`), bound to `nav.diagnosisTab`; `PageCarousel` interactive on v0 at the page of the selected dot; `DiagnosisDots` over the middle page: red numbered 14 pt circles at `topPct`, on the outer edge, alternating sides; the selected dot has a ring. Below the page a dark tip bubble with `diagnosis.problems.<code>` and the params. For `section-*`, `sectionName` is `t("rescueV2.diagnosis.sections." + params.section)`.
- Sheet: `diagnosis.title` with `diagnosis.total`, `diagnosis.sub`, `ChipRow` of `diagnosis.chips` with counts (a chip filters, jumps to the next page holding that chip, and selects its first dot; `hSelection`). `studentItems`, never counted: a gentle `diagnosis.yours`, then one line per item: with a `section`, its name from `diagnosis.sections.<section>`; with `section` null, the sentence `diagnosis.problems.<code>`. An item with pages jumps to its first page on a tap. A problem with no page has its dot on page 1 (Task S9), so its chip and its sentence always have somewhere to go.
- Foot: CTA. Android: `diagnosis.cta`, fine print `diagnosis.fine`. iOS: `diagnosis.ctaStatus`, no fine print.
- CTA → `continueRescue(id)`. 200 with `entitlement.kind` → the phase moves on to `confirm_rules`. 402 → `setNav({ paying: true })`.

**Screen 8, After preview** (`PreviewStep`). Sheet top 49%.
- Stage: `SegSwitch` on `after`. Two watermarked pages from `getRescuePreview`: side the cover, middle the chapter, third a skeleton-free blank paper. Tapping the switch runs `SweepFade` over the before image. Before images: `beforeUrl`.
- `SweepFade`, the mock's sweep cross-fade, in Reanimated:
```tsx
// Top image clipped by an animated width. direction:"ltr" and the anchor counter RTL (see the traps).
const w = useSharedValue(0);
useEffect(() => { w.value = withTiming(on ? width : 0, { duration: 600, easing: Easing.inOut(Easing.ease) }); }, [on, width]);
const clip = useAnimatedStyle(() => ({ width: w.value }));
return (
  <View style={{ width, height, direction: "ltr" }}>
    <Image source={{ uri: before }} style={{ width, height }} />
    <Animated.View style={[styles.clip, I18nManager.isRTL ? { right: 0 } : { left: 0 }, clip]}>
      <Image source={{ uri: after }} style={{ width, height }} />
    </Animated.View>
  </View>
);
```
- Sheet: `preview.title`, `preview.body` (`bodyCoverOnly` when `chapter` is null), pill `preview.pill`. `!previewReady`: `preview.unavailable`.
- Foot: Android `diagnosis.cta` and fine print `diagnosis.fine`; iOS `diagnosis.ctaStatus` and no fine print. The tap calls `continueRescue(id)`: 200 moves on, 402 → `setNav({ paying: true })`.

**Screen 9, Payment** (`PaymentStep`). Sheet top 23%. `paying` in nav. Subscribers never reach it: `continue` entitled them.
- Stage: three 70×98 pages from the preview and v0.
- **Android.** Sheet by `entitlement.purchase.state`:
  - `none` and `refunded` (a student buying again after a refund, P-22): `payment.title`, `payment.price` with `entitlement.priceDzd` and `payment.once`; four check rows `inc1`..`inc4`; two radio rows `payment.manual`/`manualSub`, `payment.card`/`cardSub`, shown only when `config.manualEnabled` / `config.paymentsEnabled`; `payment.safe`. `forSale` false, or neither method available: only `payment.notForSale`, no CTA. Foot: CTA `payment.cta`, fine print `payment.subscriber`.
  - `pending_manual`: `underReviewTitle`, `underReviewBody`, no CTA.
  - `rejected_manual`: `rejectedTitle`, the reason, CTA `tryAgain`.
  - `pending_card`: `confirming` while polling, and a CTA `payment.cardRetry` → `payByCard` again: closing Chargily sends no webhook. The server turns this state to `none` after 15 minutes (P-51).
  - `paid`: `confirming`. `needsPolling` keeps polling while it lasts (A1), and the server's tick grants a payment whose grant a recycle lost (P-62), so it ends by itself. A student who bought again after a refund and a failed first rescue moves to the `confirm_*` screens at the grant: `computePhase` gives `failed` only for an entitlement older than the failure (Task S2), so screen 18 is never the dead end of a second purchase.
  - `refund_due`: the line `failure.refundDue`, no CTA.
- Card, following `subscription.tsx`'s `buy`:
```ts
const RETURN_SCHEME = "kwill://payment";  // same as subscription.tsx
const GRANT_POLL_MS = [0, 600, 1500, 3000, 5000, 8000];
async function payByCard(projectId: string) {
  const { checkoutUrl } = await startCheckout({ kind: "rescue", projectId }, i18n.language);
  const r = await WebBrowser.openAuthSessionAsync(checkoutUrl, RETURN_SCHEME);
  if (r.type !== "success" || !r.url.includes("payment-success")) {
    await store.refresh();
    if (r.type === "success") setNotice("payment.cardNotFinished");
    return;
  }
  for (const wait of GRANT_POLL_MS) {
    await new Promise((res) => setTimeout(res, wait));
    await store.refresh();
    // The webhook grants, and races the browser back. The signal is the project, not quota.available.
    if (useRescueV2Store.getState().project?.entitlement.kind) { hSuccess(); return; }
  }
}
```
- Manual: `router.push({ pathname: "/(app)/payment-manual", params: { kind: "rescue", rescueProjectId: id, amountDzd: String(price) } })`.
- `payment-manual.tsx`: accept `kind: "rescue"` and `rescueProjectId`, pass them to `submitManualPayment`, and onward to `payment-manual-submitted` as a param. Its existing `PURCHASES_HIDDEN` redirect stays.
- `payment-manual-submitted.tsx`: when `rescueProjectId` is present, the CTA goes to `/(app)/rescue?projectId=…`, else unchanged.
- `payment-success.tsx`, `payment-failed.tsx`: `const { rescue } = useLocalSearchParams()`; when set, `<Redirect href={`/(app)/rescue?projectId=${rescue}`} />`. That is the fallback path, when the browser returned through the deep link.
- **iOS.** The sheet is status only: `payment.statusTitle`, `payment.statusBody`, CTA `payment.statusRefresh` → `store.refresh()`, link `payment.statusBack` → `setNav({ paying: false })`. No price, no method, no mention of email. `entitlement.kind` set → the phase moves on by itself.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit`, then walks W3 and W4. Step 3: Commit** the exact paths. Message: `feat(rescue-v2): screens 7 to 9: diagnosis on the page, the sweep, payment and iOS status`.

### Task A6: screens 10-12, confirm

**Files:** `components/rescue/steps/RulesStep.tsx`, `QuestionStep.tsx`, `CoverStep.tsx`; create `components/rescue/MarginOverlay.tsx`, `components/rescue/RuleRow.tsx`, `components/rescue/RulePickerSheet.tsx`, `components/rescue/PageZoom.tsx`, `components/rescue/CoverFieldSheet.tsx`.

**Screen 10, Rules** (`RulesStep`). Sheet top 24%.
- Stage: page 1 of the chapter, big, `MarginOverlay`: four dashed orange lines placed by the margin fields, `cm / 21` of the page's width and `cm / 29.7` of its height, with small labels. `bindingSide` decides which side gets `marginBinding`. Values spring on change (`withSpring`), read from local edits so they move before the server answers (visual first, memory: `editor-visual-first`).
- Sheet (`scrollable`): `rules.title`; pill `rules.fromGuide` when `fromGuide`. Rows grouped by `field.row` in the order of §1.5, with labels `rules.rows.<row>`. `RuleRow` shows the value (`rules.values.<v>` for enums, the number otherwise, font names as they are in LTR), a green tint and the pill `rules.fromNote` when `source='note'`, and a chevron chosen by direction. `additions` shows five switches inline with `rules.fields.*` and `rules.hints.*`, no picker. `captionNumbers` uses `rules.hints.captionNumbersCount` with `diagnosis.captionNumbersToAdd` when that is above 0 (D-22 wants the additions on this screen). `secondFont` and `secondSize` sit in the `font` row, and `noNumberDedication` and `noNumberThanks` in the `numbering` row, as switches in its picker.
- A row tap opens `RulePickerSheet` (name `rescue-rule-picker`, modal, `components/BottomSheet.tsx`): every field of the row, enums as a list, numbers as a stepper with `min`, `max`, `step`. A choice calls `store.apply(() => saveRules(id, { edits: { [fieldId]: value } }))`. `rule_out_of_range` shows `rules.outOfRange`.
- Foot: CTA `rules.cta` → `saveRules(id, { confirm: true })`. `hLight`.

**Screen 11, Question** (`QuestionStep`). Sheet top 49%. Also shown for `await_answers`.
- Stage: `PageZoom` on v0: the question's page, scaled 2.2×, translated so `topPct` sits at 40% of the stage; a warm highlight band across it with an orange outline, 3% of the page tall. Animated from the unzoomed page with `withSpring`. Pages keep their direction; transforms on a child with `direction:"ltr"`.
- `page` null, a re-run's question (P-29): a paper-coloured page with the `excerpt` in the same highlight band, direction from content. No page image exists yet: `source` runs no conversion and the version's pages first appear at `render`, after this pause.
- Sheet: `question.counter` with the index among all questions; the question's `text` (already in the student's language), direction from content; two buttons from `options[].label`; link `question.decide`. No question has a block index.
- Answer → `saveAnswer(id, key, { role })` or `{ decide: true }`, `hLight`, spring to the next. The last answer on a re-run → `resumeVersion(activeVersionId)`.

**Screen 12, Cover** (`CoverStep`). Sheet top 49%. Three cases from `cover` (P-31):
- `allowedChoices=['generated']`, no cover: one page centred, title `cover.titleMissing` when `missing` is not empty.
- `['keep','generated']`: pair, labels `cover.keep`, `cover.generated`.
- `['clean','generated']`: pair, labels `cover.clean`, `cover.generated`.
- Stage: the pair at 96×136 with `direction:"ltr"` (order by policy, not by language); the picked one has a 2.5 px brand outline, its label bold in `brandPrimaryLight`. Images from `getCoverSamples` when `samples='ready'`, `SkeletonPage` while `rendering`, labels only on `failed`. On mount with `samples='none'`: `renderCoverSamples(id)`. A tap → `saveCover(id, { choice })`, `hSelection`.
- Sheet (`scrollable`): `cover.title`. Under `keep` and `clean`, first the line `cover.formsOnly` (P-50): the student's cover keeps its words, so these values reach the deposit forms only, and nothing on this screen implies otherwise. Rows `fieldTitle`, `fieldStudents`, `fieldSupervisor`, `fieldYear`, each with a pencil; a value from the profile has the small tag `cover.fromProfile`, one from the catalogue `cover.fromCatalogue`; an empty one shows `cover.add` in brand ink. Link `cover.more` reveals `fieldUniversity`, `fieldFaculty`, `fieldDepartment`, `fieldDegree`, `fieldSpecialty`, and `fieldSubtitle`, `fieldField`, `fieldCoSupervisor`, `fieldJury` whenever they hold a value: the generated cover prints them, so the student must be able to see and correct them. It opens by itself when one of these holds a value under `generated`. `CoverFieldSheet` (name `rescue-cover-field`) edits one value; `students` is a small list, and `jury` a small list of name and rank. Save → `saveCover(id, { fields })` → then `renderCoverSamples` when `generated` is in `allowedChoices`, debounced to the sheet's close. A save while the samples are rendering is not a 409 dead end: the server marks `cover.dirty` and renders again when the first render ends (Task S17), and the screen keeps its skeleton until `samples='ready'` again.
- Foot: CTA `cover.cta` → `startRescue(id)`. `422 cover_fields_missing` → `cover.needed` naming the first of `errorInfo.missing` (A1 carries it); the row flashes. Success → `hMedium`; phase `repairing`.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit`, then walk W5. Step 3: Commit** the exact paths. Message: `feat(rescue-v2): screens 10 to 12: rules with live margins, questions, cover`.

### Task A7: screens 13-18, repair and result

**Files:** `components/rescue/steps/RepairingStep.tsx`, `ResultStep.tsx`, `ChangedStep.tsx`, `RevisionsStep.tsx`, `FailureStep.tsx`. Modify `lib/download-export.ts`, `lib/download-export.web.ts` (`zip` in `MIME`; `UTI` for zip is `public.zip-archive`).

**Screen 13, Repairing** (`RepairingStep`). Sheet top 49%. No CTA.
- Stage: `PageCarousel` non-interactive. While the active version has no `pages`: three v0 pages with `dim`. Once `pagesReady>0`: side = a finished page with a green check badge (`okb`), middle = finished with the brand shimmer, third = v0 `dim`. Label `common.pageOf` from `pagesReady`/`pagesTotal`. Before `render` there are no finished pages and `pagesTotal` is 0: the label is hidden and the 8-part bar carries the progress; pages turn from grey to finished during `render`, as each one uploads (Task S18).
- Sheet: `repairing.title`; an 8-part bar (done green, current brand, rest `borderSubtle`) from `progress.step`, which the server only ever moves up (§1.1: Regenerate's hooks do not run in step order), so the bar never goes backwards; `repairing.stepOf` and the ETA (`common.etaMinutes` with `Math.ceil(etaSeconds / 60)`, `common.etaSoon` under 60 s; `common.waitingWord` or `common.waitingBrain` from `waiting`). `StepList` window: previous, current, next of `repairing.steps.<stepKey>`.
- Foot: fine print `repairing.safe`.
- A cold start or a push mid-run lands here, because the phase is `repairing`. Polling fills it in. A dropped connection only pauses the bar: never re-POST (memory: `turn-survives-background`).

**Screen 14, Done.** The OS notification, built on the server (§1.8). The app also fires `hSuccess` when polling sees `repairing` → `done`.

**Screen 15, Result** (`ResultStep`). Sheet top 49%.
- Stage: `PageCarousel` interactive on `currentVersion.id`; a green check badge on the middle page.
- Sheet (`scrollable`): `result.title`, `result.stats`, muted `result.words`. Two download cards: red PDF tile + "PDF", blue DOCX tile + "Word". Tap: `getVersionFile(id, "pdf")` → `downloadExport(file)`; failure → `result.downloadFailed`. A brand-wash card `result.packTitle`, built from `currentVersion.pack` (P-48):
  - `files` joined with " · " through `result.packFiles.<kind>`, so the line is true whatever the department's rules and the file allowed. Button `result.share` → `getVersionFile(id, "deposit")` + `downloadExport`, which opens the share sheet.
  - `omitted` with `no-abstracts`: the muted line `result.packNoAbstracts`. Nothing to rebuild.
  - `state='partial'`: `result.packOmitted` with the missing kinds, and a link `result.packRebuild`.
  - `state='missing'`: `result.packMissing`, no share button (there is no file to fetch), and the button `result.packRebuild`.
  - `result.packRebuild` → `store.beginRerun([])`: the server makes it a `pack_rebuilt` run (Task S18), and phase `repairing` shows it like any other.
  `currentVersion.published=false`: a wash line `result.notPublished`.
- Foot: links `result.changed` (→ overlay `changed`), `result.history` (→ overlay `timeline`), `result.revisions` (→ overlay `revisions`), and `result.open`.
- Open in Kwill, exactly in this order, because the workspace reads params and redirects to chat without them (`thesis-workspace.tsx:628`):
```ts
await useThesisStore.getState().refreshTheses();
useThesisStore.getState().setCurrentThesis(thesisId);
void useThesisDocStore.getState().revalidate(thesisId);   // after a re-run or a restore
// P-66: the working copy is also revalidated when `phase` goes to `done` while the screen is open, and by the done push (Task A9), because
// Regenerate shifted every index and an op queued before it would land on the wrong paragraph. `beginRerun` flushed the queue first.
router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId } });
```
  Do not copy `rescue-result.tsx:39`'s bare replace.

**Screen 16, What changed** (`ChangedStep`). Sheet top 22%.
- Stage: one 56×80 page, the page of the tapped item (starts on page 1).
- Sheet (`scrollable`): `changed.title`. Loads `getVersion(id).changes`. A group per `groups[]` with `changed.groups.<key>` and its count; rows: a `p.N` tag when `page` is set (LTR tag), the sentence from `changed.items.<code>` with `count` and params; an unknown code falls to `changed.items.other_change`. A group shows its first 20 rows, and a `changed.more` row adds 50 more each tap: every fix is listed (D-8), and a thesis can hold hundreds. A tap jumps the stage to that page. Only a whole-document rule has no page and no tap. Group order as the mock, captions after headings (P-31). Heading excerpts render with `firstStrongDirection`.

**Screen 17, After revisions** (`RevisionsStep`). Sheet top 42%. Local overlay, or forced by `not_same_thesis`.
- Stage: `PageCarousel` on the current version; the middle page outlined in brand.
- Sheet (`scrollable`): `revisions.title` + badge `revisions.free` (no badge on iOS); `revisions.body`; `editedInKwill` true and no file chosen: `revisions.editedInKwill` and `changedPages` from `getImpact(id)`; **with a file chosen: `revisions.editedNotInFile` instead (the file wins and the edits are kept in History, P-67), never the promise to include them**. A dashed card `revisions.pickFile` → the picker from screen 1 with `multiple:true`; a chosen file shows `revisions.fileChosen`. `revisions.supervisorLabel` with `BottomSheetTextInput`, `revisions.supervisorPlaceholder`, `VoiceMic`; on blur `sendNote(id, text, "supervisor")`; the chips and conflict cards through `components/rescue/NoteChips.tsx`. Pill `revisions.keepAnswers`.
- `failure.code='not_same_thesis'`: a wash line `revisions.differentThesis`, the button `revisions.askReview` (when `failure.reviewable` and not `reviewRequested`: `requestRescueReview(failure.versionId)`, then `revisions.reviewSent`; P-57, a real student whose thesis changed a lot is not stuck) and link `revisions.startNew` (`ackVersion`, `store.reset()`, `setNav` to start). **Back and ✕ here acknowledge the failure and land on the last good result** (`backFor` returns `"ack"`, Task A1); the student is never made to start over to leave. Failure screens never show for it.
- Foot: CTA `revisions.cta` (iOS: `ctaStatus`), disabled while a note parses or a conflict is open → `store.beginRerun(files)`, which sets `upload` first, so the sheet stays here during the upload and `reading.uploadLost` can only mean a cold start. While `phase='uploading'`, this foot shows `reading.stepUpload` with the upload's progress bar in place of the CTA. `rescue_rerun_expired` → `revisions.expired`; `rescue_rerun_daily_cap` → `revisions.dailyCap`.

**Screen 18, Honest failure** (`FailureStep`). A full page, no sheet, `colors.bgPrimary`, centred, the app's safe area.
- A green shield tile; `failure.title`; the body by `failure.code`: `prove_failed`, `regenerate_failed`, `stage_crashed`, `brain_failed` → `failure.bodyPage` with `page`, else `failure.body`; `not_docx`, `word_refused` → `failure.bodyOpen`; `merge_refused` → `failure.bodyMerge`; `converter_unavailable` → `failure.bodyWait`; `too_big` → `failure.bodyBig`. A Word fault on our side (`stage_crashed`, `converter_unavailable`) never reads as a problem with the file (P-54).
- Trust rows, each only when true: always `failure.trustOriginal`; `refund='due'` → `failure.refundDue`; `refund='done'` → `failure.refundDone`; `refund='none'` with no purchase on this run → `failure.noCharge`; `previousVersionN` → `failure.previousSafe`; rescue or re-run → `failure.team`.
- **iOS** (`PURCHASES_HIDDEN`): `failure.refundDue` becomes `failure.refundDueStatus` and `failure.refundDone` becomes `failure.refundDoneStatus`, status words with no amount, method or link, because a student who paid on the web is still owed invariant 5's sentence. `failure.noCharge` is not shown: on iOS nothing here was ever a charge.
- Buttons: `failure.ok`: `ackVersion(versionId)`, then to result when a previous version exists, else to chat. Link `common.contactSupport` → `/(app)/support`. For `not_docx`, `word_refused` on v0: also `failure.tryAnother` → `store.reset()`.
- `hWarn` once on arrival.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit`, then walks W6, W7, W8. Step 3: Commit** the exact paths. Message: `feat(rescue-v2): screens 13 to 18: repair, result, changes, revisions, honest failure`.

### Task A8: history, H1-H6

**Files:** `app/(app)/rescue/library.tsx`, `components/rescue/steps/TimelineStep.tsx`, `VersionStep.tsx`, `CompareStep.tsx`, `EditRerunStep.tsx`; create `components/rescue/CompareSlider.tsx`, `components/rescue/RestoreDialog.tsx`.

**H1, Library** (`library.tsx`, a normal scrolling screen).
- `BackButton`, `library.title`, and at the trailing end the `＋` of the mock (`library.new`): `store.reset()` then `router.push("/(app)/rescue")` with no `projectId`, which opens screen 1. A repeat customer (D-7 sells the repair per thesis) starts a second rescue from here; the drawer row and the home card go to the library or the project, so this is the door. Skeleton from `RescueSkeleton`'s list variant on first load.
- Loads `listRescueProjects()` and `useThesisStore.theses`. No project at all → `router.replace("/(app)/rescue")`.
- A project card: a 56×78 page (`coverPageVersionId`, page 1), title, `library.versionMeta`, a state pill by phase (`ready`, `diagnosed`, `working`, `failed`), chips: `library.history` (brand wash) → `/(app)/rescue?projectId=…&view=history`; `library.open` when `thesisId`; `library.rerun` → `/(app)/rescue?projectId=…&view=revisions` (A3 applies the view after `open`, so the phase change cannot clear it); `library.continue` while not done. A project with `canDelete` (a diagnosis-only one): long-press → `Alert` with `library.delete`, `library.deleteConfirm` → `deleteRescueProject`; an entitled project with no thesis offers no delete (P-65), `rescue_entitled` is never shown to the student.
- Theses without a project: a plain card, `library.draftMeta`, `library.open`.
- Footer line `library.hint`.

**H2, Timeline** (`TimelineStep`). Sheet top 29%.
- Stage: a dark pill `timeline.badgeCurrent` or `timeline.badge` for the selected version; `PageCarousel` on the selected version, **interactive with its page label** (D-18: every version is viewable, not three still pages).
- Sheet (`scrollable`): `timeline.title`. `loadVersions()`. The rail (a 2 px line on the leading side): each version a dot and two lines: `timeline.triggers.<trigger>` (with `n` from `triggerN`) with the badge `timeline.current` on the newest, and `timeline.meta`, `metaPages` or `metaFailed`. Grey editor steps, as many as there were: under each version with `editedBefore`, `timeline.edited`, or `timeline.editedBlocks` with its `changedBlocks`, so a step survives the re-run that absorbed it; and for `edited.edited`, one more above the newest, placed after `afterVersionN`. The original pinned last with a lock glyph, `timeline.original`, badge `timeline.originalKept`, `timeline.originalMeta`. Tap a row: selects it and previews in the stage. Second tap, or a chevron: overlay `version`.
- Foot: CTA `timeline.cta` → overlay `edit_rerun`; fine print `timeline.fine` (none on iOS).

**H3, A version** (`VersionStep`). Sheet top 33%.
- Stage: badge; the version's pages in an interactive `PageCarousel` with its page label (H2 and H3 are the only viewing surfaces for a past version, so they swipe like screens 7 and 15).
- Sheet: `timeline.triggers.<trigger>`, `version.meta`; an action list: `version.pdf`, `version.word`, `version.compare` → the sheet lists the other versions under `version.pickCompare`, then overlay `compare`; `version.changed` → overlay `changed` with this `versionId`; `version.open`: if this is the current version, the same sequence as screen 15; otherwise H6 first; `version.restore` → H6. The original shows only `pdf`, `word`, `compare` (P-44). On a split original `word` reads `version.wordMerged`, and `version.partsTitle` lists each part by its filename, a tap → `getVersionFile(id, "part", index)` + `downloadExport`, so "as you uploaded it" stays true. A failed version shows only its meta.

**H4, Compare** (`CompareStep`). Sheet top 55%.
- Stage: two small labels `common.version` on the pair's sides, `CompareSlider`, 150×200 scaled.
- `CompareSlider`, with the RTL rules and explicit worklets:
```tsx
export function CompareSlider({ aUri, bUri, width, height }: Props) {
  const x = useSharedValue(width / 2);
  const start = useSharedValue(0);
  const pan = useMemo(() => {
    const g = Gesture.Pan();
    g.onBegin(() => { "worklet"; start.value = x.value; });
    g.onUpdate((e) => { "worklet"; x.value = Math.min(width, Math.max(0, start.value + e.translationX)); });
    return g;
  }, [width]);
  const clip = useAnimatedStyle(() => ({ width: x.value }));
  const handle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - HANDLE / 2 }] }));
  const anchor = I18nManager.isRTL ? { right: 0 } : { left: 0 };
  return (
    <GestureDetector gesture={pan}>
      <View style={{ width, height, direction: "ltr" }}>
        <Image source={{ uri: bUri }} style={{ width, height }} />
        <Animated.View style={[styles.clip, anchor, clip]}><Image source={{ uri: aUri }} style={{ width, height }} /></Animated.View>
        <Animated.View style={[styles.handle, anchor, handle]} />
      </View>
    </GestureDetector>
  );
}
```
- Sheet: `compare.title`, `compare.changedCount`; a pager with the mirrored chevrons, `compare.pager`, stepping `compareVersions(a, b, { offset: i, limit: 6 })`; change rows for that page from `changes`, what the later version did there that the earlier did not (`compareChanges`, Task S9); none is a normal state, and the slider still shows the page. `total=0`: `compare.same`. Saved images only, no conversion, no wait.

**H5, Edit and re-run** (`EditRerunStep`). Sheet top 21%.
- Stage: three small pages; the first page in the impact outlined.
- Sheet (`scrollable`): four accordions: `editRerun.rules` (one-line summary of font, size, spacing), `editRerun.notes` (`notesCount`), `editRerun.answers` (`answersCount`), `editRerun.cover` (the choice's label); each with `editRerun.edit`/`editRerun.close`. Rules opens the same rows as screen 10. Notes opens the text input and chips as screen 17, saving as a `supervisor` note. Answers lists each answered question's excerpt and its choice, with the old choice struck through once changed; a tap flips it with `saveAnswer`. Cover opens the choice **and** the fields as screen 12: the allowed choices with their sample pair (`getCoverSamples`, `renderCoverSamples` on open, as screen 12), then the field rows. Changing only the choice is a change (`coverChanged` in the impact, D-18); a generated cover whose title or students were cleared answers `422 cover_fields_missing` from `createRerun` too, and H5 words it as screen 12 does, from `errorInfo.missing`.
- On opening, and after every save → `getImpact(id)`, debounced 400 ms. Every edit here is already saved, and the server compares the project's settings with the last done version's, so the answer survives leaving and coming back. Foot fine print by `scope`: `all` → `impactAll`; `pages` → `impactPages` with the list and `impactToc`; `pack` → `impactPack`; `note` → `impactNote`; `none` → `impactNone`; then `editRerun.nextVersion` with `nextN`.
- Foot: CTA `editRerun.cta` (iOS: `ctaStatus`) → `store.beginRerun([])`, disabled only at `scope:'none'`.

**H6, Restore** (`RestoreDialog`). A dialog in a transparent RN `Modal`, not a sheet: scrim + centred card, an orange-wash tile with ↺, `restore.title`, `restore.body`, and when `project.editedInKwill` the warm line `restore.bodyEdited` (P-52), `restore.confirm`, `restore.cancel`. Confirm → `restoreVersion(versionId)`; `rescue_locked` or any failure → `restore.failed`; success → overlay `timeline`, `hSuccess`, and `revalidate(thesisId)`.

Also in `app/(app)/thesis-detail.tsx`, with the other actions: when `RESCUE_V2_ENABLED` and a project has this `thesisId` (from `listRescueProjects` on mount), a row `rescueV2.library.history` → `/(app)/rescue?projectId=…&view=history`. A failed lookup shows nothing.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit`, then walk W9. Step 3: Commit** the exact paths. Message: `feat(rescue-v2): history: library, timeline, version, compare, edit and restore`.

---

### Group A-C: entry points, Share, walks (in this order, after A-B)

### Task A9: the doors, push and cold start

**Files:**
- Modify: `components/AppDrawer.tsx`, `components/chat/ChatWelcome.tsx`, `app/_layout.tsx`, `types/notification.ts`, `lib/push-notifications.ts`, `app/(app)/notifications.tsx`, `lib/api.ts` and `stores/thesis-doc-store.ts` (Step 5b, P-66)
- Create: `components/rescue/RescueHomeCard.tsx`, `hooks/useRescueColdStart.ts`

- [ ] **Step 1: Drawer.** In `toolRows`, before the `import` row:
```ts
...(RESCUE_V2_ENABLED ? [{
  key: "rescue-v2",
  icon: LifeBuoy,
  label: t("rescueV2.drawerRow"),
  // library decides: no project yet → the start screen.
  onPress: () => go(() => router.push("/(app)/rescue/library" as any)),
} satisfies Row] : []),
```
Leave the `import` row exactly as it is. The release commit changes it (§7).

- [ ] **Step 2: Home card.** `RescueHomeCard` in `ChatWelcome`, under the body text, above `ctaRow`, rendered only when `RESCUE_V2_ENABLED`. On mount, `listRescueProjects()` into local state. Three states: none → `card.title`, `card.body` (iOS: `bodyStatus`), `card.cta` → `/(app)/rescue`; one in progress → `card.continue` → that project; one done → `card.ready` → that project. An error or a disabled server → renders nothing. Static styles, `TouchableOpacity`, tint + dark ink.

- [ ] **Step 3: Notification type.** `types/notification.ts`: add `"rescue"` (and `"tasks_complete"`, which the server already sends). `app/(app)/notifications.tsx` `iconFor`: `case "rescue":` returns `FileCheck` with `colors.brandPrimary`.

- [ ] **Step 4: A tap on a killed app.** Nothing calls `getLastNotificationResponse` today, so a push tapped on a dead app goes nowhere. In `lib/push-notifications.ts`:
```ts
/** The push that launched the app, once. The listener below only hears taps on a running app. */
export function consumeColdStartNotificationRoute(): string | null {
  const Notifications = getNotifications();
  if (!Notifications) return null;
  try {
    const last = Notifications.getLastNotificationResponse();
    const route = last?.notification.request.content.data?.route;
    if (typeof route !== "string") return null;
    Notifications.clearLastNotificationResponse();
    return route;
  } catch {
    return null;
  }
}
```

And no banner for the screen the student is already looking at, now that a push goes out on every wait (§1.8): `setNotificationHandler`'s `handleNotification` reads a filter set from outside, `setPushBannerFilter(fn)`; when `fn(data)` is true, `shouldShowBanner`, `shouldShowList` and `shouldPlaySound` are false. `useRescueColdStart` sets it: `(d) => { const s = useRescueV2Store.getState(); return s.screenOpen && d?.projectId === s.projectId; }`.

- [ ] **Step 5: `hooks/useRescueColdStart.ts`.** Gated like `useAuthDeepLink`, because a navigation issued before the router exists is silently dropped.
```ts
export function useRescueColdStart(ready: boolean) {
  const did = useRef(false);
  useEffect(() => {
    if (!ready || did.current || !RESCUE_V2_ENABLED) return;
    did.current = true;
    (async () => {
      const route = consumeColdStartNotificationRoute();
      if (route) { router.push(route as never); return; }
      if (Platform.OS !== "web") {
        // A file shared before sign-in is still waiting natively. Its own try: on iOS this THROWS on any binary
        // without A10's plugin config (no ExpoShareIntoAppGroupId in Info.plist), and that must not stop the resume below.
        try {
          const Sharing = await import("expo-sharing");
          if (Sharing.getSharedPayloads().length > 0) { router.push("/(app)/rescue?share=1" as never); return; }
        } catch {
          // No share config in this binary: no payload.
        }
      }
      const { projects } = await listRescueProjects();
      const active = projects.find((p) => p.resumeOnOpen);
      if (active) router.push(`/(app)/rescue?projectId=${active.id}` as never);
    })().catch(() => {});
  }, [ready]);
}
```
In `app/_layout.tsx`, next to `useAuthDeepLink(appReady && fontsLoaded)`: `useRescueColdStart(appReady && fontsLoaded && isAuthenticated);`. The old lane's resume at `:236-243` stays until the release commit. A `consumeColdStart…` route that a running listener also fires pushes twice on some Android versions: guard with `lastPushedRoute` and a 2 s window in the hook's `router.push`.

- [ ] **Step 5b: Queued edits cannot land on the wrong paragraph (P-66).** Regenerate shifts every index, and `POST /api/thesis/:id/ops` is positional. The document DTO already carries `docHash` (`lib/api.ts:1641`). `applyThesisOps(thesisId, ops, ifMatch?)` sends it as `If-Match: "<docHash>"` (the server side is Task S19); `stores/thesis-doc-store.ts`'s drain passes the `docHash` of the document it holds, and a 412 takes the existing path ('server rejected: drop the queue, alert, revalidate') that a rejected op already takes. An older server ignores the header. Three more calls: the done push (`data.type='rescue'` with a thesis) calls `revalidate(thesisId)` in the foreground handler and on tap; `useThesisDocStore.revalidate` also runs when a mounted workspace regains focus while `listRescueProjects` says its thesis has a project (one cached lookup per focus); and `beginRerun` already flushed the queue (A1). Tests, `thesis-doc-store` suite: an op queued before a publish is sent with the old hash, answered 412, dropped, and the document revalidated; with the right hash it applies; with no hash known it is sent without the header, as today.

- [ ] **Step 6: Check.** `npx tsc --noEmit && npx vitest run`, then walk W8.

- [ ] **Step 7: Commit** the exact paths. Message: `feat(rescue-v2): drawer row, home card, push routing and cold-start resume`.

### Task A10: Share → Kwill. THIS TASK CHANGES `app.json` AND THE NATIVE PROJECTS

**This is the only task in M5 that moves the fingerprint.** Every installed binary is cut off from OTA the moment this lands. So **write it now, on branch `release/rescue-v2-share`, and do not merge it to `master` until the release**. Everything else in M5 is JS-only, and `master` stays publishable meanwhile.

**Never in the shared tree.** Other sessions work in `~/kwill` on `master`, with one moving HEAD. `android/` and `ios/` are gitignored, so a prebuild there changes them for everyone and no branch holds it, and `scripts/build-apk.sh` runs Gradle on whatever `android/` holds: any APK built from `master` afterwards would advertise Share → Kwill with no `+native-intent` to route it. So every step below runs in a worktree with its own native output:
```bash
cd ~/kwill && git worktree add ~/kwill-share -b release/rescue-v2-share master
cd ~/kwill-share
cp -cR ~/kwill/node_modules node_modules          # an APFS clone: real files for Metro and Gradle, and a release build's rewrite stays in this copy
cp -cR ~/kwill/android android && cp -cR ~/kwill/ios ios   # iOS signing lives only in the gitignored ios/
cp ~/kwill/.env .env
```
When `master` moves, `git rebase master` here. The native output never leaves this tree: §7 runs prebuild again in `~/kwill` at the release.

**Files:**
- Create: `app/+native-intent.ts`, `lib/rescue-v2-share.ts`, `lib/rescue-v2-share.test.ts`
- Modify: `app.json`, `vitest.config.ts`, `components/rescue/ShareInbox.tsx` (step 6)

- [ ] **Step 1: Failing test, then implement** the pure routing. The docs' example falls back to `/` on a parse error, which would break every relative deep link (password reset, payment), so this returns the path instead.
```ts
// lib/rescue-v2-share.ts
export function routeForIncoming(path: string): string {
  try {
    if (new URL(path).hostname === "expo-sharing") return "/rescue?share=1";
  } catch {
    // A relative path or a custom scheme with no host: not ours.
  }
  return path;
}
// app/+native-intent.ts
import { routeForIncoming } from "@/lib/rescue-v2-share";
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return routeForIncoming(path);
}
```
Tests: `kwill://expo-sharing?x=1` → `/rescue?share=1`; `kwill:///#access_token=abc` → unchanged; `/payment-success?rescue=1` → unchanged; `kwill://payment-success` → unchanged; an empty string → unchanged.

- [ ] **Step 2: `app.json`.** Replace the bare `"expo-sharing"` plugin entry:
```json
[
  "expo-sharing",
  {
    "android": {
      "enabled": true,
      "singleShareMimeTypes": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      "multipleShareMimeTypes": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
    },
    "ios": {
      "enabled": true,
      "extensionBundleIdentifier": "com.kwill.app.ShareExtension",
      "appGroupId": "group.com.kwill.app",
      "activationRule": { "supportsFileWithMaxCount": 12 }
    }
  }
]
```
`extensionBundleIdentifier` is set because the docs (`.ShareExtension`) and the plugin's code (`.expo-sharing-extension`) disagree on the default. The feature is marked experimental in the docs, and opening the main target from an iOS extension "may stop working in a future iOS release": if it ever does, the picker on screen 1 still works, so nothing is lost.

- [ ] **Step 3: Regenerate natively.**
```bash
cd ~/kwill-share     # never ~/kwill
npx expo prebuild -p android --no-install
npx expo prebuild -p ios --no-install       # NOT --clean: iOS signing lives only in the gitignored ios/
git diff app.json                            # prebuild can rewrite it: only the plugin block may differ; restore anything else
```
`scripts/build-apk.sh` never runs prebuild, so this step is what lands the intent filters in this tree's `AndroidManifest.xml`.

- [ ] **Step 4: Things only the owner can do**, listed for the final report rather than asked for: in the Apple Developer portal, register App Group `group.com.kwill.app`, App ID `com.kwill.app.ShareExtension` with that group, add the group to `com.kwill.app`, make both provisioning profiles, and select them in Xcode for the `expo-sharing-extension` target. The plugin assumes EAS-managed signing; Kwill archives locally.

- [ ] **Step 5: Test on a device**, walk W10, on a release-candidate binary built in `~/kwill-share`. Android: Files → Share → Kwill, one and several. WhatsApp → Kwill. Telegram → Kwill. If Telegram sends `application/octet-stream`, add that type to both lists, keeping the `.docx` filter in `ShareInbox`, which then says `start.notDocx` for anything else. iOS: Files, WhatsApp, Telegram. `parseProvider` in `plugin/template-files/ios/ShareIntoViewController.swift` needs `public.file-url` or PDF, or the extension closes silently, so a sender that offers neither shows nothing; note which, do not patch the template (a `patches/` file is itself a fingerprint input).

- [ ] **Step 6: The copy in the app group.** `clearSharedPayloads` leaves the file in the group container. In `ShareInbox`, after a successful `begin`, delete the file with `new File(uri).delete()` inside a `try`: a thesis must not stay there.

- [ ] **Step 7: Commit in `~/kwill-share`, on `release/rescue-v2-share`,** with the exact paths, message `feat(rescue-v2): Share to Kwill from WhatsApp, Telegram and Files`. **Do not publish an OTA from a tree holding this commit before the release's new binary exists.**

### Task A11: the walks

Run §6's walks W1-W9 on the simulator and record a screenshot per screen in the scratchpad, light and dark, Arabic and French, then one pass of W1-W9 with the UI in English, light only. Run W11 here too: it needs S22's server, A5's screen 9 and a real failed run, none of which exist when Group D-B lands. Fix what they find in the owning task's files. Delete `lib/rescue-v2-fixtures.ts` and its branch in `store.open`. **M5 is not done until every walk passes.** W10 and the device pass go to the owner, in the final report: push delivery in W6, W7 and W8 needs a real device, because `registerForPushNotificationsAsync` returns no token on a simulator or emulator.

---

## 4. M6: the dashboard

**Ends with:** a price saved in the dashboard shows in the app within one poll, and every run, with its cost, failure and Support link, is on one page.

**Repo rules.** `~/kwill-dashboard`. A push to `master` goes live on Vercel, so **commit and hold until the release**: these pages call `/admin/rescue/*`, which production does not have yet. 51 other dirty paths exist in the tree: `git commit -- <exact paths>`. `.env.local` is cloud Supabase plus a localhost server, so the direct lane reads production: this module uses the API lane only. D4's Support inbox is the exception, a direct read, so W11 points the dashboard's Supabase variables at the local stack too (§6).

### Group D-A (one engineer, after S20 is merged on the server)

### Task D1: access, navigation, API client, words

**Files:**
- Modify: `src/lib/auth/access.ts`, `src/lib/auth/access.test.ts`, `src/components/sidebar.tsx`, `src/i18n/messages.ts`, `src/i18n/messages/en.json`, `src/i18n/messages/fr.json`, `src/i18n/messages/ar.json`
- Create: `src/lib/api/rescue.ts`, `src/features/rescue/types.ts`, `src/features/rescue/index.ts`, `src/features/rescue/format.ts`, `src/features/rescue/format.test.ts`, `src/features/rescue/locales.test.ts`, `src/features/rescue/locales/en.json`, `src/features/rescue/locales/fr.json`, `src/features/rescue/locales/ar.json`

- [ ] **Step 1: Failing access test.** `canAccessPath` is prefix-based, so the two pages get disjoint prefixes:
```ts
it("rescue: runs for support, platform and finance; price for finance only", () => {
  expect(canAccessPath("support_admin", "/d/rescue/runs")).toBe(true);
  expect(canAccessPath("platform_admin", "/d/rescue/runs")).toBe(true);
  expect(canAccessPath("finance_admin", "/d/rescue/runs")).toBe(true);
  expect(canAccessPath("finance_admin", "/d/rescue/price")).toBe(true);
  expect(canAccessPath("support_admin", "/d/rescue/price")).toBe(false);
  expect(canAccessPath("platform_admin", "/d/rescue/price")).toBe(false);
  expect(canAccessPath("content_admin", "/d/rescue/runs")).toBe(false);
  expect(canAccessPath("super_admin", "/d/rescue/price")).toBe(true);
});
```
`ROLE_ACCESS`: add `"/d/rescue/runs"` to `support_admin`, `platform_admin`, `finance_admin`; add `"/d/rescue/price"` to `finance_admin`.

- [ ] **Step 2: Sidebar.** In `GROUPS`: `operations` gains `{ href: "/d/rescue/runs", icon: "refresh-cw", labelKey: "sidebar.rescueRuns" }`; `finance` gains `{ href: "/d/rescue/price", icon: "wallet", labelKey: "sidebar.rescuePrice" }`. In `src/i18n/messages/*.json`, on the `sidebar` line, add `"rescueRuns"` (en "Rescue runs", fr "Sauvetages", ar "عمليات الإنقاذ") and `"rescuePrice"` (en "Rescue price", fr "Prix du sauvetage", ar "سعر الإنقاذ"). Edit that line surgically.

- [ ] **Step 3: `src/lib/api/rescue.ts`.** `server-only`, its own `adminCall`, same as `src/lib/api/manual-payments.ts`:
```ts
export type RescueSettings = { enabled: "off" | "staff" | "on"; priceDzd: number | null; freeDiagnosesPerDay: number; rerunWindowDays: number; planRescuesPer30d: number };
export function getRescueSettings(): Promise<RescueSettings>;
export function updateRescueSettings(body: Partial<RescueSettings>): Promise<{ saved: boolean }>;
export function listRescueRuns(q: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{ rows: RescueRunRow[]; total: number }>;
export function getRescueRunsSummary(days?: number): Promise<RescueRunsSummary>;
export function markRescueRefunded(paymentId: string, refundedBy: string, note?: string, confirmDelivered?: boolean): Promise<{ refunded: boolean }>;
export function retryRescueRun(versionId: string, requestedBy: string, overrideSameThesis?: boolean): Promise<{ versionId: string }>;
export function listRescueRefunds(q: { status?: "due" | "done"; limit?: number; offset?: number }): Promise<{ rows: RescueRefundRow[]; total: number }>;
export function sweepRescueForUser(userId: string): Promise<{ removed: number }>;
```
`features/rescue/types.ts`: `RescueRunRow`, `RescueRefundRow`, `RescueRunsSummary`, `RescueCost`, re-declared from §1.4 and §1.3.

- [ ] **Step 4: `features/rescue/format.ts`, with failing tests first.** Pure:
```ts
export function fmtDuration(seconds: number | null): string;   // "—", "45s", "12m 03s"
export function fmtCost(cost: RescueCost | null): { brain: string; dzd: string; word: string }; // "session", "—", "4 × 3m"; a model run: "model", "412 DZD", …
export function runStatusKey(row: RescueRunRow): "running" | "waiting" | "done" | "failed" | "refundDue";
export const RUN_STATUS_FILTERS = ["running", "waiting", "done", "failed", "refund_due"] as const;
```
A fixed list of filters, because pills built from loaded rows hide empty states.

- [ ] **Step 5: Locales.** `features/rescue/locales/{en,fr,ar}.json`, namespace `rescue`. Register in `src/i18n/messages.ts`: three imports and the three `byLocale` arrays. `locales.test.ts`, modelled on `src/features/overview/locales.test.ts`, uses relative imports because `vitest.config.ts` is untracked.
`en.json`:
```json
{ "rescue": {
  "runsTitle": "Rescue runs",
  "priceTitle": "Rescue price",
  "filters": { "all": "All", "running": "Running", "waiting": "Waiting", "done": "Done", "failed": "Failed", "refund_due": "Refund due" },
  "columns": { "time": "Time", "student": "Student", "thesis": "Thesis", "version": "Version", "status": "Status", "duration": "Duration", "pages": "Pages", "cost": "Cost", "failure": "Failure", "money": "Money", "actions": "Actions" },
  "kinds": { "original": "Diagnosis", "rescue": "First rescue", "rerun": "Re-run", "restore": "Restore" },
  "status": { "running": "Running", "waiting": "Waiting", "done": "Done", "failed": "Failed", "refundDue": "Refund due" },
  "waitingConverter": "Waiting for Word",
  "waitingBrain": "Waiting for the brain",
  "kpis": { "running": "Running", "waiting": "Waiting", "done": "Done", "failed": "Failed", "refundDue": "Refunds due", "avgFirst": "Avg first rescue", "avgRerun": "Avg re-run", "word": "Word machine" },
  "wordUp": "Reachable",
  "wordDown": "Unreachable",
  "included": "Included in plan",
  "markRefunded": "Mark refunded",
  "refundConfirm": "Return the money first, in Chargily or by transfer, then mark it here. The student is told.",
  "refundNote": "Note (optional)",
  "retry": "Retry",
  "retryOverride": "Retry anyway (this is the same thesis)",
  "refundDeliveredConfirm": "A rescue was delivered for this payment. Refund it anyway?",
  "stats": { "stuck": "Stuck", "oldestHeavy": "Oldest heavy job (s)", "storage": "Storage", "canary": "Word check", "canaryRestarts": "Word restarts, 24 h" },
  "refundsTitle": "Refunds due",
  "refundsEmpty": "No refund is due.",
  "projectGone": "Project deleted",
  "openSupport": "Support thread",
  "searchPlaceholder": "Search by email",
  "empty": "No runs yet.",
  "loadFailed": "Could not load this from the server.",
  "price": {
    "label": "Price of one rescue (DZD)",
    "help": "Whole dinars. Empty means not for sale: the app says the repair isn't available.",
    "enabled": "Open rescue to students",
    "enabledHelp": "Off: every student route answers \"disabled\". Staff only: the routes open for staff accounts and jobs run, for the trial on the real host. On: students.",
    "enabledOff": "Off",
    "enabledStaff": "Staff only",
    "enabledOn": "On, for students",
    "planRescues": "Rescues a plan includes per 30 days",
    "freePerDay": "Free checks per student per day",
    "windowDays": "Days of free re-runs after purchase",
    "save": "Save",
    "saved": "Saved",
    "invalid": "Enter a whole number from 1 to 100000, or leave it empty."
  }
} }
```
`fr.json`:
```json
{ "rescue": {
  "runsTitle": "Sauvetages",
  "priceTitle": "Prix du sauvetage",
  "filters": { "all": "Tous", "running": "En cours", "waiting": "En attente", "done": "Terminés", "failed": "Échoués", "refund_due": "À rembourser" },
  "columns": { "time": "Heure", "student": "Étudiant", "thesis": "Mémoire", "version": "Version", "status": "État", "duration": "Durée", "pages": "Pages", "cost": "Coût", "failure": "Échec", "money": "Paiement", "actions": "Actions" },
  "kinds": { "original": "Diagnostic", "rescue": "Premier sauvetage", "rerun": "Reprise", "restore": "Restauration" },
  "status": { "running": "En cours", "waiting": "En attente", "done": "Terminé", "failed": "Échoué", "refundDue": "À rembourser" },
  "waitingConverter": "En attente de Word",
  "waitingBrain": "En attente du cerveau",
  "kpis": { "running": "En cours", "waiting": "En attente", "done": "Terminés", "failed": "Échoués", "refundDue": "À rembourser", "avgFirst": "Moyenne premier sauvetage", "avgRerun": "Moyenne reprise", "word": "Machine Word" },
  "wordUp": "Joignable",
  "wordDown": "Injoignable",
  "included": "Inclus dans l'abonnement",
  "markRefunded": "Marquer comme remboursé",
  "refundConfirm": "Rendez d'abord l'argent, sur Chargily ou par virement, puis marquez-le ici. L'étudiant est prévenu.",
  "refundNote": "Note (facultatif)",
  "retry": "Relancer",
  "retryOverride": "Relancer quand même (c'est le même mémoire)",
  "refundDeliveredConfirm": "Un sauvetage a été livré pour ce paiement. Rembourser quand même ?",
  "stats": { "stuck": "Bloqués", "oldestHeavy": "Plus ancienne tâche lourde (s)", "storage": "Stockage", "canary": "Test de Word", "canaryRestarts": "Redémarrages de Word, 24 h" },
  "refundsTitle": "À rembourser",
  "refundsEmpty": "Aucun remboursement en attente.",
  "projectGone": "Projet supprimé",
  "openSupport": "Fil de support",
  "searchPlaceholder": "Chercher par e-mail",
  "empty": "Aucun sauvetage pour l'instant.",
  "loadFailed": "Impossible de charger cela depuis le serveur.",
  "price": {
    "label": "Prix d'un sauvetage (DZD)",
    "help": "En dinars entiers. Vide : pas en vente, l'application dit que la remise en forme n'est pas disponible.",
    "enabled": "Ouvrir le sauvetage aux étudiants",
    "enabledHelp": "Désactivé : toutes les routes étudiant répondent « désactivé ». Équipe seulement : les routes s'ouvrent aux comptes de l'équipe et les tâches tournent, pour l'essai sur l'hôte réel. Activé : les étudiants.",
    "enabledOff": "Désactivé",
    "enabledStaff": "Équipe seulement",
    "enabledOn": "Activé, pour les étudiants",
    "planRescues": "Sauvetages inclus par abonnement sur 30 jours",
    "freePerDay": "Diagnostics gratuits par étudiant et par jour",
    "windowDays": "Jours de reprises gratuites après l'achat",
    "save": "Enregistrer",
    "saved": "Enregistré",
    "invalid": "Entrez un nombre entier de 1 à 100000, ou laissez vide."
  }
} }
```
`ar.json`:
```json
{ "rescue": {
  "runsTitle": "عمليات الإنقاذ",
  "priceTitle": "سعر الإنقاذ",
  "filters": { "all": "الكل", "running": "قيد العمل", "waiting": "في الانتظار", "done": "مكتملة", "failed": "لم تكتمل", "refund_due": "مبالغ للإعادة" },
  "columns": { "time": "الوقت", "student": "الطالب", "thesis": "المذكرة", "version": "النسخة", "status": "الحالة", "duration": "المدة", "pages": "الصفحات", "cost": "التكلفة", "failure": "سبب التوقف", "money": "الدفع", "actions": "إجراءات" },
  "kinds": { "original": "تشخيص", "rescue": "الإنقاذ الأول", "rerun": "إعادة", "restore": "استرجاع" },
  "status": { "running": "قيد العمل", "waiting": "في الانتظار", "done": "مكتملة", "failed": "لم تكتمل", "refundDue": "مبلغ للإعادة" },
  "waitingConverter": "في انتظار Word",
  "waitingBrain": "في انتظار الدماغ",
  "kpis": { "running": "قيد العمل", "waiting": "في الانتظار", "done": "مكتملة", "failed": "لم تكتمل", "refundDue": "مبالغ للإعادة", "avgFirst": "متوسط الإنقاذ الأول", "avgRerun": "متوسط الإعادة", "word": "جهاز Word" },
  "wordUp": "متصل",
  "wordDown": "غير متصل",
  "included": "مشمول في الباقة",
  "markRefunded": "تأكيد إعادة المبلغ",
  "refundConfirm": "أعد المبلغ أولًا عبر Chargily أو بتحويل، ثم أكّد هنا. سيصل إشعار إلى الطالب.",
  "refundNote": "ملاحظة (اختياري)",
  "retry": "أعد المحاولة",
  "retryOverride": "أعد المحاولة رغم ذلك (هي المذكرة نفسها)",
  "refundDeliveredConfirm": "سُلّم إنقاذ مقابل هذه الدفعة. هل نسترجعها رغم ذلك؟",
  "stats": { "stuck": "عالقة", "oldestHeavy": "أقدم مهمة ثقيلة (ث)", "storage": "التخزين", "canary": "فحص Word", "canaryRestarts": "إعادات تشغيل Word، 24 ساعة" },
  "refundsTitle": "مبالغ للإعادة",
  "refundsEmpty": "لا مبلغ للإعادة.",
  "projectGone": "مشروع محذوف",
  "openSupport": "محادثة الدعم",
  "searchPlaceholder": "ابحث بالبريد الإلكتروني",
  "empty": "لا توجد عمليات بعد.",
  "loadFailed": "تعذّر تحميل هذا من الخادم.",
  "price": {
    "label": "سعر الإنقاذ الواحد (دج)",
    "help": "دنانير كاملة. فارغ يعني غير معروض للبيع، ويقول التطبيق إن الإصلاح غير متاح.",
    "enabled": "فتح الإنقاذ للطلبة",
    "enabledHelp": "إيقاف: كل مسارات الطلبة تجيب «غير مفعّل». للفريق فقط: تُفتح المسارات لحسابات الفريق وتعمل المهام، لتجربة الخادم الحقيقي. تفعيل: للطلبة.",
    "enabledOff": "إيقاف",
    "enabledStaff": "للفريق فقط",
    "enabledOn": "تفعيل للطلبة",
    "planRescues": "عدد الإنقاذات المشمولة بالاشتراك كل 30 يومًا",
    "freePerDay": "التشخيصات المجانية لكل طالب في اليوم",
    "windowDays": "أيام الإعادة المجانية بعد الشراء",
    "save": "حفظ",
    "saved": "تم الحفظ",
    "invalid": "أدخل عددًا صحيحًا من 1 إلى 100000، أو اتركه فارغًا."
  }
} }
```
The parity test fails on a missing key.

- [ ] **Step 6: Run and commit** the exact paths. Message: `feat(rescue): dashboard access, navigation and API client`.

### Group D-B (three engineers at once, after D1)

### Task D2: the price

**Files:** Create `src/app/d/rescue/price/page.tsx`, `src/app/d/rescue/price/client.tsx`, `src/app/d/rescue/price/action.ts`, `src/features/rescue/components/price-form.tsx`, `src/features/rescue/price-parse.ts`, `src/features/rescue/price-parse.test.ts`.

- `page.tsx`: first line `await requirePathAccess("/d/rescue/price");`, `dynamic = "force-dynamic"`, `getRescueSettings().catch(() => null)`.
- `action.ts`: `"use server"`, `hasStaffRole("finance_admin")` first; `revalidatePath`.
- `price-form.tsx`, modelled on `manual-payment-settings-form.tsx`, with `enabled` as a three-way choice (`enabledOff`, `enabledStaff`, `enabledOn`, P-68) and a number field `planRescues` (0..20, P-58), with **one difference that matters: `settings === null` (a failed load) disables Save** and shows `loadFailed`, because a blank form saved would take the rescue off sale.
- `price-parse.ts`: `parsePrice("")` → null; `"2500"` → 2500; `"0"`, `"-1"`, `"2.5"`, `"abc"`, `"100001"` → `"invalid"`. Tests first.

- [ ] **Step 1: Failing tests. Step 2: Build; `npx tsc --noEmit && npx vitest run`. Step 3: Commit** the exact paths. Message: `feat(rescue): the price setting`. W11 runs in A11: the route it calls is mounted only in S21.

### Task D3: the runs list

**Files:** Create `src/app/d/rescue/runs/page.tsx`, `src/app/d/rescue/runs/client.tsx`, `src/app/d/rescue/runs/action.ts`, `src/features/rescue/data.ts`, `src/features/rescue/components/runs-view.tsx`.

- `page.tsx`: `await requirePathAccess("/d/rescue/runs");`, reads `?status`, `?q`, `?page`; `getRunsSnapshot({ status, q, offset })`; force-dynamic.
- `data.ts`: `server-only`, over `listRescueRuns`, `listRescueRefunds` and `getRescueRunsSummary`; failures become `{ rows: [], refunds: [], total: 0, summary: null, error }`, as `src/features/pdf-conversions/data.ts` does.
- `runs-view.tsx`:
  - `StatGrid` of `summary`: running, waiting, done, failed, refunds due, average first rescue and re-run (cost and time; "—" until M7 writes tokens), Word reachable with a dot, the last canary (`stats.canary`, with `stats.canaryRestarts`; red when the last check failed, P-54), `stats.stuck`, `stats.oldestHeavy` and `stats.storage` from the summary (P-61, P-64).
  - A `refundsTitle` panel above the table, from `listRescueRefunds({ status: "due" })`: student, amount, project title or `projectGone`, reason, and `markRefunded` behind the same inline confirm. It reads `payments`, so a double payment and a payment whose project is gone are on it and can be marked. `refundsEmpty` when there are none.
  - Debounced `?q=` search and a pill row from `RUN_STATUS_FILTERS`, as `subscriptions-list.tsx`.
  - `DataTable` columns: time (`suppressHydrationWarning`); student: email links to `/d/users/{userId}`, "—" with no profile; thesis: title links to `/d/theses/{thesisId}`, else the mono short id with the full id in `title` (the pdf-conversions pattern); version `n` and kind; status pill with `stage`, and `waitingConverter`/`waitingBrain`; duration; pages; cost from `fmtCost`; failure code and page; money: amount, `included` for a subscription, refund state; actions.
  - **Pagination is server-side here.** Real Previous/Next from `total` and `?page=`, not `DataTable`'s client pages, because the pages in this repo stop at 50 and ignore `total`.
- `action.ts`: `markRefunded(paymentId, note)` guarded by `hasStaffRole("finance_admin")`, passing the acting staff id; `retryRun(versionId)` guarded by `hasStaffRole("support_admin", "platform_admin")`.
- Actions in the row: `markRefunded` when `refundStatus='due'`, behind an inline confirm with `refundConfirm` and the note (a second confirm, `refundDeliveredConfirm`, when the server answers `rescue_already_delivered`, then it resends with `confirmDelivered`); `retry` when `failed`, and `retryOverride` for a `not_same_thesis` failure whose Support case asked for a look (P-57); `openSupport` → `/d/support?conversation={id}` when there is one.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit && npx vitest run`. Step 3: Commit** the exact paths. Message: `feat(rescue): the runs list with cost, failures, refunds and Support handoff`. W11 runs in A11.

### Task D4: handoff touches in other modules

**Files:** Modify `src/app/d/support/page.tsx`, `src/features/support/components/inbox.tsx`, `src/features/manual-payments/components/manual-payments-list.tsx`, `src/features/manual-payments/types.ts`, `src/features/manual-payments/locales/en.json`, `fr.json`, `ar.json`, `src/app/d/users/action.ts`. Create `src/app/d/users/action.test.ts`.

- `/d/support?conversation=<id>`: the page reads it; if that thread is not in the newest 100, `getSupportConversation(id)` (it exists, unused) and prepend it. `Inbox` takes `initialId?: string` and seeds `useState(initialId ?? rows[0]?.id ?? "")`. It also shows `topic` beside the subject, so `rescue_failure` threads stand out.
- Manual payments: `kind` adds `"rescue"`; the column reads `r.kind === "topup" ? t("kindTopup") : r.kind === "rescue" ? t("kindRescue") : r.plan ?? "—"`. Add `kindRescue` (en "Thesis rescue", fr "Sauvetage de mémoire", ar "إنقاذ مذكرة"). Today it renders "—".
- Staff delete (P-34): `deleteUserAccount` calls `auth.admin.deleteUser` directly and never reaches the server, so a student's rescue blobs would stay with nothing left to find them. It now calls `sweepRescueForUser(id)` first, and a failed sweep throws with the account still there. `action.test.ts`, both calls mocked: sweep before delete; a sweep failure means no delete.

- [ ] **Step 1: Build. Step 2: `npx tsc --noEmit && npx vitest run`. Step 3: Commit** the exact paths. Message: `feat(support,payments): deep link to a thread; manual payments name a rescue; a staff delete sweeps rescue files`.

---

## 5. File ownership and order

A group's tasks run at the same time on disjoint files. A group starts only when the group before it on its track is merged. **Gate 0** is the same for all and is strict (P-53): M2b's integrator has reported done **and** M3 is finished and merged: its §1 code (`review/review-task.ts`, `fixes.ts`, `round.ts`), its `review` CLI command, `replay.ts`, and the whole fix loop, with the corpus replays green. M3 lands before M4 starts so the two never edit `regenerate/*`, `prove/*`, `scripts/rescue-lab/cli.ts` or `replay.ts` at once; from Gate 0 on, S5 owns `cli.ts`, and a defect found later goes through the owner task's files (S22 step 2), not through the M3 loop. S22 still needs t03 and one split thesis to rescue, and S9a's Step 0 records the corpus before it touches anything.

```
Gate 0 (M2b integrated, M3 §1 code)
   │
   ▼
S-A  S0 → S2 → S1 → S3 → S4  (one engineer, in order)
   │ ├───────────────────────────────────► A-A  A1 → A2 → A3   (app needs the contract only)
   ▼                                          │
S-B  S9a ║ S9c → S5 ║ S6 ║ S7 ║ S8 ║ S9 ║ S9b   ▼
   │                                        A-B  (A4 ║ A5 ║ A6 ║ A7) → A8
   ▼                                          │
S-C  S10 ║ S11 ║ S12 ║ S13                    │
   │                                          │
   ▼                                          │
S-D  S14 ║ S15                                │
   │                                          │
   ▼                                          │
S-E  S16                                      │
   │                                          │
   ▼                                          │
S-F  S17 ║ S18 ║ S19 ║ S20 ──► D-A  D1 → D-B  D2 ║ D3 ║ D4
   │                                          │
   ▼                                          │
S-G  S21 → S22 ───────────────────────────────┤
                                              ▼
                                            A-C  A9 → A10 (its own worktree and branch) → A11 (walks need S22; W11 runs here, after D-B)
```
`║` = at the same time. `→` = in order. Nothing in a `║` group imports a file another task of that group is writing: what they share is in `pipeline/contract.ts` (S2), or comes from an earlier wave. A-B can start before the server is finished: until S19 lands, its steps are built against `lib/rescue-v2-fixtures.ts` through `?fixture=<phase>` (dev only, Task A1, removed in A11), and the walks wait.

**Who owns what.** No two tasks in one group touch one file. A file named twice below belongs to two tasks in different groups, which never run together.

| Task | Owns |
|---|---|
| S0 | `scripts/rescue-local-db.sh`, `vitest.config.ts`, `src/__tests__/setup-local-db-only.ts`, `src/__tests__/local-db-only.test.ts` |
| S1 | `sql/2026-11-02-rescue-v2.sql`, `src/db/rescue-schema.ts`, `src/db/index.ts`, `src/lib/rescue-run/__tests__/schema.test.ts` |
| S2 | `src/lib/rescue/pipeline/contract.ts`, `pipeline/phase.ts`, `brain/brain.ts`, `brain/session-brain.ts`, `__tests__/pipeline-phase.test.ts` |
| S3 | `src/lib/rescue/map/build-map-tasks.ts`, `brain/tasks.ts`, their tests |
| S4 | `src/lib/rescue/rules/rules.ts`, `rules/fields.ts`, their tests |
| S5 | (reads `scripts/rescue-lab/replay.ts`, M3's; does not edit it) `src/lib/rescue/pipeline/renderer.ts`, `pipeline/stages-free.ts`, `pipeline/stages-rescue.ts`, `pipeline/cover-sample.ts`, `preview/preview.ts`, `prove/prove.ts`, `src/lib/render/page-images.ts`, `src/lib/word-converter.ts` (the two error classes), `deposit/page-counter.ts`, `scripts/rescue-lab/cli.ts`, `scripts/rescue-lab/render.ts`, `__tests__/pipeline-stages.test.ts`, `__tests__/pipeline-stages-word.test.ts`, `__tests__/preview.test.ts` |
| S6 | `src/lib/rescue/brain/ask-task.ts`, `brain/parse-note-task.ts`, `brain/read-guide-task.ts`, their tests |
| S7 | `src/lib/rescue/blocks/diff.ts`, `blocks/strip-generated.ts`, `blocks/answers.ts`, their tests |
| S8 | `src/lib/rescue/rules/note-merge.ts`, its test |
| S9 | `src/lib/rescue/pipeline/change-events.ts`, `pipeline/change-report.ts`, `pipeline/diagnosis-view.ts`, `pipeline/impact.ts`, their tests |
| S9a | `src/lib/rescue/regenerate/styles.ts`, `regenerate/layout.ts`, `regenerate/dividers.ts`, `regenerate/tables.ts`, `regenerate/apparatus.ts`, `regenerate/index.ts`, `reset/reset.ts`, `__tests__/note-effects.test.ts`, `__tests__/note-effects-word.test.ts` |
| S9b | `src/lib/rescue/review/review-task.ts`, `review/round.ts`, `__tests__/review-note-pages.test.ts` |
| S9c | `src/lib/rescue/diagnose/diagnose.ts`, `diagnose/facts.ts`, `__tests__/diagnose.test.ts`, `__tests__/facts.test.ts` |
| S10 | `scripts/word-convert-service.mjs`, `scripts/word-tunnel-watchdog.sh`, `scripts/quick-tunnel-word.sh`, `scripts/install-word-converter-launchagents.sh`, `scripts/word-sanitize.mjs`, `scripts/word-classify.mjs`, `src/lib/word-converter.ts`, `src/__tests__/word-converter-jobs.test.ts`, `word-tunnel-watchdog.test.ts`, `quick-tunnel-word.test.ts`, `word-sanitize.test.ts`, `word-classify.test.ts` (`scripts/word-lock.mjs` is done and not touched) |
| S11 | `src/lib/document-storage.ts`, `src/lib/rescue-run/config.ts`, `rescue-run/storage.ts`, `rescue-run/preflight.ts`, their tests |
| S12 | `src/lib/rescue-run/repo.ts` (including `hasPendingPayment` and `CARD_PENDING_MINUTES`, which S14 and S15 import), `rescue-run/jobs.ts`, their tests |
| S13 | `src/lib/support-cases.ts`, `src/lib/notifications.ts`, `src/routes/support.ts`, `src/lib/rescue-run/copy.ts`, `rescue-run/notify.ts`, their tests |
| S14 | `src/lib/rescue-run/entitlement.ts`, `rescue-run/email.ts`, `src/lib/billing/open-checkout.ts`, `src/lib/billing/manual-payments.ts`, `src/routes/payment.ts`, `src/routes/pay.ts`, their tests |
| S15 | `src/lib/rescue-run/sweep.ts`, `src/lib/thesis-delete.ts`, `src/routes/user.ts`, `src/mcp/tools/thesis.ts` (`delete_thesis`), its test |
| S16 | `src/lib/rescue-run/runner.ts`, `tick.ts`, `kick.ts`, `stage-context.ts`, `stages/index.ts`, `renderer.ts`, `brain-factory.ts`, `failure.ts`, `cost.ts`, `rules-state.ts`, `catalogue.ts`, `reconcile.ts`, `src/routes/tasks.ts`, `__tests__/fakes.ts`, and the first version of `stages/free.ts`, `stages/rescue.ts`, `stages/side.ts`; their tests |
| S17 | `src/lib/rescue-run/stages/free.ts`, `stages/side.ts`, their tests |
| S18 | `src/lib/rescue-run/stages/rescue.ts`, its tests |
| S19 | `src/routes/rescue-v2.ts`, `src/lib/rescue-run/dto.ts`, `src/lib/thesis-history.ts` (`pinSnapshot`, one hunk), `src/routes/thesis/blocks.ts` (`If-Match` on `/ops`, one hunk), their tests |
| S20 | `src/routes/admin-rescue.ts`, its test |
| S21 | `src/index.ts`, `DEPLOY_OCTENIUM.md`, `scripts/rescue-lab/README.md`, `src/lib/rescue-run/__tests__/guard.test.ts`, `src/__tests__/rescue-boot-graph.test.ts` |
| S22 | `scripts/rescue-e2e/*` (including `stub-converter.ts`), `scripts/rescue-lab/replay-rerun.ts`, the constant in `rescue-run/dto.ts` |
| A1 | `types/rescue-v2.ts`, `lib/rescue-v2-enabled.ts`, `lib/rescue-v2-api.ts`, `lib/rescue-v2-screen.ts` + test, `lib/rescue-v2-layout.ts` + test, `lib/rescue-v2-upload.ts`, `lib/rescue-v2-page-cache.ts`, `lib/rescue-v2-fixtures.ts`, `stores/rescue-v2-store.ts`, `hooks/useRescuePolling.ts`, `constants/colors.ts`, `lib/api.ts`, `vitest.config.ts` |
| A2 | `locales/ar.json`, `locales/fr.json`, `locales/en.json`, `lib/rescue-v2-locales.test.ts`, `vitest.config.ts` |
| A3 | `app/(app)/rescue/*`, `app/(app)/_layout.tsx`, `stores/bottom-sheet-store.ts`, `components/rescue/LivingScreen.tsx`, `RescueStage.tsx`, `LivingSheet.tsx`, `PageImage.tsx`, `PageCarousel.tsx`, `SkeletonPage.tsx`, `StageChrome.tsx`, `ui.tsx`, `CountUp.tsx`, `steps/index.ts`, `components/skeletons/RescueSkeleton.tsx`, `hooks/useDrawerSwipeLock.ts`, `hooks/useRescueBack.ts`, and the first version of every step file and of `NoteChips.tsx`, `VoiceMic.tsx`, `ShareInbox.tsx` |
| A4 | `components/UniversityPicker.tsx` (a `sheet` prop), `components/rescue/steps/StartStep.tsx`, `PartsStep.tsx`, `ReadingStep.tsx`, `WhichRulesStep.tsx`, `NotesStep.tsx`, `UnderstoodStep.tsx`, `components/rescue/MiniTextPage.tsx`, `NoteChips.tsx`, `VoiceMic.tsx`, `ShareInbox.tsx` |
| A5 | `steps/DiagnosisStep.tsx`, `PreviewStep.tsx`, `PaymentStep.tsx`, `components/rescue/DiagnosisDots.tsx`, `SweepFade.tsx`, `SegSwitch.tsx`, `app/(app)/payment-manual.tsx`, `payment-manual-submitted.tsx`, `payment-success.tsx`, `payment-failed.tsx` |
| A6 | `steps/RulesStep.tsx`, `QuestionStep.tsx`, `CoverStep.tsx`, `components/rescue/MarginOverlay.tsx`, `RuleRow.tsx`, `RulePickerSheet.tsx`, `PageZoom.tsx`, `CoverFieldSheet.tsx` |
| A7 | `steps/RepairingStep.tsx`, `ResultStep.tsx`, `ChangedStep.tsx`, `RevisionsStep.tsx`, `FailureStep.tsx`, `lib/download-export.ts`, `lib/download-export.web.ts` |
| A8 | `app/(app)/rescue/library.tsx`, `steps/TimelineStep.tsx`, `VersionStep.tsx`, `CompareStep.tsx`, `EditRerunStep.tsx`, `components/rescue/CompareSlider.tsx`, `RestoreDialog.tsx`, `app/(app)/thesis-detail.tsx` |
| A9 | `lib/api.ts` (`applyThesisOps` `ifMatch`, one hunk), `stores/thesis-doc-store.ts` (the drain's hash), `components/AppDrawer.tsx`, `components/chat/ChatWelcome.tsx`, `app/_layout.tsx`, `types/notification.ts`, `lib/push-notifications.ts`, `app/(app)/notifications.tsx`, `components/rescue/RescueHomeCard.tsx`, `hooks/useRescueColdStart.ts` |
| A10 | `app/+native-intent.ts`, `lib/rescue-v2-share.ts` + test, `app.json`, `vitest.config.ts`, `components/rescue/ShareInbox.tsx`, on its own branch, in the `~/kwill-share` worktree with its own `android/` and `ios/` |
| D1 | `src/lib/auth/access.ts` + test, `src/components/sidebar.tsx`, `src/i18n/messages.ts`, `src/i18n/messages/*.json`, `src/lib/api/rescue.ts`, `src/features/rescue/{types,index,format}.ts`, `format.test.ts`, `locales.test.ts`, `locales/*` |
| D2 | `src/app/d/rescue/price/*`, `src/features/rescue/components/price-form.tsx`, `price-parse.ts` + test |
| D3 | `src/app/d/rescue/runs/*`, `src/features/rescue/data.ts`, `components/runs-view.tsx` |
| D4 | `src/app/d/support/page.tsx`, `src/features/support/components/inbox.tsx`, `src/features/manual-payments/components/manual-payments-list.tsx`, `types.ts`, `locales/*`, `src/app/d/users/action.ts` + test |

Merge overlap with `feat/web-version` (not merged, 7 ahead, 149 behind): `app.json`, `lib/push-notifications.ts`. Its spec keeps rescue on the phone, so M5 is not blocked (D-9). This plan respects its rule that no web-reachable module imports `expo-file-system` at module scope.

---

## 6. The walks

**Environment** (localhost, never the cloud, P-37). Server: the block in `scripts/rescue-e2e/README.md`. Open it to students and keep a tick running, which releases expired leases just as the production cron does:
```bash
curl -s -X PUT localhost:3000/admin/rescue/settings -H 'x-admin-token: local' -H 'content-type: application/json' -d '{"enabled":"on","priceDzd":2500,"freeDiagnosesPerDay":50}'
while true; do curl -s -X POST localhost:3000/api/tasks/tick -H 'x-tasks-secret: local' >/dev/null; sleep 60; done
```
App, by hand: `./scripts/dev-net.sh` does not do this. `~/kwill/.env` holds an `https://` cloud Supabase URL, its rewrite matches only `http://` and never touches the anon key, so the app would keep signing in on cloud and the local server would reject its tokens at the first call; and a full run restarts the server with plain `npm run dev`, which in a new window reads `.env`, the cloud database.
```bash
cd ~/kwill && cp .env .env.walk.bak                     # restore it afterwards, and never publish an update from this state
IP=$(ipconfig getifaddr en0)
ANON=$(cd ~/kwill-server && supabase status -o env | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')
sed -i '' -E "s|^EXPO_PUBLIC_SUPABASE_URL=.*|EXPO_PUBLIC_SUPABASE_URL=http://$IP:54331|; s|^EXPO_PUBLIC_SUPABASE_ANON_KEY=.*|EXPO_PUBLIC_SUPABASE_ANON_KEY=$ANON|; s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=http://$IP:3000|" .env
grep -E 'EXPO_PUBLIC_(SUPABASE_URL|API_URL)' .env       # both http://<this Mac>
npx expo start --clear                                  # EXPO_PUBLIC_* are inlined at bundle time
# afterwards:
mv .env.walk.bak .env
```
Sign in with S0's accounts, password `test1234`: `rescue-student@kwill.local`, `rescue-subscriber@kwill.local`. An Android phone also needs `./scripts/dev-net.sh --adb-only`, for the port reverses and nothing else.

Dashboard, for W11: its Support inbox and staff login read Supabase directly, and `.env.local` points them at cloud, where the walk's threads do not exist. Shell variables outrank `.env.local`:
```bash
cd ~/kwill-dashboard && eval "$(cd ~/kwill-server && supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  MODAKERATI_SERVER_URL=http://localhost:3000 ADMIN_API_TOKEN=local npm run dev     # sign in as rescue-staff@kwill.local
```

**Driving the simulator** (memory: `docx-editor-migration`): Maestro, `~/.maestro/bin/maestro --udid <sim> test flow.yaml` with `point: "x%,y%"` integers only (iOS has no `back`), and `xcrun simctl io booted screenshot`. A simulator or emulator registers no push token (`registerForPushNotificationsAsync`), so on the simulator a walk tests the push's routing with `xcrun simctl push booted com.kwill.app payload.apns`, the payload being `{ "aps": { "alert": { "title": "t", "body": "b" } }, "body": { "route": "/(app)/rescue?projectId=<id>", "projectId": "<id>" } }`: `expo-notifications` reads `userInfo.body` as `data`. Delivery itself goes in the owner's device pass. DB checks with a node `postgres` one-liner against the local URL. If `npm run ios` fails linking `Sealable::Sealable()`, see memory `ios-prebuilt-stuck-on-release`. iOS hides purchases, so W3 runs on Android (`npm run android`, emulator or the owner's phone over `adb`); iOS runs W4.

**The brain.** Claude answers from the session: `npx tsx scripts/rescue-lab/cli.ts pending` lists tasks; write `<id>.answer.json.tmp`, then rename. Use a test file made for this, or an existing corpus thesis with its owner's permission; never quote it.

| Walk | Runs | Passes when |
|---|---|---|
| W1 Shell | iOS and Android, Arabic | `/rescue` opens from the drawer; an edge swipe opens no drawer there and still does in chat; the sheet springs between steps; **on iOS, from every step, ✕ or back leaves or goes to the previous step**, screens 1, 3-6, 8, 10-13 and notes included; Android back behaves; dark and light match the mock's tokens |
| W2 Free road | iOS, Arabic, one file; then Android, French, three parts | Screens 1, 3, 4, 5, 6, and 2 for the parts: during Word's conversion skeletons and `reading.converting`, then real pages appear one by one before the phase moves on; chips appear; a chip the file cannot honour reads as `refusedUnsupported`, not under "we understood"; a guide clash asks; with a guide still being read the CTA waits with `notes.waitGuide`; close the app during `map`, reopen, land on 6; a split thesis drags on both platforms, joins and merges; **with 12 parts the list drags and scrolls and the last row is not behind the CTA, and the university sheet opens, scrolls, takes typing with the keyboard up and picks**; with a science-profile university, the profile question shows and `no` leaves the default |
| W3 Android money | Android, free account; a manual payment approved with `curl` on `/admin/manual-payments/:id/approve`; then the card path with Chargily test keys and a hand-signed webhook | 7 → 8 (sweep plays) → 9 → under review → push "payment received" → 10. Close Chargily without paying: `pending_card` offers `payment.cardRetry`, and after 15 minutes (set `created_at` by SQL) the sheet is back to buying and the project can be deleted. Reject a manual payment: the push routes to 9 with the reason. After a marked refund, 9 offers buying again, **and after that second purchase the student is on 10, 11 and 12 and reaches 13, never back on 18** (a first rescue forced to fail before, acked, refunded, bought again). Kill the server between the webhook's claim and its grant: the tick grants it within two minutes and `confirming` ends by itself |
| W4 iOS status | iOS, free account; then the same project granted by `curl` | No price, no "free", no email word on 1, 4, 7, 8, 9, 17, 18, H2, H5. Status sheet shows; refresh after the grant moves to 10. A subscriber account skips 9. Screen 18 after a paid failure shows `refundDueStatus`, then `refundDoneStatus`, and never `noCharge` |
| W5 Confirm | Continue from W3 | Margins move on the page as a row changes; "from your note" tag shows; the additions row names how many captions get a number; a question zooms to its line; "let Kwill decide" works; each cover case: no cover, clean, messy; under keep and clean `cover.formsOnly` shows and an edited supervisor reaches the forms; on a generated cover the logo and the university from screen 4 show, and subtitle, programme and jury can be corrected; a missing title blocks with `cover.needed` |
| W6 Repair | Continue from W5 | 13 keeps v0's pages dim, then pages turn finished during `render`; close the app; kill the server mid-`render`; restart; routing checked with `simctl push`: a tap on the killed app lands on 15; PDF, Word and deposit pack download and open; the pack line names what is in the zip; force a total pack failure: "ready" still comes, 15 says the pack is missing, rebuild works; "opens in Kwill" lands in the workspace with this thesis; 16 lists every group, "show more" reaches the last row, and tapping jumps. On the owner's device: the push arrives |
| W7 Failure | `RESCUE_FORCE_FAIL=prove`, a purchase, then a subscriber, then a re-run; then a re-run of another document, **where back and ✕ on 17 acknowledge it and land on the last good result, 'Ask us to look' opens one Support case, and the dashboard retry with the override passes it** | 18 in each: "we will return your payment" / "nothing was charged" / "previous version as it was"; the original unchanged; the dashboard shows refund due; staff mark it; "we returned your payment" appears. On the owner's device: the push |
| W8 Cold start and push | Kill the app at each of: `reading`, `confirm_rules`, `repairing`, `done`, and a diagnosed project 2 days old (set `updated_at` by SQL); **and kill the app during an upload: the cold start shows `reading.uploadLost` and the choose-again button works (W8 covers a killed upload, which no earlier walk did)**. Then `simctl push` each of `parts_ready`, `setup_ready`, `questions_waiting`, `payment_rejected`, `done`, `failed` on a killed app. On iOS, on a binary with no share config | Resumes on the right screen for the first three, on a binary whose `getSharedPayloads` throws too; opens chat for the last two; the home card and the drawer offer them. Each push lands on its screen. With that project's screen open, no banner. On the owner's device: the events arrive |
| W9 History | After W6: edit two paragraphs in Kwill; re-run with a supervisor note, with a low-confidence new block; edit rules on H5; change the deposit rule alone on H5; leave H5 and come back; edit again and restore | H1 card; H2 keeps the grey edited step after the re-run, labelled "after the supervisor's notes"; 11 on the re-run shows the excerpt on a blank paper; H5 impact text matches what changes, is unchanged after leaving, and offers a run for a note alone and for the deposit alone (`pack_rebuilt`, same .docx); H3 downloads, and on a split original offers the parts; H4 steps only differing pages and the slider tracks the finger in Arabic and French; H6 warns about the edits, adds a version on top and the workspace shows it, and undo there brings the edits back; no question asked twice; **after the restore, a re-run with no file reaches `done` from the restored version's source and rules, H5 shows the restored rules and the impact is not empty; a supervisor note 'chapter titles at 18' changes the regenerated file (the font size on the page), is tagged 'from your note' and is not `note` scope in the impact; H1's ＋ starts a second rescue from a project that is done; H2 and H3 swipe through a past version's pages; 'Redo' on H1 lands on 17 and 'history' on the timeline from a cold app; an edit queued offline before a re-run is refused, not applied to another paragraph** |
| W10 Share | Device, by the owner, on a release-candidate binary built in `~/kwill-share` | WhatsApp, Telegram and Files → Kwill → screen 3, signed in and signed out, both platforms |
| W11 Dashboard | In A11, after S22 and A5. The dashboard on the local stack (above), staff signed in | Save a price; the app's screen 9 shows it on next open; clear it; `notForSale` shows. A blank load disables Save. Runs list filters; a double payment and a payment for a deleted project are on the refunds panel and can be marked; a failed run's Support link opens that thread; retry creates a version; a staff delete leaves no object under the student's root; roles: finance reaches price, support does not |

Every walk is repeated once in dark mode and once with the UI in French over an Arabic thesis: page direction follows the content, the sheet follows the UI. A11 adds one pass with the UI in English.

---

## 7. Handover to the single release

M7 comes between this plan and the release. This list is what M4-M6 leave for it. **Order is the spec's §12.**

1. **Rename landed.** `git diff package.json` on the server still holds the `mdocxengine` → `@kwill/docx-engine` hunk, uncommitted (memory: `docx-engine-npm-rename`). `scripts/deploy.mjs:57,98,118` handles only `mdocxengine`: change those lines to `@kwill/docx-engine` when the rename lands; until then a deploy needs the worktree pattern in memory `ios-purchases-hidden`.
2. **`adm-zip`** moves from `devDependencies` to `dependencies`: `deploy.mjs` drops dev deps, and it resolves today only through the engine's own dependency.
3. **Stage and boot before Passenger** (memory: `deploy-stage-boot-before-passenger`). Native imports are guarded by S21, and this catches what a test cannot.
3b. **Build and ship the engine with the server.** `cd ~/mdocxengine && npm run build` (M2 added engine exports), then deploy with `node scripts/deploy.mjs minor --engine --deps`, after the SQL step and the stage-and-boot check: `deploy.mjs` warns that new server code on an old engine has taken production down. The minor version bump follows the server's versioning rule.
4. **SQL on cloud before the deploy:** `supabase db query --linked -f sql/2026-11-02-rescue-v2.sql`, then the two checks of §1.2. Deploys before this point are safe for plans and top-ups (P-49), and `rescue.enabled` stays unset until it is done.
5. **Unverified on the host, check each:**
   - the cron exists and `TASKS_TICK_SECRET` is set; install §S21's block in cPanel, `flock` included;
   - `pdftoppm` is not needed there (P-8), but confirm `/jobs` works through the tunnel with a 100-page thesis;
   - raw `PUT` of 20 MB, the limit P-10 and P-64 allow, passes nginx and Passenger (`curl -X PUT --data-binary`), and a request with no `Content-Length` answers 411;
   - the cloud bucket's per-file limit: `rescue.max_object_mb` must not exceed it. A project on Supabase's free plan cannot go above 50 MB, which is the default. Raise the setting only after reading the real limit, and every part of §1.7's arithmetic follows. **Also read the project's total storage allowance and egress** (about 1 GB on the free plan, to be verified): one 20 MB thesis is about 75 MB a version, so set `rescue.project_max_mb` and the number of projects the plan can hold from the real figure, and watch `storageBytes` in `/admin/rescue/runs/summary`;
   - `SMTP_*` and `PUBLIC_BASE_URL` set; `isMailerConfigured()` true, or iOS students never learn where to pay;
   - Chargily live keys (memory: `launch-readiness-audit`).
6. **Word.**
   - Put the secret in `~/.config/kwill/word-jobs-secret` (mode 600), re-run `scripts/install-word-converter-launchagents.sh` (it now carries the secret into the plist, S10 Step 6c) and set `env.WORD_JOBS_SECRET` in `app_settings`. The service refuses `/jobs` without it.
   - Owner's call, not a task (P-55): run Word and poppler under their own macOS account with no Full Disk Access and none of the owner's files. The sanitiser removes the known ways a document reaches the disk, but Word on a personal account with Full Disk Access is still the weakest link of the product.
   - `launchctl kickstart -k gui/$(id -u)/com.kwill.word-convert-service`, then the same for `com.kwill.word-tunnel-watchdog`, when no conversion is running.
   - Does `cloudlinux-selector set` restart Passenger? Change the URL (`launchctl kickstart -k gui/$(id -u)/com.kwill.word-tunnel`), wait 90 s, then `curl -H "x-admin-token: …" https://modakerati.greenpedal.net/admin/pdf-conversions | jq .reachable`. If `false`, do NOT add a `restart.txt` touch to the tunnel script: a rotation then kills the running stage, and a flapping network rotates often (P-61). The renderer reads `env.WORD_CONVERTER_URL` per conversion (Task S16); the tunnel script's step 4 writes that setting (an admin call or the SQL it already uses) instead of touching Passenger.
7. **Server settings, staff first (P-68):** `env.RESCUE_BRAIN=model` and the pinned models from M7; `rescue.price_dzd`; then `rescue.enabled=staff`. **Host trial as a staff account, before any student:** one small thesis and one 300-page thesis end to end on the host, recording peak RSS, event-loop lag, thread count and stage seconds (a second terminal on `/d/logs` and `ps`). Stop criteria, none of which may be seen: RSS above 70% of the host's memory limit, event-loop lag above 2 s on `/api/health` during a stage, threads within 20% of the limit, any `SIGABRT` or a Passenger restart mid-run. Only then `rescue.enabled=1`, **and only once the iOS build carrying the `/(app)/rescue` route is approved as well as the Android one**: a push route opens an unmatched screen on a binary without it, and App Store review lags. Until then iOS students are mailed (P-23, P-69) and Android students use the app; nothing in this plan routes a push to a binary that lacks the screen, because `rescue.enabled=1` waits for both builds.
8. **App, the release commit:**
   - `lib/rescue-v2-enabled.ts`: `RESCUE_V2_ENABLED: boolean = true`.
   - `components/AppDrawer.tsx`, `import` row: `label: t("documents.import"), onPress: handleImport`, for every build; remove the `__DEV__` branch and its comment.
   - `app/_layout.tsx`: remove the old lane's cold-start block (`:236-243`) and the `useRescueStore` import.
   - Merge `release/rescue-v2-share` into `master`, then remove the worktree. A10's native output stayed in that worktree, so in `~/kwill`: `npx expo prebuild -p android --no-install`, `npx expo prebuild -p ios --no-install` (NOT `--clean`), `git diff app.json`.
   - Then, as CLAUDE.md orders: commit → `./scripts/build-apk.sh bundle` → verify `unzip -p android/app/build/outputs/bundle/release/app-release.aab base/assets/fingerprint` against `npx expo-updates runtimeversion:resolve --platform android` → publish. `git diff app.json` after every build.
   - iOS: archive locally with the portal work of A10 step 4 done, export with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (memory: `ios-export-rsync-clash`).
9. **Dashboard:** push `master`.
10. **D-1, in a follow-up commit:** delete `src/lib/format/*`, `src/routes/rescue.ts` and its mount, the app's `rescue-choice`, `rescue-norms`, `rescue-verdict`, `rescue-questions`, `rescue-working`, `rescue-result`, `stores/rescue-store.ts`, the `rescue.*` locale block (surgically, never by round-trip), and `rescue_runs` once its rows are not needed. New names stay (P-2).

---

## 8. Done when

| Must hold | Checked by |
|---|---|
| The CLI and the server share one pipeline; `cli.ts rescue t03` gives the same counts as before the move | S5 step 10 |
| A guard stays green: no DB or model in `src/lib/rescue/`, `rescue-run` reaches no model client | S2, S21 |
| A stage survives a `kill -9` and a deploy; two processes never run the same stage; a zombie cannot commit; `withThesisLock` is held only around publish | S12, S16, S18, S22 step 7 |
| Converter down, at any point in any stage: no attempt spent, a calm line, a failure only after 48 h. "Word refused your file" only when Word failed twice on that file **with a healthy canary both times**; a wedged Word is restarted and waited out, a timeout with a healthy canary is `stage_crashed`, never the file's | S5, S10, S16, S18, S22 step 11, W6 |
| A recycle, a deploy or a tunnel rotation never spends an attempt; a hung stage and a brain that never answers end; a version with no job and a state with no job are reconciled | S12, S16, S22 step 7 |
| One payment rescues one thesis: A + B then B is held for review, and a subscription includes two a month from a ledger a deleted project cannot reset; free limits survive project deletion | S7, S14, S19, S22 |
| An upload is checked before it is stored (central directory only), Word sees a sanitised copy, and a hostile file never reaches the Mac's disk or a dialog | S10, S11, S19, S22 step 12 |
| A restore is a full copy and resets the project's choices; the next re-run does not undo it | S19, W9 |
| Storage per project is bounded and readable to the student | S11, S18, S19 |
| The corpus replays (`replay.ts all`, `replay-rerun.ts all`) are green after S9a, S9c, S5 and S22, and equal to the numbers recorded before S9a | S5, S9a, S22 step 3 |
| The pipeline ran on the real host as staff before the first student | §7 step 7 |
| A re-run after an edit redoes only changed pages, as P-41 defines that (Map, Ask, Review and uploads partial; Reset, Regenerate and Word whole, within P-41's time target), and asks no repeated question; pages ±1, Prove green; a rescued file coming back adds no second dividers and sends nothing to Map | S7, S18, S22 steps 5-6, `replay-rerun.ts` over the corpus |
| Every stage runs from storage and `stage_state` alone, in a process that ran nothing else; every change the student's text went through is listed, with its page unless it is a whole-document rule | S9, S18 |
| Every chip under "we understood" changes the file or is a structure hint that reached Map and Review; every rule field changes the file; a removed chip takes its meaning with it | S8, S9a, S18 |
| A thesis Prove passed is delivered whatever happens to its pack; screen 15 says what the pack holds, and a rebuild is free | S16, S18, A7, W6 |
| A deploy before the release SQL leaves plans and top-ups working | S14 |
| Price from the dashboard; unset refuses checkout; webhook and manual approve both grant; a double payment becomes a refund due, visible and markable, never a silent keep; an abandoned checkout blocks nothing | S14, S20, D2, D3, W3, W11 |
| iOS shows status only; the email reaches `/pay` | S14, W4 |
| A forced Prove failure: no file, a refund due and then marked, the original's hash unchanged, a Support thread, the right sentence for payer, subscriber and re-run | S16, S22 step 9, W7 |
| History: view, compare, restore, edit + re-run; nothing deleted until the thesis is; editor edits survive a restore | S19, S22 step 8, W9 |
| Deleting a thesis or an account, by the student, by staff or by the chat's `delete_thesis` tool, even while a stage runs, leaves no object under its root | S15, S20, D4, S22 step 10, W11 |
| A student can leave every step on either platform, and a push brings them back from every wait | A3, S13, S16, W1, W8 |
| 18 + 6 screens walked on the simulator, light and dark, in Arabic and French with one pass in English; keys at parity; no banned word | A2, A11 |
| `npx tsc --noEmit` and vitest green in all three repos | Gates |

