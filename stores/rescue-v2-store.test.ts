import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches the API, the upload module and the document store. Each is replaced here, so the store runs under node.
vi.hoisted(() => { (globalThis as Record<string, unknown>).__DEV__ = false; });

const api = vi.hoisted(() => ({
  getRescueProject: vi.fn(),
  listVersions: vi.fn(),
  createRescueProject: vi.fn(),
  createRerun: vi.fn(),
  getRescueConfig: vi.fn(),
  getVersionPages: vi.fn(),
  getVersion: vi.fn(),
  saveRules: vi.fn(),
  sendNote: vi.fn(),
  restoreVersion: vi.fn(),
}));
const up = vi.hoisted(() => ({ uploadPart: vi.fn() }));
vi.mock("@/lib/rescue-v2-api", () => api);
vi.mock("@/lib/rescue-v2-upload", () => up);
const doc = vi.hoisted(() => ({ flushOps: vi.fn() }));
vi.mock("@/stores/thesis-doc-store", () => ({ useThesisDocStore: { getState: () => doc } }));

import type { RescueProjectDTO } from "@/types/rescue-v2";
import { reopenIfOpen, useRescueV2Store } from "@/stores/rescue-v2-store";
import { useHistoryUi } from "@/stores/rescue-history-ui";

const S = () => useRescueV2Store.getState();

function dto(id: string, phase: string, extra: Record<string, unknown> = {}): RescueProjectDTO {
  return {
    id, phase, thesisId: null, activeVersionId: `${id}-v1`, failure: null,
    note: { state: "none" }, setup: { guide: { state: "none" } }, cover: null,
    entitlement: { purchase: { state: "none" }, kind: null }, progress: null,
    ...extra,
  } as unknown as RescueProjectDTO;
}
const f = (name: string) => ({ uri: `file:///${name}`, name, size: 1 });
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const httpError = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), code ? { status, code } : { status });

beforeEach(() => {
  vi.resetAllMocks();
  doc.flushOps.mockResolvedValue(true);
  S().reset();
});

