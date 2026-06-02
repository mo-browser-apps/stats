import { ipc } from '@mobrowser/api';
import {
  CpuMetric,
  DiskMetric,
  MemoryMetric,
  MetricStatus,
  MetricsSnapshot,
  NetworkMetric,
  TemperatureMetric,
  UptimeMetric,
} from '../gen/metrics';
import { MetricsServiceDescriptor } from '../gen/ipc_service';
import { MetricsSampler } from './metrics-sampler';
import {
  CpuReading,
  DiskReading,
  MemoryReading,
  NetworkReading,
  ReadingStatus,
  TemperatureReading,
  UptimeReading,
} from './metric-types';

/** Interval between published snapshots, in milliseconds. */
const PUBLISH_INTERVAL_MS = 1000;

/** Maps the sampler's internal status onto the generated wire enum. */
function toMetricStatus(status: ReadingStatus): MetricStatus {
  switch (status) {
    case 'ok':
      return MetricStatus.METRIC_STATUS_OK;
    case 'unavailable':
      return MetricStatus.METRIC_STATUS_UNAVAILABLE;
    default:
      return MetricStatus.METRIC_STATUS_UNKNOWN;
  }
}

/**
 * Owns the renderer-facing metrics stream.
 *
 * Registers `MetricsService` as a broadcast (pub/sub fan-out) stream: every
 * subscribing renderer sees the same tick, so there is a single sampling cadence
 * in main rather than per-renderer timers. Each tick the {@link MetricsSampler}
 * is read once and the snapshot is fanned out to all subscribers, so adding
 * subscribers never triggers extra sampling work.
 *
 * Samples CPU, memory, disk, network throughput, uptime/load, and optional CPU
 * temperature. Network counters and temperature come from the native probes, so a
 * tick is async. Temperature is best-effort and is published as explicit
 * unavailable when no trustworthy CPU sensor is readable.
 *
 * Lifecycle hardening (I09): the cadence runs only while the UI is active. The
 * sole consumer is the single compact window, so {@link setActive} pauses the
 * interval (and the two native probes it drives) while the window is hidden and
 * resumes it when shown. A tick is skipped if the previous async publish has not
 * finished, so a slow or hung probe cannot stack overlapping work. `publish()`
 * never rejects: the sampler degrades per-group failures to unavailable, and a
 * delivery error (e.g. a stale publish after `dispose()`) is swallowed rather
 * than left as an unhandled rejection. `dispose()` stops the interval and closes
 * any in-flight subscribers; it is called from the app quit path so the process
 * exits cleanly.
 */
export class MetricsService {
  private readonly handle = ipc.registerService(MetricsServiceDescriptor);

  private readonly sampler = new MetricsSampler();

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Whether the UI is active and snapshots should be sampled and published. */
  private active = false;

  /** Set while an async publish is in flight, to guard against overlap. */
  private publishing = false;

  /** Set once `dispose()` has run; blocks any further start or publish. */
  private disposed = false;

  /**
   * Marks the service active or idle and (re)starts or pauses the cadence to
   * match. Active means a renderer can see snapshots, i.e. the window is shown;
   * idle means the window is hidden and there is nothing to display, so sampling
   * the native probes every second would be wasted work. Resuming emits one
   * snapshot immediately so a freshly shown window paints without waiting a full
   * interval. Idempotent for repeated calls with the same state.
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
   * Samples once and publishes the snapshot to every subscriber. A no-op for
   * delivery when nobody is subscribed; sampling still happens so the cadence
   * stays consistent. Async because the network counters and temperature are
   * read over native RPCs.
   *
   * Never rejects: a tick that overlaps an in-flight publish is skipped (so a
   * slow probe cannot stack work), and any delivery failure - including a stale
   * publish racing a `dispose()`, which the runtime makes throw - is swallowed so
   * the floating caller never produces an unhandled rejection.
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
    model: reading.model,
    coreCount: reading.coreCount,
  };
}

function toMemoryMetric(reading: MemoryReading): MemoryMetric {
  return {
    status: toMetricStatus(reading.status),
    usedBytes: reading.usedBytes,
    totalBytes: reading.totalBytes,
    usedPercent: reading.usedPercent,
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
    loadAverage: reading.loadAverage,
  };
}

function toTemperatureMetric(reading: TemperatureReading): TemperatureMetric {
  return {
    status: toMetricStatus(reading.status),
    celsius: reading.celsius,
  };
}
