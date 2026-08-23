# Rescue P4 — the agent orchestrates the repair, the tools are the hands

**Date:** 2026-08-23
**Status:** design, from the first real run
**Supersedes:** the fixed FormatPlan runner as the *whole* of pipeline step 5
  (`2026-08-18-thesis-rescue-mise-en-page-design.md`). It does NOT supersede the
  diagnosis, the paywall seam, the snapshot, or the verify pass.

## The evidence

`m-moire-isp.docx` — 153 pages, 24,935 words, French, a real ISP mémoire — was
run through the shipped lane on 2026-08-23. Eleven defects, all reproducible,
all traceable to the same shape of cause: **a fixed nine-step plan cannot make a
per-document judgement.**

| # | Defect | Where it was seen | Root cause |
|---|---|---|---|
| 1 | Table of contents inserted BEFORE the cover page | p. i | `stepApparatus` passes `atIndex: 0` — a literal, not a computed front-matter boundary |
| 2 | Cover-page lines are TOC entries, listed twice | p. i | classifier returned `heading` for "REPUBLIQUE ALGERIENNE…"; `title-page` is a role that is never enforced anywhere |
| 3 | The student's typed SOMMAIRE survives | pp. xiv–xv | `findTypedTOC` matches dotted-leader paragraphs under a title; this SOMMAIRE is a bullet list |
| 4 | Every TOC page number reads `1` | p. i | known + documented; Word repaginates on open. Needs saying on the result screen, not fixing |
| 5 | Duplicate chapter entries; chapter titles alone on a page | pp. xvii, xviii | divider pages. Nothing compares a lone title against the real heading that follows it |
| 6 | THREE legacy header designs coexist | brown rule p. xiv, red rule p. 67, blue band p. 83 | `sectPr` chrome is never touched by the run |
| 7 | Whole sections carry no header at all | Glossaire p. xxii, Abréviations p. xx | same as 6, plus no `link_section_to_previous` pass |
| 8 | Empty paragraphs and stray whitespace survive | throughout | `NOISE_RE` requires a digit — an empty paragraph cannot match it |
| 9 | Figures with no caption stay uncaptioned | Maslow pyramid p. 37 | `convertTextCaptions` only rewrites captions that are already typed |
| 10 | Typed lists stay typed (`-`, `❖`, `▪`, `1.`) | pp. 79, 83 | no list step exists, in a registry that ships `find_lists` + `set_list` |
| 11 | RTL leak in French prose (`: III.7. Avantages…`) | p. 79 | a French paragraph carrying `bidi`; `finish` normalized the wrong way |

## The decision

**The agent orchestrates the repair. The tools are the hands.**

The original spec's line was "the AI is the eyes, the plan is the hands", and it
bought determinism at the cost of judgement. The run above is the bill for that
trade: nine ordered steps cannot decide that two blocks reading "Chapitre I" are
a divider page plus its real heading, cannot look at a pyramid and name it, and
cannot tell a typed dash from a list item.

The registry already holds nearly every hand the job needs — `design_section_header`,
`set_header`, `set_header_footer_xml`, `link_section_to_previous`, `get_sections`,
`find_lists`, `set_list`, `list_captions`, `insert_caption`,
`convert_text_captions_to_real_captions`, `insert_table_of_contents`,
`remove_table_of_contents`, `set_paragraph_pagination`, `add_divider_pages`,
`delete_blocks`. The fixed plan is a strictly weaker subset of what the agent
can already reach.

### What stays deterministic — non-negotiable

Determinism was not wrong, it was applied at the wrong altitude. These stay:

- **P0 snapshot before anything.** One tap of Undo, always.
- **The lock is per write, never across the run.** A multi-minute agent turn
  holding `withThesisLock` blocks every other write to that thesis.
- **`verify.ts` runs after the agent finishes** and its checks are recorded, not
  swallowed. The agent's own opinion that it is done is not evidence
  (see `ai-self-assessment-unreliable`).
- **Resume.** A backgrounded app must not restart the repair. The agent's
  progress is journalled per completed objective, not per tool call.
