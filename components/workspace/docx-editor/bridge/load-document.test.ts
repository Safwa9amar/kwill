import { describe, it, expect, vi } from "vitest";
import { fetchDocument, unquoteEtag } from "./load-document";

const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;

function mockFetch(status: number, etag?: string) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === "etag" ? etag ?? null : null) },
    arrayBuffer: async () => bytes,
  })) as unknown as typeof fetch;
}

describe("unquoteEtag", () => {
  it("strips quotes and a weak prefix", () => {
    expect(unquoteEtag('"abc"')).toBe("abc");
    expect(unquoteEtag('W/"abc"')).toBe("abc");
    expect(unquoteEtag(null)).toBeNull();
  });
});

describe("fetchDocument", () => {
  it("GETs the bytes with the token and returns the unquoted etag", async () => {
    const f = mockFetch(200, '"h1"');
    const r = await fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", fetchImpl: f });
    expect(r).toEqual({ status: 200, bytes, docHash: "h1" });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://x/api/thesis/t/docx");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.cache).toBe("no-store");
  });
  it("sends If-None-Match and reports 304 without bytes", async () => {
    const f = mockFetch(304, '"h1"');
    const r = await fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", ifNoneMatch: "h1", fetchImpl: f });
    expect(r).toEqual({ status: 304 });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('"h1"');
  });
  it("throws on any other status", async () => {
    await expect(fetchDocument({ apiBase: "http://x", thesisId: "t", token: "tok", fetchImpl: mockFetch(500) })).rejects.toThrow("500");
  });
});
