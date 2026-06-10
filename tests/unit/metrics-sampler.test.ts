import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests the stateful metric delta math through the real {@link MetricsSampler},
 * driving synthetic samples. The native gen module runs a MoBrowser-runtime-only
 * binding at import, and `os`/`fs` read the real machine, so all three are mocked;
 * `performance.now` is stubbed so network rate windows are deterministic.
 */
const h = vi.hoisted(() => ({
  readMemory: vi.fn(),
  readNetwork: vi.fn(),
  readTemp: vi.fn(),
  cpus: vi.fn(),
  statfsSync: vi.fn(),
  uptime: vi.fn(),
  loadavg: vi.fn(),
}));

vi.mock("@main/gen/native", () => ({
  native: {
    memory: { ReadUsage: h.readMemory },
    network: { ReadCounters: h.readNetwork },
    temperature: { ReadCpuTemperature: h.readTemp },
  },
}));
vi.mock("node:os", () => ({ cpus: h.cpus, uptime: h.uptime, loadavg: h.loadavg }));
vi.mock("node:fs", () => ({ statfsSync: h.statfsSync }));

import { MetricsSampler } from "@main/metrics/metrics-sampler";

const GB = 1024 * 1024 * 1024;

/** Builds one logical core's tick counters (ms). */
function core(model: string, busy: number, idle: number) {
  // Put all "busy" time in user; the sampler sums user+nice+sys+irq.
  return { model, speed: 0, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

/** Controls performance.now() so elapsed windows are exact. */
let clockMs = 0;

beforeEach(() => {
  vi.clearAllMocks();
  clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);

  // Sensible defaults; individual tests override.
  h.cpus.mockReturnValue([core("M2", 0, 100)]);
  h.statfsSync.mockReturnValue({ blocks: 100, bsize: GB, bavail: 40 });
  h.uptime.mockReturnValue(3600);
  h.loadavg.mockReturnValue([1.5, 1.0, 0.5]);
  h.readMemory.mockResolvedValue({ available: false, totalBytes: 0, usedBytes: 0, availableBytes: 0, cachedBytes: 0 });
  h.readNetwork.mockResolvedValue({ available: false, rxBytes: 0, txBytes: 0 });
  h.readTemp.mockResolvedValue({ available: false, celsius: 0 });
});

describe("CPU delta math", () => {
  it("reports unknown on the first sample (no delta yet)", async () => {
    const sampler = new MetricsSampler();
    const reading = await sampler.sample();
    expect(reading.cpu.status).toBe("unknown");
  });

  it("computes usage from busy/total tick deltas on the second sample", async () => {
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 100, 100)]); // busy 100, total 200
    await sampler.sample();
    h.cpus.mockReturnValue([core("M2", 175, 125)]); // +75 busy, +25 idle -> 75/100 = 75%
    const reading = await sampler.sample();
    expect(reading.cpu.status).toBe("ok");
    expect(reading.cpu.usagePercent).toBeCloseTo(75);
  });

  it("reports unknown on a zero-delta (idle) tick", async () => {
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 100, 100)]);
    await sampler.sample();
    // Identical counters: totalDelta 0 -> unknown, not a fake 0%.
    const reading = await sampler.sample();
    expect(reading.cpu.status).toBe("unknown");
  });

  it("reports unknown when the counters went backwards (reset)", async () => {
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 500, 500)]);
    await sampler.sample();
    h.cpus.mockReturnValue([core("M2", 100, 100)]); // busy delta negative
    const reading = await sampler.sample();
    expect(reading.cpu.status).toBe("unknown");
  });

  it("clamps usage into 0-100", async () => {
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 0, 0)]);
    await sampler.sample();
    // Busy grows far more than total would allow -> clamped at 100.
    h.cpus.mockReturnValue([core("M2", 1000, 0)]);
    const reading = await sampler.sample();
    expect(reading.cpu.status).toBe("ok");
    expect(reading.cpu.usagePercent).toBe(100);
  });

  it("degrades CPU to unavailable when os.cpus() throws, and re-arms after", async () => {
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 100, 100)]);
    await sampler.sample(); // establish a baseline

    h.cpus.mockImplementationOnce(() => {
      throw new Error("os boom");
    });
    const failed = await sampler.sample();
    expect(failed.cpu.status).toBe("unavailable");
    // Other groups stay produced.
    expect(failed.uptime.status).toBe("ok");

    // The catch reset the baseline, so the next successful read is a first sample
    // again (unknown), not a delta against the pre-failure ticks.
    h.cpus.mockReturnValue([core("M2", 500, 500)]);
    expect((await sampler.sample()).cpu.status).toBe("unknown");
  });
});

