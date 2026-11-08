# Rescue v2: the single-release checklist

Date: 2026-11-08. Sources: spec §12 (release order) and §13 (what is deleted),
`~/kwill-server/lab/.handover/plan-check-list.md` (every RELEASE item and the open ones), `CLAUDE.md` "Releasing", and
the memory notes on OTA, the Android build, Octenium, deploys, versioning, Vercel, the Word converter, the engine rename,
billing and iOS.

This is the checklist, not the release. Nothing here has been run against production. Each step says who runs it:

- **AGENT**: a Claude session can run it from this Mac.
- **OWNER**: only the owner can do it. That covers Touch ID, a real device, Chargily live keys, Apple settings, macOS
  dialogs, DNS and the registrar, pushing to a deploying remote, and every production decision.

State values: **READY** (can run now), **BLOCKED** (the reason is given), **DONE** (verified on 2026-11-08 with the
command shown).

Repo tips when this was written: app `920d7d9`, server `8f4bd25`, engine `e753eba`, dashboard 11 commits ahead of
`origin/master`. Other agents are still committing. **Re-run every "verify" command at the freeze.** Do not trust these
numbers then.

---

## Summary

| # | Item | Who | State |
|---|---|---|---|
| 0 | Production API host resolves | OWNER | **BLOCKED**: `modakerati.greenpedal.net` resolves to 127.0.0.1, served by a parking nameserver (§0) |
| 1 | Freeze: no agent commits in any repo | OWNER | READY |
| 2 | M7 production brain (`RESCUE_BRAIN=model`) | AGENT (M7 plan) | **BLOCKED**: not built; `createBrain` throws for anything but `session` |
| 3 | M3 corpus reviews (7 of about 20 accepted) | AGENT | **BLOCKED**: stopped by the owner until the release is built |
| 4 | History rewrite before any push (privacy) | AGENT prepares, OWNER approves | READY: dry run passed on clones (§4) |
| 5 | Public engine repo already holds two students' theses in `samples/` | OWNER | **BLOCKED**: owner decision (§4.6) |
| 6 | Engine: build and pack | AGENT | DONE as a dry run in a clone (§5) |
| 7 | Server: commit the engine rename together with the 3 files HEAD needs | AGENT | READY: proven on a clean clone (§6) |
| 8 | `scripts/deploy.mjs` still names `mdocxengine` | AGENT | **BLOCKED** until 7 lands; patch prepared (§6.3) |
| 9 | Cloud SQL (3 files) + `pdf_conversion_log` | AGENT | DONE: all present on the online DB (§7) |
| 10 | Reset the test settings on the online DB | AGENT, OWNER approves | READY (§7.3) |
| 11 | Production env: `RESCUE_BRAIN`, model pins, `WORD_JOBS_SECRET`, `TASKS_TICK_SECRET`, SMTP | OWNER (host env) / AGENT (`app_settings`) | **BLOCKED** on M7 and on §8 |
| 12 | Word converter for production | OWNER | **BLOCKED**: today's tunnel is in a restart loop and the v2 service is not installed (§8) |
| 13 | Server deploy, minor bump to 1.33.0, from a clean worktree, `--engine` | AGENT, OWNER says go | **BLOCKED** on 0, 2, 7, 8 |
| 14 | Feature-flag flips, in order | AGENT (settings) / OWNER (go) | READY as a plan (§9) |
| 15 | App: merge Share, set the gate, bump versions | AGENT | READY: test merge clean, tsc 0, vitest 677/677 (§10) |
| 16 | Android: prebuild, build, verify the fingerprint, publish | AGENT builds, OWNER uploads to Play | **BLOCKED** on 15 and on the Gradle build with Share (not proven) |
| 17 | iOS: App Group, Share extension App ID, profiles, archive | OWNER | **BLOCKED**: Apple portal (§10.5) |
| 18 | W10 device walk (Share from Files, WhatsApp, Telegram) | OWNER | **BLOCKED**: needs the release binary on a phone |
| 19 | Chargily live keys + a real checkout walk with cancel | OWNER | **BLOCKED**: `.env` holds `test_` keys |
| 20 | Dashboard push (Vercel deploys on push) | OWNER | **BLOCKED** until the server is live; 11 commits waiting |
| 21 | After release: delete the old rescue code (D-1) and the old Word scripts | AGENT | after release (§12) |

---

## 0. The production host does not resolve (found today)

Verified 2026-11-08 at 21:20 with:

```bash
dig +short modakerati.greenpedal.net @8.8.8.8          # 127.0.0.1
dig +short blink.greenpedal.net @8.8.8.8               # 127.0.0.1
curl -s "https://dns.google/resolve?name=modakerati.greenpedal.net&type=A"
#   "data":"127.0.0.1", "Comment":"Response from dns11.parkpage.foundationapi.com."
```

The answer comes from a **parking** nameserver, so `greenpedal.net` has most likely expired or been parked at the
registrar. Every installed app inlines `EXPO_PUBLIC_API_URL=https://modakerati.greenpedal.net` (checked in
`.env.production`), and the dashboard's `MODAKERATI_SERVER_URL` probably uses it too. **Until this is fixed, the live
app cannot reach its server, rescue or not.**

- OWNER: check the registrar for `greenpedal.net` (renew it, or point its nameservers back). Octenium's `srv50` answers
  at 188.165.51.53.
- If the domain is lost, the app needs a new API host. That means a new `.env.production`, the EAS `production` env vars
  (they outrank the file; see the OTA note), the dashboard's Vercel env, and `deploy.mjs` `MODK_URL`. The Android binary
  in this release carries the new host anyway. An OTA can also carry it to binaries at the matching runtime version.
- An agent tried to probe Octenium by IP. The permission check refused it, which is correct. Everything below that says
  "verify on production" waits on this.

---

## 1. Freeze

1. OWNER tells every running agent to stop committing in `~/kwill`, `~/kwill-server`, `~/mdocxengine` and
   `~/kwill-dashboard`.
2. AGENT records the tips: `git -C <repo> rev-parse HEAD` for each repo, plus `git -C <repo> status --short | wc -l`.
3. AGENT runs `git fetch origin` in each repo (read-only on the remote), so `origin/*` is current before the rewrite.

---

## 2. Work that must land before the release (other scopes; listed, not done here)

