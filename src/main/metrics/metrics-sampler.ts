import * as fs from "node:fs";
import * as os from "node:os";
import { native } from "../gen/native";
import {
  CpuReading,
  DiskReading,
  MemoryReading,
  MetricsReading,
  NetworkReading,
  TemperatureReading,
  UptimeReading,
} from "./metric-types";

/**
 * Filesystem path of the main system volume on macOS.
 */
const SYSTEM_VOLUME_PATH = "/";

/**
 * Temperature values outside this Celsius range are treated as bad sensor data.
 */
const MIN_PLAUSIBLE_TEMPERATURE_CELSIUS = 10;
const MAX_PLAUSIBLE_TEMPERATURE_CELSIUS = 120;

/**
 * Upper bound on a plausible per-interface throughput, in bytes per second
 * (100 Gbps). A single-tick delta above this is treated as a counter
 * discontinuity and dropped to a 0 rate rather than reported as a spike. The
 * ceiling sits well above any current Mac NIC so it never clips real traffic.
 */
const MAX_PLAUSIBLE_BYTES_PER_SEC = 100_000_000_000 / 8;

/**
 * Cumulative interface byte counters captured at a point in time.
 */
interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
  /**
   * `performance.now()`-style monotonic timestamp in milliseconds.
   */
  atMs: number;
}

/**
 * Aggregate CPU tick counters summed across all logical cores, in milliseconds.
 * Mirrors the categories Node exposes per core via `os.cpus()[].times`.
 */
interface CpuTicks {
  /**
   * user + nice + sys + irq: time the CPU was doing work.
   */
  busy: number;
  /**
   * busy + idle: total observed CPU time.
   */
  total: number;
}

/**
 * Samples the system metrics for one snapshot: CPU usage, CPU identity, load
 * average, memory, disk capacity, network throughput, uptime, and optional CPU
 * temperature. CPU/disk/uptime come from Node `os`/`fs`; memory, network
 * throughput, and temperature come from native probes (Node cannot expose the
 * macOS VM cache breakdown, rx/tx byte counters, or thermal sensors).
 *
 * CPU usage and network throughput are deltas between successive samples, so
 * this class is stateful: it holds the previous CPU tick counters and the
 * previous network byte counters. The first sample of each has no delta and
 * reports `unknown`; subsequent samples report `ok`. Temperature is best-effort
 * and frequently `unavailable` on Apple Silicon (no documented public sensor).
 *
 * Every group is sampled defensively: a failure in one group degrades only that
 * group to `unavailable` and never throws, so one bad source cannot poison the
 * whole snapshot or crash the main process.
 */
export class MetricsSampler {
  private previousCpuTicks: CpuTicks | null = null;

  private previousNetworkCounters: NetworkCounters | null = null;

  /**
   * Produces one reading of all sampled metric groups. Async because the network
   * counters and temperature are read over native RPCs; the Node `os`/`fs` groups
   * are synchronous and gathered first.
   */
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
   *
   * Returns `unknown` (not a fake 0%) when there is no previous sample to diff
   * against, or when the delta is non-positive - which also covers a zero-delta
   * tick and a logical-core-count change that would make a raw delta meaningless.
   */
  private sampleCpu(): CpuReading {
    try {
      const cores = os.cpus();

      const current = aggregateCpuTicks(cores);
      const previous = this.previousCpuTicks;
      this.previousCpuTicks = current;

      if (previous === null) {
        // First sample: no delta yet. Pending until the next tick.
        return { status: "unknown", usagePercent: 0 };
      }

      const busyDelta = current.busy - previous.busy;
      const totalDelta = current.total - previous.total;

      if (totalDelta <= 0 || busyDelta < 0) {
        // Zero/negative delta (idle tick, counter reset, or core-count change):
        // not a meaningful percentage this tick.
        return { status: "unknown", usagePercent: 0 };
      }

      const usagePercent = clampPercent((busyDelta / totalDelta) * 100);
      return { status: "ok", usagePercent };
    } catch {
      this.previousCpuTicks = null;
      return { status: "unavailable", usagePercent: 0 };
    }
  }

  /**
   * Physical memory usage from the native macOS VM-statistics probe.
   */
  private async sampleMemory(): Promise<MemoryReading> {
    try {
      const usage = await native.memory.ReadUsage({});
      if (!usage.available || !Number.isFinite(usage.totalBytes) || usage.totalBytes <= 0) {
        return unavailableMemory();
      }

      const totalBytes = usage.totalBytes;
      const usedBytes = clampBytes(usage.usedBytes, totalBytes);
      const availableBytes = clampBytes(usage.availableBytes, totalBytes);
      const cachedBytes = clampBytes(usage.cachedBytes, totalBytes);
      const wiredBytes = clampBytes(usage.wiredBytes, usedBytes);
      const compressedBytes = clampBytes(usage.compressedBytes, usedBytes);
      const appBytes = clampBytes(usage.appBytes, usedBytes);
      const usedPercent = clampPercent((usedBytes / totalBytes) * 100);
      return {
        status: "ok",
        usedBytes,
        totalBytes,
        availableBytes,
        cachedBytes,
        appBytes,
        wiredBytes,
        compressedBytes,
        usedPercent,
      };
    } catch {
      return unavailableMemory();
    }
  }

