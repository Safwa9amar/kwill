import type {
  RescueCoverChoice,
  RescueCoverFieldsDTO,
  RescueQuestionDTO,
  RescueRuleFieldDTO,
  RescueRuleFieldId,
  RescueRuleRowId,
} from "@/types/rescue-v2";

// Pure helpers for screens 10 to 12 (the rules, the question, the cover). No React Native import, so the tests run under node.

/** The page the margins are drawn on: A4, in cm. */
export const PAGE_WIDTH_CM = 21;
export const PAGE_HEIGHT_CM = 29.7;
/** The zoomed question page: its scale, and the height of the line it points at, as a share of the stage. */
export const ZOOM_SCALE = 2.2;
export const ZOOM_TARGET = 0.4;

/** The rows in the order of §1.5, which is the order the sheet shows them. */
export const RULE_ROW_ORDER: RescueRuleRowId[] = ["font", "spacing", "headings", "margins", "numbering", "footnotes", "deposit", "additions"];

export type RuleValue = string | number | boolean;

/** Fields grouped by their row, the rows in §1.5's order. A row the server did not send is left out. */
export function groupRuleRows(fields: RescueRuleFieldDTO[]): { row: RescueRuleRowId; fields: RescueRuleFieldDTO[] }[] {
  return RULE_ROW_ORDER
    .map((row) => ({ row, fields: fields.filter((f) => f.row === row) }))
    .filter((g) => g.fields.length > 0);
}

/** The edits the student made that the server does not hold yet. An edit the server already holds is dropped. */
export function unsavedRuleEdits(
  fields: RescueRuleFieldDTO[],
  pending: Partial<Record<RescueRuleFieldId, RuleValue>>,
): Partial<Record<RescueRuleFieldId, RuleValue>> {
  const out: Partial<Record<RescueRuleFieldId, RuleValue>> = {};
  for (const f of fields) {
    const v = pending[f.id];
    if (v !== undefined && v !== f.value) out[f.id] = v;
  }
  return out;
}

/**
 * The four margin lines as distances from the page's edges, each a share of the page: top and bottom of the A4 height, the two sides of its
 * width. The binding margin goes to the side the student binds on; the other side gets the opposite margin.
 */
export function marginLines(
  m: { top: number; bottom: number; binding: number; opposite: number },
  bindingSide: "left" | "right",
): { top: number; bottom: number; start: number; end: number } {
  return {
    top: m.top / PAGE_HEIGHT_CM,
    bottom: m.bottom / PAGE_HEIGHT_CM,
    start: (bindingSide === "left" ? m.binding : m.opposite) / PAGE_WIDTH_CM,
    end: (bindingSide === "right" ? m.binding : m.opposite) / PAGE_WIDTH_CM,
  };
}

/**
 * The zoom that brings the line at `topPct` of the page to ZOOM_TARGET of the stage. The page is centred in the stage and scales about its
 * centre, so the line's height after the scale is measured from that centre; the translation moves it the rest of the way.
 */
export function zoomFor(pageH: number, stageH: number, topPct: number, scale: number): { scale: number; translateY: number } {
  return { scale, translateY: (ZOOM_TARGET - 0.5) * stageH - (topPct * pageH - pageH / 2) * scale };
}

/** One step of a number field, clamped to its range and rounded to the step's own decimals (no float drift). */
export function stepRuleNumber(value: number, dir: 1 | -1, r: { min: number; max: number; step: number }): number {
  const decimals = (r.step.toString().split(".")[1] ?? "").length;
  const clamped = Math.min(r.max, Math.max(r.min, value + dir * r.step));
  return Number(clamped.toFixed(decimals));
}

/** The first question still without an answer, or -1 when every one has one. */
export function currentQuestionIndex(questions: Pick<RescueQuestionDTO, "answer">[]): number {
  return questions.findIndex((q) => q.answer === null);
}

/** The cover the student has picked: their own tap first, then the server's choice, then its default. */
export function pickedCover(pending: RescueCoverChoice | null, cover: { choice: RescueCoverChoice | null; defaultChoice: RescueCoverChoice }): RescueCoverChoice {
  return pending ?? cover.choice ?? cover.defaultChoice;
}

// ── The cover's fields ───────────────────────────────────────────────────────

export type CoverRowId =
  | "title" | "students" | "supervisor" | "year"
  | "university" | "faculty" | "department" | "degree" | "specialty" | "subtitle" | "field" | "coSupervisor" | "jury";

