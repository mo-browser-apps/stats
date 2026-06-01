/**
 * Main-internal metric domain types.
 *
 * These describe the sampler's output independently of the generated protobuf
 * shape. The metrics service maps them onto `MetricsSnapshot` for the renderer.
 * Keeping a separate domain type lets the sampler express "not yet determined"
 * vs "tried and unavailable" cleanly without depending on the wire enum.
 */

/**
 * Availability of a single sampled metric group.
 *
 * - `unknown`: not yet determined (e.g. CPU before a second tick exists for a
 *   delta). The renderer shows a pending placeholder, not a value.
 * - `ok`: the value was read and is meaningful.
 * - `unavailable`: the source was tried and could not be read reliably.
 */
export type ReadingStatus = "unknown" | "ok" | "unavailable";

/** Aggregate CPU usage plus static identity. */
export interface CpuReading {
  status: ReadingStatus;
  /** 0-100 aggregate usage across all logical cores. */
  usagePercent: number;
  /** CPU model string; empty when unknown. */
  model: string;
  /** Logical core count; 0 when unknown. */
  coreCount: number;
}

/** Physical memory usage in bytes plus derived percent. */
export interface MemoryReading {
  status: ReadingStatus;
  usedBytes: number;
  totalBytes: number;
  /** 0-100 used percentage. */
  usedPercent: number;
}

/** Capacity of the main system volume in bytes plus derived percent. */
export interface DiskReading {
  status: ReadingStatus;
  usedBytes: number;
  totalBytes: number;
  /** Space available to the current (unprivileged) user; see the sampler. */
  freeBytes: number;
  /** 0-100 used percentage. */
  usedPercent: number;
}

/** Instantaneous network throughput derived from interface counter deltas. */
export interface NetworkReading {
  status: ReadingStatus;
  /** Receive (download) rate in bytes per second. */
  rxBytesPerSec: number;
  /** Transmit (upload) rate in bytes per second. */
  txBytesPerSec: number;
}

/** System uptime in seconds plus the 1/5/15 minute load averages. */
export interface UptimeReading {
  status: ReadingStatus;
  uptimeSeconds: number;
  /** 1/5/15 minute averages when the platform provides them; otherwise empty. */
  loadAverage: number[];
}

/**
 * One sampling pass. CPU, memory, disk, and uptime come from Node `os`/`fs`;
 * network comes from the native counter probe. Temperature is owned by a later
 * iteration and is published as explicit unavailable by the metrics service.
 */
export interface MetricsReading {
  cpu: CpuReading;
  memory: MemoryReading;
  disk: DiskReading;
  network: NetworkReading;
  uptime: UptimeReading;
}
