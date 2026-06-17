import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCelsius,
  formatCpuPercent,
  formatCpuPercentPrecise,
  formatCpuTime,
  formatPercentParts,
  formatRateParts,
  formatStartTime,
  formatUptime,
  UNAVAILABLE_TEXT,
} from "@/lib/format";

describe("formatPercentParts", () => {
  it("renders one fractional digit with a % unit", () => {
    expect(formatPercentParts(42)).toEqual({ value: "42.0", unit: "%" });
    expect(formatPercentParts(0)).toEqual({ value: "0.0", unit: "%" });
    expect(formatPercentParts(3.456)).toEqual({ value: "3.5", unit: "%" });
  });

  it("clamps into 0-100", () => {
    expect(formatPercentParts(-5)).toEqual({ value: "0.0", unit: "%" });
    expect(formatPercentParts(150)).toEqual({ value: "100.0", unit: "%" });
  });

  it("is unavailable (no unit) for non-finite input", () => {
    expect(formatPercentParts(Number.NaN)).toEqual({ value: UNAVAILABLE_TEXT, unit: "" });
    expect(formatPercentParts(Number.POSITIVE_INFINITY)).toEqual({ value: UNAVAILABLE_TEXT, unit: "" });
  });
});

describe("formatCpuPercent", () => {
  it("is NOT clamped at 100 (Activity Monitor semantics)", () => {
    expect(formatCpuPercent(240)).toBe("240.0%");
  });

  it("floors negative noise at 0", () => {
    expect(formatCpuPercent(-1)).toBe("0.0%");
  });

  it("is unavailable for non-finite input", () => {
    expect(formatCpuPercent(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatCpuPercentPrecise", () => {
  it("renders two fractional digits, uncapped", () => {
    expect(formatCpuPercentPrecise(13.041)).toBe("13.04%");
    expect(formatCpuPercentPrecise(105)).toBe("105.00%");
  });

  it("floors negatives and rejects non-finite", () => {
    expect(formatCpuPercentPrecise(-2)).toBe("0.00%");
    expect(formatCpuPercentPrecise(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatBytes", () => {
  it("keeps sub-GB values whole and GB+ to one decimal", () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatBytes(15.6 * 1024 * 1024 * 1024)).toBe("15.6 GB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("treats values below 1 byte as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(0.4)).toBe("0 B");
  });

  it("adds one decimal in precise mode", () => {
    // Precise adds a digit to each tier: whole MB -> one decimal, GB -> two.
    expect(formatBytes(512.4 * 1024 * 1024, true)).toBe("512.4 MB");
    expect(formatBytes(15.63 * 1024 * 1024 * 1024, true)).toBe("15.63 GB");
  });

  it("scales into TB and PB with one decimal", () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatBytes(5 * 1024 ** 5)).toBe("5.0 PB");
  });

  it("caps at the largest unit instead of overflowing past PB", () => {
    // 2048 PB has no larger unit; the loop must stop at PB rather than index
    // past BYTE_UNITS into an undefined suffix.
    expect(formatBytes(2048 * 1024 ** 5)).toBe("2048.0 PB");
  });

  it("promotes on the rounded value instead of rendering 1024", () => {
    // 1023.5 KB rounds to 1024; it must promote to 1 MB, never read "1024 KB".
    expect(formatBytes(1023.5 * 1024)).toBe("1 MB");
    expect(formatBytes(1023.997 * 1024 ** 3, true)).toBe("1.00 TB");
  });

  it("is unavailable for negative or non-finite input", () => {
    expect(formatBytes(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatBytes(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatRateParts", () => {
  it("keeps sub-10 values to one decimal and larger values whole", () => {
    expect(formatRateParts(1.2 * 1024 * 1024)).toEqual({ value: "1.2", unit: "MB/s" });
    expect(formatRateParts(45 * 1024)).toEqual({ value: "45", unit: "KB/s" });
    expect(formatRateParts(0)).toEqual({ value: "0", unit: "B/s" });
  });

  it("promotes the unit at 1000 so the number never exceeds three digits", () => {
    // 1018 B/s would be four digits wide; it must read as ~1 KB/s instead.
    expect(formatRateParts(1018)).toEqual({ value: "1.0", unit: "KB/s" });
    expect(formatRateParts(999 * 1024)).toEqual({ value: "999", unit: "KB/s" });
    expect(formatRateParts(1000 * 1024)).toEqual({ value: "1.0", unit: "MB/s" });
  });

  it("promotes on the rounded value instead of rendering 1000", () => {
    // 999.7 rounds to 1000 - four digits; it must promote instead.
    expect(formatRateParts(999.7)).toEqual({ value: "1.0", unit: "KB/s" });
    expect(formatRateParts(999.7 * 1024)).toEqual({ value: "1.0", unit: "MB/s" });
  });

  it("is unavailable (no unit) for negative or non-finite input", () => {
    expect(formatRateParts(-1)).toEqual({ value: UNAVAILABLE_TEXT, unit: "" });
    expect(formatRateParts(Number.POSITIVE_INFINITY)).toEqual({ value: UNAVAILABLE_TEXT, unit: "" });
  });
});


describe("formatUptime", () => {
  it("shows the two most significant units", () => {
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(formatUptime(8 * 60)).toBe("8m");
    expect(formatUptime(45)).toBe("45s");
  });

  it("is unavailable for negative or non-finite input", () => {
    expect(formatUptime(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatUptime(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});


describe("formatCpuTime", () => {
  it("uses h:mm:ss above an hour (no centiseconds)", () => {
    expect(formatCpuTime(3661 * 1_000_000_000)).toBe("1:01:01");
  });

  it("uses m:ss.cc below an hour", () => {
    // 40 minutes 31.84 seconds.
    expect(formatCpuTime((40 * 60 + 31.84) * 1_000_000_000)).toBe("40:31.84");
  });

  it("uses Ns.cc below a minute", () => {
    expect(formatCpuTime(4.62 * 1_000_000_000)).toBe("4.62s");
    expect(formatCpuTime(0)).toBe("0.00s");
  });

  it("truncates just below a minute instead of rounding into 60.00s", () => {
    expect(formatCpuTime(59.996 * 1_000_000_000)).toBe("59.99s");
  });

  it("is unavailable for negative or non-finite input", () => {
    expect(formatCpuTime(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatCpuTime(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatCelsius", () => {
  it("rounds to whole degrees", () => {
    expect(formatCelsius(48.4)).toBe("48°C");
    expect(formatCelsius(48.6)).toBe("49°C");
  });

  it("is unavailable for non-finite input", () => {
    expect(formatCelsius(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatStartTime", () => {
  it("is unavailable for non-positive or non-finite epochs", () => {
    expect(formatStartTime(0)).toBe(UNAVAILABLE_TEXT);
    expect(formatStartTime(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatStartTime(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });

  it("is unavailable for an epoch beyond the JS Date range", () => {
    expect(formatStartTime(8.7e15)).toBe(UNAVAILABLE_TEXT);
  });

  it("renders a real epoch as a non-empty local string", () => {
    // The exact text is locale/timezone dependent, so assert it produced a
    // concrete (non-unavailable) string rather than a specific format.
    const text = formatStartTime(Date.UTC(2025, 9, 29, 15, 34, 39));
    expect(text).not.toBe(UNAVAILABLE_TEXT);
    expect(text).toContain("2025");
  });
});
