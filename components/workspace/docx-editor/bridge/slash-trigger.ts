// The Notion-style "/command" trigger, as text rules — the same ones Lexical's
// SlashPlugin applies, so the Insert menu blooms on exactly the same keystrokes on
// both surfaces. A slash is a command only at the start of the text or right after
// whitespace; the query is the run of non-space, non-slash characters up to the
// caret ("see /fig" → "fig", "and/or" → nothing).

const SLASH_RE = /(?:^|\s)\/([^\s/]*)$/;

/** The `/query` ending at the caret, or null. `before` is the text up to the caret. */
export function slashQuery(before: string): { query: string; start: number } | null {
  const m = SLASH_RE.exec(before);
  if (!m) return null;
  // Offset of the "/" itself: the match may begin with the whitespace before it.
  const start = m.index + (m[0].startsWith("/") ? 0 : 1);
  return { query: m[1], start };
}