describe("a reply for another project never touches the open one (fix 1)", () => {
  it("a reply for A that lands after open(B) does not make A the open project", async () => {
    const a = deferred<RescueProjectDTO>(), b = deferred<RescueProjectDTO>();
    api.getRescueProject.mockImplementation((id: string) => (id === "A" ? a.p : b.p));
    const pA = S().open("A");
    const pB = S().open("B");
    b.resolve(dto("B", "done")); await pB;
    a.resolve(dto("A", "reading")); await pA;
    expect(S().projectId).toBe("B");
    expect(S().project?.id).toBe("B");
  });

  it("a poll for A still in flight when B opens is dropped", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().open("A");
    const poll = deferred<RescueProjectDTO>();
    api.getRescueProject.mockReturnValueOnce(poll.p);
    const r = S().refresh();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    poll.resolve(dto("A", "reading")); await r;
    expect(S().projectId).toBe("B");
    expect(S().project?.id).toBe("B");
  });

  it("a refresh failure for A after open(B) does not show on B", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().open("A");
    const poll = deferred<RescueProjectDTO>();
    api.getRescueProject.mockReturnValueOnce(poll.p);
    const r = S().refresh();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    poll.reject(new TypeError("Network request failed")); await r;
    expect(S().errorCode).toBeNull();
  });

  it("a loadVersions reply for A after the switch leaves B's timeline empty", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const v = deferred<unknown>();
    api.listVersions.mockReturnValueOnce(v.p);
    const lv = S().loadVersions();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    v.resolve({ versions: [{ id: "vA" }], edited: { edited: false, changedBlocks: null, afterVersionN: null } }); await lv;
    expect(S().versions).toEqual([]);
  });

  it("opening B drops A's versions at once, so they never show under B", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    api.listVersions.mockResolvedValueOnce({ versions: [{ id: "vA" }], edited: { edited: true, changedBlocks: 3, afterVersionN: 1 } });
    await S().loadVersions();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    expect(S().versions).toEqual([]);
    expect(S().edited).toBeNull();
  });

  it("an apply for A that lands after open(B) is dropped", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const call = deferred<RescueProjectDTO>();
    const ap = S().apply(() => call.p);
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    call.resolve(dto("A", "repairing")); await ap;
    expect(S().projectId).toBe("B");
    expect(S().project?.id).toBe("B");
  });

  it("a page error for A after the switch does not show on B", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const pages = deferred<unknown>();
    api.getVersionPages.mockReturnValueOnce(pages.p);
    const lp = S().loadPages("A-v1", 1, 1);
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    pages.reject(httpError(500)); await lp;
    expect(S().errorCode).toBeNull();
  });

  it("reset() while a refresh is in flight: nothing lands after it", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().open("A");
    const poll = deferred<RescueProjectDTO>();
    api.getRescueProject.mockReturnValueOnce(poll.p);
    const r = S().refresh();
    S().reset();
    poll.resolve(dto("A", "reading")); await r;
    expect(S().projectId).toBeNull();
    expect(S().project).toBeNull();
  });

  it("an upload that finishes after the switch does not land its project or clear B's upload", async () => {
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    const partA = deferred<RescueProjectDTO>();
    const partB = deferred<RescueProjectDTO>();
    up.uploadPart.mockReturnValueOnce(partA.p).mockReturnValueOnce(partB.p);
    const beginA = S().begin([f("a.docx")], "picker");
    await tick();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "reading"));
    await S().open("B");
    api.createRerun.mockResolvedValueOnce(dto("B", "uploading", { activeVersionId: "B-v2" }));
    const rerunB = S().beginRerun([f("rerun.docx")]);
    await tick();
    partA.resolve(dto("A", "uploading")); await beginA;
    expect(S().projectId).toBe("B");
    expect(S().project?.id).toBe("B");
    expect(S().upload?.fileName).toBe("rerun.docx");
    partB.resolve(dto("B", "reading")); await rerunB;
    expect(S().upload).toBeNull();
  });

  it("an upload that fails after the switch does not show its error on B", async () => {
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    const partA = deferred<RescueProjectDTO>();
    up.uploadPart.mockReturnValueOnce(partA.p);
    const beginA = S().begin([f("a.docx")], "picker");
    await tick();
    api.getRescueProject.mockResolvedValueOnce(dto("B", "done"));
    await S().open("B");
    partA.reject(httpError(413, "rescue_too_large")); await beginA;
    expect(S().projectId).toBe("B");
    expect(S().errorCode).toBeNull();
    expect(S().upload).toBeNull();
  });

  it("open(null) clears versions, edited and upload", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    api.listVersions.mockResolvedValueOnce({ versions: [{ id: "vA" }], edited: { edited: true, changedBlocks: 3, afterVersionN: 1 } });
    await S().loadVersions();
    const part = deferred<RescueProjectDTO>();
    api.createRescueProject.mockResolvedValueOnce(dto("N", "uploading"));
    up.uploadPart.mockReturnValueOnce(part.p);
    const begin = S().begin([f("n.docx")], "picker");
    await tick();
    expect(S().upload).not.toBeNull();
    await S().open(null);
    expect(S().versions).toEqual([]);
    expect(S().edited).toBeNull();
    expect(S().upload).toBeNull();
    part.resolve(dto("N", "reading")); await begin;
    expect(S().projectId).toBeNull();
  });
});

describe("a failed part's error survives polling (fix 2)", () => {
  async function failSecondPart() {
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart
      .mockResolvedValueOnce(dto("A", "uploading"))
      .mockRejectedValueOnce(httpError(413, "rescue_too_large"));
    const ok = await S().begin([f("a.docx"), f("b.docx")], "picker");
    expect(ok).toBe(false);
    expect(S().errorCode).toBe("rescue_too_large");
  }

  it("a refresh with an unchanged DTO keeps the error while the server still waits for parts", async () => {
    await failSecondPart();
    api.getRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    await S().refresh();
    expect(S().errorCode).toBe("rescue_too_large");
  });

  it("a refresh whose DTO moved, phase still uploading, keeps the error too", async () => {
    await failSecondPart();
    api.getRescueProject.mockResolvedValueOnce(dto("A", "uploading", { cover: { samples: "none" } }));
    await S().refresh();
    expect(S().errorCode).toBe("rescue_too_large");
  });

  it("the error clears once the phase changes", async () => {
    await failSecondPart();
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().refresh();
    expect(S().errorCode).toBeNull();
  });

  it("a retry clears the error", async () => {
    await failSecondPart();
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart.mockResolvedValueOnce(dto("A", "uploading")).mockResolvedValueOnce(dto("A", "uploading"));
    const retry = S().begin([f("a.docx"), f("b.docx")], "picker");
    expect(S().errorCode).toBeNull();
    await retry;
    // The same uploading DTO as before the failure: with the mark cleared by the retry, nothing brings the old error back.
    api.getRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    await S().refresh();
    expect(S().errorCode).toBeNull();
  });
});

