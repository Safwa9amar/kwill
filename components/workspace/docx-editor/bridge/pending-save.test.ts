import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPendingSave, openInitial, pendingKey, pruneRecovered, recoveredAt, recoveredKey, settleWithin,
  type PendingRecord, type PendingStore,
} from "./pending-save";
import { createSaveLoop, type SaveState } from "./save-loop";

function memoryStore(): PendingStore & { map: Map<string, PendingRecord> } {
  const map = new Map<string, PendingRecord>();
  return {
    map,
    put: async (r) => { map.set(r.key, structuredClone(r)); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
    keys: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

const buf = (...b: number[]) => new Uint8Array(b).buffer;

describe("keys", () => {
  it("recovered keys sort in time order and round-trip their timestamp", () => {
    const a = recoveredKey("t", 999);
    const b = recoveredKey("t", 1_700_000_000_000);
    expect([b, a].sort()).toEqual([a, b]);
    expect(recoveredAt(b)).toBe(1_700_000_000_000);
  });
  it("pruneRecovered keeps the newest", () => {
    const ks = [1, 2, 3, 4, 5].map((n) => recoveredKey("t", n));
    expect(pruneRecovered(ks, 3)).toEqual([ks[0], ks[1]]);
    expect(pruneRecovered(ks.slice(0, 2), 3)).toEqual([]);
  });
});

describe("createPendingSave", () => {
  it("put → take → clear", async () => {
    const s = memoryStore();
    const p = createPendingSave(s, "t", () => 10);
    await p.put(buf(1, 2), "h1");
    expect(await p.take()).toMatchObject({ key: pendingKey("t"), baseHash: "h1", at: 10 });
    await p.clear();
    expect(await p.take()).toBeNull();
  });
  it("keep() turns the refused bytes into a recovered copy and bounds how many stay", async () => {
    const s = memoryStore();
    let now = 100;
    const p = createPendingSave(s, "t", () => now);
    for (let i = 0; i < 5; i++) {
      await p.put(buf(i), "h");
      now += 1;
      const ref = await p.keep();
      expect(ref).toEqual({ key: recoveredKey("t", now), at: now });
    }
    expect(await p.take()).toBeNull();
    const kept = await s.keys("recovered:t:");
    expect(kept).toHaveLength(3);
    const latest = await p.latestRecovered();
    expect(latest?.at).toBe(105);
    expect(new Uint8Array((await p.readRecovered(latest!.key))!)).toEqual(new Uint8Array([4]));
  });
  it("keep() with nothing pending is a no-op", async () => {
    expect(await createPendingSave(memoryStore(), "t").keep()).toBeNull();
  });
  it("never reads or deletes another thesis's copy through a key from the bridge", async () => {
    const s = memoryStore();
    const other = createPendingSave(s, "other", () => 5);
    await other.put(buf(9), null);
    const ref = await other.keep();
    const mine = createPendingSave(s, "t");
    expect(await mine.readRecovered(ref!.key)).toBeNull();
    await mine.discard(ref!.key);
    expect(s.map.has(ref!.key)).toBe(true);
  });
});

describe("openInitial", () => {
  it("shows a waiting pending record at once, without asking the server", async () => {
    const s = memoryStore();
    const p = createPendingSave(s, "t");
    await p.put(buf(7), "base");
    const fetchDoc = vi.fn();
    const r = await openInitial({ pending: p, fetchDoc });
    expect(r).toMatchObject({ docHash: "base", replay: true });
    expect(new Uint8Array(r!.bytes)).toEqual(new Uint8Array([7]));
    expect(fetchDoc).not.toHaveBeenCalled();
  });
  it("otherwise opens the server's bytes", async () => {
    const r = await openInitial({
      pending: createPendingSave(memoryStore(), "t"),
      fetchDoc: async () => ({ status: 200, bytes: buf(1), docHash: "srv" }),
    });
    expect(r).toMatchObject({ docHash: "srv", replay: false });
  });
  it("a hung store costs at most waitMs, then the network path runs", async () => {
    vi.useFakeTimers();
    const hung = { take: () => new Promise<never>(() => {}) };
    const fetchDoc = vi.fn(async () => ({ status: 200 as const, bytes: buf(1), docHash: "srv" }));
    const r = openInitial({ pending: hung, fetchDoc, waitMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await r)?.replay).toBe(false);
    vi.useRealTimers();
  });
});

describe("settleWithin", () => {
  afterEach(() => vi.useRealTimers());
  it("swallows a rejection (a broken store must not cost the save)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await settleWithin(Promise.reject(new Error("quota")), 100)).toBeUndefined();
    warn.mockRestore();
  });
});

describe("save loop + pending copy (spec D6)", () => {
  function make(status: number, body: Record<string, unknown>, store = memoryStore()) {
    const states: SaveState[] = [];
    const pending = createPendingSave(store, "t", () => 42);
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push(store.map.has(pendingKey("t")) ? "PUT(with copy)" : "PUT(no copy)");
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    }) as unknown as typeof fetch;
    const loop = createSaveLoop({
      apiBase: "http://x", thesisId: "t", token: () => "tok",
      getBytes: async () => buf(1, 2, 3), onState: (s) => states.push(s), fetchImpl, pending,
    });
    return { loop, states, store, order };
  }

  it("writes the copy BEFORE the PUT and clears it after a 2xx", async () => {
    const { loop, store, order } = make(200, { docHash: "h2" });
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(order).toEqual(["PUT(with copy)"]);
    expect(store.map.size).toBe(0);
  });
  it("keeps the copy when the network fails, with the hash it was edited from", async () => {
    const store = memoryStore();
    const loop = createSaveLoop({
      apiBase: "http://x", thesisId: "t", token: () => "tok",
      getBytes: async () => buf(1), onState: () => {},
      fetchImpl: (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch,
      pending: createPendingSave(store, "t"),
    });
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    expect(store.map.get(pendingKey("t"))?.baseHash).toBe("h1");
  });
  it("a 412 sets the refused bytes aside and says where", async () => {
    const { loop, states, store } = make(412, { docHash: "srv" });
    loop.setHash("h1");
    loop.markDirty();
    await loop.flush();
    const key = recoveredKey("t", 42);
    expect(states.at(-1)).toEqual({ kind: "stale", serverHash: "srv", recovered: { key, at: 42 } });
    expect(store.map.has(pendingKey("t"))).toBe(false);
    expect(store.map.get(key)?.baseHash).toBe("h1");
  });
  it("a broken store does not stop the save", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: PendingStore = {
      put: async () => { throw new Error("no IndexedDB"); },
      get: async () => { throw new Error("no IndexedDB"); },
      delete: async () => { throw new Error("no IndexedDB"); },
      keys: async () => { throw new Error("no IndexedDB"); },
    };
    const states: SaveState[] = [];
    const loop = createSaveLoop({
      apiBase: "http://x", thesisId: "t", token: () => "tok",
      getBytes: async () => buf(1), onState: (s) => states.push(s),
      fetchImpl: (async () => ({ status: 200, ok: true, json: async () => ({ docHash: "h2" }) })) as unknown as typeof fetch,
      pending: createPendingSave(broken, "t"),
    });
    loop.markDirty();
    await loop.flush();
    expect(states.at(-1)).toMatchObject({ kind: "saved", docHash: "h2" });
    warn.mockRestore();
  });
});
