# Rescue my thesis, v2 — replacing the print shop

**Date:** 2026-11-02
**Status:** design approved, not yet planned
**Repos:** `~/kwill` (app), `~/kwill-server` (pipeline, routes, prompts), `~/mdocxengine` (two new operations), `~/kwill-dashboard` (price, runs list)
**Mockups (open in a browser):** [`2026-11-02-rescue-v2/`](2026-11-02-rescue-v2/)
- `01-market-decisions-and-stages.html`: market research, shop vs Kwill, the animated 8 stages, the four decisions
- `02-ux-directions.html`: the three UX directions (B was chosen)
- `03-living-thesis-flow.html`: the student screens, light and dark (screen 2 "Your parts" is specified in §9.2, not drawn)
- `04-history.html`: history and versions, 6 screens

**Supersedes:** `2026-08-18-thesis-rescue-mise-en-page-design.md` and `2026-08-23-rescue-agent-orchestrated-repair.md`. The old pipeline is rebuilt from zero (see "What is kept, what is deleted").

---

## 1. Goal

Algerian students pay print shops and cyber cafés to make a finished mémoire deposit-ready. Kwill does the same job in minutes, on their department's own rules. It proves the result on the real PDF and redoes it for free after every revision from the supervisor.

**v1 delivers:** full mise en page of everything in the file, the cover page, and the deposit pack. Other shop services are later specs (§14).

### What the shops sell (research, 2026-11-01)

| Service | Shop price | Kwill |
|---|---|---|
| Mise en page (التنسيق) | ≈ 40 DA/page, negotiable (≈ 2 800 DA for 70 pages) | **v1** |
| Cover page (الواجهة) | bundled | **v1** |
| Deposit: print 3.5–7 DA/page, binding, CD; PDF + Word, integrity declaration, supervisor authorisation, abstract sheet | per item | **v1**: files and forms; printing stays at shops |
| "Plagiat": rewording until the checker passes | bundled with formatting | later, honest version (find and cite, never reword) |
| SPSS analysis | "SPSS et Word en temps record"; freelancers $5–10 | later |
| Proofreading / "correction méthodologique" | per page | later |
| Defense slides | $10–35 | later |
| Typing handwritten drafts (الرقن) | 35–50 DA/page | later |
| Writing the thesis for them | 50 000–200 000 DA | **never** |

Three findings shaped the design:
- **The shop's real product is "it opens right".** Listings advertise *"anti-décalage"*: the file not shifting on the print shop's PC. Kwill answers it by embedding fonts and delivering the checked PDF.
- **Revisions are where shops earn twice.** The supervisor changes chapter 2, the TOC and numbering break, and the student pays again. Kwill's re-run is free.
- **Deposit and formats are changing.** Khenchela 2025-26 accepts deposit as **PDF only on the supervisor's platform account**, with similarity ≤ 40% before the defense. The 2025 amendment to arrêté 1275 adds the business-model mémoire. Faculties are moving to IMRAD. Rescue must recognise the format, not assume one.

Sources are listed in mockup `01`, section "Sources".

---

## 2. Decisions