describe("polls land in order (fix 3)", () => {
  it("an older poll that lands after a newer one is dropped", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "repairing"));
    await S().open("A");
    const slow = deferred<RescueProjectDTO>(), fast = deferred<RescueProjectDTO>();
    api.getRescueProject.mockReturnValueOnce(slow.p).mockReturnValueOnce(fast.p);
    const r1 = S().refresh();
    const r2 = S().refresh();
    fast.resolve(dto("A", "done")); await r2;
    slow.resolve(dto("A", "repairing")); await r1;
    expect(S().project?.phase).toBe("done");
  });

  it("an older poll that fails after a newer one landed does not show its error", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().open("A");
    const slow = deferred<RescueProjectDTO>();
    api.getRescueProject.mockReturnValueOnce(slow.p).mockResolvedValueOnce(dto("A", "reading"));
    const r1 = S().refresh();
    await S().refresh();
    slow.reject(new TypeError("Network request failed")); await r1;
    expect(S().errorCode).toBeNull();
  });
});

describe("the polling hook starts no poll while one is in flight (fix 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("react");
    vi.doUnmock("react-native");
    vi.doUnmock("expo-router");
    vi.doUnmock("@/stores/rescue-v2-store");
    vi.resetModules();
  });

  it("a poll slower than 3 s does not stack a second poll behind it", async () => {
    vi.useFakeTimers();
    const effects: (() => void | (() => void))[] = [];
    let appListener: ((s: string) => void) | null = null;
    const pending: { resolve: () => void }[] = [];
    const refresh = vi.fn(() => { const d = deferred<void>(); pending.push(d); return d.p; });
    const reading = dto("A", "reading");
    vi.doMock("react", () => ({ useEffect: (fn: () => void | (() => void)) => { effects.push(fn); }, useCallback: <T,>(fn: T) => fn }));
    vi.doMock("expo-router", () => ({ useFocusEffect: () => {} }));
    vi.doMock("react-native", () => ({
      AppState: {
        currentState: "active",
        addEventListener: (_type: string, l: (s: string) => void) => { appListener = l; return { remove() {} }; },
      },
    }));
    vi.doMock("@/stores/rescue-v2-store", () => ({
      useRescueV2Store: (sel: (s: { project: RescueProjectDTO; refresh: typeof refresh }) => unknown) => sel({ project: reading, refresh }),
    }));
    const { useRescuePolling } = await import("@/hooks/useRescuePolling");
    useRescuePolling();
    const stopPolling = effects[1]();
    expect(appListener).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(1);

    pending[0].resolve();
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
    if (typeof stopPolling === "function") stopPolling();
  });

  it("a screen waiting on staff (18, or 17 with a review asked for) polls slowly while focused, and stops on blur", async () => {
    vi.useFakeTimers();
    const focus: (() => void | (() => void))[] = [];
    const refresh = vi.fn(async () => {});
    const waiting = dto("A", "failed", { failure: { code: "not_same_thesis", reviewRequested: true } });
    vi.doMock("react", () => ({ useEffect: () => {}, useCallback: <T,>(fn: T) => fn }));
    vi.doMock("react-native", () => ({
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    }));
    vi.doMock("expo-router", () => ({ useFocusEffect: (fn: () => void | (() => void)) => { focus.push(fn); } }));
    vi.doMock("@/stores/rescue-v2-store", () => ({
      useRescueV2Store: (sel: (s: { project: RescueProjectDTO; refresh: typeof refresh }) => unknown) => sel({ project: waiting, refresh }),
    }));
    const { useRescuePolling } = await import("@/hooks/useRescuePolling");
    useRescuePolling();
    const blur = focus[0]();
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).not.toHaveBeenCalled();                    // not the 3 s run poll
    await vi.advanceTimersByTimeAsync(22000);
    expect(refresh).toHaveBeenCalledTimes(1);
    if (typeof blur === "function") blur();
    await vi.advanceTimersByTimeAsync(100000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("an HTTP error without a code is server_unavailable, not network (fix 4)", () => {
  it("a status with no code (a proxy's 502 page) is server_unavailable", async () => {
    api.getRescueProject.mockRejectedValueOnce(httpError(502));
    await S().open("A");
    expect(S().errorCode).toBe("server_unavailable");
  });

  it("a request that got no answer is still network", async () => {
    api.getRescueProject.mockRejectedValueOnce(new TypeError("Network request failed"));
    await S().open("A");
    expect(S().errorCode).toBe("network");
  });

  it("a 2xx whose body is not JSON (the JSON parse fails) is server_unavailable", async () => {
    api.getRescueProject.mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"));
    await S().open("A");
    expect(S().errorCode).toBe("server_unavailable");
  });

  it("an error with its own code keeps that code", async () => {
    api.getRescueProject.mockRejectedValueOnce(httpError(409, "stale_version"));
    await S().open("A");
    expect(S().errorCode).toBe("stale_version");
  });
});

describe("open(null) and the upload state (fix 7)", () => {
  it("a part that lands a 2xx with no JSON (the upload module's server_unavailable) is shown, not an empty project", async () => {
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart.mockRejectedValueOnce(Object.assign(new Error("upload: no JSON reply"), { status: 200, code: "server_unavailable" }));
    const ok = await S().begin([f("a.docx")], "picker");
    expect(ok).toBe(false);
    expect(S().errorCode).toBe("server_unavailable");
    expect(S().projectId).toBe("A");
    expect(S().project?.id).toBe("A");
  });
});

describe("retryLast repeats what failed (fix 8)", () => {
  it("a failed create is repeated with the same files", async () => {
    api.createRescueProject.mockRejectedValueOnce(httpError(502)).mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart.mockResolvedValueOnce(dto("A", "reading"));
    expect(await S().begin([f("a.docx")], "picker")).toBe(false);
    expect(S().errorCode).toBe("server_unavailable");
    await S().retryLast();
    expect(api.createRescueProject).toHaveBeenCalledTimes(2);
    expect(api.createRescueProject.mock.calls[1]).toEqual(api.createRescueProject.mock.calls[0]);
    expect(S().projectId).toBe("A");
    expect(S().errorCode).toBeNull();
  });

  it("a failed retry replaces the record, so the next retry repeats the retry", async () => {
    api.createRescueProject
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(409, "second_failure"))
      .mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart.mockResolvedValueOnce(dto("A", "reading"));
    await S().begin([f("a.docx")], "picker");
    await S().retryLast();
    expect(S().errorCode).toBe("second_failure");
    await S().retryLast();
    expect(api.createRescueProject).toHaveBeenCalledTimes(3);
    expect(S().projectId).toBe("A");
    expect(S().errorCode).toBeNull();
  });

  it("a failed page list is repeated for the same pages, and the error clears when it lands", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    api.getVersionPages
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ count: 3, pages: [{ page: 2, hash: "h2", url: "u2" }] });
    await S().loadPages("A-v1", 2, 2);
    expect(S().errorCode).toBe("server_unavailable");
    await S().retryLast();
    expect(api.getVersionPages).toHaveBeenLastCalledWith("A-v1", 2, 2);
    expect(S().pages["A-v1"]?.byPage[2]?.hash).toBe("h2");
    expect(S().errorCode).toBeNull();
  });

  it("a failed loadVersions is repeated", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    api.listVersions
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ versions: [{ id: "vA" }], edited: { edited: false, changedBlocks: null, afterVersionN: null } });
    await S().loadVersions();
    await S().retryLast();
    expect(api.listVersions).toHaveBeenCalledTimes(2);
    expect(S().versions).toEqual([{ id: "vA" }]);
    expect(S().errorCode).toBeNull();
  });

  it("a failed apply is repeated with the same call", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const call = vi.fn().mockRejectedValueOnce(httpError(409, "conflict")).mockResolvedValueOnce(dto("A", "done"));
    expect(await S().apply(call)).toBe(false);
    expect(S().errorCode).toBe("conflict");
    await S().retryLast();
    expect(call).toHaveBeenCalledTimes(2);
    expect(S().errorCode).toBeNull();
  });

  it("a part that failed is re-sent from that part", async () => {
    api.createRescueProject.mockResolvedValueOnce(dto("A", "uploading"));
    up.uploadPart
      .mockResolvedValueOnce(dto("A", "uploading"))
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce(dto("A", "reading"));
    await S().begin([f("a.docx"), f("b.docx")], "picker");
    expect(S().errorCode).toBe("server_unavailable");
    await S().retryLast();
    expect(up.uploadPart).toHaveBeenCalledTimes(3);
    expect(up.uploadPart.mock.calls[2][1]).toBe(1);
    expect(S().errorCode).toBeNull();
  });

  it("with nothing recorded, retryLast re-reads the project", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().open("A");
    api.getRescueProject.mockResolvedValueOnce(dto("A", "reading"));
    await S().retryLast();
    expect(api.getRescueProject).toHaveBeenLastCalledWith("A");
  });

  it("a success clears the record: a later retry does not repeat an old failure", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const call = vi.fn().mockRejectedValueOnce(httpError(409, "conflict"));
    await S().apply(call);
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().refresh();
    expect(S().errorCode).toBeNull();
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().retryLast();
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("a failed student action is never hidden by a poll (apply exempt from the order check)", () => {
  it("a poll that landed after the apply started does not hide the apply's failure", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().open("A");
    const call = deferred<RescueProjectDTO>();
    const ap = S().apply(() => call.p);
    api.getRescueProject.mockResolvedValueOnce(dto("A", "done"));
    await S().refresh();
    call.reject(httpError(409, "conflict"));
    await ap;
    expect(S().errorCode).toBe("conflict");
  });
});

