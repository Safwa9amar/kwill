import { describe, expect, it } from "vitest";
import { canRetry, errorWord, shellShows } from "./rescue-v2-errors";

describe("errorWord", () => {
  it("names the Start screen's own word for each code the upload path returns", () => {
    expect(errorWord("not_docx", 50)).toEqual({ key: "start.notDocx" });
    expect(errorWord("rescue_daily_limit", 50)).toEqual({ key: "start.dailyLimit" });
    expect(errorWord("rescue_busy", 50)).toEqual({ key: "start.busy" });
    expect(errorWord("rescue_one_in_progress", 50)).toEqual({ key: "start.inProgress" });
    expect(errorWord("upload_stalled", 50)).toEqual({ key: "reading.uploadLost" });
    expect(errorWord("rescue_disabled", 50)).toEqual({ key: "unavailable" });
  });

  it("gives the size word the part limit", () => {
    expect(errorWord("rescue_too_large", 50)).toEqual({ key: "start.tooLarge", params: { mb: 50 } });
  });

  it("has no size word until the limits are read", () => {
    expect(errorWord("rescue_too_large", null)).toBeNull();
  });

  it("words the screen-level codes the notes step can meet", () => {
    expect(errorWord("note_parsing", 50)).toEqual({ key: "notes.parsing" });
    expect(errorWord("guide_reading", 50)).toEqual({ key: "notes.waitGuide" });
    expect(errorWord("note_conflict", 50)).toEqual({ key: "notes.pickOne" });
  });

  it("returns null for a code with no word of its own, and for no code", () => {
    expect(errorWord("network", 50)).toBeNull();
    expect(errorWord("server_unavailable", 50)).toBeNull();
    expect(errorWord(null, 50)).toBeNull();
  });
});

describe("canRetry", () => {
  it("offers no Retry for the codes a retry cannot change", () => {
    for (const code of ["rescue_daily_limit", "rescue_too_large", "rescue_disabled", "rescue_one_in_progress"]) {
      expect(canRetry(code), code).toBe(false);
    }
  });

  it("offers Retry for a code a later try can clear, and for a failure with no code", () => {
    for (const code of ["rescue_busy", "upload_stalled", "note_parsing", "note_conflict", "guide_reading", "network", "server_unavailable"]) {
      expect(canRetry(code), code).toBe(true);
    }
    expect(canRetry(null)).toBe(true);
  });
});

describe("shellShows", () => {
  it("leaves the codes a screen draws itself to that screen", () => {
    expect(shellShows("rule_out_of_range")).toBe(false);
    expect(shellShows("cover_fields_missing")).toBe(false);
  });

  it("shows the shell line for any other code, and none when there is no code", () => {
    expect(shellShows("rescue_daily_limit")).toBe(true);
    expect(shellShows("network")).toBe(true);
    expect(shellShows(null)).toBe(false);
  });
});
