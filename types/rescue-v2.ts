export const RESCUE_STAGES = [
  "await_upload", "propose_order", "await_part_order", "merge", "read", "await_setup",
  "map", "diagnose", "ask", "read_cover", "preview",
  "source", "map_changed", "ask_changed", "await_answers",
  "reset", "regenerate", "render", "review", "review_render", "prove", "deposit", "publish",
  "done",
] as const;
export type RescueStage = (typeof RESCUE_STAGES)[number];
export type RescueLane = "heavy" | "brain";
export type RescueJobKind = "pipeline" | "read_guide" | "parse_note" | "cover_samples";
export type RescueVersionKind = "original" | "rescue" | "rerun" | "restore";
export type RescueVersionStatus = "running" | "waiting_student" | "done" | "failed";
export type RescueTrigger =
  | "first_diagnosis" | "first_rescue" | "rules_edited" | "supervisor_note"
  | "new_file" | "edited_in_kwill" | "restored" | "staff_retry" | "pack_rebuilt";
export type RescueFailureCode =
  | "not_docx" | "word_refused" | "merge_refused" | "regenerate_failed" | "prove_failed"
  | "stage_crashed" | "brain_failed" | "converter_unavailable" | "not_same_thesis" | "too_big";

export type RescuePhase =
  | "uploading" | "proposing_order" | "await_part_order" | "reading" | "await_setup"
  | "understanding" | "diagnosing" | "diagnosed"
  | "confirm_rules" | "confirm_questions" | "confirm_cover"
  | "repairing" | "done" | "failed";

export type RescueStepKey =
  | "upload" | "read" | "understand" | "compare"
  | "prepare" | "styles" | "typography" | "sections" | "cover" | "toc" | "captions" | "check";

export interface RescueProgressDTO {
  track: "reading" | "repairing";
  /** 1-based. On "repairing", 1..8. */
  step: number;
  of: number;
  stepKey: RescueStepKey;
  pagesReady: number;
  pagesTotal: number;
  /** null while waiting on the brain or on Word: never a made-up number. */
  etaSeconds: number | null;
}

export interface RescueConfigDTO {
  enabled: boolean;
  forSale: boolean;
  priceDzd: number | null;
  paymentsEnabled: boolean;
  manualEnabled: boolean;
  limits: { partMb: number; parts: number; totalMb: number; guideMb: number };
}

export interface RescuePartDTO {
  index: number;
  filename: string;
  sizeBytes: number;
  uploaded: boolean;
  role: "cover" | "front-matter" | "introduction" | "chapter" | "conclusion" | "bibliography" | "annex" | "other" | null;
  continuesPrevious: boolean;
  /** Position in the proposed or confirmed order, 0-based. `parts` always arrives sorted by it (once an order exists), so screen 2 shows the proposal. */
  order: number;
  /** The part's own first lines, for the mini page on screen 2. */
  openingText: string;
}

export interface RescueNoteChipDTO {
  id: string;
  label: string;
  kind: "rule" | "hint";
  /** kind "rule" only. */
  ruleField?: RescueRuleFieldId;
  value?: string | number | boolean;
}
export interface RescueNoteConflictDTO {
  id: string;
  fieldId: RescueRuleFieldId;
  noteValue: string | number | boolean;
  guideValue: string | number | boolean;
  choice: "note" | "guide" | null;
}
export interface RescueNoteDTO {
  /** The newest note's text. */
  text: string;
  /** How many notes are saved, for H5. */
  count: number;
  state: "none" | "parsing" | "ready" | "failed";
  chips: RescueNoteChipDTO[];
  conflicts: RescueNoteConflictDTO[];
  refused: { label: string; reason: "changes-words" | "skips-checks" | "breaks-deposit" | "not-supported" }[];
}

export interface RescueSetupDTO {
  universityId: string | null;
  universityName: string | null;
  normProfileId: string | null;
  /** True when the university came from the student's profile. */
  fromProfile: boolean;
  /** P-70: a faculty-specific profile of this university, offered as a question; null when none, or when a generic one was applied by itself. */
  profileOffer: { id: string; name: string } | null;
  guide: { state: "none" | "reading" | "read" | "failed"; filename: string | null };
}

export interface RescueSummaryDTO {
  pages: number;
  chapters: number;
  figures: number;
  tables: number;
  equations: number;
  footnotes: number;
  hasCover: boolean;
  format: "classic" | "imrad" | "1275";
  language: "ar" | "fr" | "en";
}

