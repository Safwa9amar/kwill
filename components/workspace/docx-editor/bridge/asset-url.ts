// Turning a `require()`d asset into bytes inside the DOM bundle.
//
// What `require("x.wasm" | "x.ttf")` evaluates to in a 'use dom' bundle is a
// PLAIN STRING — @expo/metro-config's asset transformer emits
// `module.exports = "<path>"` for any web-platform asset without pixel
// dimensions (images get `{ uri, width, height }` instead). The path depends on
// how the bundle was built, and all three forms are relative to the DOM page:
//
//   dev (Metro)            "/assets?unstable_path=.%2Fnode_modules%2Fharfbuzzjs%2Fdist/harfbuzz.wasm"
//   export:embed (binary)  "assets/node_modules/harfbuzzjs/dist/harfbuzz.<md5>.wasm"   (in www.bundle/)
//   export for EAS Update  "<md5>.wasm"   (flat, beside the page in .expo-internal/)
//
// The last form is why this is OTA-safe where `public/` is not: the update
// carries the asset and expo-updates lays it down next to the HTML.
//
// ⚠️ A release page is a `file://` document (Android `file:///android_asset/
// www.bundle/…`, iOS the app bundle, an update `.expo-internal/`), and `fetch()`
// refuses the file scheme in Chromium. So bytes are read with XHR there, and a
// URL handed to Emscripten must be made ABSOLUTE first — its own file:// check
// is `startsWith("file://")`, which a relative path never passes, and the fetch
// it falls back to fails on that page.

/** The URL string a DOM-bundle asset module evaluates to. */
export function assetUrl(mod: unknown): string {
  if (typeof mod === "string" && mod) return mod;
  if (mod && typeof mod === "object" && typeof (mod as { uri?: unknown }).uri === "string") {
    return (mod as { uri: string }).uri;
  }
  // A number is a NATIVE asset id — this module was bundled for the wrong side.
  throw new Error(`not a DOM-bundle asset: ${typeof mod === "number" ? `native asset id ${mod}` : String(mod)}`);
}

/** `url` resolved against the page. `base` is the page's own URL (document.baseURI). */
export function absoluteUrl(url: string, base: string | undefined): string {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** The page's base URL, or undefined outside a document (vitest). */
export function pageBase(): string | undefined {
  return typeof document !== "undefined" ? document.baseURI : undefined;
}

type XhrLike = {
  open(method: string, url: string, async: boolean): void;
  responseType: string;
  status: number;
  response: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  send(body: null): void;
};

/** Read an asset's bytes: XHR for `file://` (fetch refuses the scheme), fetch otherwise. */
export function loadAssetBytes(
  url: string,
  o: { fetchImpl?: typeof fetch; xhr?: () => XhrLike } = {},
): Promise<Uint8Array> {
  if (url.startsWith("file:")) {
    return new Promise((resolve, reject) => {
      const x = o.xhr ? o.xhr() : (new XMLHttpRequest() as unknown as XhrLike);
      x.open("GET", url, true);
      x.responseType = "arraybuffer";
      // A file:// read answers status 0, not 200.
      x.onload = () => {
        if ((x.status === 200 || x.status === 0) && x.response instanceof ArrayBuffer && x.response.byteLength > 0) {
          resolve(new Uint8Array(x.response));
        } else {
          reject(new Error(`asset ${url}: status ${x.status}`));
        }
      };
      x.onerror = () => reject(new Error(`asset ${url}: unreadable`));
      x.send(null);
    });
  }
  const f = o.fetchImpl ?? fetch;
  return f(url).then(async (r) => {
    if (!r.ok) throw new Error(`asset ${url}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  });
}