describe("network delta math", () => {
  it("reports unknown on the first sample (no baseline)", async () => {
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1000, txBytes: 2000 });
    const sampler = new MetricsSampler();
    const reading = await sampler.sample();
    expect(reading.network.status).toBe("unknown");
  });

  it("computes per-second rates over the elapsed window", async () => {
    const sampler = new MetricsSampler();
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1000, txBytes: 5000 });
    clockMs = 1000;
    await sampler.sample();
    // +2000 rx, +1000 tx over 2 seconds -> 1000 B/s rx, 500 B/s tx.
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 3000, txBytes: 6000 });
    clockMs = 3000;
    const reading = await sampler.sample();
    expect(reading.network.status).toBe("ok");
    expect(reading.network.rxBytesPerSec).toBe(1000);
    expect(reading.network.txBytesPerSec).toBe(500);
  });

  it("drops a negative delta (counter reset) to a 0 rate", async () => {
    const sampler = new MetricsSampler();
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1_000_000, txBytes: 1_000_000 });
    clockMs = 1000;
    await sampler.sample();
    // Counters went backwards (interface reset): rate clamps to 0, no spike.
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 10, txBytes: 10 });
    clockMs = 2000;
    const reading = await sampler.sample();
    expect(reading.network.status).toBe("ok");
    expect(reading.network.rxBytesPerSec).toBe(0);
    expect(reading.network.txBytesPerSec).toBe(0);
  });

  it("drops an impossible forward jump (> 100 Gbps) to a 0 rate", async () => {
    const sampler = new MetricsSampler();
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 0, txBytes: 0 });
    clockMs = 1000;
    await sampler.sample();
    // 1 TB in 1 second is far above the plausible ceiling -> treated as a
    // discontinuity (e.g. a reconnect handing back a fresh counter) -> 0.
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1_000_000_000_000, txBytes: 0 });
    clockMs = 2000;
    const reading = await sampler.sample();
    expect(reading.network.rxBytesPerSec).toBe(0);
  });

  it("reports unavailable and re-arms the baseline when counters are unavailable", async () => {
    const sampler = new MetricsSampler();
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1000, txBytes: 1000 });
    clockMs = 1000;
    await sampler.sample();
    // Counters drop out -> unavailable; the baseline is cleared.
    h.readNetwork.mockResolvedValue({ available: false, rxBytes: 0, txBytes: 0 });
    clockMs = 2000;
    expect((await sampler.sample()).network.status).toBe("unavailable");
    // Next available sample is a first sample again -> unknown, not a giant rate.
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 9999, txBytes: 9999 });
    clockMs = 3000;
    expect((await sampler.sample()).network.status).toBe("unknown");
  });

  it("reports unknown when the clock did not advance (no divide-by-zero rate)", async () => {
    const sampler = new MetricsSampler();
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 1000, txBytes: 1000 });
    clockMs = 5000;
    await sampler.sample();
    // Two samples at the same timestamp: elapsed <= 0 -> unknown, never a rate.
    h.readNetwork.mockResolvedValue({ available: true, rxBytes: 9000, txBytes: 9000 });
    const reading = await sampler.sample();
    expect(reading.network.status).toBe("unknown");
  });
});

