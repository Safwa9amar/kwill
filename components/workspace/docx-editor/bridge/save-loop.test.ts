import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSaveLoop, type SaveState } from "./save-loop";

const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;

function mockPut(status: number, body: Record<string, unknown> = {}) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })) as unknown as typeof fetch;
}

describe("createSaveLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(fetchImpl: typeof fetch) {
    const states: SaveState[] = [];
    const loop = createSaveLoop({
      apiBase: "http://x",
      thesisId: "t",
      token: () => "tok",
      getBytes: async () => bytes,
      onState: (s) => states.push(s),
      debounceMs: 1500,
      fetchImpl,
    });
    return { loop, states };
  }

  it("debounces: one PUT after quiet, carrying If-Match, then adopts the returned hash", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    loop.markDirty();
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://x/api/thesis/t/docx");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"h1"');
    expect(loop.getHash()).toBe("h2");
    expect(states.map((s) => s.kind)).toEqual(["dirty", "saving", "saved"]);
    expect(states.at(-1)).toEqual({ kind: "saved", at: expect.any(Number), docHash: "h2" });
  });

  it("a 412 reports stale with the server's hash and keeps ours", async () => {
    const f = mockPut(412, { error: "stale", docHash: "srv" });
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(loop.getHash()).toBe("h1");
    expect(states.at(-1)).toEqual({ kind: "stale", serverHash: "srv" });
  });

  it("flush() saves immediately and resolves after the PUT", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing dirty is a no-op", async () => {
    const f = mockPut(200, { ok: true, docHash: "h2" });
    const { loop } = make(f);
    await loop.flush();
    expect(f).not.toHaveBeenCalled();
  });

  it("saves are chained, never concurrent", async () => {
    let resolveFirst!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = () => r({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) }); }))
      .mockImplementationOnce(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h3" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    const first = loop.flush();
    loop.markDirty();
    const second = loop.flush();
    // `getBytes` is itself async, so the first save's fetch call is at least
    // one microtask tick away even though nothing else is queued ahead of it;
    // drain the microtask queue (no real time passes) before asserting on it.
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
    await second;
    expect(f).toHaveBeenCalledTimes(2);
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1].headers).toMatchObject({ "If-Match": '"h2"' });
    expect(loop.getHash()).toBe("h3");
  });

  it("onSaved fires with the saved bytes on success only", async () => {
    const f = vi.fn()
      .mockImplementationOnce(async () => ({ status: 412, ok: false, json: async () => ({ error: "stale", docHash: "srv" }) }))
      .mockImplementationOnce(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    const saved = vi.fn();
    const off = loop.onSaved(saved);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();               // 412 → no callback
    expect(saved).not.toHaveBeenCalled();
    await loop.flush();               // still dirty → retried → 200
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith(bytes);
    off();
  });

  it("a network error reports error and stays dirty for the next attempt", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const { loop, states } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toEqual({ kind: "error", message: "offline" });
    await loop.flush();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
