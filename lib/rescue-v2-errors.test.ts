import { describe, expect, it } from "vitest";
import { errorWord } from "./rescue-v2-errors";

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
