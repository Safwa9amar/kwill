import { describe, expect, it } from "vitest";
import { normalizeProfileLanguage, profileLanguageToWrite } from "./profile-language";

describe("profileLanguageToWrite", () => {
  it("writes the UI language when the profile says something else, or nothing", () => {
    expect(profileLanguageToWrite("ar", "fr")).toBe("ar");
    expect(profileLanguageToWrite("en", null)).toBe("en");
    expect(profileLanguageToWrite("fr", undefined)).toBe("fr");
  });
  it("writes nothing when the profile already agrees", () => {
    expect(profileLanguageToWrite("ar", "ar")).toBeNull();
    expect(profileLanguageToWrite("fr", "fr")).toBeNull();
  });
  it("only ever writes ar / fr / en, normalised", () => {
    expect(profileLanguageToWrite("ar-DZ", "fr")).toBe("ar");
    expect(profileLanguageToWrite("es", "fr")).toBeNull();
    expect(profileLanguageToWrite("", "fr")).toBeNull();
    expect(profileLanguageToWrite(null, "fr")).toBeNull();
  });
  it("tidies a profile holding a regional or cased form of the same language", () => {
    expect(profileLanguageToWrite("ar", "ar-DZ")).toBe("ar");
    expect(profileLanguageToWrite("fr", "FR")).toBe("fr");
  });
});

describe("normalizeProfileLanguage", () => {
  it("maps locale tags onto the three languages", () => {
    expect(normalizeProfileLanguage("fr_FR")).toBe("fr");
    expect(normalizeProfileLanguage("EN-us")).toBe("en");
    expect(normalizeProfileLanguage("kab")).toBeNull();
  });
});
