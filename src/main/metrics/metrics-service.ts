import { ipc } from '@mobrowser/api';
import { MetricStatus, MetricsSnapshot } from '../gen/metrics';
import { MetricsServiceDescriptor } from '../gen/ipc_service';

/** Interval between published snapshots, in milliseconds. */
const PUBLISH_INTERVAL_MS = 1000;

/**
 * Owns the renderer-facing metrics stream.
 *
 * Registers `MetricsService` as a broadcast (pub/sub fan-out) stream: every
 * subscribing renderer sees the same tick, so there is a single sampling
 * cadence in main rather than per-renderer timers. This iteration publishes an
 * explicit-unavailable snapshot on a fixed cadence; real sampling replaces the
 * snapshot body in a later iteration without changing this wiring.
 *
 * Publishing with no current subscriber is a runtime no-op, so the interval is
 * safe to run unconditionally. `dispose()` stops the interval and tears down
 * any in-flight subscribers.
 */
export class MetricsService {
  private readonly handle = ipc.registerService(MetricsServiceDescriptor);

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Starts the publish cadence. Emits one snapshot immediately so a renderer
   * that is already subscribed paints without waiting a full interval.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.publish();
    this.timer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
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
   * Publishes the current snapshot to every subscriber. A no-op when nobody is
   * subscribed.
   */
  private publish(): void {
    this.handle.StreamSnapshots(this.buildSnapshot());
  }

  /**
   * Builds an explicit-unavailable snapshot. Each metric group reports
   * `UNAVAILABLE` so the renderer renders honest placeholder states until real
   * sampling lands; only the timestamp carries live data.
   */
  private buildSnapshot(): MetricsSnapshot {
    return {
      timestampMs: Date.now(),
      cpu: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, usagePercent: 0, model: '', coreCount: 0 },
      memory: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, usedBytes: 0, totalBytes: 0, usedPercent: 0 },
      disk: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent: 0 },
      network: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, rxBytesPerSec: 0, txBytesPerSec: 0 },
      uptime: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, uptimeSeconds: 0, loadAverage: [] },
      temperature: { status: MetricStatus.METRIC_STATUS_UNAVAILABLE, celsius: 0 },
    };
  }
}