describe("a re-run waits for the queued edits to reach the server (P-66)", () => {
  // An open thesis project whose re-run is about to be created. The flush is the thesis' queue, drained before the re-run shifts its indices.
  const openThesis = () => {
    useRescueV2Store.setState({ projectId: "T", project: dto("T", "done", { thesisId: "TH1", originalVersionId: "T-v0" }) });
  };

  it("does not create the re-run when the queue did not drain, and says so", async () => {
    openThesis();
    doc.flushOps.mockResolvedValueOnce(false);
    expect(await S().beginRerun([f("rerun.docx")])).toBe(false);
    expect(api.createRerun).not.toHaveBeenCalled();
    expect(S().errorCode).toBe("edits_not_saved");
    expect(S().upload).toBeNull();
    expect(S().nav.overlay).toBeNull();
  });

  it("does not create the re-run when the flush throws", async () => {
    openThesis();
    doc.flushOps.mockRejectedValueOnce(new Error("boom"));
    expect(await S().beginRerun([])).toBe(false);
    expect(api.createRerun).not.toHaveBeenCalled();
    expect(S().errorCode).toBe("edits_not_saved");
  });

  it("the Retry on the line flushes again and then starts the re-run", async () => {
    openThesis();
    doc.flushOps.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    api.createRerun.mockResolvedValueOnce(dto("T", "uploading", { thesisId: "TH1", activeVersionId: "T-v2" }));
    await S().beginRerun([]);
    expect(api.createRerun).not.toHaveBeenCalled();
    await S().retryLast();
    expect(doc.flushOps).toHaveBeenCalledTimes(2);
    expect(api.createRerun).toHaveBeenCalledTimes(1);
    expect(S().errorCode).toBeNull();
    expect(S().project?.activeVersionId).toBe("T-v2");
  });

  it("a drained queue starts the re-run as before", async () => {
    openThesis();
    api.createRerun.mockResolvedValueOnce(dto("T", "uploading", { thesisId: "TH1", activeVersionId: "T-v2" }));
    await S().beginRerun([]);
    expect(api.createRerun).toHaveBeenCalledTimes(1);
    expect(S().errorCode).toBeNull();
  });
});

