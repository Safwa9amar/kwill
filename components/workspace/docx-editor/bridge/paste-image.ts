// "Might this paste be a picture?" — the same deliberately generous test Lexical's
// PasteImagePlugin applies.
//
// WebKit routinely exposes NOTHING to clipboardData for a pasted image (no items,
// no files, no types), so an empty payload counts as a maybe and native asks the
// real pasteboard (expo-clipboard). It also often hands a picture over as text/html
// wrapping a single <img> — HTML whose text content is empty is that case, not a
// text paste. Anything carrying real text is left to the engine untouched, which
// keeps ordinary text paste — the common case — on its normal path.

export type ClipboardFacts = {
  types: readonly string[];
  fileTypes: readonly string[];
  html: string;
  plain: string;
};

export function maybeImagePaste(cd: ClipboardFacts): boolean {
  const hasImage = cd.types.some((t) => t.startsWith("image/")) || cd.fileTypes.some((t) => t.startsWith("image/"));
  const htmlIsOnlyImage = /<img[\s/>]/i.test(cd.html) && !cd.html.replace(/<[^>]*>/g, "").trim();
  const hasText = !!cd.plain.trim() || (!!cd.html && !htmlIsOnlyImage);
  return hasImage || htmlIsOnlyImage || !hasText;
}

/** Read the facts off a live ClipboardEvent's data (the DOM half, kept beside the rule). */
export function clipboardFacts(cd: DataTransfer): ClipboardFacts {
  const types = Array.from(cd.types ?? []);
  return {
    types,
    fileTypes: Array.from(cd.files ?? []).map((f) => f.type),
    html: types.includes("text/html") ? cd.getData("text/html") : "",
    plain: types.includes("text/plain") ? cd.getData("text/plain") : "",
  };
}
