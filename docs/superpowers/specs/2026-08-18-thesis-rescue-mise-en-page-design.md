# مسار الإنقاذ — importing a finished thesis and formatting it to the faculty norms

**Date:** 2026-08-18
**Status:** design approved, not yet planned
**Ships before:** April 2027

## The idea

A student has written their whole mémoire in Word and has three days left. The
text is done. What is not done is the تنسيق — the font their faculty demands, the
margins, the chapter page breaks, a real table of contents, page numbers that are
roman in the front matter and arabic in the body, a list of figures that is a
Word field and not something they typed by hand.

Today they pay a مكتب طباعة several thousand dinars for that. This feature does
it in one session.

It is a **rescue lane**, not a branch of the new-thesis wizard. A student who
already has a finished thesis must never be asked to re-type its title, its
topic, or its fields. The lane is: pick the file, pick the faculty, watch it
work, answer about five questions, download the .docx.

## Why this shape

Nine decisions were made before the design and everything below follows from
them.

**The AI is the eyes. The plan is the hands.** The model never writes OOXML. It
reads the document and returns a semantic map — what every block *is*. A
deterministic, ordered plan then executes against that map. This buys model
accuracy on the one thing code is bad at (understanding an Algerian mémoire's
structure in Arabic or French) and code's determinism on the one thing models are
bad at (fifteen ordered OOXML passes that must *all* land). A half-formatted
thesis three days before the deadline is worse than an unformatted one.

**Structure recovery comes first, or nothing else works.** Most imported theses
have no real Word headings — chapters are bold centred paragraphs. Without
heading styles there is no TOC, no numbering, no sections. Every other step
depends on this one.

**Safe changes apply silently; only ambiguity is asked about.** Fonts, margins,
spacing, page numbering, captions and the TOC apply with no questions. The run
pauses only for the handful of structure calls it is genuinely unsure about.
About five taps on a real thesis, not sixty.

**The diagnosis is free, the repair is paid.** Classification is one cheap model
call and produces the verdict — "مذكرتك بها 47 مخالفة لمعايير كليتك" — with the
list. That screen is the sales pitch and it costs almost nothing. Payment unlocks
executing the plan and downloading the file. Proof before payment, and no full
pipeline run burned on a student who was never going to pay.

**Norms come from the seeded catalogue.** Reading a faculty's guide PDF to build
a new profile is real and valuable, and it is a separate spec (see Out of scope).

**No cover page.** It is the one step that would demand data the file does not
contain — jury, supervisor, year — and a rescue lane must never ask for anything
it could read instead.

## What this is not

- Not a rewrite of the student's words. Nothing in this pipeline changes prose.
- Not the new-thesis wizard with an upload button on it.
- Not a chat feature. The AI is called twice, headlessly, with a schema.
- Not the faculty-guide reader. That is spec C.

## Architecture

```
DIAGNOSE (free)                          REPAIR (paid)
─────────────────────────────────────    ────────────────────────────────
1. EXTRACT    docx → block list          4. ASK      ~5 dismissible cards
2. CLASSIFY   ← AI. role + confidence     5. EXECUTE  the FormatPlan, ordered
3. RECONCILE  ← code. sanity + plan       6. VERIFY   assert, doctor, persist
   ↓                                         ↓
   the verdict screen                        the download
```

Only step 2 calls a model. Steps 1 and 3–6 are testable in vitest with no model
at all, which is what makes a deadline promise honest.

The paywall sits on a seam that already exists: the FormatPlan produced by step 3
*is* the diagnosis. Nothing extra is built to support it.

### Step 1 — Extract

The .docx becomes an ordered block list: index, text, bold, size, alignment,
`outlineLvl`, `isTable`, `hasImage`, and whether a page break precedes it.
`thesis-extractor.ts` and the engine's block reader already supply most of this.

### Step 2 — Classify (the only AI call in the pipeline)

**The candidate set comes from `doc.inferOutline()`**, which already exists in
mdocxengine and returns headings with confidence `styled | high | medium | low`.

| `inferOutline` says | What happens |
|---|---|
| `styled` | A real Word heading. Trusted. No model call. |
| `high` | Applied silently. |
| `medium` / `low` | **Sent to the model.** |
| Model still unsure | **Asked of the student** in step 4. |

Around that outline candidate set, code adds a deliberately over-inclusive net:
every table, every image, every short line styled off the dominant body run,
anything adjacent to a page break, and anything matching
`الفصل|المبحث|المطلب|Chapitre|Section|\d+\.\d+`. On a 120-page mémoire this is
roughly 150–300 blocks out of ~3,000.

The net decides **what the model looks at**, never **what something is**. Step 6
audits for gaps: if forty pages passed with no heading, the net failed, and the
run widens it and re-classifies rather than shipping a broken TOC.

