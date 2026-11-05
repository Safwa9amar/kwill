/**
 * The document tag a queued batch is sent against (P-66). Pure: the store decides which tag it holds and when, and these say what each
 * answer means. A batch built on one copy of the document carries that copy's tag as `If-Match`, and the server refuses it (412) once
 * the document has moved on.
 */

/** The `If-Match` value for a tag, quoted as the server's `ifMatchAllows` reads it. Null when no tag is known: the batch goes as today. */
export function ifMatchValue(tag: string | null | undefined): string | null {
  return tag ? `"${tag}"` : null;
}

/**
 * The tag of the state a write has just left the server in: `history.docHash` of the write's answer. The echoed `document` carries the tag
 * from BEFORE the write (the server reads the thesis row first), so it is never read here.
 */
export function tagOfWrite(res: unknown): string | null {
  const history = (res as { history?: { docHash?: unknown } | null } | null)?.history;
  const tag = history?.docHash;
  return typeof tag === "string" && tag !== "" ? tag : null;
}

/** The tag of a document read from the server. Only a live document has one. */
export function tagOfRead(doc: unknown): string | null {
  const d = doc as { available?: unknown; docHash?: unknown } | null;
  return d?.available === true && typeof d.docHash === "string" && d.docHash !== "" ? d.docHash : null;
}
