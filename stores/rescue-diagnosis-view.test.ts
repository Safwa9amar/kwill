import { beforeEach, describe, expect, it } from "vitest";
import type { RescueDotDTO } from "@/types/rescue-v2";
import { useDiagnosisView } from "./rescue-diagnosis-view";

const V = () => useDiagnosisView.getState();
const dot = (n: number, page: number, chip: RescueDotDTO["chip"]): RescueDotDTO =>
  ({ n, chip, code: "margins", page, topPct: 0.5, params: {} }) as RescueDotDTO;
const dots = [dot(1, 2, "headings"), dot(2, 2, "toc"), dot(3, 4, "headings")];

beforeEach(() => {
  useDiagnosisView.setState({ key: null, page: 1, chip: null, selectedN: null });
});

describe("the diagnosis view", () => {
  it("opens on the first page holding a dot, with that page's first dot selected", () => {
    V().ensure("p1", "v1", dots);
    expect(V().page).toBe(2);
    expect(V().selectedN).toBe(1);
    expect(V().chip).toBeNull();
  });

  it("starts over for another project, and keeps the place for the same one", () => {
    V().ensure("p1", "v1", dots);
    V().goTo(4, dots);
    V().ensure("p1", "v1", dots);
    expect(V().page).toBe(4);
    V().ensure("p2", "v1", dots);
    expect(V().page).toBe(2);
  });

  it("starts over for the same project at another version, so a re-run never keeps the old page or dot", () => {
    V().ensure("p1", "v1", dots);
    V().goTo(4, dots);
    V().select(3);
    V().pickChip("toc", dots);
    V().ensure("p1", "v2", dots);
    expect(V().page).toBe(2);
    expect(V().chip).toBeNull();
    expect(V().selectedN).toBe(1);
  });

  it("a chip filters, jumps to the next page holding it, and selects its first dot", () => {
    V().ensure("p1", "v1", dots);
    V().pickChip("headings", dots);
    expect(V().chip).toBe("headings");
    expect(V().page).toBe(4);
    expect(V().selectedN).toBe(3);
  });

  it("a chip picked again clears the filter and keeps the page", () => {
    V().ensure("p1", "v1", dots);
    V().pickChip("toc", dots);
    V().pickChip("toc", dots);
    expect(V().chip).toBeNull();
    expect(V().page).toBe(2);
    expect(V().selectedN).toBe(1);
  });

  it("a swipe to a page selects that page's first dot under the filter", () => {
    V().ensure("p1", "v1", dots);
    V().pickChip("headings", dots);
    V().goTo(2, dots);
    expect(V().selectedN).toBe(1);
  });
});
