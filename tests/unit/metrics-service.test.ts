import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests the lifecycle gating of {@link MetricsService}: the sampling cadence (and
 * the native probes it drives) must run only while the service is active, i.e.
 * while the window is visible and the Stats view is on screen. The native gen
 * module binds a MoBrowser-runtime-only addon at import and `ipc.registerService`
 * needs the runtime, so both are mocked; timers are faked so the 1s cadence is
 * driven deterministically.
 */
const h = vi.hoisted(() => ({
  streamSnapshots: vi.fn(),
  disposeHandle: vi.fn(),
  sample: vi.fn(),
}));

vi.mock("@mobrowser/api", () => ({
  ipc: {
    registerService: vi.fn(() => ({
      StreamSnapshots: h.streamSnapshots,
      dispose: h.disposeHandle,
    })),
  },
}));

// The descriptor is only an opaque token passed to the mocked registerService.
vi.mock("@main/gen/ipc_service", () => ({ MetricsServiceDescriptor: {} }));

// Replace the real sampler with a spy so we can count sampling passes without
// touching the machine or the native client. Constructed with `new`, so the mock
// must be a constructable function rather than an arrow.
vi.mock("@main/metrics/metrics-sampler", () => ({
  MetricsSampler: vi.fn(function MockSampler() {
    return { sample: h.sample };
  }),
}));

import { MetricsService } from "@main/metrics/metrics-service";

const PUBLISH_INTERVAL_MS = 1000;

/** A minimal snapshot; the gating tests only care about call counts. */
function emptyReading() {
  return {
    cpu: { status: "unavailable", usagePercent: 0, model: "", coreCount: 0 },
    memory: { status: "unavailable", usedBytes: 0, totalBytes: 0, availableBytes: 0, cachedBytes: 0, usedPercent: 0 },
    disk: { status: "unavailable", usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 },
    network: { status: "unavailable", rxBytesPerSec: 0, txBytesPerSec: 0 },
    uptime: { status: "unavailable", uptimeSeconds: 0, loadAverage: [] },
    temperature: { status: "unavailable", celsius: 0 },
  };
}

/** Lets pending sampler promises settle between fake-timer ticks. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.sample.mockResolvedValue(emptyReading());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MetricsService lifecycle gating", () => {
  it("does not sample before it is activated", async () => {
    new MetricsService();
    await vi.advanceTimersByTimeAsync(5 * PUBLISH_INTERVAL_MS);
    expect(h.sample).not.toHaveBeenCalled();
  });

  it("samples immediately and on each interval while active", async () => {
    const service = new MetricsService();

    service.setActive(true);
    await flush();
    // Resuming emits one snapshot immediately so a freshly shown window paints
    // without waiting a full interval.
    expect(h.sample).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(h.sample).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(h.sample).toHaveBeenCalledTimes(3);
  });

  it("stops sampling once deactivated (window hidden or Stats tab left)", async () => {
    const service = new MetricsService();

    service.setActive(true);
    await vi.advanceTimersByTimeAsync(2 * PUBLISH_INTERVAL_MS);
    const callsWhileActive = h.sample.mock.calls.length;
    expect(callsWhileActive).toBeGreaterThan(0);

    service.setActive(false);
    await vi.advanceTimersByTimeAsync(10 * PUBLISH_INTERVAL_MS);
    // No further sampling after deactivation: the native probes are not touched
    // while hidden / off the Stats view.
    expect(h.sample).toHaveBeenCalledTimes(callsWhileActive);
  });

  it("resumes sampling when reactivated", async () => {
    const service = new MetricsService();

    service.setActive(true);
    await flush();
    service.setActive(false);
    await vi.advanceTimersByTimeAsync(3 * PUBLISH_INTERVAL_MS);
    const callsBeforeResume = h.sample.mock.calls.length;

    service.setActive(true);
    await flush();
    expect(h.sample).toHaveBeenCalledTimes(callsBeforeResume + 1);
  });

  it("does not sample after dispose, even if reactivation is attempted", async () => {
    const service = new MetricsService();

    service.dispose();
    expect(h.disposeHandle).toHaveBeenCalledTimes(1);

    service.setActive(true);
    await vi.advanceTimersByTimeAsync(5 * PUBLISH_INTERVAL_MS);
    expect(h.sample).not.toHaveBeenCalled();
  });
});