| # | Decision |
|---|---|
| D-1 | **Built from zero.** Keep mdocxengine and the server's document tools. Delete the old rescue pipeline (`src/lib/format/*`, `routes/rescue.ts`, the 5 app screens, `rescue-store`) once v2 passes the corpus. Old code returns only if a test on a real thesis proves it does the job. |
| D-2 | **Claude (this harness) is the only brain until the rescue fully works.** No OpenRouter in the rescue code path until the final milestone (§12). |
| D-3 | **Everything in the file is treated.** Page 1 is never assumed to be a cover; a cover is recognised by looking at the rendered page. |
| D-4 | **No cover in the file → Kwill creates one** from the university catalogue plus fields read from the file (title; supervisor from the thanks page), asking only for what is missing. |
| D-5 | **A messy cover → two finished covers side by side** (theirs cleaned in place, the university standard), fields read from the old cover and confirmed in one tap. The student picks. |
| D-6 | **Rules, in priority order:** the department guide (PDF or photo, read by the brain) → the catalogue profile → the Algerian default. Shown on one editable screen. |
| D-7 | **Free diagnosis; the repair is a one-time purchase per thesis**, included for subscribers. The price is set in the dashboard, never hardcoded. |
| D-8 | **Typographic cleanup only, never words.** Spacing around ؟ : ; ! « », parentheses direction in RTL, digit consistency, tatweel, quotes. Every change is listed in the change report. |
| D-9 | **Mobile app first**; web after `feat/web-version` merges. |
| D-10 | **The free preview** is two pages really repaired (the cover and the first chapter opening), watermarked. |
| D-11 | **Corpus:** the 6 theses on disk, plus the theses in the user's Gmail that students sent for mise en page, growing to about 20 (ar/fr/en; sciences, humanities, law, STAPS; with and without a cover; with equations, tables and figures; **split into parts and single-file**). Gmail attachments are listed first (file, sender, size) and downloaded only after the user confirms each batch. They live only in the gitignored lab folder. |
| D-12 | **v1 package = rescue + cover + deposit pack** (decision 1, option A). |
| D-13 | **Free re-runs on the same thesis until the defense** (decision 2, option A), made affordable by **saving the whole rescue run** (§7). |
| D-14 | **Embed fonts in the .docx and deliver the checked PDF** (decision 3, option A), **within font licences**. Checked 2026-11-02: Simplified Arabic and Traditional Arabic are fsType 0x0002, *restricted, embedding not permitted* (Word refuses too); Times New Roman and Tahoma are *editable*. So: embed every font whose licence allows it; the restricted ones ship with Windows and are on nearly every shop PC; any font that is **neither standard on Windows nor embeddable** (typically a downloaded decorative font on the cover) is flagged in Diagnose and swapped for an embeddable equivalent; the PDF is the guaranteed-identical copy. |
| D-15 | **Next services, in season order:** SPSS field study → similarity pre-check → defense pack (decision 4, option A). |
| D-16 | **UX direction B, "Living thesis"** (§9). |
| D-17 | **Student notes:** an optional free-text or voice note at the start, and "what did your supervisor ask?" on every re-run (§6). |
| D-18 | **History page:** every version kept, viewable, comparable, downloadable, restorable; choices editable and re-runnable (§9.3). |
| D-19 | **One release.** Nothing ships piece by piece. Everything is built and verified on localhost with the session brain; the production brain is the last milestone; then server, engine, app and dashboard ship together. |
| D-20 | **A thesis split into several files is merged into one.** The student picks all the parts at once; Kwill proposes the order (cover, front matter, introduction, chapters, conclusion, bibliography, annexes) and flags a file that *continues* the one before it (a chapter written across two files); the student confirms or drags to reorder; then the parts are merged **without adding anything**: no title headings, no page breaks, no normalisation (Regenerate does all of that). |
| D-21 | **Implementation is subagent-driven:** a fresh implementer per plan task, a reviewer after each, Claude arbitrates. Corpus rescues (the session brain) stay with Claude in the main session. |
| D-22 | **Caption numbers are generated apparatus, not words (decided 2026-11-02).** A caption the student left unnumbered gets a real label and number (`جدول 12: البيان المالي`), as a field, like a page number. The student's own words stay untouched and in order, every addition appears in the change report and on the Confirm screen, and it can be turned off there. A typed number on a caption (`2- جدول …`) is replaced by the real one. Prove compares caption text without the label and number. |

---

## 3. The pipeline: 8 stages