describe("disk", () => {
  it("computes used/free/percent from statfs blocks", async () => {
    h.statfsSync.mockReturnValue({ blocks: 100, bsize: GB, bavail: 40 }); // 100 GB total, 40 free
    const reading = await new MetricsSampler().sample();
    expect(reading.disk.status).toBe("ok");
    expect(reading.disk.totalBytes).toBe(100 * GB);
    expect(reading.disk.freeBytes).toBe(40 * GB);
    expect(reading.disk.usedBytes).toBe(60 * GB);
    expect(reading.disk.usedPercent).toBe(60);
  });

  it("degrades only disk to unavailable when the total is non-positive", async () => {
    h.statfsSync.mockReturnValue({ blocks: 0, bsize: GB, bavail: 0 });
    const reading = await new MetricsSampler().sample();
    expect(reading.disk.status).toBe("unavailable");
    // Other groups are unaffected (uptime still ok).
    expect(reading.uptime.status).toBe("ok");
  });

  it("degrades only disk to unavailable when statfs throws", async () => {
    h.statfsSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const reading = await new MetricsSampler().sample();
    expect(reading.disk.status).toBe("unavailable");
    expect(reading.uptime.status).toBe("ok");
  });
});

describe("memory", () => {
  it("maps an available reading and clamps values to the total", async () => {
    h.readMemory.mockResolvedValue({
      available: true,
      totalBytes: 16 * GB,
      usedBytes: 8 * GB,
      availableBytes: 8 * GB,
      cachedBytes: 2 * GB,
    });
    const reading = await new MetricsSampler().sample();
    expect(reading.memory.status).toBe("ok");
    expect(reading.memory.usedBytes).toBe(8 * GB);
    expect(reading.memory.usedPercent).toBe(50);
  });

  it("clamps an over-total used value to the total", async () => {
    h.readMemory.mockResolvedValue({
      available: true,
      totalBytes: 16 * GB,
      usedBytes: 99 * GB, // implausible; clamps to total
      availableBytes: 0,
      cachedBytes: 0,
    });
    const reading = await new MetricsSampler().sample();
    expect(reading.memory.usedBytes).toBe(16 * GB);
    expect(reading.memory.usedPercent).toBe(100);
  });

  it("is unavailable when the native probe reports unavailable", async () => {
    h.readMemory.mockResolvedValue({ available: false, totalBytes: 0, usedBytes: 0, availableBytes: 0, cachedBytes: 0 });
    expect((await new MetricsSampler().sample()).memory.status).toBe("unavailable");
  });

  it("is unavailable when available but the total is non-finite (garbage probe)", async () => {
    h.readMemory.mockResolvedValue({
      available: true,
      totalBytes: Number.NaN,
      usedBytes: 8 * GB,
      availableBytes: 0,
      cachedBytes: 0,
    });
    // A NaN/<=0 total must not divide into a nonsense percent.
    expect((await new MetricsSampler().sample()).memory.status).toBe("unavailable");
  });
});

