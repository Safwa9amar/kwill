import { describe, expect, it } from "vitest";
import { runNoteCta, waitForNote, type NoteCtaRun, type NoteWait } from "./rescue-v2-note-cta";

/** A note that reads `parsing` for `parsingReads` looks, then settles, with or without an open conflict. */
function fakeWorld(opts: { parsingReads?: number; conflict?: boolean; moveAt?: number } = {}) {
  let reads = 0;
  let refreshes = 0;
  const sleeps: number[] = [];
  const deps = {
    read: () => {
      reads++;
      const parsing = reads <= (opts.parsingReads ?? 0);
      const live = opts.moveAt === undefined || reads < opts.moveAt;
      return { parsing, conflict: opts.conflict ?? false, live };
    },
    refresh: async () => { refreshes++; },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { deps, sleeps, refreshes: () => refreshes };
}

function fakeRun(over: Partial<{ send: boolean; wait: NoteWait; start: boolean }> = {}) {
  const calls: string[] = [];
  const run: NoteCtaRun = {
    send: async () => { calls.push("send"); return over.send ?? true; },
    wait: async () => { calls.push("wait"); return over.wait ?? "settled"; },
    start: async () => { calls.push("start"); return over.start ?? true; },
  };
  return { run, calls };
}

describe("waitForNote", () => {
  it("returns at once when the note is not being read", async () => {
    const w = fakeWorld();
    expect(await waitForNote(w.deps)).toBe("settled");
    expect(w.sleeps).toEqual([]);
  });

  it("polls through the store until the note settles, then says so", async () => {
    const w = fakeWorld({ parsingReads: 3 });
    expect(await waitForNote(w.deps, 10, 5)).toBe("settled");
    expect(w.refreshes()).toBe(3);
    expect(w.sleeps).toEqual([5, 5, 5]);
  });

  it("says conflict when the settled note has an open conflict", async () => {
    const w = fakeWorld({ parsingReads: 1, conflict: true });
    expect(await waitForNote(w.deps, 10, 5)).toBe("conflict");
  });

  it("gives up after the poll limit, so the button is never held forever", async () => {
    const w = fakeWorld({ parsingReads: 1000 });
    expect(await waitForNote(w.deps, 4, 5)).toBe("timeout");
    expect(w.refreshes()).toBe(4);
  });

  it("stops when the student has moved to another project", async () => {
    const w = fakeWorld({ parsingReads: 5, moveAt: 2 });
    expect(await waitForNote(w.deps, 10, 5)).toBe("moved");
  });
});

describe("runNoteCta", () => {
  it("sends the changed note, waits for it, then starts the diagnosis exactly once", async () => {
    const { run, calls } = fakeRun();
    expect(await runNoteCta(true, run)).toBe("started");
    expect(calls).toEqual(["send", "wait", "start"]);
  });

  it("starts with no send when the text is the saved one and the note is settled", async () => {
    const { run, calls } = fakeRun();
    expect(await runNoteCta(false, run)).toBe("started");
    expect(calls).toEqual(["wait", "start"]);
  });

  it("does not wait or start when the send fails: the shell's line already says why", async () => {
    const { run, calls } = fakeRun({ send: false });
    expect(await runNoteCta(true, run)).toBe("stopped");
    expect(calls).toEqual(["send"]);
  });

  it("does not start when the note conflicts, so the conflict buttons stay the next step", async () => {
    const { run, calls } = fakeRun({ wait: "conflict" });
    expect(await runNoteCta(true, run)).toBe("stopped");
    expect(calls).toEqual(["send", "wait"]);
  });

  it("does not start when the wait ends without a settled note", async () => {
    for (const w of ["timeout", "moved"] as NoteWait[]) {
      const { run, calls } = fakeRun({ wait: w });
      expect(await runNoteCta(true, run), w).toBe("stopped");
      expect(calls, w).not.toContain("start");
    }
  });
});
