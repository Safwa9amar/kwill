import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDENT_CODES } from "./rescue-v2-errors";

// The rescue screens' words, held to one shape in ar, fr and en. The locale files
// hold duplicate keys elsewhere, so they are read as text for the `rescueV2`
// block's uniqueness and then parsed: JSON.parse keeps the last duplicate, and
// rescueV2 appears once, so the parse is exact for it.

const LANGS = ["ar", "fr", "en"] as const;
type Lang = (typeof LANGS)[number];

// The Diagnose codes the server emits, as they are at ~/kwill-server
// src/lib/rescue/diagnose/ (server HEAD eec7f28), plus the two font codes from
// src/lib/rescue/regenerate/font-policy.ts, which reach the same screens. A code
// the server adds needs a line here and in every language; the screens fall back
// to `diagnosis.problems.generic` for any code without one, so a raw key is never
// shown. `section-missing` and `section-empty` travel with the section id in params.
const DIAGNOSE_CODES = [
  "margins", "page-size", "body-font", "body-size", "line-spacing", "alignment",
  "headings-not-real", "heading-skip", "heading-size", "toc-missing", "toc-typed",
  "captions-typed", "caption-position", "figure-no-caption", "table-no-caption",
  "list-of-figures-missing", "list-of-tables-missing", "typed-notes", "page-numbers",
  "blank-pages", "heading-at-page-end", "spacing-by-empty-lines", "cover-missing",
  "section-missing", "section-empty", "typography",
  "text-glued", "text-duplicated", "annexes-absent", "bibliography-residue",
  "contents-error", "reference-error", "caption-references", "caption-numbers-repeat",
  "caption-double", "text-box-cut-off", "chapter-title-in-picture",
  "font-not-portable", "font-symbol-not-portable",
] as const;

// Words the copy must never use, in any language: the student never sees a
// document's internals or a judgement.
const BANNED = [
  "section break", "saut de section", "فاصل مقطعي",
  "field", "champ", "حقل",
  "block", "bloc", "كتلة",
  "style", "ستايل", "نمط",
  "error", "erreur", "خطأ",
  "violation", "مخالف",
];

const PATH = (lang: Lang) => new URL(`../locales/${lang}.json`, import.meta.url);

function leaves(node: unknown, prefix: string, out: Map<string, string>): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      leaves(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

function rescueWords(lang: Lang): { blocks: number; words: Map<string, string> } {
  const raw = readFileSync(PATH(lang), "utf8");
  const blocks = raw.split('"rescueV2": {').length - 1;
  const parsed = JSON.parse(raw) as { rescueV2?: unknown };
  return { blocks, words: leaves(parsed.rescueV2, "", new Map()) };
}

const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort().join(",");

const all = Object.fromEntries(LANGS.map((lang) => [lang, rescueWords(lang)])) as Record<
  Lang,
  { blocks: number; words: Map<string, string> }
>;

describe("rescueV2 locale parity", () => {
  it("has one rescueV2 block per language, with words in it", () => {
    for (const lang of LANGS) {
      expect(all[lang].blocks, `${lang}: rescueV2 blocks`).toBe(1);
      expect(all[lang].words.size, `${lang}: rescueV2 leaves`).toBeGreaterThan(0);
    }
  });

  it("has the same leaf paths in ar, fr and en", () => {
    const paths = (lang: Lang) => [...all[lang].words.keys()].sort();
    expect(paths("fr")).toEqual(paths("en"));
    expect(paths("ar")).toEqual(paths("en"));
  });

  it("has the same {{placeholders}} in every leaf, across languages", () => {
    for (const [path, en] of all.en.words) {
      for (const lang of ["ar", "fr"] as const) {
        expect(placeholders(all[lang].words.get(path) ?? ""), `${lang} ${path}`).toBe(placeholders(en));
      }
    }
  });

  it("has no empty leaf and no banned word in any leaf", () => {
    for (const lang of LANGS) {
      for (const [path, text] of all[lang].words) {
        expect(text.trim(), `${lang} ${path} is empty`).not.toBe("");
        const lower = text.toLowerCase();
        const hit = BANNED.find((word) => lower.includes(word));
        expect(hit, `${lang} ${path} uses "${hit}"`).toBeUndefined();
      }
    }
  });

  it("has a line for every Diagnose code in each language, and a generic one", () => {
    for (const lang of LANGS) {
      const missing = [...DIAGNOSE_CODES, "generic"].filter(
        (code) => !all[lang].words.has(`diagnosis.problems.${code}`),
      );
      expect(missing, `${lang}: diagnosis.problems lines missing`).toEqual([]);
    }
  });

  it("has a line for every code a student can meet, in each language", () => {
    for (const lang of LANGS) {
      const missing = STUDENT_CODES.filter((code) => !all[lang].words.has(`codes.${code}`));
      expect(missing, `${lang}: codes lines missing`).toEqual([]);
    }
  });

  it("has a line for every change code the server emits, in each language (D-8)", () => {
    // The codes ~/kwill-server src/lib/rescue/pipeline/change-events.ts and change-report.ts emit. A code the server adds
    // needs a line here and in every language, or the change list shows a raw key.
    const CHANGE_CODES = [
      "cover_generated", "cover_cleaned", "toc_real", "toc_rebuilt", "toc_added", "list_added", "heading_real",
      "captions_real", "caption_number_added", "caption_word_as_label", "caption_renumbered", "captions_moved",
      "chapters_new_page", "page_numbers", "running_heads", "rules_applied", "empty_removed", "manual_breaks_removed",
      "review_fixes", "divider_added", "frame_added", "front_page_unnumbered", "basmala_unnumbered", "direction_set",
      "references_sorted", "notes_converted", "fonts_embedded", "font_swapped", "comments_removed", "other_change",
      "typo_space_before_punct", "typo_space_after_comma", "typo_tatweel", "typo_nbsp_before_punct",
      "typo_nbsp_after_guillemet", "typo_space_after_punct", "typo_collapse_spaces",
    ] as const;
    for (const lang of LANGS) {
      const missing = CHANGE_CODES.filter((code) => !all[lang].words.has(`changed.items.${code}`));
      expect(missing, `${lang}: changed.items lines missing`).toEqual([]);
    }
  });
});
