import { describe, expect, it } from "vitest";
import { MetricStatus } from "@/gen/metrics";
import { baseState, isLive, usageState } from "@/domain/metric-view";

describe("baseState", () => {
  it("maps OK to ok", () => {
    expect(baseState(MetricStatus.METRIC_STATUS_OK)).toBe("ok");
  });

  it("maps UNAVAILABLE to unavailable", () => {
    expect(baseState(MetricStatus.METRIC_STATUS_UNAVAILABLE)).toBe("unavailable");
  });

  it("maps UNKNOWN (and anything else) to pending", () => {
    expect(baseState(MetricStatus.METRIC_STATUS_UNKNOWN)).toBe("pending");
    expect(baseState(MetricStatus.UNRECOGNIZED)).toBe("pending");
  });
});

describe("usageState", () => {
  it("refines an OK metric by the default thresholds", () => {
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 10)).toBe("ok");
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 70)).toBe("elevated");
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 89.9)).toBe("elevated");
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 90)).toBe("critical");
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 100)).toBe("critical");
  });

  it("honors custom thresholds", () => {
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 50, 40, 80)).toBe("elevated");
    expect(usageState(MetricStatus.METRIC_STATUS_OK, 85, 40, 80)).toBe("critical");
  });

  it("passes non-OK base states through unchanged", () => {
    expect(usageState(MetricStatus.METRIC_STATUS_UNAVAILABLE, 95)).toBe("unavailable");
    expect(usageState(MetricStatus.METRIC_STATUS_UNKNOWN, 95)).toBe("pending");
  });

  it("treats a non-finite percent on an OK metric as unavailable", () => {
    expect(usageState(MetricStatus.METRIC_STATUS_OK, Number.NaN)).toBe("unavailable");
  });
});

describe("isLive", () => {
  it("is true for ok/elevated/critical", () => {
    expect(isLive("ok")).toBe(true);
    expect(isLive("elevated")).toBe(true);
    expect(isLive("critical")).toBe(true);
  });

  it("is false for pending/unavailable", () => {
    expect(isLive("pending")).toBe(false);
    expect(isLive("unavailable")).toBe(false);
  });
});
