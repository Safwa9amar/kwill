/**
 * Screens 13 to 18's pure rules: the repair's step list, the failure's words by code, the trust rows, the deposit pack's line, and the
 * change report's order. Kept apart from the screens so each rule can be tested without React Native.
 */
import type { RescueChangeGroup, RescuePackDTO } from "@/types/rescue-v2";

/** The eight stages of the repair, in the order the bar counts them (plan §1.4 `repairing.steps`). */
export const REPAIR_STEP_KEYS = ["prepare", "styles", "typography", "sections", "cover", "toc", "captions", "check"] as const;
export type RepairStepKey = (typeof REPAIR_STEP_KEYS)[number];
const REPAIR_COUNT = REPAIR_STEP_KEYS.length;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The bar's eight parts, from the server's 1-based `step`. The server only moves `step` up, so the bar never goes backwards. */
export function repairBar(step: number): ("done" | "current" | "pending")[] {
  const at = clamp(Math.round(step), 1, REPAIR_COUNT) - 1;
  return REPAIR_STEP_KEYS.map((_, i) => (i < at ? "done" : i === at ? "current" : "pending"));
}

export interface RepairRow { key: RepairStepKey; state: "done" | "current" | "pending" }

/** The sheet's list: the previous step, the current one and the next. The current step is the server's `stepKey`; `step` is the fallback. */
export function repairWindow(stepKey: string | null, step: number): RepairRow[] {
  const named = REPAIR_STEP_KEYS.indexOf(stepKey as RepairStepKey);
  const idx = named >= 0 ? named : clamp(Math.round(step), 1, REPAIR_COUNT) - 1;
  const rows: RepairRow[] = [];
  for (const i of [idx - 1, idx, idx + 1]) {
    if (i < 0 || i >= REPAIR_COUNT) continue;
    rows.push({ key: REPAIR_STEP_KEYS[i], state: i < idx ? "done" : i === idx ? "current" : "pending" });
  }
  return rows;
}

export interface EtaWord { key: string; params?: { minutes: number } }

/**
 * The time left, in words. While the brain or Word holds the run, the server's `waiting` says so and no number is made up (`etaSeconds`
 * is null then). Otherwise: under a minute, or whole minutes rounded up.
 */
export function repairEta(etaSeconds: number | null, waiting: "converter" | "brain" | null): EtaWord | null {
  if (waiting === "brain") return { key: "common.waitingBrain" };
  if (waiting === "converter") return { key: "common.waitingWord" };
  if (etaSeconds === null) return null;
  if (etaSeconds < 60) return { key: "common.etaSoon" };
  return { key: "common.etaMinutes", params: { minutes: Math.ceil(etaSeconds / 60) } };
}

/** Which slot shows what on screen 13: side, middle and third, in physical order. A slot is a page of the new version or of v0. */
export interface RepairSlot { from: "active" | "v0"; page: number; done: boolean; dim: boolean; shimmer: boolean }

/**
 * Before any page of the new version is finished, three grey pages of v0. Then the side is the page before the newest finished one (or
 * a grey v0 page while there is only one), the middle is the newest finished page with the shimmer, and the third is a grey v0 page.
 */
export function repairSlots(pagesReady: number, hasActive: boolean): [RepairSlot, RepairSlot, RepairSlot] {
  if (!hasActive || pagesReady <= 0) {
    return [
      { from: "v0", page: 1, done: false, dim: true, shimmer: false },
      { from: "v0", page: 2, done: false, dim: true, shimmer: false },
      { from: "v0", page: 3, done: false, dim: true, shimmer: false },
    ];
  }
  const side: RepairSlot = pagesReady >= 2
    ? { from: "active", page: pagesReady - 1, done: true, dim: false, shimmer: false }
    : { from: "v0", page: 1, done: false, dim: true, shimmer: false };
  return [
    side,
    { from: "active", page: pagesReady, done: true, dim: false, shimmer: true },
    { from: "v0", page: 3, done: false, dim: true, shimmer: false },
  ];
}

export type FailureBody = { key: string; params?: Record<string, number> };

/**
 * The body of the honest failure, by code. A Word fault on our side never reads as a problem with the file (P-54). `stage_crashed` and
 * the rest name the page when a Prove check pointed at one; `not_same_thesis` never shows here (it is the revisions screen).
 */
export function failureBody(code: string, page: number | null): FailureBody {
  switch (code) {
    case "prove_failed": case "regenerate_failed": case "stage_crashed": case "brain_failed":
      return page !== null ? { key: "failure.bodyPage", params: { page } } : { key: "failure.body" };
    case "not_docx": case "word_refused": return { key: "failure.bodyOpen" };
    case "merge_refused": return { key: "failure.bodyMerge" };
    case "converter_unavailable": return { key: "failure.bodyWait" };
    case "too_big": return { key: "failure.bodyBig" };
    default: return { key: "failure.body" };
  }
}

export interface TrustInput {
  ios: boolean;
  refund: "none" | "due" | "done";
  /** entitlement.purchase.state: "none" means no purchase on this project. */
  purchaseState: string;
  previousVersionN: number | null;
  /** The failed version is a rescue or a re-run, not the free original. */
  rescueRun: boolean;
}

/**
 * The trust rows, each only when true. On iOS the refund is status words with no amount, method or link (P-23), and "nothing was charged"
 * is never said: nothing on iOS was ever a charge here.
 */