export type RescueChipKey = "headings" | "cover" | "toc" | "numbering" | "figures" | "text" | "structure";
export interface RescueDotDTO {
  n: number;
  chip: RescueChipKey;
  /** A Diagnose code with any ":id" removed: "margins", "section-missing". */
  code: string;
  page: number;
  /** 0..1 from the top of the page. */
  topPct: number;
  params: Record<string, string | number>;
}
export interface RescueDiagnosisDTO {
  total: number;
  chips: { key: RescueChipKey; count: number }[];
  dots: RescueDotDTO[];
  /**
   * Things only the student can fill in, such as an empty conclusion. Said kindly, never counted in `total`.
   * `section` null: the item is about a place (a figure with no caption), worded from `diagnosis.problems.<code>`.
   */
  studentItems: { code: string; section: string | null; pages: number[] }[];
  /** Captions left unnumbered that D-22 will number. Shown beside the switch on the rules screen. */
  captionNumbersToAdd: number;
  /** Soft outlines on one page for screen 6. */
  outline: { page: number; bands: { topPct: number; heightPct: number; role: string }[] } | null;
}

export type RescueRuleFieldId =
  | "bodyFont" | "bodySize" | "secondFont" | "secondSize" | "alignment" | "lineSpacing"
  | "h1Size" | "h2Size" | "h3Size" | "headingBold"
  | "marginTop" | "marginBottom" | "marginBinding" | "marginOpposite" | "bindingSide"
  | "frontMatter" | "pagePosition" | "noNumberDedication" | "noNumberThanks" | "footnoteSize" | "deposit"
  | "captionNumbers" | "dividers" | "frames" | "referencesSort" | "keepTables";
export type RescueRuleRowId = "font" | "headings" | "spacing" | "margins" | "numbering" | "footnotes" | "deposit" | "additions";
export interface RescueRuleFieldDTO {
  id: RescueRuleFieldId;
  row: RescueRuleRowId;
  kind: "enum" | "number" | "switch";
  value: string | number | boolean;
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  source: "default" | "catalogue" | "guide" | "note" | "student";
}
export interface RescueRulesDTO {
  fields: RescueRuleFieldDTO[];
  fromGuide: boolean;
  confirmedAt: string | null;
}

export interface RescueQuestionDTO {
  /** A content hash. Never shown. */
  key: string;
  text: string;
  excerpt: string;
  /** null on a re-run: a new block has no page yet (P-29). The app shows the excerpt on a blank paper. */
  page: number | null;
  topPct: number | null;
  options: { label: string; role: string }[];
  answer: { role: string } | { decide: true } | null;
}

export type RescueCoverChoice = "keep" | "clean" | "generated";
export interface RescueCoverFieldsDTO {
  university?: string; faculty?: string; department?: string;
  degree?: string; field?: string; specialty?: string;
  title?: string; subtitle?: string;
  students?: string[]; supervisor?: string; coSupervisor?: string;
  jury?: { name: string; rank?: string; role?: string }[];
  academicYear?: string;
}
export interface RescueCoverDTO {
  hasCover: boolean;
  allowedChoices: RescueCoverChoice[];
  defaultChoice: RescueCoverChoice;
  choice: RescueCoverChoice | null;
  fields: RescueCoverFieldsDTO;
  fieldSources: Record<string, "cover" | "thanks" | "catalogue" | "profile" | "student">;
  /** Fields the chosen cover cannot do without, still empty. */
  missing: string[];
  samples: "none" | "rendering" | "ready" | "failed";
}

export interface RescueEntitlementDTO {
  kind: "purchase" | "subscription" | "staff" | null;
  /** True when the student's current plan includes the rescue: screen 9 is skipped. */
  includedByPlan: boolean;
  forSale: boolean;
  priceDzd: number | null;
  purchase: {
    state: "none" | "pending_card" | "pending_manual" | "rejected_manual" | "paid" | "refund_due" | "refunded";
    rejectReason: string | null;
  };
  rerunFreeUntil: string | null;
}

export interface RescueFailureDTO {
  versionId: string;
  code: RescueFailureCode;
  /** The page a Prove check pointed at, when it could. */
  page: number | null;
  /** What happens to the money. */
  refund: "none" | "due" | "done";
  /** Newest version still good, null when none. */
  previousVersionN: number | null;
  /** not_same_thesis: a person can look at it (P-57). */
  reviewable: boolean;
  reviewRequested: boolean;
}

