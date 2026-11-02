# Rescue v2 M3 — Review and the corpus fix loop

**Goal:** every corpus thesis (about 20) rescued, every page looked at, every defect turned into a fix, a rule or a Prove check; replays green.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md` §3 (stage 7), §8 (`review`), §10, §11, D-21, D-27.

---

## 1. The Review stage in code

`src/lib/rescue/review/` (pure, guard applies):

- `review-task.ts`: the `review` brain task. Input: overview sheets (9 pages per image), then zoomed pages the brain asks for, the page map, the roles. Output: issues, each with a page, a block key where one applies, a kind, and at most one fix from the allow-list. Validator rejects any fix outside the allow-list and any block key not in the inventory.
- `fixes.ts`: the allow-list. Every fix is code, none changes a word:
  | Fix | Does |
  |---|---|
  | `keep_with_next` | keeps a block with the next one |
  | `page_break_before` | starts a block on a new page |
  | `table_keep_whole` | a short table stays on one page |
  | `table_fit_width` | a table wider than the text area fits to the margins |
  | `center_object` | centres a figure or table |
  | `set_role` | a wrong Map role: corrected, then Regenerate re-runs from Reset |
  | `remove_empty` | an empty paragraph causing a blank line or page |
  | `exempt_page` | a page Prove should exempt, with a reason (divider, full-page figure) |
- `round.ts`: `reviewRound(input, brain) → { issues, fixes applied, pagesToRerender }`, at most 3 rounds; after a fix, re-convert only what's needed, then Prove again. Never half-finished: a run that can't reach green fails honestly.

CLI: `review <tNN> [--run]`, using the session brain's file queue. The answer goes in `gold/review.json`; defects found and how each was fixed go in `gold/review.md` (no thesis text).

## 2. Corpus runs

Theses: t01–t20 (t21 is the seed CV, not a thesis). Keys exist for t01, t02, t03, t05, t06, t18, t19. Missing: t04, t07–t17, t20.

**One subagent per thesis (D-27).** It writes the answer key (`map`, `approve-map`), checks the diagnosis (`diagnose`, `approve-diagnosis`), rescues, looks at every page, answers Review, and reports defects as a list with page numbers and no thesis text.

Before t18's rescue: re-assemble it in the right order (part 0 after the introduction) and re-map; its current key matches the wrong order.

Word is one queue, so runs are effectively serial. Run the small theses first.

## 3. The fix loop

Every defect becomes exactly one of: a tool or engine fix with a regression test; a rule in the agent's instructions; a new Prove check. After a fix batch, re-run every thesis that fix could touch; before calling M3 done, re-run them all.

Defects are collected in `lab/defects.jsonl` (gitignored; neutral ids, pages, kind, status).

### Defects known so far (from the t03 page review, run 2026-11-02t16-13)

| # | Defect | Owner |
|---|---|---|
| 1 | Caption alone at the bottom of a page, its table on the next | M2b module E keep-with-next |
| 2 | Header row alone at the bottom of a page; rows split; no repeated header | `regenerate/tables.ts` |
| 3 | `جدول 1: جدول ...` doubled label | apparatus and engine |
| 4 | `جدول 2 ...` beside `جدول 1: ...`, mixed separators | apparatus and engine |
| 5 | A page holding only typed notes | M2b module D |
| 6 | Page-map drift from marker width: page-numbers check 28/32 | M2b module I |

Not defects, for the student: an empty conclusion or abstract section is reported by Diagnose (`section-empty:*`) and stays the student's to write.

## 4. Replays

`scripts/rescue-lab/replay.ts <tNN>|all`: re-runs from recorded answers with no brain, and compares against the accepted output: page count ±1, the same headings on the same pages, all Prove checks. The corpus is private and gitignored, so replays run on this Mac, not in hosted CI. Exit code non-zero on any difference.

## 5. Output of the milestone

- Every thesis: `gold/map.json`, `gold/diagnosis.json`, `gold/review.json`, `gold/review.md`, accepted output.
- The procedure written as the production agent's instructions (for M7): the Map and Review instructions in `brain/`. No backticks in anything that ends up in `src/lib/ai/types.ts`.
- A summary table: thesis, pages before and after, checks, defects found and fixed, time.
