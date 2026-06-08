import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCelsius,
  formatCpuPercent,
  formatCpuPercentPrecise,
  formatCpuTime,
  formatPercent,
  formatRate,
  formatStartTime,
  formatUptime,
  UNAVAILABLE_TEXT,
} from "@/lib/format";

describe("formatPercent", () => {
  it("renders one fractional digit", () => {
    expect(formatPercent(42)).toBe("42.0%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(3.456)).toBe("3.5%");
  });

  it("clamps into 0-100", () => {
    expect(formatPercent(-5)).toBe("0.0%");
    expect(formatPercent(150)).toBe("100.0%");
  });

  it("is unavailable for non-finite input", () => {
    expect(formatPercent(Number.NaN)).toBe(UNAVAILABLE_TEXT);
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(UNAVAILABLE_TEXT);
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

  it("is unavailable for negative or non-finite input", () => {
    expect(formatBytes(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatBytes(Number.NaN)).toBe(UNAVAILABLE_TEXT);
  });
});

describe("formatRate", () => {
  it("appends /s to a byte size, inheriting formatBytes precision", () => {
    // Sub-GB rates are whole (MB tier has no decimals); GB+ keeps one digit.
    expect(formatRate(1.2 * 1024 * 1024)).toBe("1 MB/s");
    expect(formatRate(1.2 * 1024 * 1024 * 1024)).toBe("1.2 GB/s");
    expect(formatRate(0)).toBe("0 B/s");
  });

  it("is unavailable for negative or non-finite input", () => {
    expect(formatRate(-1)).toBe(UNAVAILABLE_TEXT);
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe(UNAVAILABLE_TEXT);
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

  it("renders a real epoch as a non-empty local string", () => {
    // The exact text is locale/timezone dependent, so assert it produced a
    // concrete (non-unavailable) string rather than a specific format.
    const text = formatStartTime(Date.UTC(2025, 9, 29, 15, 34, 39));
    expect(text).not.toBe(UNAVAILABLE_TEXT);
    expect(text).toContain("2025");
  });
});
