import { describe, it, expect, vi } from "vitest";
import { absoluteUrl, assetUrl, loadAssetBytes } from "./asset-url";

describe("assetUrl", () => {
  it("takes the string a DOM-bundle asset module evaluates to", () => {
    expect(assetUrl("c0e47a64.ttf")).toBe("c0e47a64.ttf");
  });
  it("takes an image-shaped { uri } too", () => {
    expect(assetUrl({ uri: "assets/x.png", width: 1, height: 1 })).toBe("assets/x.png");
  });
  it("refuses a native asset id — that module was bundled for the wrong side", () => {
    expect(() => assetUrl(12)).toThrow(/native asset id 12/);
    expect(() => assetUrl(undefined)).toThrow();
  });
});

describe("absoluteUrl", () => {
  it("leaves the URL alone with no page to resolve against", () => {
    expect(absoluteUrl("a.ttf", undefined)).toBe("a.ttf");
  });
  it("resolves relative and root-relative paths against the page", () => {
    expect(absoluteUrl("a.ttf", "file:///android_asset/www.bundle/p.html")).toBe("file:///android_asset/www.bundle/a.ttf");
    expect(absoluteUrl("/assets?unstable_path=.%2Fx/a.ttf", "http://10.0.0.2:8081/_expo/@dom/p.html"))
      .toBe("http://10.0.0.2:8081/assets?unstable_path=.%2Fx/a.ttf");
  });
});

describe("loadAssetBytes", () => {
  it("reads a file:// asset with XHR (fetch refuses the scheme) and accepts status 0", async () => {
    const fetchImpl = vi.fn();
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const xhr = () => {
      const x = {
        open: vi.fn(), responseType: "", status: 0, response: null as unknown,
        onload: null as (() => void) | null, onerror: null as (() => void) | null,
        send: () => { x.response = buf; x.onload?.(); },
      };
      return x;
    };
    const bytes = await loadAssetBytes("file:///x/a.ttf", { fetchImpl: fetchImpl as unknown as typeof fetch, xhr });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects an empty file:// read rather than handing the engine zero bytes", async () => {
    const xhr = () => {
      const x = {
        open: vi.fn(), responseType: "", status: 0, response: new ArrayBuffer(0) as unknown,
        onload: null as (() => void) | null, onerror: null as (() => void) | null,
        send: () => { x.onload?.(); },
      };
      return x;
    };
    await expect(loadAssetBytes("file:///x/missing.ttf", { xhr })).rejects.toThrow(/status 0/);
  });
  it("fetches an http asset (dev, Metro)", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    const bytes = await loadAssetBytes("http://h:8081/a.ttf", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(Array.from(bytes)).toEqual([9]);
    const notFound = vi.fn(async () => new Response("", { status: 404 }));
    await expect(loadAssetBytes("http://h:8081/b.ttf", { fetchImpl: notFound as unknown as typeof fetch })).rejects.toThrow(/404/);
  });
});
