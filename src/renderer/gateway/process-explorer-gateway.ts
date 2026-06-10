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
 * pull (have_revision) so main can answer with a delta - argv the renderer
 * already holds is omitted and merged back in locally. Its `icons` table doubles
 * as the renderer's content-addressed icon store: a key it already maps is never
 * re-fetched. Module state on purpose: it must survive view re-mounts but reset
 * with the renderer, so a reloaded renderer naturally pulls a full snapshot
 * (have_revision 0) and re-fetches every icon once. Holds sensitive argv like
 * any snapshot; never logged or persisted.
 */
let lastSnapshot: ProcessSnapshot | null = null;

/**
 * Assembles the icon table for `snapshot` (which arrives from main with an
 * empty `icons`): known keys come from the previous snapshot's table, and keys
 * the renderer has never seen are fetched once through GetProcessIcons. Keys
 * are content hashes, so a held value can never be stale; the rebuilt table
 * carries exactly the keys the new rows reference, which keeps it bounded by
 * the live process set. A failed fetch degrades to whatever is held locally -
 * affected rows render the generic glyph and the next pull retries the
 * still-missing keys.
 */
async function assembleIcons(snapshot: ProcessSnapshot): Promise<{ [key: string]: string }> {
  const known = lastSnapshot?.icons ?? {};
  const referenced = new Set<string>();
  for (const row of snapshot.processes) {
    const key = row.app?.iconKey;
    if (key !== undefined && key.length > 0) {
      referenced.add(key);
    }
  }

  const missing = [...referenced].filter((key) => known[key] === undefined);
  let fetched: { [key: string]: string } = {};
  if (missing.length > 0) {
    try {
      fetched = (await ipc.processExplorer.GetProcessIcons({ keys: missing })).icons;
    } catch {
      // Degrade to the locally held icons; no diagnostic is logged.
    }
  }

  const icons: { [key: string]: string } = {};
  for (const key of referenced) {
    const bytes = known[key] ?? fetched[key];
    if (bytes !== undefined) {
      icons[key] = bytes;
    }
  }
  return icons;
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
  /**
   * An explicit empty/loading snapshot for first paint before any pull.
   */
  emptySnapshot,

  /**
   * Pulls the latest cached process snapshot from main. Advertises the last
   * snapshot this renderer holds; when main answers with a delta against it,
   * the delta is merged locally into a full snapshot. The icon table is then
   * assembled locally (snapshots arrive with an empty one): held keys are
   * reused, unknown keys are fetched once through GetProcessIcons. Callers
   * always receive self-contained data regardless of what went over the wire.
   */
  async getSnapshot(): Promise<ProcessSnapshot> {
    const base = lastSnapshot;
    const response = await ipc.processExplorer.GetProcessSnapshot({
      haveRevision: base?.revision ?? 0,
    });
    const merged = response.delta ? mergeSnapshotDelta(base, response) : response;
    const snapshot = { ...merged, icons: await assembleIcons(merged) };
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
