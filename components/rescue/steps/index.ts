import type React from "react";
import type { RescueScreen } from "@/lib/rescue-v2-screen";
import { StartStep } from "./StartStep";
import { PartsStep } from "./PartsStep";
import { ReadingStep } from "./ReadingStep";
import { WhichRulesStep } from "./WhichRulesStep";
import { NotesStep } from "./NotesStep";
import { UnderstoodStep } from "./UnderstoodStep";
import { DiagnosisStep } from "./DiagnosisStep";
import { PreviewStep } from "./PreviewStep";
import { PaymentStep } from "./PaymentStep";
import { RulesStep } from "./RulesStep";
import { QuestionStep } from "./QuestionStep";
import { CoverStep } from "./CoverStep";
import { RepairingStep } from "./RepairingStep";
import { ResultStep } from "./ResultStep";
import { ChangedStep } from "./ChangedStep";
import { RevisionsStep } from "./RevisionsStep";
import { TimelineStep } from "./TimelineStep";
import { VersionStep } from "./VersionStep";
import { CompareStep } from "./CompareStep";
import { EditRerunStep } from "./EditRerunStep";

export interface RescueStep {
  /** The top half. */
  Stage: React.ComponentType;
  /** The sheet's content. */
  Sheet: React.ComponentType;
  /** Pinned at the sheet's foot (the CTA), null for none. */
  Foot?: React.ComponentType | null;
  /** The sheet's content scrolls (long lists). */
  scrollable?: boolean;
  /** The content handles its own drags (screen 2's reorderable list): gorhom's content pan stays off and it brings its own scrolling. */
  ownsGestures?: boolean;
}

export const RESCUE_STEPS: Record<Exclude<RescueScreen, "failure">, RescueStep> = {
  start: StartStep, parts: PartsStep, reading: ReadingStep, rules_choice: WhichRulesStep, notes: NotesStep,
  understood: UnderstoodStep, diagnosis: DiagnosisStep, preview: PreviewStep, payment: PaymentStep,
  rules: RulesStep, question: QuestionStep, cover: CoverStep, repairing: RepairingStep, result: ResultStep,
  changed: ChangedStep, revisions: RevisionsStep, timeline: TimelineStep, version: VersionStep,
  compare: CompareStep, edit_rerun: EditRerunStep,
};
