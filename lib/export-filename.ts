/**
 * A filename the filesystem will actually accept.
 *
 * Thesis titles are frequently Arabic, and the server's own filenames carry
 * bidi control characters (the export URL showed a run of %E2%80%8E — left-to-
 * right marks). Those are invisible, legal in a title, and a menace in a path,
 * so they come out along with anything that could change the directory.
 *
 * `#`, `%` and `?` come out too. expo-file-system/legacy reads a path as a URI:
 * a `#` starts a fragment, which cuts the name and its extension off, a `?`
 * starts a query, and a `%` breaks the decode on iOS. Replacing them is the one
 * fix that is provable for every platform; percent-encoding the name is not.
 */
export function safeFilename(name: string, format: string): string {
  const cleaned = name
    .replace(/[‎‏‪-‮⁦-⁩]/g, "") // bidi controls
    .replace(/[/\\:*?"<>|#%]/g, "-") // path, reserved and URI-special characters
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || "thesis";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${format || "docx"}`;
}
