import { ipc } from "@/gen/ipc";
import type { MetricsSnapshot } from "@/gen/metrics";

/** Tears down a subscription. Idempotent; safe as a `useEffect` cleanup. */
type Unsubscribe = () => void;

/**
 * Renderer-side wrapper over the metrics streaming client. Main owns the
 * sampling cadence, so the renderer holds no timer: a component subscribes
 * once and returns the {@link Unsubscribe} as its effect cleanup.
 */
export const metricsGateway = {
  subscribe(
    onSnapshot: (snapshot: MetricsSnapshot) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    const subscription = ipc.metrics.StreamSnapshots({}).subscribe({
      next: onSnapshot,
      error: (error) => onError?.(error),
    });

    return () => subscription.unsubscribe();
  },
};