```
FREE ─────────────────────────────────────────────────────────────────
0 ASSEMBLE    code+brain  only when several files: propose order → student
                          confirms → merge the parts with nothing added
1 READ        code   inventory + word fingerprint; convert to PDF → page map
2 MAP         brain  one role per block + document format; sees page images
3 DIAGNOSE    code   problems vs rules; ≤ 5 questions; 2-page preview
── one-time payment (subscribers skip) ────────────────────────────────
4 CONFIRM     student rules screen · note · questions · cover choice + fields
5 RESET       code   wipe the presentation layer inside the student's own file
6 REGENERATE  code   rebuild every layer from rules + map (12 steps, §5)
7 REVIEW      brain  look at every page; fix what only eyes catch; ≤ 3 rounds
8 PROVE       code   checks on the real PDF → deliver .docx + PDF + deposit pack
```

**Who does what.** The brain works only in **Map** and **Review**, plus four small reading tasks (§8). It never writes XML. Code does every write, through the existing tools and two new engine operations. Each stage saves its state, so a run resumes after a crash or a closed app.

**Rendering is used throughout.** Read converts the original to PDF to get the page map (which block is on which page) and find blank pages. Map shows the brain the first pages and any ambiguous page as images. Diagnose renders only the two preview pages. Review renders overview sheets, then the zoomed suspect pages, and after a fix re-converts only those. Prove reads its checks out of the final PDF.

### Invariants (enforced in code, whatever the brain or the note says)

1. **Words never change.** The normalised word sequence after == before, except the listed typographic fixes (D-8). For a split thesis, "before" is **the parts concatenated in the confirmed order**.
2. **Nothing is lost.** Counts of footnotes, figures, tables, equations and drawings after == before (for a split thesis: the **sum over all parts**).
3. **"Junk" can only delete empty paragraphs.** A block with text is never deleted, whatever its role.
4. **The original is never touched.** Every stage works on a copy; v0 bytes are kept (every part, for a split thesis).

### Assemble (split theses)

- **Reused:** the engine's MergeManager (the merge itself), and the code-only parts of `thesis-classify.ts` (`titleFromFilename`, `stripManualNumber`, `heuristicRole`, `orderByRole`) as the first guess for the order.
- **Not reused:** `thesis-combine.ts`'s added Heading1 per part, its page breaks and its normalisation. Rescue adds no content; Regenerate owns all formatting.
- **Brain task `order_parts`** (§8) reads each part's opening and outline, confirms or corrects the heuristic order, and flags `continuesPrevious` (a chapter split across two files).
- **The student confirms** the order on one screen (screen 2 in §9.2), with drag to reorder.
- **Merge risks the corpus must cover:** parts with different page setups, colliding style names, separate footnote and numbering parts, and images. Every merge is checked by invariants 1–2 against the parts, before Read runs.
5. **Never half-finished.** If Prove fails, the student gets no file. They get a clear message and a refund (§9.2, screen 17).

---

## 4. Map: roles and formats

**One role per block, with a confidence:** cover, dedication, thanks, abbreviations, abstract-ar/fr/en, typed-toc, typed-list (figures/tables), divider-page, part, h1–h4, body, quote, list-item, figure, table, equation, caption-figure, caption-table, bibliography-heading, bibliography-entry, annex-heading, annex-body, junk.

**Document format:** classic, IMRAD or 1275 business-model. Each has its own required section structure.

Low-confidence roles become questions, at most 5, each dismissible and each with "let Kwill decide".

---

## 5. Regenerate: 12 steps

1. Styles from the rules (font, sizes, line spacing, alignment; Arabic fields `fontCs`/`sizeCsPt`)
2. Roles → real headings (keep-with-next)
3. Typography (D-8), every fix recorded
4. Sections: cover, front matter, one per chapter
5. Page numbers: none on the cover, abjad or roman in the front matter, 1 2 3 from the body
6. Headers: the chapter title per section
7. Cover (D-4 / D-5)
8. Divider pages and frames on dedication/thanks: numbered chapters only, never introduction or conclusion
9. TOC and lists of figures/tables: real Word fields, **clickable** (hyperlinked)
10. Captions: real, numbered (SEQ + bookmark, the existing caption model)
11. References grouped (books, articles, theses, websites) and sorted, **only if the student confirmed it**
12. **Fonts embedded** in the .docx where the licence allows (fsType installable/editable); restricted fonts are never embedded (anti-décalage, D-14)

