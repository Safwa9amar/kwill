// GET the whole .docx from the server (Task 2's route). The bytes stay in the
// WebView — they never cross the DOM bridge — and the ETag (the server's
// `docHash`) is what every later decision keys on: whether a reload is needed,
// and what `If-Match` a save must carry.

export function unquoteEtag(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(/^W\//i, "").replace(/^"(.*)"$/, "$1") || null;
}

export type FetchDocumentResult =
  | { status: 200; bytes: ArrayBuffer; docHash: string | null }
  | { status: 304 };

export async function fetchDocument(o: {
  apiBase: string;
  thesisId: string;
  token: string;
  ifNoneMatch?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FetchDocumentResult> {
  const f = o.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${o.token}` };
  if (o.ifNoneMatch) headers["If-None-Match"] = `"${o.ifNoneMatch}"`;
  const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { headers, cache: "no-store" });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`document ${res.status}`);
  return { status: 200, bytes: await res.arrayBuffer(), docHash: unquoteEtag(res.headers.get("etag")) };
}
