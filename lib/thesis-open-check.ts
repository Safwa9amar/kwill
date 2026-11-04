// The check that a thesis may be opened from the rescue screens. Pure, so it is tested under node.

/** Throws unless the thesis is in the list the app has just read. The caller pushes the workspace only after this returns. */
export function requireListed(theses: { id: string }[], thesisId: string): void {
  if (!theses.some((t) => t.id === thesisId)) throw new Error("thesis-not-listed");
}