export function failureTrust(i: TrustInput): FailureBody[] {
  const rows: FailureBody[] = [{ key: "failure.trustOriginal" }];
  if (i.refund === "due") rows.push({ key: i.ios ? "failure.refundDueStatus" : "failure.refundDue" });
  if (i.refund === "done") rows.push({ key: i.ios ? "failure.refundDoneStatus" : "failure.refundDone" });
  if (i.refund === "none" && i.purchaseState === "none" && !i.ios) rows.push({ key: "failure.noCharge" });
  // Version 0 is the original file, already said by trustOriginal: "version 0 as it was" would say it twice, in machinery words.
  if (i.previousVersionN !== null && i.previousVersionN > 0) rows.push({ key: "failure.previousSafe", params: { n: i.previousVersionN } });
  if (i.rescueRun) rows.push({ key: "failure.team" });
  return rows;
}

/** The kinds the pack can name, in pack order. A kind outside this list is never shown raw. */
export const PACK_KINDS = ["thesis-pdf", "thesis-docx", "abstract-sheet", "integrity-declaration", "deposit-authorisation", "cd-note"] as const;

/** The words of the kinds the screen can name: a kind with no word is left out, so no raw key ever shows. */
export function packNames(kinds: string[], exists: (key: string) => boolean): string[] {
  return kinds
    .filter((k) => (PACK_KINDS as readonly string[]).includes(k) && exists(`rescueV2.result.packFiles.${k}`))
    .map((k) => `rescueV2.result.packFiles.${k}`);
}

export interface PackView {
  /** ready: the whole pack. partial: some of it is left out and a rebuild could add it. missing: no pack at all (P-48). */
  mode: "ready" | "partial" | "missing";
  /** The names of the files that are in the pack, joined by the caller. */
  files: string[];
  /** The names left out for a reason a rebuild can fix (not the no-abstracts case), or null when none can be named. */
  omitted: string[] | null;
  /** The no-abstracts line, which needs no rebuild. */
  noAbstracts: boolean;
  /** The zip was too large to build (P-64): said on its own line, with every file there to share one by one. */
  zipTooLarge: boolean;
  /** A share button: there is a deposit zip to fetch. Never true with the zip too large or removed. */
  share: boolean;
  /** The rebuild button. A rebuild cannot make the zip smaller, so the zip never offers one. */
  rebuild: boolean;
}

export function packView(pack: RescuePackDTO | null, exists: (key: string) => boolean): PackView | null {
  if (!pack) return null;
  const noAbstracts = pack.omitted.some((o) => o.reason === "no-abstracts");
  const zipTooLarge = pack.omitted.some((o) => o.kind === "zip" && o.reason === "zip-too-large");
  // The zip is not a file a rebuild can add, so it takes no part in the rebuild decision and no name in the omitted line.
  // A zip removed since (zip-pruned): no share, and the rebuild makes it again.
  const noZip = zipTooLarge || pack.omitted.some((o) => o.kind === "zip");
  const fixable = pack.omitted.filter((o) => o.reason !== "no-abstracts" && o.kind !== "zip").map((o) => o.kind);
  const omitted = packNames(fixable, exists);
  if (pack.state === "missing") return { mode: "missing", files: [], omitted: null, noAbstracts, zipTooLarge, share: false, rebuild: true };
  if (pack.state === "ready") {
    return { mode: "ready", files: packNames(pack.files, exists), omitted: null, noAbstracts, zipTooLarge, share: !noZip, rebuild: false };
  }
  return {
    mode: "partial",
    files: packNames(pack.files, exists),
    omitted: omitted.length > 0 ? omitted : null,
    noAbstracts,
    zipTooLarge,
    share: !noZip,
    rebuild: true,
  };
}

/** The order the change report's groups are shown in, as the mock: captions come after headings (P-31). */
export const CHANGE_GROUP_ORDER: RescueChangeGroup[] = [
  "cover", "toc", "headings", "captions", "numbering", "pages", "references", "notes", "fonts", "typography", "other",
];

export function orderedGroups<T extends { key: RescueChangeGroup }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => CHANGE_GROUP_ORDER.indexOf(a.key) - CHANGE_GROUP_ORDER.indexOf(b.key));
}

/** The first rows a group shows, and how many each tap of "show more" adds (every fix is listed; D-8). */
export const CHANGE_FIRST_ROWS = 20;
export const CHANGE_MORE_ROWS = 50;

export function visibleRows(shown: number | undefined, total: number): number {
  return Math.min(total, shown ?? CHANGE_FIRST_ROWS);
}

/** The sentence key of a change item: its own line when there is one, else the catch-all. A code is never shown raw. */
export function changeItemKey(code: string, exists: (key: string) => boolean): string {
  return exists(`rescueV2.changed.items.${code}`) ? `changed.items.${code}` : "changed.items.other_change";
}

/**
 * The name a downloaded rescue file is saved under: the student's UI language, not the thesis's. The words are the server's own names
 * (kwill-server deposit/pack.ts: DEPOSIT_FILE_NAMES' thesis-pdf / thesis-docx and DEPOSIT_ZIP_NAME), so a file is named the same way
 * wherever it comes from; only the language is picked here. The files INSIDE the deposit zip keep the thesis language: they go to the
 * university. A part (the student's own upload) and a language with no names keep the server's name.
 */
const FILE_NAMES: Record<"ar" | "fr" | "en", Record<"pdf" | "docx" | "deposit", string>> = {
  ar: { pdf: "المذكرة.pdf", docx: "المذكرة.docx", deposit: "ملف-الإيداع.zip" },
  fr: { pdf: "memoire.pdf", docx: "memoire.docx", deposit: "dossier-de-depot.zip" },
  en: { pdf: "thesis.pdf", docx: "thesis.docx", deposit: "deposit-pack.zip" },
};
export function rescueFileName(kind: string, uiLanguage: string | null | undefined, serverName: string): string {
  const lang = (uiLanguage ?? "").slice(0, 2) as keyof typeof FILE_NAMES;
  const names = FILE_NAMES[lang];
  return names && (kind === "pdf" || kind === "docx" || kind === "deposit") ? names[kind] : serverName;
}
