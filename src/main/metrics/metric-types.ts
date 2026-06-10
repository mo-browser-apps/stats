/**
 * Main-internal metric domain types describing the sampler's output,
 * independently of the generated protobuf shape. The metrics service maps them
 * onto `MetricsSnapshot`. A separate domain type lets the sampler distinguish
 * "not yet determined" from "tried and unavailable" without the wire enum.
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

/**
 * Aggregate CPU usage plus static identity.
 */
export interface CpuReading {
  status: ReadingStatus;
  /**
   * 0-100 aggregate usage across all logical cores.
   */
  usagePercent: number;
  /**
   * CPU model string; empty when unknown.
   */
  model: string;
  /**
   * Logical core count; 0 when unknown.
   */
  coreCount: number;
  /**
   * 1/5/15 minute load averages when the platform provides them.
   */
  loadAverage: number[];
}

/**
 * Physical memory usage in bytes plus derived percent.
 */
export interface MemoryReading {
  status: ReadingStatus;
  /**
   * Memory in use after excluding reclaimable cache.
   */
  usedBytes: number;
  totalBytes: number;
  /**
   * Memory available to apps, including reclaimable cache.
   */
  availableBytes: number;
  /**
   * Reclaimable cached files/purgeable memory.
   */
  cachedBytes: number;
  /**
   * 0-100 used percentage.
   */
  usedPercent: number;
}

/**
 * Capacity of the main system volume in bytes plus derived percent.
 */
export interface DiskReading {
  status: ReadingStatus;
  usedBytes: number;
  totalBytes: number;
  /**
   * Space available to the current (unprivileged) user.
   */
  freeBytes: number;
  /**
   * 0-100 used percentage.
   */
  usedPercent: number;
}

/**
 * Instantaneous network throughput derived from interface counter deltas.
 */
export interface NetworkReading {
  status: ReadingStatus;
  /**
   * Receive (download) rate in bytes per second.
   */
  rxBytesPerSec: number;
  /**
   * Transmit (upload) rate in bytes per second.
   */
  txBytesPerSec: number;
}

/**
 * System uptime in seconds. Load average moved to {@link CpuReading}.
 */
export interface UptimeReading {
  status: ReadingStatus;
  uptimeSeconds: number;
}

/**
 * Optional CPU temperature. Best-effort: macOS has no documented public CPU
 * temperature source on Apple Silicon, so this is frequently `unavailable`.
 */
export interface TemperatureReading {
  status: ReadingStatus;
  /**
   * CPU-core temperature in degrees Celsius; 0 when not `ok`.
   */
  celsius: number;
}

/**
 * One sampling pass. CPU, memory, disk, and uptime come from Node `os`/`fs`;
 * network and temperature come from the native probes. Temperature is optional
 * and frequently `unavailable` on Apple Silicon.
 */
export interface MetricsReading {
  cpu: CpuReading;
  memory: MemoryReading;
  disk: DiskReading;
  network: NetworkReading;
  uptime: UptimeReading;
  temperature: TemperatureReading;
}