Candidates go to the model in ordered windows with overlap, because context
decides the answer — a bold line after a page break is a chapter title; the same
line mid-paragraph is emphasis.

**Roles**, tuned to what an Algerian mémoire actually contains:

| Group | Roles |
|---|---|
| Front matter | `title-page`, `dedication` (إهداء), `thanks` (شكر وتقدير), `abstract` (ملخص), `toc`, `list-of-figures`, `list-of-tables`, `abbreviations` |
| Body | `heading/1`–`heading/4` (الفصل → المبحث → المطلب), `body`, `quote`, `annex` |
| Objects | `table`, `table-caption`, `figure`, `figure-caption` |
| Noise | hand-typed page numbers, fake running heads, stray empty paragraphs |

That last row matters more than it looks. Imported theses are full of manually
typed page numbers and hand-made headers that have to be **deleted**, not
formatted.

**Output** is index-anchored *and* text-anchored:
`{ index, textHead, role, level?, confidence }`. Indices shift; every consumer
re-resolves through the `lib/block-links.ts` pattern — trust the index while its
text still matches, otherwise re-find by label.

**Model:** a cheap model pinned through the feature registry. Explicitly **not**
`openrouter/free`, which collapsed silently for thirteen hours in August. A
per-thesis cost ceiling is set before build; the free diagnosis makes this a cost
paid for every student who tries the lane, not only the ones who pay.

### Step 3 — Reconcile (code)

Deterministic sanity over the map, then the plan:

- Heading hierarchy: no level jumps, no `heading/3` before any `heading/2`.
- Sequence: الفصل الثاني does not precede الفصل الأول.
- Dedupe overlapping window results.
- Anything still uncertain becomes a **question** for step 4.
- Anything the norms already satisfy becomes a **skipped** step, not a no-op run.

The output is a persisted `FormatPlan`: an ordered list of steps, each with a
status, plus the question list and the verdict counts.

### Step 5 — Execute: the FormatPlan

Pipeline steps are numbered 1–6; the plan's own steps are numbered P0–P9 to keep
the two apart. Everything below is inside pipeline step 5.

Order is forced by data dependencies, not taste. One file per step, one vitest
per step.

| # | Step | Writes | Why it is here |
|---|---|---|---|
| P0 | Snapshot | `persistThesisDocx` "Before formatting" | The single Undo. Everything below is reversible because of this row. |
| P1 | Clean | delete `noise` blocks | Deleting later re-shifts every index. |
| P2 | Structure | `setHeadingLevel` ×N | Load-bearing. Nothing below works without it. |
| P3 | Norms | `applyNormProfileToDocument` | Already built — body + `styles.xml` + house norms. |
| P4 | Sections | `sectPr`: front matter / body / annexes | ⚠️ byte-safe surgery only. |
| P5 | Chrome | headers/footers, `front_matter_numbering` | Roman i·ii·iii then arabic 1·2·3 at the body. Needs step 4's sections. |
| P6 | Pagination | `set_paragraph_pagination` | Chapter starts a page, `keepNext` on headings, widow/orphan control. |
| P7 | Captions | `convert_text_captions_to_real_captions` | Typed "Figure 1 :" becomes a real SEQ field. |
| P8 | Apparatus | TOC, list of figures, list of tables | **Last.** Caption lists collect *real* captions, so step 7 must have run; the TOC collects *real* headings, so step 2 must have run. |
| P9 | Finish | `normalizeDocxRtl` → doctor → persist → conformity record | |

**Front matter is assembled bottom-up.** Step 8 inserts near index 0 and every
insert shifts what follows. Inserting in reverse document order — lists first,
then the TOC above them — means no insert invalidates a later step's indices.
Cheaper and safer than re-reading the block list between every insert.

**The lock is held per persisting step, never for the whole run.** Each step
takes `withThesisLock`, loads a fresh engine inside it, writes, and releases —
matching what `/:id/format` already does. A multi-minute run that held the lock
end to end would block every other write to that thesis for its whole duration,
which is the mistake the tasks executor already had to be corrected for.

### Step 6 — Verify

Re-read the document and assert the norms actually hold: the dominant body run is
the profile's font at the profile's size, margins match, every `heading/1` starts
a page, the TOC has entries, no `noise` survived, and heading coverage has no
forty-page gap. Failures are recorded in the conformity record rather than
silently swallowed.

## Refactor in scope

The engine is reusable; the MCP tool handlers are not. `insert_table_of_contents`
calls `doc.engine.toc.insertTOC()`, but the *policy* around it — RTL detection,
removing a typed TOC first, patching `TOC1..9` styles for RTL — is inline in the
tool handler body.

