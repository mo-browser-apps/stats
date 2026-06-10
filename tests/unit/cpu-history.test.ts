import { describe, expect, it } from "vitest";
import { pushSample, sampleIndexAtFraction } from "@/domain/cpu-history";

describe("pushSample", () => {
  it("appends and keeps at most capacity newest entries", () => {
    expect(pushSample([1, 2], 3, 3)).toEqual([1, 2, 3]);
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("keeps null gap samples", () => {
    expect(pushSample([1], null, 3)).toEqual([1, null]);
  });
});

describe("sampleIndexAtFraction", () => {
  it("returns null when empty", () => {
    expect(sampleIndexAtFraction(0.5, 0)).toBeNull();
  });

  it("maps the right edge to the newest filled sample", () => {
    expect(sampleIndexAtFraction(1, 10, 60)).toBe(9);
  });

  it("clamps the empty left region to the oldest sample", () => {
    expect(sampleIndexAtFraction(0, 10, 60)).toBe(0);
  });

  it("maps a full buffer linearly", () => {
    expect(sampleIndexAtFraction(0, 60, 60)).toBe(0);
    expect(sampleIndexAtFraction(1, 60, 60)).toBe(59);
  });
});
