import type {
  RescueFailureDTO,
  RescuePartDTO,
  RescuePhase,
  RescueProjectDTO,
  RescueRuleFieldDTO,
  RescueVersionSummaryDTO,
} from "@/types/rescue-v2";

/**
 * DEV ONLY. One believable project per phase so every Rescue v2 screen can be built and walked before the server exists (Task A1, Step 11).
 * Every name, number and sentence here is invented. Task A11 deletes this file and the `?fixture=` branch in the store.
 */

const NOW = "2026-11-04T09:00:00.000Z";
const V0 = "fixture-version-0";
const V1 = "fixture-version-1";

const setupEmpty: RescueProjectDTO["setup"] = {
  universityId: null, universityName: null, normProfileId: null, fromProfile: false, profileOffer: null,
  guide: { state: "none", filename: null },
};

const summary: NonNullable<RescueProjectDTO["summary"]> = {
  pages: 48, chapters: 4, figures: 3, tables: 2, equations: 0, footnotes: 5, hasCover: true, format: "classic", language: "fr",
};

const part = (index: number, uploaded: boolean, role: RescuePartDTO["role"], order: number): RescuePartDTO => ({
  index,
  filename: `partie-${index + 1}.docx`,
  sizeBytes: 3_400_000 + index * 250_000,
  uploaded,
  role,
  continuesPrevious: false,
  order,
  openingText: "Texte inventé pour l'aperçu de cette partie.",
});

const v0Summary: RescueVersionSummaryDTO = {
  id: V0, n: 0, kind: "original", trigger: "first_diagnosis", triggerN: null, status: "done",
  createdAt: NOW, finishedAt: NOW, pages: 48, fixes: 0, changedPages: null, published: false,
  editedBefore: false, changedBlocks: null, pack: null,
};

const v1Summary: RescueVersionSummaryDTO = {
  id: V1, n: 1, kind: "rescue", trigger: "first_rescue", triggerN: null, status: "done",
  createdAt: NOW, finishedAt: NOW, pages: 48, fixes: 14, changedPages: null, published: true,
  editedBefore: false, changedBlocks: null,
  pack: { state: "ready", files: ["thesis-pdf", "thesis-docx", "abstract-sheet", "integrity-declaration"], omitted: [] },
};

const rule = (id: RescueRuleFieldDTO["id"], row: RescueRuleFieldDTO["row"], kind: RescueRuleFieldDTO["kind"], value: RescueRuleFieldDTO["value"], extra: Partial<RescueRuleFieldDTO> = {}): RescueRuleFieldDTO =>
  ({ id, row, kind, value, source: "default", ...extra });

const rulesFields: RescueRuleFieldDTO[] = [
  rule("bodyFont", "font", "enum", "Times New Roman", { options: ["Times New Roman", "Arial", "Simplified Arabic"] }),
  rule("bodySize", "font", "number", 12, { min: 10, max: 14, step: 1 }),
  rule("lineSpacing", "spacing", "number", 1.5, { min: 1, max: 2, step: 0.5 }),
  rule("marginTop", "margins", "number", 2.5, { min: 1, max: 4, step: 0.5 }),
  rule("captionNumbers", "additions", "switch", true),
  rule("pagePosition", "numbering", "enum", "bottom-center", { options: ["bottom-center", "top-right"] }),
];

const base: RescueProjectDTO = {
  id: "fixture-project",
  title: "Titre fictif de mémoire",
  thesisId: null,
  language: "fr",
  phase: "uploading",
  waiting: null,
  progress: null,
  activeVersionId: V0,
  originalVersionId: V0,
  currentVersion: null,
  parts: [],
  setup: setupEmpty,
  note: { text: "", count: 0, state: "none", chips: [], conflicts: [], refused: [] },
  summary: null,
  diagnosis: null,
  previewReady: false,
  entitlement: {
    kind: null, includedByPlan: false, forSale: true, priceDzd: 1500,
    purchase: { state: "none", rejectReason: null }, rerunFreeUntil: null,
  },
  rules: null,
  questions: [],
  cover: null,
  failure: null,
  editedInKwill: false,
  resumeOnOpen: false,
  updatedAt: NOW,
};

const paid: RescueProjectDTO["entitlement"] = {
  ...base.entitlement, kind: "purchase", purchase: { state: "paid", rejectReason: null },
  rerunFreeUntil: "2027-11-04T09:00:00.000Z",
};