describe("a failed open never shows the upload screen (item 14)", () => {
  it("a project that fails to open is marked as an open failure, with no project", async () => {
    api.getRescueProject.mockRejectedValueOnce(httpError(502));
    await S().open("A");
    expect(S().projectId).toBe("A");
    expect(S().project).toBeNull();
    expect(S().openFailed).toBe(true);
    expect(S().errorCode).toBe("server_unavailable");
  });

  it("Retry repeats the open and lands on the view that was asked for", async () => {
    api.getRescueProject.mockRejectedValueOnce(httpError(502)).mockResolvedValueOnce(dto("A", "done"));
    await S().open("A", "history");
    expect(S().openFailed).toBe(true);
    await S().retryLast();
    expect(api.getRescueProject).toHaveBeenCalledTimes(2);
    expect(S().project?.id).toBe("A");
    expect(S().nav.overlay).toBe("timeline");
    expect(S().openFailed).toBe(false);
    expect(S().errorCode).toBeNull();
  });

  it("a failed refresh of a project already on screen does not replace it", async () => {
    useRescueV2Store.setState({ projectId: "A", project: dto("A", "done") });
    api.getRescueProject.mockRejectedValueOnce(httpError(502));
    await S().open("A");
    expect(S().project?.id).toBe("A");
    expect(S().openFailed).toBe(false);
  });
});

