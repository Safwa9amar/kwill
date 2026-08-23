# Rescue P4 — implementation plan

**Spec:** `docs/superpowers/specs/2026-08-23-rescue-agent-orchestrated-repair.md`
**Repos:** `~/modakerati-server` (most of it), `~/modakerati` (Task 6 only)
**Gate for every task:** `cd ~/modakerati-server && npx vitest run` green, plus
`npx tsc --noEmit` in whichever repo was touched. Slow suites: re-run with
`--testTimeout=60000` before calling a timeout a failure.

Tasks 1–4 are the FALLBACK layer and each is independently shippable. Task 5 is
the agent runtime that leads them. Do NOT start 5 before 1–4: an agent whose
fallback is broken is a worse product than today's, not a better one.

---

## Task 1 — Fix the fallback steps (server, pure, vitest)

All five are bugs in code that runs whether or not the agent leads.

**1a. `clean` must delete empty paragraphs and collapse whitespace.**
`NOISE_RE` requires a digit, so an empty paragraph can never match it.
- Add `EMPTY_RE` and a whitespace collapse to `src/lib/format/candidates.ts`.
- ⚠️ **An empty paragraph is not always noise.** A page ornament needs its own
  carrier paragraph, an anchored drawing needs a host, and a paragraph holding
  `sectPr` or a bookmark is structural. Deleting those corrupts the document.
  Gate deletion on: no drawing, no `sectPr`, no bookmark, no anchor, and not the
  last paragraph of a story.
- Collapse runs of 2+ empty paragraphs to one rather than deleting all — a blank
  line between sections is typography, three is debris.

**1b. A cover-page block must never become a heading.**
The classifier returned `heading` for "REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET
POPULAIRE" and `stepStructure` promoted it, so it entered the TOC — twice, since
the document has two cover pages.
- In `reconcile.ts`, blocks before the first real front-matter role, or labelled
  `title-page`, are never promotable. `title-page` is already a declared role in
  `types.ts` and is currently enforced nowhere.
- In `plan.ts`, filter `title-page` out of `promotions` as a second gate.
- Regression fixture: a mémoire whose first eight blocks are cover lines.

**1c. The TOC goes after the cover, not at index 0.**
`stepApparatus` passes a literal `atIndex: 0` — before the title page.
- Compute the front-matter boundary: after the last `title-page` block, before
  the first `dedication`/`thanks`/`abstract`.
- Thread it into `insertTocWithPolicy({ atIndex })`. Caption lists insert at the
  same computed index, keeping the existing bottom-up reverse order.

**1d. Widen typed-TOC detection.**
`findTypedTOC` (mdocxengine) matches dotted-leader paragraphs under a TOC title.
The SOMMAIRE on p. xiv is a BULLET LIST, so it survived and the thesis shipped
with two tables of contents.
- Recognise a typed TOC by its TITLE plus a run of short entry-shaped
  paragraphs, whether they carry dot leaders, bullets, or neither.
- Add `SOMMAIRE` to the title vocabulary alongside `Table des matières` /
  `الفهرس` / `فهرس المحتويات`.
- ⚠️ Widening a destructive matcher: require the title match AND at least three
  entry-shaped lines before removing anything.

**1e. The RTL leak.**
`: III.7. Avantages du dossier infirmier` on p. 79 — a French paragraph carrying
`bidi`, so the colon jumped to the left.
- In `finish`, a paragraph whose script disagrees with the document direction is
  normalized to the document direction, not left alone.
- ⚠️ Per `thesis-language-rtl` this is content-driven: detect from the text, not
  from `thesis.language`, which is unreliable on imports.

## Task 2 — The chrome objective (the header contract)

Today `sections-numbering` calls only `applyFrontMatterNumbering` — page numbers.
Nothing touches headers, which is why three legacy designs coexist and whole
sections have none.

- New `src/lib/format/steps/chrome.ts` + a `chrome` entry in `STEP_ORDER`,
  positioned after `sections-numbering` and before `pagination`.
- **Delete first:** every legacy header and footer in every section — the brown
  rule, the red rule, the blue filled band.
- **Then apply one design** via `design_section_header` / `set_header_footer_xml`:
  two columns, brown bottom border 2pt.
  - Arabic (RTL): right column = chapter number, left = chapter name.
  - Latin (LTR): left column = chapter number, right = chapter name.
- Continuation sections inherit via `link_section_to_previous`; no section is
  left bare. Front matter gets the same design without a chapter number.
