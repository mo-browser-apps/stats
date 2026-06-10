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

/** Temperature values outside this Celsius range are treated as bad sensor data. */
const MIN_PLAUSIBLE_TEMPERATURE_CELSIUS = 10;
const MAX_PLAUSIBLE_TEMPERATURE_CELSIUS = 120;

/**
 * Upper bound on a plausible per-interface throughput (100 Gbps, in bytes/s).
 * A single-tick delta above it is a counter discontinuity, dropped to a 0 rate
 * rather than reported as a spike.
 */
const MAX_PLAUSIBLE_BYTES_PER_SEC = 100_000_000_000 / 8;

/** Cumulative interface byte counters at a monotonic timestamp. */
interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
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

  private previousNetworkCounters: NetworkCounters | null = null;

  async sample(): Promise<MetricsReading> {
    return {
      cpu: this.sampleCpu(),
      memory: await this.sampleMemory(),
      disk: this.sampleDisk(),
      network: await this.sampleNetwork(),
      uptime: this.sampleUptime(),
      temperature: await this.sampleTemperature(),
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
      const usage = await native.memory.ReadUsage({});
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
   * unavailable) or when the clock did not advance; a counter that went
   * backwards re-arms via {@link rate} as a 0 rate instead of a spike.
   */
  private async sampleNetwork(): Promise<NetworkMetric> {
    try {
      const counters = await native.network.ReadCounters({});
      if (!counters.available) {
        this.previousNetworkCounters = null;
        return { status: UNAVAILABLE, rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      const current: NetworkCounters = {
        rxBytes: counters.rxBytes,
        txBytes: counters.txBytes,
        // performance.now() is monotonic, so the rate window survives
        // wall-clock/NTP adjustments.
        atMs: performance.now(),
      };
      const previous = this.previousNetworkCounters;
      this.previousNetworkCounters = current;

      const elapsedSeconds = previous === null ? 0 : (current.atMs - previous.atMs) / 1000;
      if (previous === null || elapsedSeconds <= 0) {
        return { status: UNKNOWN, rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      return {
        status: OK,
        rxBytesPerSec: rate(current.rxBytes - previous.rxBytes, elapsedSeconds),
        txBytesPerSec: rate(current.txBytes - previous.txBytes, elapsedSeconds),
      };
    } catch {
      this.previousNetworkCounters = null;
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
      const result = await native.temperature.ReadCpuTemperature({});
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
