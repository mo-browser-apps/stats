import * as fs from "node:fs";
import * as os from "node:os";
import { native } from "../gen/native";
import {
  CpuMetric,
  DiskMetric,
  MemoryMetric,
  MetricStatus,
  NetworkMetric,
  TemperatureMetric,
  UptimeMetric,
} from "../gen/metrics";

const { METRIC_STATUS_UNKNOWN: UNKNOWN, METRIC_STATUS_OK: OK, METRIC_STATUS_UNAVAILABLE: UNAVAILABLE } = MetricStatus;

const SYSTEM_VOLUME_PATH = "/";

/**
 * Hard cap on a native probe RPC. The native calls have no built-in timeout,
 * so a hung probe would otherwise leave the tick promise pending forever and
 * permanently wedge the poll loop (its overlap guard never re-arms). The
 * probes are sub-millisecond syscall reads; the abort rejects into each
 * group's catch, degrading only that group, and the next tick retries.
 */
const NATIVE_CALL_TIMEOUT_MS = 2500;

/** Call options aborting a native probe at the timeout. */
function nativeCallTimeout() {
  return { signal: AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS) };
}

/** Temperature values outside this Celsius range are treated as bad sensor data. */
const MIN_PLAUSIBLE_TEMPERATURE_CELSIUS = 10;
const MAX_PLAUSIBLE_TEMPERATURE_CELSIUS = 120;

/**
 * Upper bound on a plausible machine-wide throughput (100 Gbps, in bytes/s).
 * A single-tick delta above it is a counter discontinuity, dropped to a 0 rate
 * rather than reported as a spike.
 */
const MAX_PLAUSIBLE_BYTES_PER_SEC = 100_000_000_000 / 8;

/** Cumulative per-interface byte counters at a monotonic timestamp. */
interface NetworkSample {
  byName: Map<string, { rxBytes: number; txBytes: number }>;
  atMs: number;
}

/** CPU tick counters summed across all logical cores, in milliseconds. */
interface CpuTicks {
  busy: number;
  total: number;
}

/** One sampling pass: every metric group of a snapshot except the timestamp. */
export interface MetricsReading {
  cpu: CpuMetric;
  memory: MemoryMetric;
  disk: DiskMetric;
  network: NetworkMetric;
  uptime: UptimeMetric;
  temperature: TemperatureMetric;
}

/**
 * Samples all metric groups for one snapshot. CPU/disk/uptime come from Node
 * `os`/`fs`; memory, network throughput, and temperature come from native
 * probes. CPU usage and network throughput are deltas between successive
 * samples, so the sampler is stateful; the first sample of each reports UNKNOWN.
 *
 * Every group is sampled defensively: a failure degrades only that group to
 * UNAVAILABLE and never throws, so one bad source cannot poison the snapshot.
 */
export class MetricsSampler {
  private previousCpuTicks: CpuTicks | null = null;

  private previousNetworkSample: NetworkSample | null = null;

  async sample(): Promise<MetricsReading> {
    // The native probes are independent; sampling them concurrently keeps the
    // pass as fast as the slowest probe. None of them ever rejects (each
    // degrades its own group), so Promise.all cannot throw here.
    const [memory, network, temperature] = await Promise.all([
      this.sampleMemory(),
      this.sampleNetwork(),
      this.sampleTemperature(),
    ]);
    return {
      cpu: this.sampleCpu(),
      memory,
      disk: this.sampleDisk(),
      network,
      uptime: this.sampleUptime(),
      temperature,
    };
  }

  /**
   * Aggregate CPU usage across all logical cores via successive tick deltas.
   * UNKNOWN (not a fake 0%) without a previous sample to diff against, or on a
   * non-positive delta (idle tick, counter reset, core-count change).
   */
  private sampleCpu(): CpuMetric {
    try {
      const current = aggregateCpuTicks(os.cpus());
      const previous = this.previousCpuTicks;
      this.previousCpuTicks = current;

      if (previous === null) {
        return { status: UNKNOWN, usagePercent: 0 };
      }

      const busyDelta = current.busy - previous.busy;
      const totalDelta = current.total - previous.total;
      if (totalDelta <= 0 || busyDelta < 0) {
        return { status: UNKNOWN, usagePercent: 0 };
      }

      return { status: OK, usagePercent: clampPercent((busyDelta / totalDelta) * 100) };
    } catch {
      this.previousCpuTicks = null;
      return { status: UNAVAILABLE, usagePercent: 0 };
    }
  }

  /** Physical memory usage from the native macOS VM-statistics probe. */
  private async sampleMemory(): Promise<MemoryMetric> {
    try {
      const usage = await native.memory.ReadUsage({}, nativeCallTimeout());
      if (!usage.available || !Number.isFinite(usage.totalBytes) || usage.totalBytes <= 0) {
        return unavailableMemory();
      }

      const totalBytes = usage.totalBytes;
      const usedBytes = clampBytes(usage.usedBytes, totalBytes);
      return {
        status: OK,
        usedBytes,
        totalBytes,
        availableBytes: clampBytes(usage.availableBytes, totalBytes),
        cachedBytes: clampBytes(usage.cachedBytes, totalBytes),
        appBytes: clampBytes(usage.appBytes, usedBytes),
        wiredBytes: clampBytes(usage.wiredBytes, usedBytes),
        compressedBytes: clampBytes(usage.compressedBytes, usedBytes),
        usedPercent: clampPercent((usedBytes / totalBytes) * 100),
      };
    } catch {
      return unavailableMemory();
    }
  }