- ⚠️ `w:pPr`/`w:rPr` are ORDERED sequences; a header table's `w:tblPr` wants
  `bidiVisual` before `tblW`; a story must never end with a table
  (`hf-table-word-corruption`).
- ⚠️ Headers inherit FORWARD (`section-chrome-linking`) — isolate before writing.

## Task 3 — Divider pages and chapter openings

The TOC listed two "Chapitre I" because a divider page (title alone, p. xvii)
and the real heading are two blocks with the same text.
- Detect: a block whose text matches a later heading's text, alone on its page,
  with no body content between it and that heading.
- Keep ONE. The divider page stays as a divider (it is a real Algerian mémoire
  convention) but must not be a heading, so it leaves the TOC.
- A level-1 heading opens a page **with its content** — today `stepPagination`
  sets `pageBreakBefore` on every h1, which is what leaves a title alone on a
  page followed by blank. Pair the break with `keepNext` against the first body
  paragraph.
- ⚠️ Never stack `pageBreakBefore` on a paragraph that follows a `sectPr` —
  that is the documented blank-page bug (`table-of-contents`).

## Task 4 — Objects: real lists, real captions

**Lists.** `find_lists` and `set_list` both ship and neither is used by the lane.
- Detect fake lists: paragraphs opening with `-`, `•`, `❖`, `▪`, `1.`, `1)`,
  `أ)` etc., two or more consecutive.
- Convert with `set_list`, stripping the typed marker from the text.
- ⚠️ `numId 0` means NO numbering in OOXML — `ensureListNumId` must never
  return it (`ai-tool-registry-audit`).

**Captions.** `convertTextCaptions` only rewrites captions that are already typed.
- Sweep every table, figure and chart; typed captions become real ones (SEQ
  field + bookmark + Caption style — ONE caption model, `caption-word-parity-audit`).
- **NEW CAPABILITY:** a figure with no caption text gets one written by reading
  the image. Needs a vision call over an embedded figure returning a caption
  string; nothing in the registry does this today.

## Task 5 — The agent runtime

- Objectives, not steps: each states its goal and its **acceptance check**.
- The agent leads with the live tool registry; on death, degradation, or a
  failing acceptance check, the deterministic step from Tasks 1–4 runs instead
  and the conformity record says so.
- Journal per completed objective so a backgrounded app resumes rather than
  restarts. The existing per-step `rescue_runs` plan board is the seam.
- Lock per write, never across the run.
- ⚠️ `ai-turn-must-finish-the-job`: six causes of a half-done turn were already
  fixed once and MAX_STEPS went 16 to 32. A 153-page repair is far longer than a
  chat turn — revisit the ceiling for this feature and pin its own model.
- ⚠️ The agent's own claim of success is not evidence
  (`ai-self-assessment-unreliable`). `verify.ts` is the judge.

## Task 6 — The rebuild-fresh ask (app)

Every import asks, after the file is picked and before the diagnosis, and it
offers THREE choices:
1. **Repair** — today's lane (diagnose → verdict → paywall → fix in place).
2. **Rebuild fresh** — the AI re-lays the content into a clean base.
3. **Import only** — no diagnosis, no repair, no AI spend; the student works on
   it in Kwill's chat and editor. Wires to the EXISTING `POST /api/thesis/import`
   and its existing allowance guard. **Dismissing the card means this one**, as
   the least destructive and the only free choice.
- New screen between `rescue-norms` and the verdict; forward nav is `replace`,
  as the rest of the lane is.
- Trilingual `rescue.rebuild.*` keys — ⚠️ the locale JSONs hold ~155 duplicate
  keys each; edit them SURGICALLY, never by round-tripping.
- The card is dismissible; dismissing runs the ordinary repair.
- ⚠️ Rebuild is a FIFTH creation door: it goes through `thesisAllowance` like
  the other four, and must never read the plan via `currentPeriod`, which spends
  the trial (`thesis-limit-per-plan`).

## Task 7 — Verify and the conformity record

`verify.ts` gains a check per defect class, so the result screen cannot claim a
clean run over a broken one: one TOC only and after the cover, no cover line in
the TOC, one header design across all sections, no section without a header, no
empty-paragraph runs, no typed list left, every figure captioned, no
direction-mismatched paragraph.
- TOC page numbers reading `1` until Word repaginates is a KNOWN constraint, not
  a failure: the result screen says so plainly rather than promising numbers we
  did not compute.