describe("a supervisor note is sent once while it is in flight (item 11)", () => {
  it("a second send of the same text while the first is in flight sends nothing new", async () => {
    useRescueV2Store.setState({ projectId: "N", project: dto("N", "done") });
    const first = deferred<RescueProjectDTO>();
    api.sendNote.mockReturnValueOnce(first.p);
    const a = S().sendSupervisorNote("Changer la marge");
    const b = S().sendSupervisorNote("Changer la marge");
    expect(api.sendNote).toHaveBeenCalledTimes(1);
    first.resolve(dto("N", "done")); expect(await a).toBe(true); expect(await b).toBe(true);
  });

  it("a different text is sent on its own", async () => {
    useRescueV2Store.setState({ projectId: "N", project: dto("N", "done") });
    api.sendNote.mockResolvedValue(dto("N", "done"));
    await Promise.all([S().sendSupervisorNote("une"), S().sendSupervisorNote("deux")]);
    expect(api.sendNote).toHaveBeenCalledTimes(2);
  });

  it("once the send has landed, the same text may be sent again", async () => {
    useRescueV2Store.setState({ projectId: "N", project: dto("N", "done") });
    api.sendNote.mockResolvedValue(dto("N", "done"));
    await S().sendSupervisorNote("encore");
    await S().sendSupervisorNote("encore");
    expect(api.sendNote).toHaveBeenCalledTimes(2);
  });

  it("a landed send clears the draft that held the same text", async () => {
    useRescueV2Store.setState({ projectId: "N", project: dto("N", "done") });
    useHistoryUi.getState().setDraft("N", "clear me");
    api.sendNote.mockResolvedValue(dto("N", "done"));
    await S().sendSupervisorNote("clear me");
    expect(useHistoryUi.getState().draft).toBe("");
  });

  it("a failed send keeps the draft, so the student does not lose it", async () => {
    useRescueV2Store.setState({ projectId: "N", project: dto("N", "done") });
    useHistoryUi.getState().setDraft("N", "keep me");
    api.sendNote.mockRejectedValueOnce(httpError(409, "note_parsing"));
    expect(await S().sendSupervisorNote("keep me")).toBe(false);
    expect(useHistoryUi.getState().draft).toBe("keep me");
  });
});

describe("a changed project reads its impact again at once (item 12)", () => {
  it("a project that changed marks its impact loading, so the CTA waits for the new reply", async () => {
    useRescueV2Store.setState({ projectId: "I", project: dto("I", "done", { rules: null }) });
    useHistoryUi.getState().setImpact("I", "ok", { scope: "pages", pages: [1], toc: false, nextN: 2, changedBlocks: 1 } as never);
    api.getRescueProject.mockResolvedValueOnce(dto("I", "done", { rules: { fields: [] } }));
    await S().refresh();
    expect(useHistoryUi.getState().impact.state).toBe("loading");
  });

  it("a poll that changes nothing leaves the impact as it was", async () => {
    useRescueV2Store.setState({ projectId: "I", project: dto("I", "done", { rules: null }) });
    useHistoryUi.getState().setImpact("I", "ok", { scope: "pages", pages: [1], toc: false, nextN: 2, changedBlocks: 1 } as never);
    api.getRescueProject.mockResolvedValueOnce(dto("I", "done", { rules: null }));
    await S().refresh();
    expect(useHistoryUi.getState().impact.state).toBe("ok");
  });
});

