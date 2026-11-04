import { beforeEach, describe, expect, it, vi } from "vitest";

// The hook reaches react-native (BackHandler), expo-router and the API. Each is replaced, so the test runs under node.
vi.hoisted(() => { (globalThis as Record<string, unknown>).__DEV__ = false; });

const api = vi.hoisted(() => ({
  getRescueProject: vi.fn(),
  ackVersion: vi.fn(),
  listVersions: vi.fn(),
  createRescueProject: vi.fn(),
  createRerun: vi.fn(),
  getRescueConfig: vi.fn(),
  getVersionPages: vi.fn(),
  getVersion: vi.fn(),
  saveRules: vi.fn(),
}));
vi.mock("@/lib/rescue-v2-api", () => api);
vi.mock("@/lib/rescue-v2-upload", () => ({ uploadPart: vi.fn() }));
vi.mock("@/lib/rescue-v2-fixtures", () => ({ RESCUE_FIXTURES: {} }));
vi.mock("@/stores/thesis-doc-store", () => ({ useThesisDocStore: { getState: () => ({ flushOps: async () => true }) } }));

const rn = vi.hoisted(() => {
  const remove = vi.fn();
  return { remove, addEventListener: vi.fn(() => ({ remove })) };
});
vi.mock("react-native", () => ({ BackHandler: { addEventListener: rn.addEventListener } }));

const rr = vi.hoisted(() => ({ useFocusEffect: vi.fn(), canGoBack: vi.fn(() => true), back: vi.fn() }));
vi.mock("expo-router", () => ({ router: { canGoBack: rr.canGoBack, back: rr.back }, useFocusEffect: rr.useFocusEffect }));

// The hook's own useCallback only memoises; outside a component it is the identity.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));

import { rescueBack, useRescueBack } from "@/hooks/useRescueBack";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

/** A project the screen maps to the acknowledgement: `not_same_thesis` on a version. */
const failedNotSameThesis = {
  id: "A", phase: "failed", thesisId: null, activeVersionId: "A-v1", title: "", language: null,
  failure: { code: "not_same_thesis", versionId: "A-v1" },
  note: { state: "none" }, setup: { guide: { state: "none" } }, cover: null,
  entitlement: { purchase: { state: "none" }, kind: null }, progress: null,
} as unknown as Parameters<typeof api.getRescueProject.mockResolvedValue>[0];

beforeEach(() => {
  rr.useFocusEffect.mockClear();
  rn.addEventListener.mockClear();
  rn.remove.mockClear();
  api.ackVersion.mockReset();
  useRescueV2Store.getState().reset();
});

describe("the hardware back is registered only while the route is focused (fix 11)", () => {
  it("the listener comes from useFocusEffect and goes on blur", () => {
    useRescueBack();
    expect(rr.useFocusEffect).toHaveBeenCalledTimes(1);
    const effect = rr.useFocusEffect.mock.calls[0][0] as () => () => void;
    const cleanup = effect();
    expect(rn.addEventListener).toHaveBeenCalledWith("hardwareBackPress", rescueBack);
    expect(rn.remove).not.toHaveBeenCalled();
    cleanup();
    expect(rn.remove).toHaveBeenCalledTimes(1);
  });
});

describe("the acknowledgement is sent once per tap-in-flight (fix 11)", () => {
  it("a double tap while the ack is in flight sends one ackVersion", async () => {
    api.getRescueProject.mockResolvedValueOnce(failedNotSameThesis);
    await useRescueV2Store.getState().open("A");
    let finish!: (v: unknown) => void;
    api.ackVersion.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    expect(rescueBack()).toBe(true);
    expect(rescueBack()).toBe(true);
    expect(api.ackVersion).toHaveBeenCalledTimes(1);
    expect(api.ackVersion).toHaveBeenCalledWith("A-v1");
    finish({ ...failedNotSameThesis, phase: "done", failure: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(useRescueV2Store.getState().project?.phase).toBe("done");
  });
});