**Deposit pack (delivered with the result):** the checked PDF, the .docx with fonts embedded, the abstract sheet (ملخص · résumé · abstract on one page, from the student's own abstracts), and the integrity declaration plus the supervisor's deposit authorisation, prefilled. The department's deposit rules (PDF on the platform, or copies plus a CD) come from the rules (D-6) and decide the pack's contents.

---

## 6. Student notes

The student knows things no file shows. An optional note, typed or dictated with the existing STT route, in Arabic or French:

- **Can:** formatting wishes ("French quotes in Times 12"), structure hints ("chapter 3 is the applied part"), exceptions ("no number on the dedication"), "keep my tables as they are".
- **Shown back:** Kwill shows how it read each line as removable chips. Rules that came from the note are tagged "from your note" on the rules screen.
- **Asked, never guessed:** a clash with the department guide shows both values, and the student picks.
- **Can't:** change words, skip Prove, or break the deposit rules (§3 invariants).
- **Where it goes:** the brain reads it at Map and Review; the note parser turns what it can into rules; it is saved in the project and reused on every re-run.
- **On a re-run** the screen asks "what did your supervisor ask for?", which is saved as a new note.

---

## 7. The saved rescue run

### Tables (`sql/<date>-rescue-v2.sql`, named for the day it is written, applied by hand; `ensureSchema` is dead on prod)

```
rescue_projects   one per rescued thesis — the standing choices
  id, user_id, thesis_id (the rescued thesis in the library)
  original_paths text[]    v0 bytes — one per uploaded part, never deleted
  part_order jsonb         confirmed order + continuesPrevious flags (split theses)
  university_id, norm_profile_id, guide_path?
  rules jsonb              resolved (guide → catalogue → default) + student edits
  note text, note_rules jsonb   (parsed chips, conflict choices)
  answers jsonb            { blockKey → answer }
  cover jsonb              { choice, fields }
  purchase_id              one payment covers every version
  created_at

rescue_versions   immutable, one row per version (the timeline)
  id, project_id, n, parent_id
  kind     original | rescue | rerun | restore
  trigger  "first rescue" · "rules edited" · "supervisor note" · "restored v1"
  settings jsonb           snapshot of rules/note/answers/cover
  map jsonb                { blockKey → role, confidence }
  doc_path, pdf_path, pages text[]   (.docx, PDF, page images)
  changes jsonb, proof jsonb, stats jsonb
  cost jsonb               tokens in/out, brain, est. DA
  status   running → done | failed (+ stage), stage_state jsonb
  created_at
```

**blockKey.** A hash of the block's normalised text plus a little neighbour context, so two identical "خلاصة" headings get different keys. Indices are never stored (CLAUDE.md: indices shift).

**Re-run diff.** The new file's blocks are matched against the last version's map by blockKey:
- unchanged blocks keep their role and their answer, and the brain never sees them again;
- only new or edited blocks go to Map;
- Review re-converts only the pages those blocks landed on.

Cost scales with what changed, not with thesis size.

**Cost per version.** Every brain call is tagged with the version id as `turn_id` in `ai_usage_log`, giving the exact cost of a first rescue and of each re-run. This is the pricing data.

**Restore** writes the old version's bytes as a new version on top. Nothing is ever deleted except with the thesis.

**Editor edits** are not rows. The timeline compares the thesis's current hash with the last version's to show "edited in Kwill"; the next re-run picks those blocks up as changed.

**Runner.** A server job runs one stage at a time and saves `stage_state` after each. Brain turns run **outside** `withThesisLock`, because the tools lock themselves. Progress reaches the app live; a push goes out on done or failed (existing FCM). The app resumes from the project state on a cold start.

**Storage.** About 5 MB per version. All versions are kept until the student deletes the thesis; deleting the thesis sweeps them (extend the existing delete sweep).

---

## 8. The brain

**An interface with fixed-schema tasks:**

| Task | Input | Output |
|---|---|---|
| `order_parts` | each part's filename, opening text, outline | part order, role per part, `continuesPrevious` flags |
| `map` | blocks (text, style facts, blockKey) + page images | role + confidence per block, document format |
| `ask` | low-confidence roles | ≤ 5 questions, each with the excerpt and its page |
| `review` | overview sheets, then zoomed pages | issues found + fixes as tool calls from an allow-list |
| `read_cover` | cover page image + text | cover fields |
| `read_guide` | guide PDF or photo | rules |
| `parse_note` | the student's note + current rules | rules, chips, conflicts |

**In this project only the session brain exists.**
- The server writes each task (JSON plus page images) into a queue (`lab/tasks/` locally), and the run pauses on that stage.
- Claude answers from the Claude Code session; the harness validates the answer against the schema, and the run continues.
- No `featureClient`, no OpenRouter, no model cost in the rescue path. **A guard test fails the build** if `src/lib/rescue/` imports a model client.
- The local server runs with `RESCUE_BRAIN=session`, so the real phone flow works end to end on localhost with Claude answering behind it. Slower than a model (minutes per stage), but every screen and every saved version is real.

**The production brain** (an OpenRouter implementation of the same interface) is the final milestone (§12), scored against the answer key.

---

## 9. The student experience: "Living thesis"

The student's own pages fill the top half of the screen the whole way through. One sheet below changes per step, so the student never leaves the screen. Mockups: `03-living-thesis-flow.html` and `04-history.html`.

### 9.1 Principles
- One decision per screen, with the button under the thumb.
- Their thesis stays visible: their own pages, not icons.
- Reassure, don't judge: "47 things we'll fix", never "violations". "Your words won't change" and "the original is kept" are repeated at the moments of doubt (upload, payment, result).
- Never a blank spinner: skeleton pages fill in; progress shows on the pages, with a time left.
- Safe to leave at any point; a push brings them back to the right screen.
- Plain words: "we're building your table of contents", never "section break" or "field".
- Motion: one screen whose sheet changes height on a spring; before → after is a sweep cross-fade on the page; light haptics on answers and on "ready" (`expo-haptics`, installed).
- App tokens only (`useThemeColors`, brand orange, slate), light and dark, RTL-first with fr/en mirrored.

### 9.2 The 18 screens
Mockup `03` draws all of them except screen 2, "Your parts", which was added after the mockups were made.

| # | Screen | Notes |
|---|---|---|
| 1 | Start | Pick one file or **several parts at once**. Reached from the drawer, a home card, or **Share → Kwill** from WhatsApp/Telegram. Share needs native intent config (app.json) and therefore a new binary; it is part of the single release. |
| 2 | Your parts | Split theses only. The parts as page thumbnails in the proposed order with their roles; "continues the part above" shown as a joined pair; drag to reorder; confirm |
| 3 | Reading | Real pages appear as they're converted |
| 4 | Which rules | University prefilled from the profile; department guide optional |
| 5 | Your notes | Optional, skippable; chips; conflicts asked (§6) |
| 6 | Understood | "153 pages, 3 chapters, 23 figures…"; format shown |
| 7 | Diagnosis | Numbered dots on their real page; category chips; one-sentence explanations |
| 8 | After preview | The before/after switch; 2 pages really repaired, watermarked |
| 9 | Payment | BaridiMob/CCP (manual) or card (Chargily); subscribers skip. **iOS shows status only** and sends the student to `/pay` by email (App Store 3.1.1) |
| 10 | Rules | Editable rows; margins drawn live on their page; "from your note" tags |
| 11 | Question | The page zooms to the exact line; 2 answers + "let Kwill decide" |
| 12 | Cover | Two finished covers; fields confirmed |
| 13 | Repairing | Pages turn from grey to finished; step bar; time left; safe to close |
| 14 | Done | Push notification |
| 15 | Result | PDF, Word, deposit pack; opens in the normal workspace |
| 16 | What changed | Every fix by page; tap to jump |
| 17 | After revisions | New version (one file or new parts) + "what did your supervisor ask?"; only changed pages; **free** |
| 18 | Honest failure | No broken file, a refund, the original untouched, sent to Support |

### 9.3 History (6 screens)
Library card with a History chip → timeline (newest first, editor edits as small steps, the original locked at the bottom) → a version (download, compare, what changed, open in Kwill, restore) → compare (same page, drag slider, steps through differing pages only, uses saved page images) → edit & re-run (rules, note, answers, cover in one place; the pages a change will touch are shown before running) → restore (a new version on top; nothing deleted).

### 9.4 App structure
One route `app/(app)/rescue/` driven by the project/version state, so a cold start resumes on the right step. The sheet is a gorhom bottom sheet (unmount when closed, per the existing rule). A new `stores/rescue-store.ts` selects primitives only. Locale keys are added surgically to ar/fr/en (the JSONs contain duplicate keys; never round-trip them).

---

## 10. The lab: corpus, answer key, fix loop

- **Harness:** `~/kwill-server/scripts/rescue-lab/` (dev-only). Runs the real pipeline on a corpus thesis with the session brain.
- **Corpus:** `~/kwill-server/lab/corpus/`, **gitignored** (private student files). Each thesis has `original.docx` and `meta.json` (university, language, format, permission note).
- **Answer key** per finished thesis: `gold/map.json`, `gold/answers.json`, the accepted output (.docx + PDF + page images, every page approved by Claude) and `review.md` (defects found, how each was fixed).
- **Seeing:** pages come from the same converter production uses; Word is the tiebreaker when they disagree.
- **Fix loop:** every defect found while rescuing a thesis becomes exactly one of: a tool/engine fix with a regression test, a rule in the agent instructions, or a new Prove check. After any fix the whole corpus re-runs.
- **Output of the phase:** the answer key, plus the procedure Claude followed, written as the production agent's instructions in the server's prompt files. ⚠️ `src/lib/ai/types.ts` is a template literal: no backticks.

---

## 11. Testing and definition of done

**Three layers:**
1. **Unit tests (vitest, no brain):** blockKey and the re-run diff; runner save/resume; note-parser conflicts; deposit-pack contents; every Prove check on known-good and known-bad files; the two engine operations (wipe presentation, embed fonts), round-tripped and passed through the docx doctor.
2. **Corpus replays (CI, no brain):** each thesis replays from its recorded answers and must match its accepted output: page count ±1, the same headings on the same pages, all Prove checks passing.
3. **App walk:** Claude drives the 18 + 6 screens on the simulator against the session brain; then the user walks them on a device.

**Done when:**

| Must hold | Checked by |
|---|---|
| Every corpus thesis (~20) rescued, every page approved | lab + review notes |
| 0 content lost | Prove, every run |
| Opens in Word with no repair prompt, fonts embedded | Word oracle |
| A re-run after an edit redoes only changed pages, asks no repeated question | corpus re-run tests |
| History: view, compare, restore, edit + re-run work; nothing deleted | app walk + tests |
| Honest failure: a forced Prove failure gives a refund and leaves the original untouched | test + app walk |
| `npx tsc --noEmit` + vitest green in kwill, kwill-server, mdocxengine | CI |
| A production model clears the bars against the answer key (§12) | lab scoring |

---

## 12. Milestones and the single release

| M | Milestone | Ends with |
|---|---|---|
| M0 | Lab + brain interface: harness, session-brain queue, corpus intake (6 on disk + the Gmail theses, listed and confirmed first), converter → page images, the guard test. **First task:** prove font embedding in the engine and check font licences (D-14). | Claude can answer a `map` task on a real thesis |
| M1 | Assemble (split theses) · Read · Map · Diagnose, plus the 2-page preview | Free diagnosis correct on every corpus thesis so far, split ones included; answer keys started |
| M2 | Reset · Regenerate (engine: wipe presentation, embed fonts) · Prove | Every Prove check runs; the first thesis fully rescued |
| M3 | Review, then the fix loop over the corpus | All corpus theses rescued and approved; replays green |
| M4 | Saved runs: projects/versions tables, blockKey diff, notes, answers, cost per version, history API | A re-run after an edit is cheap and asks nothing twice |
| M5 | App: `/rescue` living thesis (18 screens), history (6), push, payment hookup, Share intent, multi-file pick | Full localhost walk with the session brain |
| M6 | Dashboard: price setting, runs list (cost, failures, Support handoff) | Price live in the app from the dashboard |
| M7 | **Production brain:** the OpenRouter implementation of the interface, scored on the corpus against the answer key. Bars: structural roles ≥ 97%, 0 content lost, ≤ 5 questions and only on truly ambiguous blocks, Review finds Claude's defects, all Prove checks pass. Pin the cheapest model that clears every bar as the `rescue.*` features. | A model passes on every corpus thesis |
| — | **Single release** | see below |

**Release order** (the repos' standing rules):
1. Engine: build, then ship the tarball the server deploy expects.
2. Server: apply `sql/<date>-rescue-v2.sql` on cloud **before** deploying; then a minor deploy (feature). Production `.env`/`app_settings` must carry `RESCUE_BRAIN` and the pinned feature models. `deploy.mjs` does not sync `.env`.
3. App: commit → build the APK (`./scripts/build-apk.sh`) → verify the fingerprint matches → publish. The Share intent changes `app.json`, so this release needs a new binary, not just an OTA.
4. Dashboard: push to `master` (Vercel).
5. Then delete the old rescue code (D-1) in a follow-up commit.

---

## 13. What is kept, what is deleted

**Kept:** mdocxengine; the server's document tools (headings, sections, page numbering, headers/footers, TOC, captions, lists, divider pages, ornaments, images, tables); `thesis-render` (page map, page images, overview sheets); `withThesisLock`; storage; billing and the payment routes; the university / norm-profile / template catalogue; FCM push; the STT route; `docx-empty-blocks` (the list of what blank-paragraph removal must keep).

**Deleted after v2 passes the corpus:** `src/lib/format/*` (the 9-step runner, its fallbacks, objectives, agent-run), `src/routes/rescue.ts` (old), the `rescue_runs` table (after its rows are no longer needed), the app screens `rescue-choice`, `rescue-norms`, `rescue-verdict`, `rescue-questions`, `rescue-working`, `rescue-result`, and the old `rescue-store`. The drawer's `__DEV__` gate (`components/AppDrawer.tsx`) is replaced by the new entry.

---

## 14. Not in this spec

Similarity pre-check (honest: find and cite), SPSS field study, proofreading, defense pack, typing from scans (OCR), printing-partner delivery, the web lane. Order when they come: **SPSS → similarity → defense pack** (D-15). Ghost-writing: never.

---

## 15. Risks and open items

- **Font licences (checked).** Traditional Arabic and Simplified Arabic forbid embedding (fsType 0x0002). Handled by D-14: embed only permitted fonts; rely on the Windows-standard set for the rest; swap non-standard, non-embeddable fonts; the PDF is identical by construction. The list of Windows-standard fonts is a data file the plan creates.
- **Converter vs Word.** Pages are judged in the production converter; Word is the tiebreaker. Known gaps (TOC numbers read "1" until Word repaginates) need a Prove check that reads page numbers from Word's own PDF where they matter.
- **Session-brain speed.** Minutes per stage on localhost is acceptable for development, not for students; that is what M7 is for.
- **Corpus privacy.** Theses come only with permission and never leave the gitignored lab folder.
- **Catalogue coverage.** Only about 7 seed norm profiles exist. The guide reader (D-6) and the editable rules screen carry v1; IMRAD and 1275 need format profiles.
- **Open question:** `modhakirati.com` is an Arabic thesis platform with +213 numbers that carries Kwill's old name. Is it the user's own old site or a competitor?
