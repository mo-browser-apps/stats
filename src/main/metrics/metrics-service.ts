import { ipc } from '@mobrowser/api';
import {
  CpuMetric,
  DiskMetric,
  MemoryMetric,
  MetricStatus,
  MetricsSnapshot,
  NetworkMetric,
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
 * This iteration samples CPU, memory, disk, network throughput, and uptime/load.
 * Network counters come from the native probe, so a tick is async. Temperature is
 * published as explicit unavailable until its iteration lands. Publishing with no
 * current subscriber is a runtime no-op, so the interval is safe to run
 * unconditionally. `dispose()` stops the interval and tears down any in-flight
 * subscribers.
 */
export class MetricsService {
  private readonly handle = ipc.registerService(MetricsServiceDescriptor);

  private readonly sampler = new MetricsSampler();

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Starts the publish cadence. Emits one snapshot immediately so a renderer
   * that is already subscribed paints without waiting a full interval.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    void this.publish();
    this.timer = setInterval(() => void this.publish(), PUBLISH_INTERVAL_MS);
  }

  /**
   * Stops the cadence and closes the broadcast stream. Idempotent.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.handle.dispose();
  }

  /**
   * Samples once and publishes the snapshot to every subscriber. A no-op for
   * delivery when nobody is subscribed; sampling still happens so the cadence
   * stays consistent. Async because the network counters are read over the
   * native RPC; the sampler swallows per-group errors so this never rejects.
   */
  private async publish(): Promise<void> {
    this.handle.StreamSnapshots(await this.buildSnapshot());
  }

  /**
   * Builds the current snapshot from one sampler reading. CPU/memory/disk/network/
   * uptime carry live (or explicit unknown/unavailable) values; temperature
   * remains explicit unavailable until its iteration implements it, so a missing
   * source degrades only its own card.
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
      temperature: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, celsius: 0 },
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
