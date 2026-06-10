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

import { MetricStatus } from "@main/gen/metrics";
import { MetricsService } from "@main/metrics/metrics-service";

const PUBLISH_INTERVAL_MS = 1000;
const UNAVAILABLE = MetricStatus.METRIC_STATUS_UNAVAILABLE;

/** A minimal reading; the gating tests only care about call counts. */
function emptyReading() {
  return {
    cpu: { status: UNAVAILABLE, usagePercent: 0 },
    memory: {
      status: UNAVAILABLE,
      usedBytes: 0,
      totalBytes: 0,
      availableBytes: 0,
      cachedBytes: 0,
      appBytes: 0,
      wiredBytes: 0,
      compressedBytes: 0,
      usedPercent: 0,
    },
    disk: { status: UNAVAILABLE, usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 },
    network: { status: UNAVAILABLE, rxBytesPerSec: 0, txBytesPerSec: 0 },
    uptime: { status: UNAVAILABLE, uptimeSeconds: 0 },
    temperature: { status: UNAVAILABLE, celsius: 0 },
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

describe("MetricsService publish robustness", () => {
  /** A promise plus its resolver, so a test can hold a sample pending. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("skips a tick while a previous publish is still in flight", async () => {
    const service = new MetricsService();
    const pending = deferred<ReturnType<typeof emptyReading>>();
    // First sample never resolves during the window, so it stays in flight.
    h.sample.mockReturnValueOnce(pending.promise);

    service.setActive(true);
    await flush();
    expect(h.sample).toHaveBeenCalledTimes(1); // immediate publish started

    // A full interval elapses while the first publish is unresolved: the overlap
    // guard must skip rather than stack a second concurrent sample.
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(h.sample).toHaveBeenCalledTimes(1);

    // Once it resolves, the cadence resumes on the next tick.
    pending.resolve(emptyReading());
    await flush();
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(h.sample).toHaveBeenCalledTimes(2);
  });

  it("survives a delivery failure and keeps the cadence (never rejects)", async () => {
    const service = new MetricsService();
    // The first StreamSnapshots throws; the floating publish must swallow it.
    h.streamSnapshots.mockImplementationOnce(() => {
      throw new Error("delivery boom");
    });

    service.setActive(true);
    await flush();
    expect(h.streamSnapshots).toHaveBeenCalledTimes(1);

    // The next tick still samples and delivers - no dead cadence, no unhandled
    // rejection from the swallowed error.
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(h.sample).toHaveBeenCalledTimes(2);
    expect(h.streamSnapshots).toHaveBeenCalledTimes(2);
  });

  it("does not deliver a publish that resolves after dispose", async () => {
    const service = new MetricsService();
    const pending = deferred<ReturnType<typeof emptyReading>>();
    h.sample.mockReturnValueOnce(pending.promise);

    service.setActive(true);
    await flush();
    expect(h.sample).toHaveBeenCalledTimes(1);

    // Dispose while the sample is still pending, then let it resolve.
    service.dispose();
    pending.resolve(emptyReading());
    await flush();

    // The post-dispose resolution must not reach the (disposed) stream.
    expect(h.streamSnapshots).not.toHaveBeenCalled();
  });
});
