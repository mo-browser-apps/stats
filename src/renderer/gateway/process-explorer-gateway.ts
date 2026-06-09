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
import { mergeSnapshotDelta } from "@/gateway/snapshot-delta";

/**
 * Called for each revision ping the main process publishes.
 */
type RevisionListener = (revision: ProcessSnapshotRevision) => void;

/**
 * Called once if the revision stream fails. The stream ends after an error.
 */
type StreamErrorListener = (error: unknown) => void;

/**
 * Tears down a subscription. Idempotent; safe to use as a cleanup callback.
 */
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
    icons: {},
    delta: false,
  };
}

/**
 * The last full snapshot this renderer assembled, advertised to main on every
 * pull (have_revision) so main can answer with a delta - icon bytes and argv
 * the renderer already holds are omitted and merged back in locally. Module
 * state on purpose: it must survive view re-mounts but reset with the renderer,
 * so a reloaded renderer naturally pulls a full snapshot (have_revision 0).
 * Holds sensitive argv like any snapshot; never logged or persisted.
 */
let lastSnapshot: ProcessSnapshot | null = null;

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
  /**
   * An explicit empty/loading snapshot for first paint before any pull.
   */
  emptySnapshot,

  /**
   * Pulls the latest cached process snapshot from main. Advertises the last
   * snapshot this renderer holds; when main answers with a delta against it,
   * the delta is merged locally into a full snapshot, so callers always receive
   * self-contained data regardless of what went over the wire.
   */
  async getSnapshot(): Promise<ProcessSnapshot> {
    const base = lastSnapshot;
    const response = await ipc.processExplorer.GetProcessSnapshot({
      haveRevision: base?.revision ?? 0,
    });
    const snapshot = response.delta ? mergeSnapshotDelta(base, response) : response;
    if (lastSnapshot === null || snapshot.revision >= lastSnapshot.revision) {
      lastSnapshot = snapshot;
    }
    return snapshot;
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