describe("a re-run or a restore is started once, and restore never repeats from the line (items 7 and 10)", () => {
  const openThesis = () => {
    useRescueV2Store.setState({ projectId: "T", project: dto("T", "done", { thesisId: "TH1", originalVersionId: "T-v0" }) });
  };

  it("a second re-run press while the first is flushing does not create a second re-run", async () => {
    openThesis();
    const flush = deferred<boolean>();
    doc.flushOps.mockReturnValueOnce(flush.p);
    api.createRerun.mockResolvedValue(dto("T", "uploading", { thesisId: "TH1", activeVersionId: "T-v2" }));
    const first = S().beginRerun([]);
    expect(await S().beginRerun([])).toBe(false);
    flush.resolve(true);
    await first;
    expect(api.createRerun).toHaveBeenCalledTimes(1);
  });

  it("the guard holds after the screen is left and reopened: the second press still starts nothing", async () => {
    openThesis();
    const flush = deferred<boolean>();
    doc.flushOps.mockReturnValueOnce(flush.p);
    const first = S().beginRerun([]);
    S().reset();
    openThesis();
    expect(await S().beginRerun([])).toBe(false);
    flush.resolve(true);
    await first;
    expect(api.createRerun).not.toHaveBeenCalled();
  });

  it("a restore whose queue did not drain sends nothing and says so", async () => {
    openThesis();
    doc.flushOps.mockResolvedValueOnce(false);
    expect(await S().restoreVersion("T-v1")).toBe("unsaved");
    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect(S().errorCode).toBeNull();
  });

  it("a restore on a drained queue lands the project it returns", async () => {
    openThesis();
    api.restoreVersion.mockResolvedValueOnce(dto("T", "done", { thesisId: "TH1", originalVersionId: "T-v0", activeVersionId: "T-v3" }));
    expect(await S().restoreVersion("T-v1")).toBe("restored");
    expect(api.restoreVersion).toHaveBeenCalledWith("T-v1");
    expect(S().project?.activeVersionId).toBe("T-v3");
  });

  it("a second restore while one is in flight sends nothing", async () => {
    openThesis();
    const first = deferred<RescueProjectDTO>();
    api.restoreVersion.mockReturnValueOnce(first.p);
    const a = S().restoreVersion("T-v1");
    expect(await S().restoreVersion("T-v1")).toBe("busy");
    first.resolve(dto("T", "done", { thesisId: "TH1" }));
    expect(await a).toBe("restored");
    expect(api.restoreVersion).toHaveBeenCalledTimes(1);
  });

  it("a failed restore is not recorded for the line's Retry, so Retry sends no restore", async () => {
    openThesis();
    api.restoreVersion.mockRejectedValueOnce(httpError(409, "rescue_wrong_stage"));
    expect(await S().restoreVersion("T-v1")).toBe("failed");
    expect(S().errorCode).toBeNull();
    await S().retryLast();
    expect(api.restoreVersion).toHaveBeenCalledTimes(1);
  });
});

describe("loadVersions answers whether the read landed (items 8 and 9)", () => {
  it("answers true when the list is read, and false when it failed", async () => {
    useRescueV2Store.setState({ projectId: "L", project: dto("L", "done") });
    api.listVersions.mockResolvedValueOnce({ versions: [], edited: { edited: true, changedBlocks: 2, afterVersionN: 1 } });
    expect(await S().loadVersions()).toBe(true);
    expect(S().edited?.edited).toBe(true);
    api.listVersions.mockRejectedValueOnce(httpError(502));
    expect(await S().loadVersions()).toBe(false);
  });
});

describe("re-opening the project already on screen (a deep link with the same projectId)", () => {
  it("open() for the open project reads it again and lands the new answer", async () => {
    api.getRescueProject.mockResolvedValueOnce(dto("A", "failed", { failure: { code: "not_same_thesis", reviewRequested: true } }));
    await S().open("A");
    api.getRescueProject.mockResolvedValueOnce(dto("A", "repairing"));
    await S().open("A");
    expect(api.getRescueProject).toHaveBeenCalledTimes(2);
    expect(S().project?.phase).toBe("repairing");
    expect(S().firstLoad).toBe(false);
  });

  it("reopenIfOpen re-reads only the project the living screen shows", async () => {
    api.getRescueProject.mockResolvedValue(dto("A", "done"));
    await S().open("A");
    expect(reopenIfOpen({ projectId: "A" })).toBe(false);          // screen not mounted
    S().setScreenOpen(true);
    expect(reopenIfOpen({ projectId: "B" })).toBe(false);          // another project: the navigation opens it
    expect(reopenIfOpen(null)).toBe(false);
    expect(reopenIfOpen({ projectId: "A", view: "history" })).toBe(true);
    await tick();
    expect(api.getRescueProject).toHaveBeenCalledTimes(2);
    expect(S().nav.overlay).toBe("timeline");
  });
});