- **M7, the production brain.** `src/lib/rescue-run/brain-factory.ts` throws `no brain for RESCUE_BRAIN=model`. The plan
  is `docs/superpowers/plans/2026-11-08-rescue-v2-m7-production-brain.md`. The release needs the pinned `rescue.*`
  feature models in `app_settings` and `RESCUE_BRAIN=model` in the production env. Decide whether a per-account provider
  pin (`user-provider.ts:61-63`) applies to rescue calls. Settle `validateMapAnswer` on a partial answer. Settle the
  normalizeForKey folding (KEY_VERSION 5) **before** launch, because of the next item.
- **RELEASE ITEM, KEY_VERSION.** Stored review fixes are keyed by source block key. A KEY_VERSION bump after launch drops
  them silently. Either store the index and keyVersion with each fix, or forbid bumps after launch without a migration.
- **M3**, delayed by the owner: 7 accepted (t01 t02 t03 t05 t06 t13 t15), t10 half done. When it resumes, replay all
  first (about 20 fixes since the 5/5).
- **Decide before release:** H5 impact ignores Kwill text edits (spec disagrees with the route). A first rescue version
  has no `pageMapPath`/`sourceKind`, so Reset/Prove run without the source page map (impact unverified).
- **Server open items:** `card_pending_over_48h` is not on the refunds route; a P-57 refusal gives the student no line;
  `/pay` can grant on GET and still show a price; a price change has no server-side role check.
- **App leftovers (minor):** the first Save tap in the cover field sheet only closes the keyboard; a deep link to the
  same project doesn't refetch; screen 11 zoom covers the status bar; picker rows and notes "reading…" are left-aligned
  in ar; the screen 5 title sits under the status bar with the keyboard open; a phantom "modified in Kwill" step after a
  412 across a re-run; manual-transfer 409s on `payment-manual.tsx` are not handled.
- **Dashboard:** D3 shows refund state on every version; `user-detail.tsx` shows `err.message`, which Next masks in
  production; the waiting_student test is still owed; `vitest.config.ts` is untracked.
- **Production engine check (OWNER):** the engine fix e753eba (namespaces on a moved picture) ships with this deploy.
  Read production's engine build date and `DOCX_AUTOREPAIR`, and decide whether to rewrite theses that were not written
  again after a float.

---

## 3. Release order (spec §12, with today's findings)

1. Privacy rewrite of all unpushed history (§4). Nothing is pushed before it.
2. Engine: build and pack (§5).
3. Server: commit the rename (§6). The SQL is already applied (§7). Set the env (§8, §9). Deploy minor from a clean
   worktree with `--engine`. Boot test on the host first.
4. Word converter v2 goes live **after** the server deploy (§8).
5. Dashboard push (§11). This document moves it to just after the server, because staff need the runs and refunds views
   for the staff-only smoke test (§9). The spec puts it after the app.
6. App: commit → build → verify the fingerprint → publish (§10). A new binary is required, because Share changes
   `app.json`.
7. Flip `rescue.enabled` to `1` once the binary is in students' hands (§9).
8. Follow-up commits: D-1 deletion and the old Word scripts (§12).

---

## 4. History rewrite before any push

`kwill` and `docx-engine` are **PUBLIC** on GitHub; `kwill-server` and `kwill-dashboard` are private (verified with
`gh repo view Safwa9amar/<repo> --json visibility`). None of the commits below is on any remote branch
(`git branch -r --contains <c>` printed nothing for each). The only local branches that hold them are server `master`,
engine `main`, app `master` and app `release/rescue-v2-share`.

### 4.1 What is in each commit (paths only)