const diagnosis: NonNullable<RescueProjectDTO["diagnosis"]> = {
  total: 14,
  chips: [{ key: "headings", count: 4 }, { key: "text", count: 3 }, { key: "numbering", count: 7 }],
  dots: [
    { n: 1, chip: "headings", code: "heading-style", page: 3, topPct: 0.2, params: {} },
    { n: 2, chip: "text", code: "margins", page: 7, topPct: 0.5, params: {} },
  ],
  studentItems: [{ code: "section-missing", section: "conclusion", pages: [] }],
  captionNumbersToAdd: 3,
  outline: null,
};

const fixture = (phase: RescuePhase, over: Partial<RescueProjectDTO> = {}): RescueProjectDTO => ({ ...base, phase, ...over });

const failureOn = (code: RescueFailureDTO["code"], over: Partial<RescueFailureDTO> = {}): RescueFailureDTO => ({
  versionId: V1, code, page: 12, refund: "due", previousVersionN: 0, reviewable: false, reviewRequested: false, ...over,
});

export const RESCUE_FIXTURES: Record<RescuePhase, RescueProjectDTO> = {
  uploading: fixture("uploading", {
    parts: [part(0, true, null, 0), part(1, false, null, 1)],
    progress: { track: "reading", step: 1, of: 4, stepKey: "upload", pagesReady: 0, pagesTotal: 0, etaSeconds: null },
  }),
  proposing_order: fixture("proposing_order", {
    parts: [part(0, true, "introduction", 0), part(1, true, "chapter", 1)],
    waiting: "brain",
  }),
  await_part_order: fixture("await_part_order", {
    parts: [part(0, true, "front-matter", 0), part(1, true, "introduction", 1), part(2, true, "chapter", 2)],
  }),
  reading: fixture("reading", {
    parts: [],
    progress: { track: "reading", step: 2, of: 4, stepKey: "read", pagesReady: 12, pagesTotal: 48, etaSeconds: 120 },
  }),
  await_setup: fixture("await_setup", { summary, setup: { ...setupEmpty, universityName: "Université fictive" } }),
  understanding: fixture("understanding", {
    summary,
    waiting: "brain",
    progress: { track: "reading", step: 3, of: 4, stepKey: "understand", pagesReady: 48, pagesTotal: 48, etaSeconds: null },
  }),
  diagnosing: fixture("diagnosing", {
    summary,
    progress: { track: "reading", step: 3, of: 4, stepKey: "compare", pagesReady: 48, pagesTotal: 48, etaSeconds: 90 },
  }),
  diagnosed: fixture("diagnosed", { summary, diagnosis, previewReady: true, currentVersion: v0Summary }),
  confirm_rules: fixture("confirm_rules", {
    summary, diagnosis, previewReady: true, currentVersion: v0Summary, entitlement: paid,
    rules: { fields: rulesFields, fromGuide: false, confirmedAt: null },
  }),
  confirm_questions: fixture("confirm_questions", {
    summary, diagnosis, previewReady: true, currentVersion: v0Summary, entitlement: paid,
    rules: { fields: rulesFields, fromGuide: false, confirmedAt: NOW },
    questions: [{
      key: "fixture-question-1",
      text: "Ce passage est-il une citation ?",
      excerpt: "Extrait inventé d'un paragraphe à classer.",
      page: 14, topPct: 0.4,
      options: [{ label: "Citation", role: "quote" }, { label: "Texte courant", role: "body" }],
      answer: null,
    }],
  }),
  confirm_cover: fixture("confirm_cover", {
    summary, diagnosis, previewReady: true, currentVersion: v0Summary, entitlement: paid,
    rules: { fields: rulesFields, fromGuide: false, confirmedAt: NOW },
    cover: {
      hasCover: true,
      allowedChoices: ["clean", "generated"],
      defaultChoice: "clean",
      choice: null,
      fields: { university: "Université fictive", title: "Titre fictif de mémoire", students: ["Étudiant fictif"] },
      fieldSources: { university: "cover", title: "cover", students: "cover" },
      missing: [],
      samples: "none",
    },
  }),
  repairing: fixture("repairing", {
    summary, diagnosis, currentVersion: v0Summary, entitlement: paid, activeVersionId: V1,
    progress: { track: "repairing", step: 3, of: 8, stepKey: "styles", pagesReady: 0, pagesTotal: 48, etaSeconds: 300 },
  }),
  done: fixture("done", {
    thesisId: "fixture-thesis", summary, diagnosis, currentVersion: v1Summary, entitlement: paid,
    activeVersionId: V1, previewReady: true, resumeOnOpen: false,
  }),
  failed: fixture("failed", {
    summary, diagnosis, currentVersion: { ...v1Summary, status: "failed", published: false, pack: null },
    entitlement: paid, activeVersionId: V1, failure: failureOn("word_refused"),
  }),
};
