// The server reads `profiles.language` to write to a student it cannot see: a
// Support thread opened for a failed rescue, a push. The app never told it, so an
// Arabic-UI student got French failure messages (11-08). The UI language is the
// truth (what is on screen); this decides whether the profile needs to catch up.
//
// Pure — no React Native — so vitest can run it.

export const PROFILE_LANGUAGES = ["ar", "fr", "en"] as const;
export type ProfileLanguage = (typeof PROFILE_LANGUAGES)[number];

/** `ar-DZ`, `AR`, `fr_FR` → `ar` / `fr`; anything we do not speak → null. */
export function normalizeProfileLanguage(code: string | null | undefined): ProfileLanguage | null {
  if (!code) return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return (PROFILE_LANGUAGES as readonly string[]).includes(base) ? (base as ProfileLanguage) : null;
}

/**
 * The value to write to `profiles.language`, or null when nothing should be
 * written: the UI language is not one of ours, or the profile already says it.
 */
export function profileLanguageToWrite(
  uiLanguage: string | null | undefined,
  profileLanguage: string | null | undefined,
): ProfileLanguage | null {
  const ui = normalizeProfileLanguage(uiLanguage);
  if (!ui) return null;
  // Exact match, so a stored `ar-DZ` or `FR` is tidied to what the server compares.
  return profileLanguage === ui ? null : ui;
}