/** What a version's deposit pack holds. Screen 15 builds its line from this, never from fixed words. */
export interface RescuePackDTO {
  /** partial: something a rebuild could add is left out. missing: no pack at all (P-48). */
  state: "ready" | "partial" | "missing";
  /** Kinds in the zip, in pack order: thesis-pdf, thesis-docx, abstract-sheet, integrity-declaration, deposit-authorisation, cd-note. */
  files: string[];
  /**
   * Left out and worth saying: the rules' own choices (pdf-only, not-required) never appear here. `kind: "zip"` with
   * `reason: "zip-too-large"` means the whole pack's zip was not built (P-64): every file still ships by itself, and no rebuild is offered.
   */
  omitted: { kind: string; reason: "no-abstracts" | "render-failed" | "missing" | "zip-too-large" }[];
}

export interface RescueVersionSummaryDTO {
  id: string;
  n: number;
  kind: RescueVersionKind;
  trigger: RescueTrigger;
  /** For "restored": which version came back. */
  triggerN: number | null;
  status: RescueVersionStatus;
  createdAt: string;
  finishedAt: string | null;
  pages: number;
  fixes: number;
  changedPages: number | null;
  published: boolean;
  /** The student edited in Kwill between the parent version and this one: a grey step under it on the timeline. */
  editedBefore: boolean;
  /** Blocks that differed from the parent when this version read its source. */
  changedBlocks: number | null;
  /** null on the original and while the version runs. */
  pack: RescuePackDTO | null;
}

export type RescueChangeGroup = "cover" | "toc" | "headings" | "captions" | "numbering" | "pages" | "references" | "notes" | "fonts" | "typography" | "other";
export interface RescueChangeItemDTO {
  page: number | null;
  code: string;
  count: number;
  params: Record<string, string | number>;
}
export interface RescueChangeReportDTO {
  total: number;
  groups: { key: RescueChangeGroup; count: number; items: RescueChangeItemDTO[] }[];
}

export interface RescueVersionDetailDTO extends RescueVersionSummaryDTO {
  changes: RescueChangeReportDTO | null;
  deposit: { files: { kind: string; name: string; sizeBytes: number }[]; omitted: { kind: string; reason: string }[] } | null;
  settings: { coverChoice: RescueCoverChoice | null; notes: number; answers: number };
}

export interface RescueProjectDTO {
  id: string;
  title: string;
  thesisId: string | null;
  language: "ar" | "fr" | "en" | null;
  phase: RescuePhase;
  waiting: "converter" | "brain" | null;
  progress: RescueProgressDTO | null;
  /** The version a job works on now, v0 during the free stages. */
  activeVersionId: string | null;
  originalVersionId: string;
  currentVersion: RescueVersionSummaryDTO | null;
  parts: RescuePartDTO[];
  setup: RescueSetupDTO;
  note: RescueNoteDTO;
  summary: RescueSummaryDTO | null;
  diagnosis: RescueDiagnosisDTO | null;
  previewReady: boolean;
  entitlement: RescueEntitlementDTO;
  rules: RescueRulesDTO | null;
  questions: RescueQuestionDTO[];
  cover: RescueCoverDTO | null;
  failure: RescueFailureDTO | null;
  editedInKwill: boolean;
  /** Cold start navigates here only when true (P-35). */
  resumeOnOpen: boolean;
  updatedAt: string;
}

export interface RescueProjectSummaryDTO {
  id: string;
  title: string;
  /** False for an entitled project with no thesis yet: paid money is never deleted silently (P-65). */
  canDelete: boolean;
  thesisId: string | null;
  phase: RescuePhase;
  currentVersionN: number | null;
  currentVersionAt: string | null;
  coverPageVersionId: string | null;
  resumeOnOpen: boolean;
  updatedAt: string;
}

export interface RescueImpactDTO {
  /** none: nothing to redo, the CTA is off. pack: only the deposit pack (P-48). note: a new note with no rule in it. */
  scope: "none" | "pack" | "note" | "pages" | "all";
  pages: number[];
  toc: boolean;
  nextN: number;
  /** Blocks edited in Kwill since the last version; null when not measured. */
  changedBlocks: number | null;
}