- **The paywall seam and the ephemeral diagnosis are untouched.**
- **Every objective keeps today's deterministic step as its FALLBACK**
  (decided 2026-08-23). The agent leads; if its turn dies, degrades, or leaves
  the objective's acceptance check failing, the corresponding `stepClean` /
  `stepStructure` / `stepNorms` / ... runs in its place and the conformity
  record says the objective was completed deterministically. This is the same
  degradation philosophy classification already has: a provider failure falls
  back to `inferOutline` and the student still gets a formatted thesis.
  Consequence: **the fallback steps are load-bearing and must be fixed too** —
  defects 1, 2, 3, 8 and 11 below are fallback-layer bugs regardless of the
  pivot.

### What the agent owns

An ordered list of OBJECTIVES, not steps. Each objective states the goal and
the acceptance check; the agent picks the tools and the order within it.

1. Clean — noise, empty paragraphs, whitespace, legacy chrome.
2. Structure — headings, divider-page dedupe, title-page protection.
3. Norms — the faculty profile.
4. Sections and numbering — roman front matter, arabic body.
5. Chrome — ONE header design everywhere (contract below).
6. Pagination — every level-1 heading opens a page WITH its content.
7. Objects — real captions everywhere, lists that are really lists.
8. Apparatus — TOC and caption lists, placed after the cover.
9. Finish — normalize, doctor, persist, verify.

## The header contract (from the user, 2026-08-23)

One design, applied to every section, replacing whatever legacy chrome exists.
A two-column header:

| | left column | right column |
|---|---|---|
| Arabic (RTL) | chapter **name** | chapter **number** |
| Latin (LTR) | chapter **number** | chapter **name** |

Always a **brown bottom border, 2pt**. Every legacy header — the brown rule, the
red rule, the blue filled band — is deleted first. No section is left without
one; sections that continue a chapter inherit forward via
`link_section_to_previous`.

## What the import ask offers — THREE doors

A repair works inside a document whose damage is structural. Sometimes the
better answer is to pour the student's content into a clean, correctly-formatted
document instead.

**Every import asks** (decided 2026-08-23) — not only the badly damaged ones —
and it offers three choices, not two:

| Choice | What runs | Cost to the student |
|---|---|---|
| **Repair** | the rescue lane: diagnose, then fix the formatting in place | the repair price; their own formatting is kept where it is already right |
| **Rebuild fresh** | the AI creates a new thesis, classifies the content, and lays it into a clean base | the repair price; guarantees the house layout, discards their formatting choices |
| **Import only** (added 2026-08-23) | nothing. The document comes in as it is and the student works on it themselves in Kwill's chat and editor | free — no diagnosis, no repair, no AI spend |

**Import-only is not a new door** — it is the plain `POST /api/thesis/import`
that already exists, which is exactly why it must be offered: a student who
wants to drive the chat and the editor themselves should never be walked
through a diagnosis they did not ask for, and should never be charged for one.
It is also the honest fallback when the student does not trust an automatic
rewrite of a document they are about to defend.

Per the product rule the card is dismissible, and dismissing means **import
only** — the least destructive of the three, and the only free one.

The ask sits **after the norms and BEFORE the picker** (revised while building:
the first draft put it after the file was chosen). Asking first means each door
opens the picker exactly once and both existing lanes stay whole — repair and
rebuild through the rescue store, import-only through the import store that
already owns that flow. It is also the honest order: which door you want is a
policy choice about your own document, not something you decide by looking at
it.

Each card must state plainly what its choice COSTS, because the student is
deciding before they have been shown a verdict.

⚠️ Rebuild-fresh is a **fifth creation door**. It must go through
`thesisAllowance`, the same as the other four, and must never read the plan via
`currentPeriod`. Import-only reuses the existing import door and its existing
guard — it adds no fifth anything.

## New capability needed

Everything above is reachable with today's tools except one:

- **Caption a figure that has no caption text.** Requires reading the image and
  naming it. `list_attached_images` can enumerate; the missing piece is a vision
  call over an embedded figure returning a caption string.

## Risks

- **A turn that quits half-done.** Six causes were already found and fixed once
  (`ai-turn-must-finish-the-job`, MAX_STEPS 16 to 32). A 153-page repair is far
  longer than a chat turn. Objectives must be journalled and resumable, and
  MAX_STEPS for this feature revisited.
- **Cost.** The diagnosis stays one cheap call; the repair becomes a long
  agentic turn on a paid document. It needs its own feature pin and a ceiling.
- **The agent declaring victory.** Mitigated by `verify.ts` being the judge, and
  by the conformity record reporting failed checks plainly.
