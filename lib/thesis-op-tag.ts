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

/**
 * The thesis a write is aimed at, for a path under `/api/thesis/<id>/`. Null for any other path.
 * Every such write the store did not tag moves the server past the store's tag, so the store forgets it (the next batch goes untagged, as
 * before) rather than sending a stale one that the server would refuse with the student's queue in it.
 */
export function thesisOfWrite(path: string): string | null {
  const m = /^\/api\/thesis\/([^/?#]+)\//.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

const untrackedWriteListeners = new Set<(thesisId: string) => void>();

/** The store listens here. Returns the unsubscribe. */
export function onUntrackedWrite(fn: (thesisId: string) => void): () => void {
  untrackedWriteListeners.add(fn);
  return () => untrackedWriteListeners.delete(fn);
}

/** Said by the API helpers before and after a thesis write sent without an `If-Match`. */
export function noteUntrackedWrite(path: string): void {
  const thesisId = thesisOfWrite(path);
  if (thesisId) for (const fn of untrackedWriteListeners) fn(thesisId);
}