| Repo | Commit | Paths that carry the data | Replaced later by |
|---|---|---|---|
| server | 02c7501 | `src/lib/rescue/__tests__/typography.test.ts` (3 lines) | d33032d |
| server | d42c427 | `src/lib/rescue/__tests__/formula-as-typed.test.ts` (4), `src/lib/rescue/__tests__/prove.test.ts` (2) | d33032d |
| server | fcd6d58 | `src/lib/rescue/__tests__/page-art.test.ts` (3) | f01015f |
| server | ac3a8ae | `src/lib/render/__tests__/page-map.test.ts` (4), `src/lib/render/page-map.ts` (1) | 26eea2f |
| server | c320833 | `src/lib/rescue/__tests__/text-boxes.test.ts` (1) | 26eea2f |
| engine | 2341255 | `src/integration/convert-text-captions.spec.ts` (3) | 77379ef |
| engine | **c913201** (not on the owner's list) | `src/integration/convert-text-captions.spec.ts` (5) | 2f86c2d |
| app | 614d25b | `docs/superpowers/plans/2026-11-02-rescue-v2-m0-lab-brain-fonts.md` (11 lines with names) | b049b4d |
| app | f116046 | same plan file (3 lines) | b049b4d |

The app spec file that 614d25b also touched was checked. It holds none of the scrubbed lines or tokens.

Each blob of these paths carries the data from the bad commit until the replacing commit. So every commit in between
holds it in its tree too (39 blob hits in the server, 8 in the engine, 25 in the app). Squashing the bad commits alone is
not enough. Every unpushed commit from the first bad one onward is rewritten, and that changes **every unpushed hash**:
app 217, server 435 (more by now), engine 47.

### 4.2 Method

`git filter-branch --index-filter`, which is built in (git 2.53; `git-filter-repo` isn't installed), limited to the
**unpushed** range (`<branch> ^origin/<branch>`). Pushed history is not touched. The filter replaces, in each mapped
path, the exact hunks that the replacing commit changed with that commit's invented values. In the app, the plan file's
blob is swapped whole for b049b4d's clean blob. The final tree of every branch stays **byte-identical**, so a working
tree with uncommitted changes can be moved onto the rewritten branch with `git update-ref` and nothing in it changes
(proven below). The three helper scripts are in the appendix. They print counts only, never the data.

### 4.3 Dry run (done 2026-11-08, on `git clone --no-local` copies under the scratchpad)

| Repo | Commits before → after | Rewritten | Final tree same | Pushed base kept | Sensitive lines | Hits after (all objects in range) |
|---|---|---|---|---|---|---|
| server (tip 2392dc4) | 951 → 951 | 435 | yes | yes | 18 | **0** (39 before) |
| engine (tip e753eba) | 120 → 120 | 47 | yes | yes | 8 | **0** (8 before) |
| app master (tip 225152a) | 1096 → 1096 | 217 | yes | yes | 14 | **0** (25 before) |
| app release/rescue-v2-share | 1070 → 1070 | (same range) | yes | still forks from rewritten master | 14 | **0** |

The pushed history scanned clean in all three repos (0 hits), so nothing has reached GitHub yet. The rewrite took 36 s
for the app, 103 s for the server and 7 s for the engine. A second clone with a modified tracked file and an untracked
file was moved onto the rewritten server branch with `git update-ref`. `git status` was identical before and after.

### 4.4 Procedure at release (AGENT, after the freeze; OWNER approves before step 6)

For each repo (path in `$R`, branch in `$B`, remote tip `BASE=$(git -C $R rev-parse origin/$B)`, replacement specs in `$SPECS`):

```bash
W=<scratch dir>; S=<dir holding mkmap.py, sanitize.py, verify.py>
git clone -q --no-local "$R" "$W/clone" && cd "$W/clone"
# app only: also create the share branch in the clone
git branch release/rescue-v2-share origin/release/rescue-v2-share          # app only
# 1. the map, from the commits that brought in invented data
python3 $S/mkmap.py . $W/map.json $SPECS
# 2. detection works before the rewrite (hits must be > 0)
python3 $S/verify.py . $W/map.json $B ^$BASE
# 3. rewrite only the unpushed range
FILTER_BRANCH_SQUELCH_WARNING=1 SANITIZE_CACHE=$W/cache \
  git filter-branch -f --index-filter "python3 $S/sanitize.py $W/map.json $WHOLE" -- $B ^$BASE > $W/fb.log 2>&1
# 4. checks: hits 0, same count, same final tree, base kept
python3 $S/verify.py . $W/map.json $B ^$BASE
git rev-list --count $B; git rev-list --count refs/original/refs/heads/$B
test "$(git rev-parse $B^{tree})" = "$(git rev-parse refs/original/refs/heads/$B^{tree})" && echo tree-same
git merge-base --is-ancestor $BASE $B && echo base-kept
# 5. old → new hash map, for the handover notes and memory that cite hashes
paste -d' ' <(git rev-list --reverse refs/original/refs/heads/$B ^$BASE) <(git rev-list --reverse $B ^$BASE) > $W/hash-map.txt
# 6. move the real repo (its working tree and uncommitted files are untouched, because the trees are equal)
cd "$R" && OLD=$(git rev-parse $B) && git fetch -q "$W/clone" $B:refs/rewrite/$B && NEW=$(git rev-parse refs/rewrite/$B)
test "$(git rev-parse $OLD^{tree})" = "$(git rev-parse $NEW^{tree})" && git update-ref -m "privacy rewrite" refs/heads/$B $NEW $OLD
git update-ref -d refs/rewrite/$B
# 7. drop the old objects locally (a push never sends unreachable objects, but don't keep them)
git reflog expire --expire=now --all && git gc --prune=now
```

`update-ref <new> <old>` refuses if `$B` moved after the clone. That is the guard against a commit landing during the
rewrite. If it refuses, start again from step 1.

`SPECS` and `WHOLE` per repo:

- server: `d33032d:src/lib/rescue/__tests__/formula-as-typed.test.ts d33032d:src/lib/rescue/__tests__/prove.test.ts
  d33032d:src/lib/rescue/__tests__/typography.test.ts f01015f:src/lib/rescue/__tests__/page-art.test.ts
  26eea2f:src/lib/render/__tests__/page-map.test.ts 26eea2f:src/lib/render/page-map.ts
  26eea2f:src/lib/rescue/__tests__/text-boxes.test.ts`; `WHOLE` empty; `B=master`.
- engine: `77379ef:src/integration/convert-text-captions.spec.ts 2f86c2d:src/integration/convert-text-captions.spec.ts`;
  `WHOLE` empty; `B=main`.
- app: `b049b4d:docs/superpowers/plans/2026-11-02-rescue-v2-m0-lab-brain-fonts.md`;
  `WHOLE="docs/superpowers/plans/2026-11-02-rescue-v2-m0-lab-brain-fonts.md=$(git rev-parse b049b4d:docs/superpowers/plans/2026-11-02-rescue-v2-m0-lab-brain-fonts.md)"`;
  `B=master`; run filter-branch with `-- master release/rescue-v2-share ^$BASE` and move both refs in step 6. `~/kwill-share` has
  that branch checked out. Moving it is safe for the same reason (equal tree).

### 4.5 After the rewrite

- Every hash in `lab/.handover/*.md`, the memory notes and the plans now points at the old commit. Keep `hash-map.txt`
  beside the handover notes (it is hashes only).
- The test suites are unaffected: final trees are identical. Intermediate commits get the invented values earlier than
  before.
- OWNER pushes: `git push origin master` (server), `git push origin main` (engine), `git push origin master` (app). Never
  `--force`, which isn't needed, because only unpushed commits changed. **Never push `~/kwill-dashboard` here: a push
  deploys.**

### 4.6 Already public: OWNER decision

The public `Safwa9amar/docx-engine` already has 8 files under `samples/` on `origin/main`. The handover notes say two
students' theses have been there since 2025-09. A rewrite of **pushed** history plus a force push doesn't remove
GitHub's caches, forks or clones, and needs a GitHub support request for cached views. Options: make the repo private,
or rewrite with `git filter-repo --path samples --invert-paths` plus a force push, then a support ticket. Owner only.
Separately, `~/mdocxengine/.env` holds a Gemini key that Google reported as leaked. Revoke it in AI Studio.

---

## 5. Engine

Verified 2026-11-08:

```bash
cd ~/mdocxengine && git log --oneline origin/main..main | wc -l   # 47 unpushed (incl. 2341255, c913201)
grep '"name"\|"version"' package.json                          # @kwill/docx-engine 2.0.0
npm view @kwill/docx-engine version                             # not on the registry (404)
git status --short                                              # M dist/index.d.cts, M dist/index.d.ts
# in a clone (never in ~/mdocxengine, whose dist/ is tracked):
npm run build        # exit 0, dist/index.js 619 kB, same two .d.ts files differ from the commit
npm pack --dry-run   # kwill-docx-engine-2.0.0.tgz, 7 files, 437 kB
```

Steps at release:

1. AGENT: `cd ~/mdocxengine && npm run build`, then commit `dist/` if it differs (`git add dist/index.d.ts
   dist/index.d.cts dist/index.js ...` by exact path). That is the "dist unstaged" item from the notes.
2. The server deploy ships the engine as a **tarball** (`npm pack` inside `deploy.mjs --engine`). It does not use the npm
   registry. Publishing `@kwill/docx-engine` to npm is **not needed for the release**. It is OWNER only (Touch ID),
   whenever wanted: `cd ~/mdocxengine && npm publish`, then `npm deprecate mdocxengine@1.0.0 "Renamed to
   @kwill/docx-engine"`.

---

## 6. Server: finish the engine rename

### 6.1 State (verified 2026-11-08)

```bash
cd ~/kwill-server
git status --short | wc -l            # 129: 128 modified + 1 untracked
npx tsc --noEmit                      # 0 errors on the working tree
ls -l node_modules/@kwill/docx-engine # -> /Users/hamzasafwan/mdocxengine ; node_modules/mdocxengine is gone
grep -rlE "['\"]mdocxengine['\"/]" src scripts --include='*.ts' --include='*.mjs'   # none; 220 files import @kwill/docx-engine
```

The rename is complete in the source. **It is not a pure rename.** Nine of the modified files carry other, older
uncommitted work as well:

| File | What else changed |
|---|---|
| `src/lib/para-format.ts` + `src/__tests__/para-format.test.ts` | fonts (theme fonts) and indentation in the format resolver |
| `src/mcp/doc-page-numbering.ts` (+ untracked `src/__tests__/front-matter-numbering-dividers.test.ts`, Aug 28) | `hideBeforeIndex`, hidden sections |
| `src/mcp/tools/docx-document.ts` | exposes `hideBeforeIndex` to the AI tool |
| `src/lib/thesis-doc.ts` | a run's `<w:tab/>` reads as a tab (TOC entries) |
| `src/lib/source-service.ts` | PDF sources get their text extracted |
| `src/lib/ai/unsupported-claim.ts` + its test | more false "not available" phrasings |
| `src/routes/thesis/charts.ts` | a route that inserts a real Word chart |

**Committed HEAD depends on three of them.** On a clean clone at HEAD 60239ac with only the rename applied (126 files,
plus the import rename in the nine), `tsc` gives 6 errors: `rescue/diagnose/facts.ts` needs `ParaFmt.font`/`ind`, and
`rescue/regenerate/layout.ts` needs `hideBeforeIndex`/`hiddenSections`. With the full `para-format.ts` and
`doc-page-numbering.ts` added, tsc is 0. `assemble-check.test.ts` also needs `thesis-doc.ts` (66/66 with it, 2 failures
without). **So a clean checkout of HEAD neither builds nor tests today.** This is the release blocker the handover notes
describe.

Full suite on that clean clone (rename + para-format + doc-page-numbering, no DB, dummy Supabase env): 318 files passed,
45 skipped, 3 failed (4 tests). Two are explained: `note-effects` byte-equal golden (known red in the handover; also red
in the working tree) and `assemble-check` (fixed by `thesis-doc.ts`, as above). The third is `quick-tunnel-word.test.ts`,
a timing test: a different case fails on each run, in the clone and in the working tree, so it is flaky.

### 6.2 Commit at release (AGENT; the owner of the rename session reviews)

One commit, staged by exact path, after the freeze:

1. `git diff --name-only > /tmp/all.txt`. The rename commit takes package.json, package-lock.json, every file whose only
   change is the import, and these four whole files with their tests: `src/lib/para-format.ts`,
   `src/__tests__/para-format.test.ts`, `src/mcp/doc-page-numbering.ts`,
   `src/__tests__/front-matter-numbering-dividers.test.ts`, `src/mcp/tools/docx-document.ts`, `src/lib/thesis-doc.ts`.
2. For `source-service.ts`, `unsupported-claim.ts` (+ test) and `routes/thesis/charts.ts`: stage **only the import hunk**
   (`git diff -U0 -- <f>`, keep the `@kwill/docx-engine` hunk, `git apply --cached`), and leave the feature hunks for
   their owner to commit or drop.
3. Gate: on a fresh `git clone --no-local` of the result, with `~/mdocxengine` as its sibling: `npm ci`, `npx tsc
   --noEmit` (0), `npx vitest run --testTimeout=60000`, where only the known `note-effects` golden may fail. Then the DB
   suites through the guard script (see RULES) when `nc -z 127.0.0.1 54332` works.
4. Message: `refactor(engine): import @kwill/docx-engine; para-format fonts, hidden front-matter numbering and TOC tabs
   that HEAD already uses`.

### 6.3 `scripts/deploy.mjs` still deploys `mdocxengine` (patch prepared, not applied)

`package.json` now depends on `"@kwill/docx-engine": "file:../mdocxengine"`, but `deploy.mjs`:

- writes `deps.mdocxengine = file:<APP_ROOT>/vendor/<tarball>` and leaves `@kwill/docx-engine` as the **relative**
  `file:../mdocxengine`, which doesn't exist on the host;
- looks for `vendor/mdocxengine-*.tgz` on the host, while `npm pack` now writes `kwill-docx-engine-2.0.0.tgz`;
- removes `node_modules/mdocxengine`, not `node_modules/@kwill/docx-engine`.

A deploy from the renamed tree would install no engine and Passenger would fail to boot (the 08-14 outage again). The
change, to land with the rename commit:

```diff
-// and `mdocxengine` is repointed from the local workspace to a tarball with an
+// and `@kwill/docx-engine` is repointed from the local workspace to a tarball with an
@@ function serverPackageJson(engineTarball) {
   delete deps["react-native-markdown-display"]; // not imported by src/, drags RN in
-  deps.mdocxengine = `file:${APP_ROOT}/vendor/${engineTarball}`;
+  delete deps.mdocxengine; // the pre-rename name; the host still has it in node_modules until the first --engine deploy
+  deps["@kwill/docx-engine"] = `file:${APP_ROOT}/vendor/${engineTarball}`;
@@
-let engineTarball = `mdocxengine-${JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")).version}.tgz`;
+let engineTarball = `kwill-docx-engine-${JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")).version}.tgz`;
@@ if (!withEngine) {
-      `ls -t ${APP_ROOT}/vendor/mdocxengine-*.tgz 2>/dev/null | head -1`,
+      `ls -t ${APP_ROOT}/vendor/kwill-docx-engine-*.tgz 2>/dev/null | head -1`,
@@ if (withEngine) {
-  run("ssh", [SSH, `rm -f ${APP_ROOT}/package-lock.json && rm -rf ${APP_ROOT}/node_modules/mdocxengine`]);
+  run("ssh", [SSH, `rm -f ${APP_ROOT}/package-lock.json && rm -rf ${APP_ROOT}/node_modules/mdocxengine ${APP_ROOT}/node_modules/@kwill/docx-engine`]);
-  run("ssh", [SSH, `cd ${APP_ROOT}/vendor && ls -t mdocxengine-*.tgz | tail -n +4 | xargs -r rm -f`]);
+  run("ssh", [SSH, `cd ${APP_ROOT}/vendor && ls -t kwill-docx-engine-*.tgz | tail -n +4 | xargs -r rm -f`]);
```

The first deploy after this **must** use `--engine` (it implies `--deps`). Without it the host has no
`kwill-docx-engine-*.tgz` and the fallback guess names a file that isn't there.

### 6.4 Deploy (AGENT runs, OWNER says go; blocked on §0, §2, §8)

1. Deploy from a **clean worktree at the release commit**, never from `~/kwill-server`. Its working tree carries other
   sessions' uncommitted work, and `deploy.mjs` builds whatever is on disk:
   `git -C ~/kwill-server worktree add ../kwill-server-release <release-sha>`, `npm ci` there. `~/mdocxengine` must be
   its sibling (it is, at `../mdocxengine`).
2. Stage and boot-test on the host before Passenger (memory: stage-and-boot):
   ```bash
   npm run build && tar czf /tmp/d.tgz --exclude='__tests__' dist
   cat /tmp/d.tgz | ssh blink-host "cd /home/hccfdkmc/modakerati && mkdir -p staging && tar xzf - -C staging"
   ssh blink-host "source /home/hccfdkmc/nodevenv/modakerati/24/bin/activate; cd /home/hccfdkmc/modakerati && \
     timeout 30 node staging/dist/index.js > /tmp/b.log 2>&1; echo exit=\$?; tail -12 /tmp/b.log"
   ```
   `exit=124` with "Kwill API running" = it boots. The staging copy resolves the **old** engine, so a missing-export
   error here is expected until `--engine` ships the new one. Check that new rescue code adds no top-level native
   import.
3. `node scripts/deploy.mjs minor --engine` → **1.33.0** (last release 1.32.0 on 09-01, a feature release → minor).
   A failed run leaves package.json bumped. Retry with `--no-bump --engine`.
4. Verify: `curl -s https://<api-host>/api/health` reports 1.33.0. A cold start can take 4 minutes and serve
   Passenger's 500 page; read `server.log` for a new "Kwill API running" before rolling back. Rollback:
   `mv dist dist.broken-1330 && cp -a dist.bak dist && touch tmp/restart.txt`.
5. Commit the bumped `package.json`/lockfile in the repo (`chore(release): v1.33.0`), then keep the version history in
   memory (the owner declined a CHANGELOG).

---

## 7. Database

The online Supabase (`janzgpfnjzihelcwmkkg`) **is** production's database. The owner declared it test-only on 11-08,
and production (Octenium) points at it.

### 7.1 State (verified 2026-11-08 with read-only `psql` on the `.env` URL, `default_transaction_read_only=on`)

| Needed | Present |
|---|---|
| `sql/2026-11-02-rescue-v2.sql`: rescue_projects, rescue_versions, rescue_jobs, rescue_ledger, rescue_tombstones; payments.rescue_project_id, refund_* | all present; indexes `rescue_versions_one_active`, `rescue_jobs_one_side_per_project` present |
| `sql/2026-11-05-rescue-guide-hash.sql`: rescue_projects.guide_hash | present |
| `sql/2026-11-05-rescue-money.sql`: payments.refund_support_conversation_id, staff_flag_at, staff_flag_reason, reconciled_at + 2 indexes | all present |
| `pdf_conversion_log` (made by `ensureSchema()` in `src/db/index.ts`, not a sql file) | present |
| `profiles.staff_role` (or the dashboard is open to anyone) | present |
| RLS on, no policies, on the five rescue tables; the service role still reads | `relrowsecurity` true on all five; `rolbypassrls` true for postgres and service_role |
| Drizzle `schema.ts` rescue/payments columns vs the DB | none missing |

No sql file is newer than 2026-11-05 (`ls sql/`). Nothing is left to apply. If a later commit adds one, apply it on the
cloud **before** the deploy: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/<file>.sql` (OWNER approves, since it is
production).

### 7.2 Storage

`storage.buckets` has no per-bucket limit on `documents`/`sources` (null). The **project-wide** upload limit is a
dashboard setting that SQL can't read. OWNER: check Supabase → Storage → Settings. A 22 MB thesis must pass (3 of 95
Gmail files and 2 of 49 corpus files are over 20 MB). `rescue.max_object_mb` defaults to the bucket figure (50).

### 7.3 Test values that are live on production now (reset at release; AGENT, OWNER approves)

```
rescue.enabled                 1     (11-08, test walks)   → 'staff' before the deploy, then '1' last (§9)
rescue.free_diagnoses_per_day  50    (test)                → delete the row (default 3)
rescue.rerun_daily_cap         200   (test)                → delete the row (default 10)
rescue.price_dzd               2500                        → OWNER confirms the price (unset = not for sale)
rescue_projects                6 rows (test accounts)      → delete with the test accounts before real students
```

The test accounts (`*@kwill.local`) and their data live on that database. Remove them before launch, or keep the staff
one only.

---

## 8. Word converter for production

### 8.1 What exists today (verified 2026-11-08, read only)

- The server calls the converter at `WORD_CONVERTER_URL`. The rescue renderer reads `app_settings` `env.WORD_CONVERTER_URL`
  **fresh on each conversion**, then `process.env` (`src/lib/rescue-run/renderer.ts:36`). It sends `x-word-secret` from
  `WORD_JOBS_SECRET` and uses the async `/jobs` API.
- The online DB has **no** `env.WORD_CONVERTER_URL` and **no** `env.WORD_JOBS_SECRET`
  (`select key from app_settings where key like 'env.%'`). Production gets `WORD_CONVERTER_URL` from the Octenium app's
  cloudlinux `env_vars`, which `scripts/quick-tunnel-word.sh` rewrites over SSH each time the quick-tunnel URL rotates.
  Those can't be read from here (SSH reads were refused before).
- On this Mac, launch agents `com.kwill.word-convert-service` (pid on `*:8092`, **the canonical v1 service**, listening
  on all interfaces with an unauthenticated `/convert`), `com.kwill.word-tunnel` and `com.kwill.word-tunnel-watchdog`
  run. `/tmp/word-tunnel-watchdog.log` has **514** "not reachable externally — restarting both LaunchAgents" lines since
  2026-11-06 13:18, the last at 21:21 today. The quick tunnel times out at `api.trycloudflare.com`. So production Word
  rendering is **down or flapping** now, and the restarts kill jobs in flight.
- `~/.config/kwill/word-jobs-secret` doesn't exist, so the v2 installer has not run.
- The lab instances (`:18100` v2 with a secret) are test-only.

### 8.2 Options

| Option | What | For | Against |
|---|---|---|---|
| A | v2 installer as designed: v2 service + v2 quick tunnel + v2 watchdog (`scripts/install-word-converter-launchagents.sh`) | built, 62 tests, backoff on 429 | quick tunnels rotate, rate-limit (today's loop) and need an SSH push to Octenium on each rotation; no uptime guarantee from Cloudflare |
| **B** | v2 service on this Mac + a **named** Cloudflare tunnel on a hostname the owner controls; set `env.WORD_CONVERTER_URL` once in `app_settings` | stable URL, no SSH push, no 429 loop; the renderer already reads the setting per conversion | needs a Cloudflare account and a domain (not `greenpedal.net` while it is parked); the v2 watchdog's quick-tunnel parts need a named-tunnel variant |
| C | A dedicated always-on Mac (or Windows + Word) host | uptime independent of the owner's laptop | cost; Windows means porting the AppleScript service |
| D | No real Word (LibreOffice) | — | the spec requires real Word for Prove; rejected |

**Recommendation: B for launch, with this Mac kept awake and on power as the converter.** A is the fallback if a
domain isn't ready. C comes once volume justifies it.

### 8.3 Steps (OWNER for anything that touches the launch agents, Word or the host)

Order (decided in the notes): **deploy the server first** (it sends `x-word-secret`, which v1 ignores), **then** install
v2 (which requires the secret on every route but `/healthcheck`).

1. OWNER: `mkdir -p ~/.config/kwill && (umask 077 && openssl rand -hex 32 > ~/.config/kwill/word-jobs-secret)`.
2. OWNER/AGENT: put the same value on the server as `WORD_JOBS_SECRET`, either in the Octenium env_vars or as a sealed
   `app_settings` row `env.WORD_JOBS_SECRET` (applied at boot by `applyEnvOverrides()`, so `touch tmp/restart.txt`), and
   confirm the "N env override(s) applied" log line.
3. OWNER: `cd ~/kwill-server && ./scripts/install-word-converter-launchagents.sh`. It keeps the old plists in
   `~/.config/kwill/word-converter-rollback-<stamp>/` and rolls back by itself if health fails. Word needs Full Disk
   Access and one "Grant File Access" dialog the first time.
4. For option B: create the named tunnel to `localhost:8092` and set
   `INSERT INTO app_settings (key, value) VALUES ('env.WORD_CONVERTER_URL','https://<word-host>') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`.
   Leave the quick-tunnel agent unloaded so it doesn't overwrite the host env.
5. Check: `GET /admin/rescue/runs/summary` shows `wordCanary` healthy. A staff rescue renders end to end (§9).
6. Follow-up commit: delete the canonical `scripts/word-convert-service.mjs`, `word-tunnel-watchdog.sh` and
   `quick-tunnel-word.sh` (they have the 9-copies bug and the open `/convert`). Never edit them in place while launchd
   runs them: editing that file **is** a deploy.

Also needed for rescue in production: the cPanel minute cron that `POST`s `/api/tasks/tick` with `x-tasks-secret` (the
rescue runner's kick and keep-alive share it), and `TASKS_TICK_SECRET` set. Neither is in `app_settings`. OWNER checks
the cron in cPanel and the env in node-selector. Wrap the cron in `flock -n` (the Octenium fork-ceiling incident).

---

## 9. Feature flags, in order

What gates Rescue v2:

| Gate | Where | Now |
|---|---|---|
| `rescue.enabled` | `app_settings`, read fresh (`src/lib/rescue-run/config.ts:155`): unset = off (every route 503 `rescue_disabled` except config), `staff` = staff only, `1` = everyone | `1` on the online DB (test) |
| `RESCUE_BRAIN` | server env: `session` (localhost only; refused under `NODE_ENV=production`) or `model` (M7, not built) | unset in `app_settings` |
| `RESCUE_V2_ENABLED` | app, `lib/rescue-v2-enabled.ts`: `= __DEV__`; the release commit sets it to `true`. It gates the drawer row, home card, push routing, library and the If-Match tag | `__DEV__` |
| Old v1 drawer row | `components/AppDrawer.tsx:313-327`, `__DEV__` only; release builds show "documents.import" there | dev only |
| Price | `rescue.price_dzd` (unset = not for sale); iOS hides price and purchase (`PURCHASES_HIDDEN`) | 2500 |

Order:

1. Before the server deploy: `rescue.enabled = 'staff'` (closes the routes to students while the new code goes live).
2. Deploy the server (§6.4) with `RESCUE_BRAIN=model` and the M7 model pins set. Install Word v2 (§8). Push the dashboard
   (§11).
3. Staff smoke test on production with `rescue-staff@kwill.local` (or the owner's staff account): a free diagnosis, a
   paid rescue on a Chargily **test** checkout including cancel and re-enter, a re-run, a refund in the dashboard.
4. OWNER: switch Chargily to live keys (§10.6) and run one real small payment.
5. Ship the app binary with `RESCUE_V2_ENABLED = true` (§10).
6. When the binary is on students' phones: `rescue.enabled = '1'`. Rollback = `'staff'` or delete the row (read fresh,
   no restart).

---

## 10. App

### 10.1 Share branch test merge (done 2026-11-08)

```bash
git worktree add --detach <scratch>/share-merge master      # master 225152a
git merge --no-ff --no-commit release/rescue-v2-share       # "Automatic merge went well"
# changed: app.json, app/+native-intent.ts (new), components/rescue/ShareInbox.tsx,
#          lib/rescue-v2-share.ts (new) + test, vitest.config.ts (auto-merged)
npx tsc --noEmit             # 0 errors
npx vitest run               # 57 files, 677 tests passed
git worktree remove --force <scratch>/share-merge
git merge-tree --write-tree --name-only master release/rescue-v2-share   # re-checked on master aecb6da: no conflicts
```

The branch is 2 commits (374e86e, 41a5972) on top of 34905ec, which master already has. Master is 30 commits ahead of that base.
No conflicts. Its `app.json` change configures the `expo-sharing` plugin (Android single/multiple share MIME = .docx;
iOS extension `com.kwill.app.ShareExtension`, App Group `group.com.kwill.app`, up to 12 files).

### 10.2 Fingerprint now (verified 2026-11-08)

```bash
npx expo-updates runtimeversion:resolve --platform android        # master: dece70867e6114dabad907bffe9d2c8fa7c29103
#                                                                   master + Share: 4fe13feb8609854cb4bf13f3906a341a0626d42c
unzip -p android/app/build/outputs/bundle/release/app-release.aab base/assets/fingerprint   # 4d16187f… (AAB of Sep 13)
npx eas-cli update:list --branch production --limit 2 --json --non-interactive              # newest OTA: 045ff176…, 2 months old
```

Master has already moved off the last shipped binary (engine 2.34 patch, harfbuzzjs). There is no APK in
`android/app/build/outputs/apk/`. A new binary was needed even without Share.

### 10.3 Release commit (AGENT, after the freeze; edits `app.json`, which is allowed only at release)

1. `git merge --no-ff release/rescue-v2-share` on master. The notes said "rebase"; a merge is enough and keeps
   41a5972/374e86e findable. After §4 the branch has new hashes.
2. In the same commit or the next: `lib/rescue-v2-enabled.ts` → `export const RESCUE_V2_ENABLED: boolean = true;`.
   Bump `app.json` `expo.version` 2.0.0 → **2.1.0**, `android.versionCode` 6 → **7** (Play rejects a re-used code),
   `ios.buildNumber` 2 → **3**. These move the fingerprint, which Share moves anyway.
3. Gates: `npx tsc --noEmit 2>&1 | grep -v '^docs/marketing' | grep -c 'error TS'` → 0; `npx vitest run` passes.
4. Check the API host in `.env.production` **and** in the EAS `production` env (`eas env:list production`; they outrank
   the file) once §0 is settled.

### 10.4 Android (AGENT builds; OWNER uploads)

Order is not negotiable: **commit → build → verify the fingerprint → publish.**

```bash
npx expo prebuild --clean --platform android         # CNG; android/ is gitignored
ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a ./scripts/build-apk.sh bundle    # .aab for Play; never pipe through tail
unzip -p android/app/build/outputs/bundle/release/app-release.aab base/assets/fingerprint
npx expo-updates runtimeversion:resolve --platform android      # must match the line above
ls -l android/app/build/generated/assets/createReleaseUpdatesResources/fingerprint   # mtime must be the build's
apksigner verify --print-certs <apk>                            # CN=Modakerati, not Android Debug (for an APK)
strings -a -n 8 <bundle>.hbc | grep -cE 'https?://(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9]'   # 0
```

On a fingerprint mismatch: `rm -rf android/app/build/generated/assets/createReleaseUpdatesResources
android/app/build/intermediates/assets/release/mergeReleaseAssets/fingerprint
android/app/build/intermediates/compressed_assets/release/compressReleaseAssets/out/assets/fingerprint.jar` and rebuild.
The Share Gradle build has **never** been proven (the sandbox had no network). If it fails, fix it on the release
commit, not on master in a hurry.

Then publish: `./scripts/publish-update.sh "Rescue v2" preview` (canary: read the env line, grep the bundle), then
`./scripts/publish-update.sh "Rescue v2" production`. OWNER uploads the .aab to Play.

### 10.5 iOS (OWNER)

- Apple Developer portal: App Group `group.com.kwill.app`; App ID `com.kwill.app.ShareExtension` with that group; App ID
  `com.kwill.app` gains the group; new provisioning profiles for both.
- `npx expo prebuild --clean --platform ios`, archive in Xcode (export with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  memory: iOS export rsync clash), upload.
- iOS shows plan status only (`PURCHASES_HIDDEN`). The rescue price must not show on iOS. The server sends
  `priceDzd`/`forSale` to every platform and the app hides them; check it on the device. The steering email needs
  `SMTP_*` live on production (the local `.env` has SMTP names; production's can't be read from here).

### 10.6 Payments (OWNER)

- `~/kwill-server/.env` has `CHARGILY_PUBLIC_KEY=test_…` and `CHARGILY_SECRET_KEY=test_…` (prefix checked only).
  Production's keys live in the host env. Switch to live keys there.
- Walk a real Chargily checkout: pay, cancel, re-enter (same open URL), the webhook, the refund path. The status words
  (pending, paid, canceled, cancelled, failed, expired) are still assumed.

### 10.7 Devices (OWNER)

W10: Share to Kwill from Files, WhatsApp and Telegram on Android and iOS, including Telegram's octet-stream case. Plus
the A11 device checks: drawer row, home card, killed-app push tap, cold-start resume, banner suppression, foreground
re-read, a real 412 race, Android card checkout and cancel return, zip-too-large layout on screen 15.

---

## 11. Dashboard (OWNER pushes; a push deploys)

`~/kwill-dashboard` is 11 commits ahead of `origin/master`, with 52 uncommitted paths from other sessions. Before the
push: `npx tsc --noEmit` and its vitest on a clean worktree at the commit to push. Check that live `profiles.staff_role`
exists (it does, §7.1). The dashboard calls the server's `/admin/rescue/*`, so push after the server is live. Push with
`git push origin master`. Check for the `ƒ Proxy (Middleware)` line in the Vercel build output.

---

## 12. After release (follow-up commits)

**D-1, old rescue code** (spec §13), once v2 is live and the old rows are no longer needed:

- Server: `src/lib/format/*` (18 files), `src/routes/rescue.ts` and its mount (`src/index.ts:42,164`); `app_settings`
  rows `env.RESCUE_AGENT`, `ai.feature.rescue.classify.model`, `ai.feature.rescue.repair.model`,
  `ai.feature.rescue.repair.provider`; table `rescue_runs` (7 rows now) after an export, if the owner wants one.
- App: `app/(app)/rescue-choice.tsx`, `rescue-norms.tsx`, `rescue-verdict.tsx`, `rescue-questions.tsx`,
  `rescue-working.tsx`, `rescue-result.tsx`, `stores/rescue-store.ts`, their references in `app/_layout.tsx`, and the
  `__DEV__` row in `components/AppDrawer.tsx:313-327`.
- Word: the canonical v1 scripts (§8.3 step 6).
- Lab fixtures: delete `rescue-v2-fixtures.ts` (A11 note).

Also after release: move the hash references in the handover notes to the new hashes (§4.5), and update memory (server
1.33.0 history, the new RTV, Word v2 live).

---

## 13. Top blockers

1. **The production host doesn't resolve** (`greenpedal.net` parked, §0). OWNER.
2. **No production brain** (M7). `RESCUE_BRAIN=model` doesn't exist yet.
3. **The server's HEAD doesn't build from a clean checkout.** The rename and the three files HEAD depends on are
   uncommitted, and `deploy.mjs` still ships `mdocxengine` (§6).
4. **Production Word is down and flapping** (514 restarts since 11-06), and v2 isn't installed. Pick option B and set
   the secret (§8).
5. **Privacy before any push** (§4). The rewrite is ready and dry-run clean. The already-public `samples/` in
   `docx-engine` needs an owner decision.

Close behind: M3 reviews still delayed; the Share Gradle build and the W10 device walk unproven; Chargily still on test
keys; Apple portal setup for the Share extension.

---

## Appendix: rewrite helpers (no data in them)

`mkmap.py`: builds the map from the replacing commits. It prints counts only.

```python
#!/usr/bin/env python3
import json, subprocess, sys
repo, out, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
pairs, sensitive = [], []
for spec in specs:
    commit, path = spec.split(":", 1)
    diff = subprocess.run(["git", "-C", repo, "diff", "-U0", f"{commit}^", commit, "--", path],
                          capture_output=True, text=True, check=True).stdout
    head = subprocess.run(["git", "-C", repo, "show", f"HEAD:{path}"], capture_output=True, text=True).stdout
    old, new = [], []
    def flush():
        if old or new:
            if len(old) == len(new):
                for o, n in zip(old, new):
                    pairs.append([path, o, n])
            else:
                pairs.append([path, "\n".join(old), "\n".join(new)])
            for o in old:
                if len(o.strip()) > 3 and o not in head:
                    sensitive.append(o)
        old.clear(); new.clear()
    for line in diff.split("\n"):
        if line.startswith("@@"):
            flush()
        elif line.startswith("-") and not line.startswith("---"):
            old.append(line[1:])
        elif line.startswith("+") and not line.startswith("+++"):
            new.append(line[1:])
    flush()
json.dump({"pairs": pairs, "sensitive": sorted(set(sensitive))}, open(out, "w"))
print(f"{out}: {len(pairs)} replacement pairs, {len(set(sensitive))} sensitive lines")
```

`sanitize.py`: the `--index-filter`. It rewrites the mapped paths' blobs, or swaps a blob whole with `path=sha`.

```python
#!/usr/bin/env python3
import json, os, subprocess, sys
m = json.load(open(sys.argv[1]))
whole = dict(a.split("=", 1) for a in sys.argv[2:])
cache = os.environ["SANITIZE_CACHE"]; os.makedirs(cache, exist_ok=True)
by_path = {}
for path, old, new in m["pairs"]:
    by_path.setdefault(path, []).append((old, new))
def sh(*args, inp=None):
    return subprocess.run(args, input=inp, capture_output=True, check=True).stdout
for path in set(by_path) | set(whole):
    ls = sh("git", "ls-files", "-s", "--", path).decode().strip()
    if not ls:
        continue
    mode, sha = ls.split()[0], ls.split()[1]
    if path in whole:
        new_sha = whole[path]
        if sha == new_sha:
            continue
    else:
        hit = os.path.join(cache, sha)
        if os.path.exists(hit):
            new_sha = open(hit).read().strip()
        else:
            text = sh("git", "cat-file", "blob", sha).decode()
            for old, new in by_path[path]:
                text = text.replace(old, new)
            new_sha = sh("git", "hash-object", "-w", "--stdin", inp=text.encode()).decode().strip()
            open(hit, "w").write(new_sha)
        if new_sha == sha:
            continue
    sh("git", "update-index", "--cacheinfo", f"{mode},{new_sha},{path}")
```

`verify.py`: scans every blob and commit message in a range. It prints counts only and exits 1 on any hit.

```python
#!/usr/bin/env python3
import json, subprocess, sys
repo, mp, revs = sys.argv[1], sys.argv[2], sys.argv[3:]
sens = [s for s in json.load(open(mp))["sensitive"] if s.strip()]
objs = subprocess.run(["git", "-C", repo, "rev-list", "--objects", *revs],
                      capture_output=True, text=True, check=True).stdout.split("\n")
shas = [o.split()[0] for o in objs if o.strip()]
p = subprocess.run(["git", "-C", repo, "cat-file", "--batch"], input=("\n".join(shas) + "\n").encode(),
                   capture_output=True, check=True).stdout
hits, n, i = 0, 0, 0
while i < len(p):
    nl = p.index(b"\n", i); hdr = p[i:nl].split()
    size = int(hdr[2]); body = p[nl + 1:nl + 1 + size]; i = nl + 1 + size + 1
    if hdr[1] in (b"blob", b"commit"):
        n += 1; t = body.decode("utf-8", "replace"); hits += sum(1 for s in sens if s in t)
print(f"objects scanned: {n}, sensitive lines: {len(sens)}, hits: {hits}")
sys.exit(1 if hits else 0)
```