  /**
   * Main system volume capacity via Node's built-in `fs.statfsSync` (no native
   * code). `bavail` is the space available to the current unprivileged user, so
   * it is the honest free figure for a user-facing monitor (it excludes the
   * blocks the filesystem reserves for the superuser); `used` is total minus
   * that available space. A non-positive total degrades disk to `unavailable` to
   * avoid a divide-by-zero, and any read/permission error is caught so only disk
   * degrades, never the whole snapshot.
   */
  private sampleDisk(): DiskReading {
    try {
      const stats = fs.statfsSync(SYSTEM_VOLUME_PATH);
      const totalBytes = stats.blocks * stats.bsize;
      if (totalBytes <= 0) {
        return { status: "unavailable", usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
      }

      const freeBytes = Math.max(0, stats.bavail * stats.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = clampPercent((usedBytes / totalBytes) * 100);
      return { status: "ok", usedBytes, totalBytes, freeBytes, usedPercent };
    } catch {
      return { status: "unavailable", usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
    }
  }

  /**
   * Instantaneous network throughput from the native interface counter probe.
   *
   * The native side sums the kernel's cumulative rx/tx byte counters across the
   * active non-loopback interfaces; this method turns successive readings into a
   * per-second rate over the measured elapsed time. The first sample (or any
   * sample after the counters were unavailable) has no baseline and reports
   * `unknown`, so the card shows a pending placeholder rather than a fake 0 B/s.
   *
   * Counter discontinuities are handled instead of surfaced as spikes: a counter
   * that went backwards (interface reset/reconnect, or a different interface set)
   * yields a 0 rate while the baseline re-arms, and a forward jump above
   * {@link MAX_PLAUSIBLE_BYTES_PER_SEC} is also dropped to 0. A non-positive
   * elapsed time is ignored to avoid dividing by zero. Any native/read error
   * degrades only this group to `unavailable`.
   */
  private async sampleNetwork(): Promise<NetworkReading> {
    try {
      const counters = await native.network.ReadCounters({});
      if (!counters.available) {
        this.previousNetworkCounters = null;
        return { status: "unavailable", rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      const current: NetworkCounters = {
        rxBytes: counters.rxBytes,
        txBytes: counters.txBytes,
        atMs: nowMs(),
      };
      const previous = this.previousNetworkCounters;
      this.previousNetworkCounters = current;

      if (previous === null) {
        // No baseline yet: pending until the next tick produces a delta.
        return { status: "unknown", rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      const elapsedSeconds = (current.atMs - previous.atMs) / 1000;
      if (elapsedSeconds <= 0) {
        return { status: "unknown", rxBytesPerSec: 0, txBytesPerSec: 0 };
      }

      const rxBytesPerSec = rate(current.rxBytes - previous.rxBytes, elapsedSeconds);
      const txBytesPerSec = rate(current.txBytes - previous.txBytes, elapsedSeconds);
      return { status: "ok", rxBytesPerSec, txBytesPerSec };
    } catch {
      this.previousNetworkCounters = null;
      return { status: "unavailable", rxBytesPerSec: 0, txBytesPerSec: 0 };
    }
  }

  /**
   * Optional CPU temperature from the native sensor probe.
   *
   * The native side averages the per-core CPU temperatures from AppleSMC core
   * keys and the HID CPU-core sensors, and reports `available=false` when
   * neither yields a plausible reading. macOS has no documented public CPU
   * temperature source on Apple Silicon, so `unavailable` is an honest outcome
   * here rather than a guessed value. Any native/read error also degrades only
   * this group to `unavailable`.
   */
  private async sampleTemperature(): Promise<TemperatureReading> {
    try {
      const result = await native.temperature.ReadCpuTemperature({});
      if (!result.available || !isPlausibleTemperature(result.celsius)) {
        return { status: "unavailable", celsius: 0 };
      }
      return { status: "ok", celsius: result.celsius };
    } catch {
      return { status: "unavailable", celsius: 0 };
    }
  }

  /**
   * System uptime from Node `os`.
   */
  private sampleUptime(): UptimeReading {
    try {
      const uptimeSeconds = Math.max(0, Math.floor(os.uptime()));
      return { status: "ok", uptimeSeconds };
    } catch {
      return { status: "unavailable", uptimeSeconds: 0 };
    }
  }
}

/**
 * Sums per-core CPU tick categories into a single busy/total pair.
 */
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

/**
 * Clamps a percentage into the 0-100 range; non-finite values become 0.
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Clamps a byte count to the 0-total range; non-finite values become 0.
 */
function clampBytes(value: number, totalBytes: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(totalBytes)) return 0;
  return Math.min(Math.max(0, totalBytes), Math.max(0, value));
}

/**
 * A zeroed, unavailable memory reading. Shared by the early-return and catch
 * paths so the full field set stays in one place as the shape grows.
 */
function unavailableMemory(): MemoryReading {
  return {
    status: "unavailable",
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
 * Converts a byte delta over an elapsed window into a per-second rate. A
 * negative delta (counter reset) or a jump above the plausible ceiling is a
 * discontinuity and yields 0 rather than a spurious spike; non-finite results
 * also yield 0.
 */
function rate(deltaBytes: number, elapsedSeconds: number): number {
  if (deltaBytes < 0) return 0;
  const bytesPerSec = deltaBytes / elapsedSeconds;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec > MAX_PLAUSIBLE_BYTES_PER_SEC) {
    return 0;
  }
  return Math.round(bytesPerSec);
}

/**
 * Monotonic millisecond clock for measuring the elapsed time between counter
 * reads. `performance.now()` is unaffected by wall-clock/NTP adjustments, so the
 * rate stays correct across system time changes.
 */
function nowMs(): number {
  return performance.now();
}
