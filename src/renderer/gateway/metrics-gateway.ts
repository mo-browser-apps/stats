import { ipc } from "@/gen/ipc";
import type { MetricsSnapshot } from "@/gen/metrics";

/** Called for each snapshot the main process pushes. */
export type SnapshotListener = (snapshot: MetricsSnapshot) => void;

/** Called once if the stream fails. The stream ends after an error. */
export type StreamErrorListener = (error: unknown) => void;

/** Tears down a subscription. Idempotent; safe to use as a cleanup callback. */
export type Unsubscribe = () => void;

/**
 * Renderer-side wrapper over the generated metrics streaming client.
 *
 * Keeps presentation components free of generated-IPC details: a component
 * subscribes once (e.g. in a `useEffect`) and returns the {@link Unsubscribe}
 * as its cleanup callback. Main owns the cadence, so the renderer holds no
 * sampling timer.
 */
export const metricsGateway = {
  /**
   * Subscribes to the metrics stream. Returns an {@link Unsubscribe} that
   * closes the underlying subscription synchronously.
   */
  subscribe(onSnapshot: SnapshotListener, onError?: StreamErrorListener): Unsubscribe {
    const subscription = ipc.metrics.StreamSnapshots({}).subscribe({
      next: onSnapshot,
      error: (error) => onError?.(error),
    });

    return () => subscription.unsubscribe();
  },
};
