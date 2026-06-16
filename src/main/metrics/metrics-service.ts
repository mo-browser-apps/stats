import { ipc } from "@mobrowser/api";
import { MetricsServiceDescriptor } from "../gen/ipc_service";
import { PollLoop } from "../poll-loop";
import { MetricsSampler } from "./metrics-sampler";

const PUBLISH_INTERVAL_MS = 1000;

/**
 * Owns the renderer-facing metrics stream: one broadcast cadence in main, so
 * every subscriber sees the same tick and extra subscribers add no sampling
 * work. {@link setActive} pauses the cadence while the Stats view is off
 * screen; resuming publishes immediately so a freshly shown window paints
 * without waiting a full interval.
 */
export class MetricsService {
  private readonly handle = ipc.registerService(MetricsServiceDescriptor);

  private readonly sampler = new MetricsSampler();

  private readonly loop = new PollLoop(PUBLISH_INTERVAL_MS, () => this.publish());

  private disposed = false;

  setActive(active: boolean): void {
    this.loop.setActive(active);
  }

  /** Stops the cadence and closes the broadcast stream. Idempotent and final. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loop.dispose();
    this.handle.dispose();
  }

  /**
   * Samples once and publishes to every subscriber. Never rejects: a delivery
   * failure (including a stale publish racing dispose) drops the tick and the
   * next one republishes.
   */
  private async publish(): Promise<void> {
    try {
      const reading = await this.sampler.sample();
      if (!this.disposed) {
        this.handle.StreamSnapshots({ timestampMs: Date.now(), ...reading });
      }
    } catch {
      // The sampler already degrades source failures per group; reaching here
      // means a delivery/runtime fault. Drop the tick, keep the cadence.
    }
  }
}