describe("temperature", () => {
  it("is ok with a finite reading when the probe reports available", async () => {
    h.readTemp.mockResolvedValue({ available: true, celsius: 57.3 });
    const reading = await new MetricsSampler().sample();
    expect(reading.temperature.status).toBe("ok");
    expect(reading.temperature.celsius).toBeCloseTo(57.3);
  });

  it("is unavailable when the probe reports unavailable", async () => {
    h.readTemp.mockResolvedValue({ available: false, celsius: 0 });
    expect((await new MetricsSampler().sample()).temperature.status).toBe("unavailable");
  });

  it("is unavailable when the probe returns a non-finite value", async () => {
    h.readTemp.mockResolvedValue({ available: true, celsius: Number.NaN });
    expect((await new MetricsSampler().sample()).temperature.status).toBe("unavailable");
  });

  it("is unavailable when the probe returns an implausible value", async () => {
    h.readTemp.mockResolvedValue({ available: true, celsius: 300 });
    expect((await new MetricsSampler().sample()).temperature.status).toBe("unavailable");
  });

  it("reads ok temperature live on every tick (no caching)", async () => {
    h.readTemp
      .mockResolvedValueOnce({ available: true, celsius: 57.3 })
      .mockResolvedValueOnce({ available: true, celsius: 64.1 });

    const sampler = new MetricsSampler();
    expect((await sampler.sample()).temperature.celsius).toBeCloseTo(57.3);
    expect(h.readTemp).toHaveBeenCalledTimes(1);

    // Same tick clock, but an ok reading is never cached: the next sample probes
    // again and reflects the latest value.
    expect((await sampler.sample()).temperature.celsius).toBeCloseTo(64.1);
    expect(h.readTemp).toHaveBeenCalledTimes(2);
  });

  it("recovers to ok on the very next tick after a transient unavailable", async () => {
    h.readTemp
      .mockResolvedValueOnce({ available: false, celsius: 0 })
      .mockResolvedValueOnce({ available: true, celsius: 48.2 });

    const sampler = new MetricsSampler();
    expect((await sampler.sample()).temperature.status).toBe("unavailable");
    expect(h.readTemp).toHaveBeenCalledTimes(1);

    const reading = await sampler.sample();
    expect(reading.temperature.status).toBe("ok");
    expect(reading.temperature.celsius).toBeCloseTo(48.2);
    expect(h.readTemp).toHaveBeenCalledTimes(2);
  });

  it("re-probes every tick while unavailable (no caching of unavailable)", async () => {
    h.readTemp.mockResolvedValue({ available: false, celsius: 0 });

    const sampler = new MetricsSampler();
    expect((await sampler.sample()).temperature.status).toBe("unavailable");
    expect((await sampler.sample()).temperature.status).toBe("unavailable");
    expect((await sampler.sample()).temperature.status).toBe("unavailable");
    expect(h.readTemp).toHaveBeenCalledTimes(3);
  });
});

describe("uptime", () => {
  it("reports floored uptime", async () => {
    h.uptime.mockReturnValue(123.9);
    const reading = await new MetricsSampler().sample();
    expect(reading.uptime.status).toBe("ok");
    expect(reading.uptime.uptimeSeconds).toBe(123);
  });

  it("degrades only uptime to unavailable when os.uptime() throws", async () => {
    h.uptime.mockImplementation(() => {
      throw new Error("uptime boom");
    });
    const reading = await new MetricsSampler().sample();
    expect(reading.uptime.status).toBe("unavailable");
    // Disk (another sync group) is unaffected.
    expect(reading.disk.status).toBe("ok");
  });
});

describe("load average", () => {
  it("reports finite load averages on the CPU reading", async () => {
    h.loadavg.mockReturnValue([2.5, 1.25, 0.75]);
    const reading = await new MetricsSampler().sample();
    expect(reading.cpu.loadAverage).toEqual([2.5, 1.25, 0.75]);
  });

  it("drops non-finite load entries (e.g. a platform without loadavg)", async () => {
    h.loadavg.mockReturnValue([1.5, Number.NaN, Number.POSITIVE_INFINITY]);
    const reading = await new MetricsSampler().sample();
    expect(reading.cpu.loadAverage).toEqual([1.5]);
  });

  it("keeps the CPU usage reading even when loadavg() throws", async () => {
    h.loadavg.mockImplementation(() => {
      throw new Error("loadavg boom");
    });
    // Two samples with a real tick delta so usage is meaningful (first is always
    // pending); load failing independently must not downgrade that usage status.
    const sampler = new MetricsSampler();
    h.cpus.mockReturnValue([core("M2", 100, 100)]);
    await sampler.sample();
    h.cpus.mockReturnValue([core("M2", 175, 125)]); // +75 busy / +100 total = 75%
    const reading = await sampler.sample();
    expect(reading.cpu.loadAverage).toEqual([]);
    expect(reading.cpu.status).toBe("ok");
    expect(reading.cpu.usagePercent).toBeCloseTo(75);
  });
});

describe("failure isolation", () => {
  it("a native memory rejection degrades only memory, not the snapshot", async () => {
    h.readMemory.mockRejectedValue(new Error("native boom"));
    const reading = await new MetricsSampler().sample();
    expect(reading.memory.status).toBe("unavailable");
    // CPU/disk/uptime are still produced.
    expect(reading.disk.status).toBe("ok");
    expect(reading.uptime.status).toBe("ok");
  });
});
