/**
 * Screens H1 to H5's pure rules: the timeline's rail, the actions a version offers, the library's chips, the compare pair and pager, and the
 * words of the edit-and-redo impact. Kept apart from the screens so each rule can be tested without React Native.
 */
import type {
  RescueChangeItemDTO,
  RescueImpactDTO,
  RescuePhase,
  RescueProjectSummaryDTO,
  RescueVersionSummaryDTO,
} from "@/types/rescue-v2";

export type RailItem =
  | { kind: "edit"; key: string; changedBlocks: number | null }
  | { kind: "version"; key: string; version: RescueVersionSummaryDTO };

/**
 * The timeline's rows, newest first. A grey editor step sits under each version that absorbed edits (`editedBefore`), so the step survives
 * the re-run that absorbed it. Edits not yet absorbed (`edited.edited`) get one step above the newest version. The original is last.
 */
export function railItems(
  versions: RescueVersionSummaryDTO[],
  edited: { edited: boolean; changedBlocks: number | null } | null,
): RailItem[] {
  const out: RailItem[] = [];
  if (edited?.edited) out.push({ kind: "edit", key: "edit-now", changedBlocks: edited.changedBlocks });
  for (const v of versions) {
    out.push({ kind: "version", key: v.id, version: v });
    if (v.editedBefore && v.kind !== "original") out.push({ kind: "edit", key: `edit-${v.id}`, changedBlocks: v.changedBlocks });
  }
  return out;
}

/** The meta line a timeline row or a version sheet shows: failed, the pages that changed, or the plain date and fixes. */
export function rowMetaKey(v: Pick<RescueVersionSummaryDTO, "status" | "changedPages">): "metaFailed" | "metaPages" | "meta" {
  if (v.status === "failed") return "metaFailed";
  if (v.changedPages !== null) return "metaPages";
  return "meta";
}

export type VersionAction = "pdf" | "word" | "compare" | "changed" | "open" | "restore";

/**
 * What a version sheet offers. A version that is not finished shows only its meta. The original is downloadable and comparable, never
 * restorable (P-44), so its editing actions are not offered either. The current version is already the one in place: nothing to restore.
 */
export function versionActions(v: Pick<RescueVersionSummaryDTO, "kind" | "status">, current = false): VersionAction[] {
  if (v.status !== "done") return [];
  if (v.kind === "original") return ["pdf", "word", "compare"];
  const actions: VersionAction[] = ["pdf", "word", "compare", "changed", "open", "restore"];
  return current ? actions.filter((a) => a !== "restore") : actions;
}

/**
 * Whether the restore dialog says that the student's saved choices will be set back. Hidden only when a fresh read says there is nothing to
 * redo. While the read is out, or when it failed, the line shows: a choice that may be reset is never passed over in silence.
 */
export function restoreImpactLine(impact: { state: "loading" | "ok" | "failed"; value: { scope: string } | null } | null): boolean {
  return !(impact?.state === "ok" && impact.value?.scope === "none");
}

/**
 * Whether the restore dialog warns that the student edited in the workspace. The project's flag can be stale, so a fresh read counts too; a
 * read that failed shows the warning rather than hide it.
 */
export function editedWarningShown(projectEdited: boolean, read: { edited: boolean } | null, refreshFailed: boolean): boolean {
  return projectEdited || read?.edited === true || refreshFailed;
}

export type PillKey = "ready" | "diagnosed" | "working" | "failed";

/** The state pill of a library card, by the project's phase. */
export function pillKey(phase: RescuePhase): PillKey {
  if (phase === "done") return "ready";
  if (phase === "failed") return "failed";
  if (phase === "diagnosed") return "diagnosed";
  return "working";
}

export interface LibraryChips {
  /** The timeline. Only a delivered rescue has overlays to open. */
  history: boolean;
  /** Redo: the Revisions screen, for a delivered rescue. */
  rerun: boolean;
  /** The thesis itself, in the workspace. */
  open: boolean;
  /** Carry on with a rescue that is not done. */
  continue: boolean;
  delete: boolean;
}

export function libraryChips(p: Pick<RescueProjectSummaryDTO, "phase" | "thesisId" | "canDelete">): LibraryChips {
  const done = p.phase === "done";
  return {
    history: done,
    rerun: done,
    open: p.thesisId !== null,
    continue: !done,
    delete: p.canDelete,
  };
}

/** Both versions of a pair, the earlier first. Compare reads the older page on the left, whichever the caller named first. */
export function orderPair<T extends { n: number }>(x: T, y: T): [T, T] {
  return x.n <= y.n ? [x, y] : [y, x];
}

/** The changes that belong to one page of a compare. A page with none gets none: nothing is claimed that the server did not say. */
export function changesOnPage(changes: RescueChangeItemDTO[], page: number | undefined): RescueChangeItemDTO[] {
  if (page === undefined) return [];
  return changes.filter((c) => c.page === page);
}

export interface ImpactLine { key: string; params?: Record<string, string | number> }

/**
 * The fine print of the edit-and-redo screen, by scope. `none` is the only case with the CTA off, and it says nothing will change. A list
 * of pages is joined with `sep`, the thesis' own list separator.
 */
export function impactLines(impact: RescueImpactDTO, sep: string): ImpactLine[] {
  switch (impact.scope) {
    case "all": return [{ key: "editRerun.impactAll" }];
    case "pack": return [{ key: "editRerun.impactPack" }];
    case "note": return [{ key: "editRerun.impactNote" }];
    case "pages": {
      if (impact.pages.length === 0) return impact.toc ? [{ key: "editRerun.impactToc" }] : [{ key: "editRerun.impactNone" }];
      const lines: ImpactLine[] = [{ key: "editRerun.impactPages", params: { pages: impact.pages.join(sep) } }];
      if (impact.toc) lines.push({ key: "editRerun.impactToc" });
      return lines;
    }
    case "none": return [{ key: "editRerun.impactNone" }];
  }
}

/** The number a new repair would carry: one past the newest version, whatever order the list is in. */
export function nextVersionN(versions: Pick<RescueVersionSummaryDTO, "n">[]): number {
  return versions.reduce((m, v) => Math.max(m, v.n), -1) + 1;
}

/** A short day, as the device's language writes it. Read at the given timestamp; the caller passes the app's language. */
export function dayLabel(iso: string, lang: string): string {
  return new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });
}
