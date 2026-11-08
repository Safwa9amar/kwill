import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { changeIsStudentEdit, createSaveLoop, type SaveState } from "./save-loop";

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
    // `getBytes` is itself async, so the first save's fetch call is at least
    // one microtask tick away even though nothing else is queued ahead of it;
    // drain the microtask queue (no real time passes) before asserting on it.
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    loop.markDirty();
    const second = loop.flush();
    resolveFirst();
    await first;
    await second;
    expect(f).toHaveBeenCalledTimes(2);
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1].headers).toMatchObject({ "If-Match": '"h2"' });
    expect(loop.getHash()).toBe("h3");
  });

  it("a flush before the queued save starts joins it: one PUT carries both edits", async () => {
    const f = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    const first = loop.flush();
    loop.markDirty();
    const second = loop.flush();
    expect(second).toBe(first);
    await first;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("while a save is in flight, any number of flushes queue exactly ONE more", async () => {
    let resolveFirst!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = () => r({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) }); }))
      .mockImplementation(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h3" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    const first = loop.flush();
    await vi.advanceTimersByTimeAsync(0);
    const waits: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      loop.markDirty();
      waits.push(loop.flush());
    }
    resolveFirst();
    await first;
    await Promise.all(waits);
    expect(f).toHaveBeenCalledTimes(2);
    expect(loop.isDirty()).toBe(false);
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

  it("lastSaveFailed: set by a network error, cleared by a landing save, NOT set by a 412", async () => {
    const f = vi.fn()
      .mockImplementationOnce(async () => { throw new TypeError("Load failed"); })
      .mockImplementationOnce(async () => ({ status: 412, ok: false, json: async () => ({ docHash: "hX" }) }))
      .mockImplementationOnce(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(loop.lastSaveFailed()).toBe(true);
    await loop.flush();
    expect(loop.lastSaveFailed()).toBe(false);
    expect(loop.isDirty()).toBe(true);
    await loop.flush();
    expect(loop.lastSaveFailed()).toBe(false);
    expect(loop.isDirty()).toBe(false);
  });

  it("a failed save retries by itself, backing off, and stops once one lands", async () => {
    const f = vi.fn()
      .mockImplementationOnce(async () => { throw new TypeError("Load failed"); })
      .mockImplementationOnce(async () => ({ status: 500, ok: false, json: async () => ({}) }))
      .mockImplementation(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // first retry after 5s → the 500
    expect(f).toHaveBeenCalledTimes(2);
    expect(loop.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(14999);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // second retry after 15s → lands
    expect(f).toHaveBeenCalledTimes(3);
    expect(loop.isDirty()).toBe(false);
    expect(loop.getHash()).toBe("h2");
    await vi.advanceTimersByTimeAsync(120000);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("no retry after a refusal (412), a discard, or a dispose", async () => {
    const stale = vi.fn(async () => ({ status: 412, ok: false, json: async () => ({ docHash: "hX" }) })) as unknown as typeof fetch;
    const a = make(stale);
    a.loop.markDirty();
    await a.loop.flush();
    await vi.advanceTimersByTimeAsync(120000);
    expect(stale).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => { throw new TypeError("Load failed"); }) as unknown as typeof fetch;
    const b = make(down);
    b.loop.markDirty();
    await b.loop.flush();
    b.loop.discard();
    await vi.advanceTimersByTimeAsync(120000);
    expect(down).toHaveBeenCalledTimes(1);

    const down2 = vi.fn(async () => { throw new TypeError("Load failed"); }) as unknown as typeof fetch;
    const c = make(down2);
    c.loop.markDirty();
    await c.loop.flush();
    c.loop.dispose();
    await vi.advanceTimersByTimeAsync(120000);
    expect(down2).toHaveBeenCalledTimes(1);
  });

  it("isDirty tracks unsaved edits: set by markDirty, cleared once a save is committed to, back on a refusal", async () => {
    const ok = mockPut(200, { docHash: "h2" });
    const { loop } = make(ok);
    expect(loop.isDirty()).toBe(false);
    loop.markDirty();
    expect(loop.isDirty()).toBe(true);
    await loop.flush();
    expect(loop.isDirty()).toBe(false);

    const refused = make(mockPut(412, { docHash: "srv" })).loop;
    refused.markDirty();
    await refused.flush();
    expect(refused.isDirty()).toBe(true);
  });

  it("discard drops the flag AND the armed debounce: a reload's bytes are never PUT back", async () => {
    const f = mockPut(200, { docHash: "h2" });
    const { loop } = make(f);
    loop.markDirty();
    loop.discard();
    expect(loop.isDirty()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await loop.flush();
    expect(f).not.toHaveBeenCalled();
  });
  // The phantom "edited in Kwill" step (11-08): a 412 across a re-run, the reload,
  // and a save that outlived it PUT the reloaded bytes back — same text, new hash.
  it("a refused save that lands AFTER a reload does not re-arm dirty: the reloaded bytes are never PUT", async () => {
    let refuse!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { refuse = () => r({ status: 412, ok: false, json: async () => ({ docHash: "srv" }) }); }))
      .mockImplementation(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "phantom" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("old");
    loop.markDirty();
    const inFlight = loop.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    // The reload lands while that PUT is out: load(), discard(), setHash(server's).
    loop.discard();
    loop.setHash("srv");
    refuse();
    await inFlight;
    expect(loop.isDirty()).toBe(false);
    await loop.flush();                       // the next reload's own flush
    await vi.advanceTimersByTimeAsync(120000);
    expect(f).toHaveBeenCalledTimes(1);
    expect(loop.getHash()).toBe("srv");
  });

  it("a save committed to before a reload, still waiting when it lands, is dropped — it would read the reloaded bytes", async () => {
    let first!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { first = () => r({ status: 412, ok: false, json: async () => ({ docHash: "srv" }) }); }))
      .mockImplementation(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "phantom" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("old");
    loop.markDirty();
    const a = loop.flush();
    await vi.advanceTimersByTimeAsync(0);
    loop.markDirty();
    const waiting = loop.flush();             // queued behind the in-flight PUT
    loop.discard();
    loop.setHash("srv");
    first();
    await a;
    await waiting;
    expect(f).toHaveBeenCalledTimes(1);
    expect(loop.isDirty()).toBe(false);
    expect(loop.getHash()).toBe("srv");
  });

  it("an edit made after the reload still saves, even with a pre-reload save waiting", async () => {
    let first!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { first = () => r({ status: 412, ok: false, json: async () => ({ docHash: "srv" }) }); }))
      .mockImplementation(async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch;
    const { loop } = make(f);
    loop.setHash("old");
    loop.markDirty();
    const a = loop.flush();
    await vi.advanceTimersByTimeAsync(0);
    loop.markDirty();
    void loop.flush();                        // pre-reload, waiting
    loop.discard();
    loop.setHash("srv");
    loop.markDirty();                         // the student types on the reloaded page
    const typed = loop.flush();
    first();
    await a;
    await typed;
    expect(f).toHaveBeenCalledTimes(2);
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1].headers).toMatchObject({ "If-Match": '"srv"' });
    expect(loop.getHash()).toBe("h2");
  });

  it("a save that LANDS after a reload keeps the reloaded hash and skips the D7 re-parse", async () => {
    let land!: () => void;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { land = () => r({ status: 200, ok: true, json: async () => ({ docHash: "late" }) }); })) as unknown as typeof fetch;
    const { loop } = make(f);
    const saved = vi.fn();
    loop.onSaved(saved);
    loop.setHash("old");
    loop.markDirty();
    const p = loop.flush();
    await vi.advanceTimersByTimeAsync(0);
    loop.discard();
    loop.setHash("srv");
    land();
    await p;
    expect(loop.getHash()).toBe("srv");
    expect(saved).not.toHaveBeenCalled();
    expect(loop.isDirty()).toBe(false);
  });
});

describe("changeIsStudentEdit", () => {
  it("a replacement the engine tags (load / refresh / recovery) is never an edit, flag or not", () => {
    for (const source of ["load", "refresh", "recovery"]) {
      expect(changeIsStudentEdit({ source }, false)).toBe(false);
      expect(changeIsStudentEdit({ source, dirty: ["b1"] }, false)).toBe(false);
    }
  });
  it("an untagged change naming blocks is an edit, even right after a load", () => {
    expect(changeIsStudentEdit({ dirty: ["b1"] }, true)).toBe(true);
    expect(changeIsStudentEdit({ created: ["b2"] }, false)).toBe(true);
  });
  it("an untagged id-less change is ours only while the load flag is armed", () => {
    expect(changeIsStudentEdit({}, true)).toBe(false);
    expect(changeIsStudentEdit({}, false)).toBe(true);
  });
});
