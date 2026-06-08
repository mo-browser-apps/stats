import { ipc } from "@/gen/ipc";
import {
  GetProcessActionStatesResponse,
  ProcessIdentity,
  ProcessActionKind,
  ProcessSnapshot,
  ProcessSnapshotRevision,
  RunProcessActionResponse,
  SnapshotStatus,
} from "@/gen/process_explorer";

/** Called for each revision ping the main process publishes. */
type RevisionListener = (revision: ProcessSnapshotRevision) => void;

/** Called once if the revision stream fails. The stream ends after an error. */
type StreamErrorListener = (error: unknown) => void;

/** Tears down a subscription. Idempotent; safe to use as a cleanup callback. */
type Unsubscribe = () => void;

/**
 * An explicit empty snapshot for the loading state before the first pull. Shaped
 * exactly like a real {@link ProcessSnapshot} so presentation code can render a
 * loading/empty view without null checks.
 */
function emptySnapshot(): ProcessSnapshot {
  return {
    status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
    revision: 0,
    timestampMs: 0,
    processes: [],
    warnings: [],
  };
}

/**
 * Renderer-side wrapper over the generated process explorer client.
 *
 * Keeps presentation components free of generated-IPC details. The delivery
 * shape matches the contract: full snapshots are pulled with {@link getSnapshot}
 * (a cached unary read owned by main) while {@link subscribeRevisions} delivers
 * lightweight revision pings so a component can pull only when the revision
 * advances. Action helpers are thin unary calls; main validates every target.
 *
 * Command-line arguments that arrive on rows are display/search data only and
 * must never be logged or persisted by callers.
 */
export const processExplorerGateway = {
  /** An explicit empty/loading snapshot for first paint before any pull. */
  emptySnapshot,

  /** Pulls the latest cached process snapshot from main. */
  async getSnapshot(): Promise<ProcessSnapshot> {
    return ipc.processExplorer.GetProcessSnapshot({});
  },

  /**
   * Subscribes to revision pings. Returns an {@link Unsubscribe} that closes the
   * underlying subscription synchronously (designed for a `useEffect` cleanup).
   * The cadence is owned by main, so the renderer holds no timer.
   */
  subscribeRevisions(onRevision: RevisionListener, onError?: StreamErrorListener): Unsubscribe {
    const subscription = ipc.processExplorer.StreamRevisions({}).subscribe({
      next: onRevision,
      error: (error) => onError?.(error),
    });

    return () => subscription.unsubscribe();
  },

  /**
   * Reads per-action availability for a target, validated in main against the
   * latest snapshot. Stale-target detection uses PID plus start time in the live
   * cache, so no snapshot revision is part of the action request.
   */
  async getActionStates(target: ProcessIdentity): Promise<GetProcessActionStatesResponse> {
    return ipc.processExplorer.GetProcessActionStates({ target });
  },

  /**
   * Requests a validated action against a target. Main re-validates and applies
   * self/critical/stale protections; the result is count-only with no sensitive
   * detail.
   */
  async runAction(
    action: ProcessActionKind,
    target: ProcessIdentity,
  ): Promise<RunProcessActionResponse> {
    return ipc.processExplorer.RunProcessAction({ action, target });
  },
};
