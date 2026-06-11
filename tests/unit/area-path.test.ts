import { describe, expect, it } from "vitest";
import { areaRuns } from "@/domain/area-path";

const identity = (sample: number) => sample;

describe("areaRuns", () => {
  it("returns no runs for empty or all-null history", () => {
    expect(areaRuns([], 60, identity, 100, -1)).toEqual([]);
    expect(areaRuns([null, null], 58, identity, 100, -1)).toEqual([]);
  });

  it("pads a single sample to a full slot so it stays visible", () => {
    const [run] = areaRuns([10], 59, identity, 100, -1);
    expect(run.edge).toBe("M 59,90 L 59.5,90 L 60,90");
    expect(run.fill).toBe("M 59,100 L 59,90 L 59.5,90 L 60,90 L 60,100 Z");
  });

  it("splits runs at null samples", () => {
    const runs = areaRuns([10, null, 20], 0, identity, 100, -1);
    expect(runs).toHaveLength(2);
    expect(runs[0].edge).toBe("M 0,90 L 0.5,90 L 1,90");
    expect(runs[1].edge).toBe("M 2,80 L 2.5,80 L 3,80");
  });

  it("extends from the baseline downward for direction 1", () => {
    const [run] = areaRuns([46], 0, identity, 50, 1);
    expect(run.edge).toBe("M 0,96 L 0.5,96 L 1,96");
    expect(run.fill).toBe("M 0,50 L 0,96 L 0.5,96 L 1,96 L 1,50 Z");
  });
});