The FormatPlan must not go through MCP, and must not re-implement that policy.
So those handler bodies are lifted into `src/lib/format/steps/*.ts`, and **both**
the MCP tool and the FormatPlan call the extracted function. This is an
extraction, not a rewrite: one file per step, the tool handler becomes a thin
wrapper, and existing tool tests keep passing unchanged.

## The experience

```
[أصلح مذكرتي]  →  .docx  →  faculty  →  Diagnosing…  →  VERDICT  →  [pay]
   drawer          picker    catalogue     ~20s          47 issues
                                                            ↓
                              Download .docx  ←  ~5 questions  ←  Working…
                              Open in editor      dismissible      real steps
                              Undo
```

The drawer door already exists (`home.importDocx` → `handleImport`). This lane
replaces its destination; no new entry point is invented. The lane never routes
through `thesis-title`, `thesis-topic` or `thesis-fields`.

**Working** reuses `ProcessingSteps`, fed by the *actual* plan — "إعادة بناء
الهيكل", "بناء فهرس المحتويات" — not a fake progress bar. The plan object makes
this free.

**The questions** are a card stack: the real paragraph in its surrounding
context, two or three choices. Per the product rule, every card is **skippable**,
and a skip falls back to the safest default — *not a heading*. A false heading
corrupts the TOC, the numbering and the page breaks at once; a missed one is a
single line the student can promote later.

**One session** means the run must survive the app backgrounding. Because the
FormatPlan is persisted with per-step status, reopening the app resumes the run
where it stopped rather than restarting it.

**Undo** is one tap back to P0's snapshot.

## Error handling

- A step that throws marks itself `failed`, records the reason, and the run
  continues to the next independent step. Steps declare their dependencies, so a
  failed step 2 stops steps 6 and 8 but not step 3.
- The document is never left half-written: each step persists through
  `persistThesisDocx`, and the doctor runs on every write.
- A classification call that fails or returns an unparseable shape falls back to
  `inferOutline`'s own `high` confidence set and records that the run was
  degraded. The student still gets a formatted thesis, and the conformity record
  says the structure was detected without AI.
- The thesis-limit guard is reused as-is. Import already creates a thesis and
  already handles `isThesisLimitError`; this lane must not become a fifth
  unguarded creation door, and must never read the plan via `currentPeriod`,
  which spends the trial.

## Known constraints

- **TOC page numbers read `1` until Word repaginates.** `w:dirty` is not the fix.
  The result preview therefore routes through the existing OnlyOffice docx→pdf
  path to force real pagination, and the conformity record says so plainly rather
  than promising numbers we did not compute.
- `sectPr` edits are byte-safe surgery only.
- `w:pPr` and `w:tblPr` are ordered sequences.
- A story must never end with a table.
- Arabic run properties need their complex-script twins (`w:cs`, `w:szCs`) or the
  change looks like it did nothing.

## Testing

Steps 1 and 3–6 are pure functions over a block list or a docx buffer, tested in
vitest with no model. A fixture set of real imported theses — Arabic, French, one
with no headings at all, one with hand-typed captions, one with hand-typed page
numbers — is the regression suite.

Step 2 is tested against recorded model responses for shape, and against the
fixtures for recall: the net must catch every heading a human labelled.

Word is the final oracle. Schema-valid is not the same as Word opens it.

## The free diagnosis collides with the one-free-thesis limit

Uploading a .docx creates a thesis, and the free tier is exactly one thesis. A
free diagnosis would therefore spend the student's only free thesis **before**
they have been shown anything or paid anything — and if they decline to pay, they
are left with a slot consumed by a document that was never repaired.

**Resolution: the diagnosis is ephemeral.** The uploaded .docx goes to a
temporary slot and is classified there. No `theses` row is created and no limit
is touched. The row is created at payment, from the bytes already uploaded, so
the student never uploads twice. An unpaid diagnosis expires from the temporary
slot on a sweep.

This keeps the four existing creation doors as the only doors that count against
the limit, and it means the verdict screen costs the student nothing at all —
which is the entire point of putting it before the paywall.

Two consequences for the build: the temporary slot needs its own retention sweep,
and the FormatPlan produced during diagnosis must survive the move from the
temporary slot to the real thesis, since it is what step 5 executes.

## Out of scope

- **Spec C — the faculty guide reader.** A student whose faculty is not in the
  catalogue uploads or photographs their دليل إعداد مذكرة التخرج, the AI extracts
  a `NormFormatting` from it, and it is saved back as a new profile so the next
  student from that faculty gets it instantly. Independently valuable, cleanly
  separable, and A+B ship without it.
- Cover page generation.
- Citation and bibliography reformatting.
- Language-level polish: quotes, spacing, Arabic punctuation.
