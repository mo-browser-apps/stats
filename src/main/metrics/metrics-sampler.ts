import * as os from "node:os";
import { CpuReading, MemoryReading, MetricsReading, UptimeReading } from "./metric-types";

/**
 * Aggregate CPU tick counters summed across all logical cores, in milliseconds.
 * Mirrors the categories Node exposes per core via `os.cpus()[].times`.
 */
interface CpuTicks {
  /** user + nice + sys + irq: time the CPU was doing work. */
  busy: number;
  /** busy + idle: total observed CPU time. */
  total: number;
}

/**
 * Samples the system metrics that are reliable from Node/TypeScript: CPU usage,
 * CPU identity, memory, uptime, and load average.
 *
 * CPU usage is a delta between successive samples (no single call yields an
 * instantaneous percentage), so this class is stateful: it holds the previous
 * aggregate tick counters. The first sample has no delta and reports CPU as
 * `unknown`; subsequent samples report `ok`. Disk, network, and temperature are
 * intentionally out of scope here and owned by later iterations.
 *
 * Technique reference: the CPU tick-delta math follows exelban/stats'
 * `Modules/CPU/readers.swift` host_cpu_load_info approach, re-implemented over
 * Node's `os.cpus()` counters; no upstream code is copied.
 *
 * Every group is sampled defensively: a failure in one group degrades only that
 * group to `unavailable` and never throws, so one bad source cannot poison the
 * whole snapshot or crash the main process.
 */
export class MetricsSampler {
  private previousCpuTicks: CpuTicks | null = null;

  /** Produces one reading of all TypeScript-sampled metric groups. */
  sample(): MetricsReading {
    return {
      cpu: this.sampleCpu(),
      memory: this.sampleMemory(),
      uptime: this.sampleUptime(),
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
      const model = cores[0]?.model ?? "";
      const coreCount = cores.length;

      const current = aggregateCpuTicks(cores);
      const previous = this.previousCpuTicks;
      this.previousCpuTicks = current;

      if (previous === null) {
        // First sample: no delta yet. Pending until the next tick.
        return { status: "unknown", usagePercent: 0, model, coreCount };
      }

      const busyDelta = current.busy - previous.busy;
      const totalDelta = current.total - previous.total;

      if (totalDelta <= 0 || busyDelta < 0) {
        // Zero/negative delta (idle tick, counter reset, or core-count change):
        // not a meaningful percentage this tick.
        return { status: "unknown", usagePercent: 0, model, coreCount };
      }

      const usagePercent = clampPercent((busyDelta / totalDelta) * 100);
      return { status: "ok", usagePercent, model, coreCount };
    } catch {
      this.previousCpuTicks = null;
      return { status: "unavailable", usagePercent: 0, model: "", coreCount: 0 };
    }
  }

  /** Physical memory usage from Node `os` totals. */
  private sampleMemory(): MemoryReading {
    try {
      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      if (totalBytes <= 0) {
        return { status: "unavailable", usedBytes: 0, totalBytes: 0, usedPercent: 0 };
      }

      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = clampPercent((usedBytes / totalBytes) * 100);
      return { status: "ok", usedBytes, totalBytes, usedPercent };
    } catch {
      return { status: "unavailable", usedBytes: 0, totalBytes: 0, usedPercent: 0 };
    }
  }

  /** System uptime and load average from Node `os`. */
  private sampleUptime(): UptimeReading {
    try {
      const uptimeSeconds = Math.max(0, Math.floor(os.uptime()));
      // loadavg() is Unix-specific; on platforms without it the entries are 0.
      const loadAverage = os.loadavg().filter((value) => Number.isFinite(value));
      return { status: "ok", uptimeSeconds, loadAverage };
    } catch {
      return { status: "unavailable", uptimeSeconds: 0, loadAverage: [] };
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

/** Clamps a percentage into the 0-100 range; non-finite values become 0. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
