import { ipc } from "@mobrowser/api";
import {
  CpuMetric,
  DiskMetric,
  MemoryMetric,
  MetricStatus,
  MetricsSnapshot,
  NetworkMetric,
  TemperatureMetric,
  UptimeMetric,
} from "../gen/metrics";
import { MetricsServiceDescriptor } from "../gen/ipc_service";
import { MetricsSampler } from "./metrics-sampler";
import {
  CpuReading,
  DiskReading,
  MemoryReading,
  NetworkReading,
  ReadingStatus,
  TemperatureReading,
  UptimeReading,
} from "./metric-types";

/**
 * Interval between published snapshots, in milliseconds.
 */
const PUBLISH_INTERVAL_MS = 1000;

/**
 * Maps the sampler's internal status onto the generated wire enum.
 */
function toMetricStatus(status: ReadingStatus): MetricStatus {
  switch (status) {
    case "ok":
      return MetricStatus.METRIC_STATUS_OK;
    case "unavailable":
      return MetricStatus.METRIC_STATUS_UNAVAILABLE;
    default:
      return MetricStatus.METRIC_STATUS_UNKNOWN;
  }
}

/**
 * Owns the renderer-facing metrics stream.
 *
 * Registers `MetricsService` as a broadcast stream: every subscriber sees the
 * same tick, so there is a single sampling cadence in main. Each tick the
 * {@link MetricsSampler} is read once and fanned out, so extra subscribers add no
 * sampling work. Network counters and temperature come from native probes, so a
 * tick is async.
 *
 * The cadence runs only while the UI is active. {@link setActive} pauses the
 * interval while the window is hidden and resumes when shown. A tick is skipped
 * while a prior publish is in flight, so a slow probe cannot stack work, and
 * `publish()` never rejects. {@link dispose} stops the interval and closes
 * in-flight subscribers.
 */
export class MetricsService {
  private readonly handle = ipc.registerService(MetricsServiceDescriptor);

  private readonly sampler = new MetricsSampler();

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether the UI is active and snapshots should be sampled and published.
   */
  private active = false;

  /**
   * Set while an async publish is in flight, to guard against overlap.
   */
  private publishing = false;

  /**
   * Set once `dispose()` has run; blocks any further start or publish.
   */
  private disposed = false;

  /**
   * Marks the service active or idle and (re)starts or pauses the cadence to
   * match. Resuming emits one snapshot immediately so a freshly shown window
   * paints without waiting a full interval. Idempotent for repeated calls with
   * the same state.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) {
      return;
    }

    this.active = active;
    if (active) {
      this.startTimer();
    } else {
      this.stopTimer();
    }
  }

  /**
   * Stops the cadence and closes the broadcast stream. Idempotent. After this
   * the service cannot be reactivated; it is intended for app shutdown.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.active = false;
    this.stopTimer();
    this.handle.dispose();
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }

    void this.publish();
    this.timer = setInterval(() => void this.publish(), PUBLISH_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Samples once and publishes the snapshot to every subscriber. Sampling still
   * happens with no subscribers so the cadence stays consistent. Async because
   * the network counters and temperature are read over native RPCs.
   *
   * Never rejects: a tick overlapping an in-flight publish is skipped, and any
   * delivery failure (including a stale publish racing a `dispose()`, which the
   * runtime makes throw) is swallowed so the floating caller never produces an
   * unhandled rejection.
   */
  private async publish(): Promise<void> {
    if (this.publishing || this.disposed) {
      return;
    }

    this.publishing = true;
    try {
      const snapshot = await this.buildSnapshot();
      if (!this.disposed) {
        this.handle.StreamSnapshots(snapshot);
      }
    } catch {
      // Degrade silently: the sampler already maps source failures to
      // unavailable, so reaching here means a delivery/runtime fault. Dropping
      // the tick keeps the cadence alive without an unhandled rejection or a
      // retry storm; the next tick republishes.
    } finally {
      this.publishing = false;
    }
  }

  /**
   * Builds the current snapshot from one sampler reading. Every group carries a
   * live value or an explicit unknown/unavailable status, so a missing source
   * (for example a machine with no readable CPU temperature sensor) degrades only
   * its own card.
   */
  private async buildSnapshot(): Promise<MetricsSnapshot> {
    const reading = await this.sampler.sample();
    return {
      timestampMs: Date.now(),
      cpu: toCpuMetric(reading.cpu),
      memory: toMemoryMetric(reading.memory),
      disk: toDiskMetric(reading.disk),
      network: toNetworkMetric(reading.network),
      uptime: toUptimeMetric(reading.uptime),
      temperature: toTemperatureMetric(reading.temperature),
    };
  }
}

function toCpuMetric(reading: CpuReading): CpuMetric {
  return {
    status: toMetricStatus(reading.status),
    usagePercent: reading.usagePercent,
  };
}

function toMemoryMetric(reading: MemoryReading): MemoryMetric {
  return {
    status: toMetricStatus(reading.status),
    usedBytes: reading.usedBytes,
    totalBytes: reading.totalBytes,
    usedPercent: reading.usedPercent,
    availableBytes: reading.availableBytes,
    cachedBytes: reading.cachedBytes,
    appBytes: reading.appBytes,
    wiredBytes: reading.wiredBytes,
    compressedBytes: reading.compressedBytes,
  };
}

function toDiskMetric(reading: DiskReading): DiskMetric {
  return {
    status: toMetricStatus(reading.status),
    usedBytes: reading.usedBytes,
    totalBytes: reading.totalBytes,
    freeBytes: reading.freeBytes,
    usedPercent: reading.usedPercent,
  };
}

function toNetworkMetric(reading: NetworkReading): NetworkMetric {
  return {
    status: toMetricStatus(reading.status),
    rxBytesPerSec: reading.rxBytesPerSec,
    txBytesPerSec: reading.txBytesPerSec,
  };
}

function toUptimeMetric(reading: UptimeReading): UptimeMetric {
  return {
    status: toMetricStatus(reading.status),
    uptimeSeconds: reading.uptimeSeconds,
  };
}

function toTemperatureMetric(reading: TemperatureReading): TemperatureMetric {
  return {
    status: toMetricStatus(reading.status),
    celsius: reading.celsius,
  };
}
