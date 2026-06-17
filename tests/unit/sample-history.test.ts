import { describe, expect, it } from "vitest";
import { pickedIndexAtFraction, pushSample, sampleIndexAtFraction } from "@/domain/sample-history";

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

describe("pickedIndexAtFraction", () => {
  it("returns null when empty", () => {
    expect(pickedIndexAtFraction(0.5, 0)).toBeNull();
  });

  it("returns null over the unfilled left region instead of clamping (resume gesture)", () => {
    // Hover clamps the empty left to the oldest sample; a click there is null,
    // so the detail view reads it as "resume live" rather than picking tick 0.
    expect(sampleIndexAtFraction(0, 10, 60)).toBe(0);
    expect(pickedIndexAtFraction(0, 10, 60)).toBeNull();
  });

  it("maps a click within the filled region to that sample", () => {
    expect(pickedIndexAtFraction(1, 10, 60)).toBe(9);
    expect(pickedIndexAtFraction(1, 60, 60)).toBe(59);
    expect(pickedIndexAtFraction(0, 60, 60)).toBe(0);
  });
});
