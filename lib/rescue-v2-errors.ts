/**
 * The word the one error line shows for a machine code, where a step has one. The keys are relative to `rescueV2.`. `null` means the
 * generic `common.somethingWrong`. A code with no word here is never shown raw.
 */
export interface ErrorWord {
  key: string;
  params?: { mb: number };
}

export function errorWord(code: string | null, partMb: number | null): ErrorWord | null {
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
    default: return null;
  }
}

/**
 * Codes a repeat of the same call cannot clear: the student is at a limit, the file is too big, the feature is off, or a rescue is already
 * running. The error line shows its word with no Retry, so a student is not invited into a loop. Close and back still work.
 */
const NO_RETRY = new Set(["rescue_daily_limit", "rescue_too_large", "rescue_disabled", "rescue_one_in_progress"]);

export function canRetry(code: string | null): boolean {
  return code === null || !NO_RETRY.has(code);
}
