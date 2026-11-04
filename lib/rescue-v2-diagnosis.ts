import type { RescueChipKey, RescueDotDTO } from "@/types/rescue-v2";

// Pure helpers for screen 7 (the diagnosis). No React Native import, so the tests run under node.

/** The dots on `page`, in `n` order, filtered to `chip` when one is picked. */
export function visibleDots(dots: RescueDotDTO[], page: number, chip: RescueChipKey | null): RescueDotDTO[] {
  return dots
    .filter((d) => d.page === page && (chip === null || d.chip === chip))
    .sort((a, b) => a.n - b.n);
}

/** The `n` of the first dot on `page` that the filter shows, or null when none. */
export function firstVisibleN(dots: RescueDotDTO[], page: number, chip: RescueChipKey | null): number | null {
  return visibleDots(dots, page, chip)[0]?.n ?? null;
}

/** The page the stage opens on: the lowest page holding a dot. A diagnosis with no dots opens on page 1. */
export function firstPage(dots: RescueDotDTO[]): number {
  if (dots.length === 0) return 1;
  return Math.min(...dots.map((d) => d.page));
}

/**
 * A chip's jump: the next page after `fromPage` that holds a dot of that chip, wrapping to the first such page when none comes after.
 * The target dot is the chip's first dot on that page. Null when no dot carries the chip.
 */
export function chipTarget(dots: RescueDotDTO[], chip: RescueChipKey, fromPage: number): { page: number; n: number } | null {
  const pages = [...new Set(dots.filter((d) => d.chip === chip).map((d) => d.page))].sort((a, b) => a - b);
  if (pages.length === 0) return null;
  const page = pages.find((p) => p > fromPage) ?? pages[0];
  const n = firstVisibleN(dots, page, chip);
  return n === null ? null : { page, n };
}

/** The chips that have something to jump to. A chip with a zero count is not offered. */
export function chipsWithDots<T extends { count: number }>(chips: T[]): T[] {
  return chips.filter((c) => c.count > 0);
}

/** The locale key for a Diagnose code: its own sentence when the locale has one, the generic sentence otherwise. Never the raw code. */
export function problemKey(code: string, exists: (key: string) => boolean): string {
  const own = `rescueV2.diagnosis.problems.${code}`;
  return exists(own) ? own : "rescueV2.diagnosis.problems.generic";
}

/**
 * The one sentence for a Diagnose code, with its params filled. A section code names its section from `rescueV2.diagnosis.sections`; a
 * section with no name, or a code with no sentence, falls back to the generic sentence, so no raw code or id is ever shown.
 */
export function problemSentence(
  t: (key: string, options?: Record<string, string | number>) => string,
  exists: (key: string) => boolean,
  code: string,
  params: Record<string, string | number>,
): string {
  const section = params.section;
  if (typeof section === "string") {
    const name = `rescueV2.diagnosis.sections.${section}`;
    if (!exists(name)) return t("rescueV2.diagnosis.problems.generic");
    return t(problemKey(code, exists), { ...params, sectionName: t(name) });
  }
  return t(problemKey(code, exists), params);
}
