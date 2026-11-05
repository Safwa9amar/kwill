/**
 * The word the one error line shows for a machine code, where a step has one. The keys are relative to `rescueV2.`. `null` means the
 * generic `common.somethingWrong`. A code with no word here is never shown raw.
 */
export interface ErrorWord {
  key: string;
  params?: { mb: number };
}

/**
 * Codes a student can meet, each worded under `rescueV2.codes.<code>` in ar, fr and en. The shell's line shows these; a screen that draws a
 * code itself (see SCREEN_OWNED) still has its own line.
 */
export const STUDENT_CODES = [
  "rescue_included_by_plan", "rescue_guide_type", "rescue_guide_pages", "rescue_note_too_long", "rescue_note_limit",
  "rescue_guide_limit", "rescue_samples_limit", "rescue_storage_full", "rescue_locked", "rescue_run_active", "rescue_wrong_stage",
  "rescue_questions_open", "rescue_cannot_restore_original", "rescue_no_file", "rescue_empty", "rescue_entitled",
  "rescue_has_thesis", "rescue_payment_pending", "rescue_allowance_used", "rescue_payment_required", "rescue_not_entitled",
] as const;

/**
 * Codes a student should not meet: a client built a request the server cannot take, or the screen asked for a step that does not exist
 * for this thesis. They get the generic line (`common.somethingWrong`), never a raw code. The server's `rescue_*` codes are the same list
 * on both sides, so a new one defaults to the generic line too.
 */
export const DEVELOPER_CODES = [
  "rule_unknown_field", "rules_invalid", "length_required", "rescue_invalid_role", "rescue_unknown_question",
  "rescue_invalid_order", "rescue_cover_choice", "rescue_not_done",
] as const;

export function errorWord(code: string | null, partMb: number | null): ErrorWord | null {
  if (code !== null && (STUDENT_CODES as readonly string[]).includes(code)) return { key: `codes.${code}` };
  switch (code) {
    case "not_docx": return { key: "start.notDocx" };
    case "rescue_too_large": return partMb === null ? null : { key: "start.tooLarge", params: { mb: partMb } };
    case "rescue_daily_limit": return { key: "start.dailyLimit" };
    case "rescue_busy": return { key: "start.busy" };
    case "rescue_one_in_progress": return { key: "start.inProgress" };
    case "upload_stalled": return { key: "reading.uploadLost" };
    case "rescue_disabled": return { key: "unavailable" };
    case "note_parsing": return { key: "notes.parsing" };
    case "guide_reading": return { key: "notes.waitGuide" };
    case "note_conflict": return { key: "notes.pickOne" };
    case "edits_not_saved": return { key: "revisions.editsNotSaved" };
    default: return null;
  }
}

/**
 * Codes a repeat of the same call cannot clear: the student is at a limit, the file is too big, the feature is off, or a rescue is already
 * running. The error line shows its word with no Retry, so a student is not invited into a loop. Close and back still work.
 */
const NO_RETRY = new Set([
  "rescue_daily_limit", "rescue_too_large", "rescue_disabled", "rescue_one_in_progress",
  // The Revisions screen words these itself (`revisions.expired`, `revisions.dailyCap`): a repeat changes nothing.
  "rescue_rerun_expired", "rescue_rerun_daily_cap",
  // A file the student must replace, a daily cap, a limit already reached, or a state a repeat cannot move: the word says what to do.
  "rescue_guide_type", "rescue_guide_pages", "rescue_note_too_long", "rescue_note_limit", "rescue_guide_limit", "rescue_samples_limit",
  "rescue_storage_full", "rescue_run_active", "rescue_wrong_stage", "rescue_questions_open", "rescue_cannot_restore_original",
  "rescue_empty", "rescue_no_file", "rescue_entitled", "rescue_has_thesis", "rescue_allowance_used", "rescue_payment_required",
  "rescue_not_entitled",
]);

export function canRetry(code: string | null): boolean {
  return code === null || !NO_RETRY.has(code);
}

/**
 * Codes a screen draws beside its own field or card (the rules' out-of-range line, the cover's missing fields). The shell line never repeats
 * them, so the same failure is not shown twice.
 */
const SCREEN_OWNED = new Set([
  "rule_out_of_range", "cover_fields_missing",
  // A 402 from Continue opens the payment sheet, which words it (paymentNoteKey); the shell never shows it.
  "rescue_payment_required",
  // Worded by the Revisions screen itself.
  "rescue_rerun_expired", "rescue_rerun_daily_cap",
]);

/** True when the shell's one error line should show this code: there is a code, and no screen draws it itself. */
export function shellShows(code: string | null): boolean {
  return code !== null && !SCREEN_OWNED.has(code);
}