interface CoverRow { id: CoverRowId; field: keyof RescueCoverFieldsDTO; kind: "text" | "list" | "jury" }

/** The rows always on screen 12. */
export const COVER_PRIMARY_ROWS: CoverRow[] = [
  { id: "title", field: "title", kind: "text" },
  { id: "students", field: "students", kind: "list" },
  { id: "supervisor", field: "supervisor", kind: "text" },
  { id: "year", field: "academicYear", kind: "text" },
];
/** The rows the More section holds: the generated cover prints them, so the student must see and correct them. */
export const COVER_MORE_ROWS: CoverRow[] = [
  { id: "university", field: "university", kind: "text" },
  { id: "faculty", field: "faculty", kind: "text" },
  { id: "department", field: "department", kind: "text" },
  { id: "degree", field: "degree", kind: "text" },
  { id: "specialty", field: "specialty", kind: "text" },
  { id: "subtitle", field: "subtitle", kind: "text" },
  { id: "field", field: "field", kind: "text" },
  { id: "coSupervisor", field: "coSupervisor", kind: "text" },
];
/**
 * Not on screen and never sent. The server drops `fields.jury` (the cover's jury is not printed yet), so these rows wait for it; their
 * words stay in the locales for later.
 */
export const COVER_HIDDEN_ROWS: CoverRow[] = [{ id: "jury", field: "jury", kind: "jury" }];

export function coverRow(id: CoverRowId): CoverRow {
  const row = [...COVER_PRIMARY_ROWS, ...COVER_MORE_ROWS, ...COVER_HIDDEN_ROWS].find((r) => r.id === id);
  if (!row) throw new Error(`unknown cover row ${id}`);
  return row;
}

/** The word key of a row's label. */
export function coverLabelKey(id: CoverRowId): string {
  return `rescueV2.cover.field${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Whether a row holds anything the student or a source gave it. */
export function coverRowHasValue(fields: RescueCoverFieldsDTO, id: CoverRowId): boolean {
  const v = fields[coverRow(id).field];
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Whether the More section is open. The student's own tap wins. Otherwise it opens by itself under the generated cover when one of its extra
 * rows holds a value, since that cover prints them.
 */
export function coverMoreOpen(manual: boolean | null, choice: RescueCoverChoice, fields: RescueCoverFieldsDTO): boolean {
  if (manual !== null) return manual;
  return choice === "generated" && COVER_MORE_ROWS.some((r) => coverRowHasValue(fields, r.id));
}

/** The tag under a value from the student's profile or the university list; nothing for a value from the file or the student. */
export function coverSourceWord(source: string | undefined): string | null {
  if (source === "profile") return "rescueV2.cover.fromProfile";
  if (source === "catalogue") return "rescueV2.cover.fromCatalogue";
  return null;
}

/** The row for the first field a cover still needs, or null when the server named a field this screen does not show. */
export function missingRow(missing: string[]): CoverRowId | null {
  for (const key of missing) {
    const row = [...COVER_PRIMARY_ROWS, ...COVER_MORE_ROWS].find((r) => r.field === key);
    if (row) return row.id;
  }
  return null;
}

export type JuryDraft = { name: string; rank: string };

/**
 * The whole fields object with one row replaced. A text row is trimmed and removed when empty; a list drops its empty items; the jury keeps
 * only the members with a name. A row that ends up empty is removed, so the server never gets a blank value it would print.
 */
export function coverFieldsAfter(
  fields: RescueCoverFieldsDTO,
  id: CoverRowId,
  value: string | string[] | JuryDraft[],
): RescueCoverFieldsDTO {
  const row = coverRow(id);
  const next: Record<string, unknown> = { ...fields };
  if (row.kind === "text") {
    const s = typeof value === "string" ? value.trim() : "";
    if (s) next[row.field] = s;
    else delete next[row.field];
  } else if (row.kind === "list") {
    const items = (Array.isArray(value) ? (value as string[]) : []).map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length) next[row.field] = items;
    else delete next[row.field];
  } else {
    const members = (Array.isArray(value) ? (value as JuryDraft[]) : [])
      .map((m) => ({ name: m.name.trim(), rank: m.rank.trim() }))
      .filter((m) => m.name.length > 0)
      .map((m) => (m.rank ? { name: m.name, rank: m.rank } : { name: m.name }));
    if (members.length) next[row.field] = members;
    else delete next[row.field];
  }
  // The server drops the jury, so it is never sent back, even when the fields the screen holds carry one from the file.
  delete next.jury;
  return next as RescueCoverFieldsDTO;
}