  /**
   * Main system volume capacity via `fs.statfsSync`. `bavail` (space available
   * to the unprivileged user) is the honest free figure; used is total minus it.
   */
  private sampleDisk(): DiskMetric {
    try {
      const stats = fs.statfsSync(SYSTEM_VOLUME_PATH);
      const totalBytes = stats.blocks * stats.bsize;
      if (totalBytes <= 0) {
        return { status: UNAVAILABLE, usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
      }

      const freeBytes = Math.max(0, stats.bavail * stats.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return {
        status: OK,
        usedBytes,
        totalBytes,
        freeBytes,
        usedPercent: clampPercent((usedBytes / totalBytes) * 100),
      };
    } catch {
      return { status: UNAVAILABLE, usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
    }
  }

  /**
   * Network throughput from the native interface counter probe: successive
   * cumulative readings turned into a per-second rate over the measured elapsed
   * time. UNKNOWN without a baseline (first sample, or after the counters were
   * unavailable) or when the clock did not advance.
   *
   * Each interface is diffed against its own previous reading. One seen for
   * the first time has no baseline and contributes nothing that tick, so an
   * interface (re)joining the active set never registers its cumulative total
   * as a burst of traffic; one that left simply stops contributing, and a
   * per-interface counter reset clamps to 0 instead of going negative.
   */
  private async sampleNetwork(): Promise<NetworkMetric> {
    try {
      const counters = await native.network.ReadCounters({}, nativeCallTimeout());
      if (!counters.available) {
        this.previousNetworkSample = null;
        return { status: UNAVAILABLE, rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      const current: NetworkSample = {
        byName: new Map(counters.interfaces.map(
          ({ name, rxBytes, txBytes }) => [name, { rxBytes, txBytes }],
        )),
        // performance.now() is monotonic, so the rate window survives
        // wall-clock/NTP adjustments.
        atMs: performance.now(),
      };
      const previous = this.previousNetworkSample;
      this.previousNetworkSample = current;

      const elapsedSeconds = previous === null ? 0 : (current.atMs - previous.atMs) / 1000;
      if (previous === null || elapsedSeconds <= 0) {
        return { status: UNKNOWN, rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      let rxDelta = 0;
      let txDelta = 0;
      for (const [name, currentCounters] of current.byName) {
        const previousCounters = previous.byName.get(name);
        if (previousCounters === undefined) continue;
        rxDelta += Math.max(0, currentCounters.rxBytes - previousCounters.rxBytes);
        txDelta += Math.max(0, currentCounters.txBytes - previousCounters.txBytes);
      }

      return {
        status: OK,
        rxBytesPerSec: rate(rxDelta, elapsedSeconds),
        txBytesPerSec: rate(txDelta, elapsedSeconds),
      };
    } catch {
      this.previousNetworkSample = null;
      return { status: UNAVAILABLE, rxBytesPerSec: 0, txBytesPerSec: 0 };
    }
  }

  /**
   * Best-effort CPU temperature from the native sensor probe. macOS has no
   * documented public CPU temperature source on Apple Silicon, so UNAVAILABLE
   * is a common, honest outcome.
   */
  private async sampleTemperature(): Promise<TemperatureMetric> {
    try {
      const result = await native.temperature.ReadCpuTemperature({}, nativeCallTimeout());
      if (!result.available || !isPlausibleTemperature(result.celsius)) {
        return { status: UNAVAILABLE, celsius: 0 };
      }
      return { status: OK, celsius: result.celsius };
    } catch {
      return { status: UNAVAILABLE, celsius: 0 };
    }
  }

  private sampleUptime(): UptimeMetric {
    try {
      return { status: OK, uptimeSeconds: Math.max(0, Math.floor(os.uptime())) };
    } catch {
      return { status: UNAVAILABLE, uptimeSeconds: 0 };
    }
  }
}

/** Sums per-core CPU tick categories into a single busy/total pair. */
function aggregateCpuTicks(cores: os.CpuInfo[]): CpuTicks {
  let busy = 0;
  let idle = 0;
  for (const core of cores) {
    const { user, nice, sys, irq, idle: coreIdle } = core.times;
    busy += user + nice + sys + irq;
    idle += coreIdle;
  }
  return { busy, total: busy + idle };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function clampBytes(value: number, totalBytes: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(totalBytes)) return 0;
  return Math.min(Math.max(0, totalBytes), Math.max(0, value));
}

function unavailableMemory(): MemoryMetric {
  return {
    status: UNAVAILABLE,
    usedBytes: 0,
    totalBytes: 0,
    availableBytes: 0,
    cachedBytes: 0,
    appBytes: 0,
    wiredBytes: 0,
    compressedBytes: 0,
    usedPercent: 0,
  };
}

function isPlausibleTemperature(celsius: number): boolean {
  return Number.isFinite(celsius) &&
    celsius >= MIN_PLAUSIBLE_TEMPERATURE_CELSIUS &&
    celsius <= MAX_PLAUSIBLE_TEMPERATURE_CELSIUS;
}

/**
 * Byte delta over an elapsed window as a per-second rate. A negative delta
 * (counter reset), a jump above the plausible ceiling, or a non-finite result
 * yields 0 rather than a spurious spike.
 */
function rate(deltaBytes: number, elapsedSeconds: number): number {
  if (deltaBytes < 0) return 0;
  const bytesPerSec = deltaBytes / elapsedSeconds;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec > MAX_PLAUSIBLE_BYTES_PER_SEC) {
    return 0;
  }
  return Math.round(bytesPerSec);
}
