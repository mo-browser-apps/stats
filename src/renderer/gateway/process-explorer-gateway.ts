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

/** Tears down a subscription. Idempotent; safe as a `useEffect` cleanup. */
type Unsubscribe = () => void;

/** An explicit empty snapshot, shaped like a real one so callers need no null checks. */
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
 * pull (have_revision) so main can answer with a delta. Its `icons` table
 * doubles as the content-addressed icon store: a held key is never re-fetched.
 * Module state on purpose: it survives view re-mounts but resets with the
 * renderer, so a reload naturally pulls a full snapshot again. Holds sensitive
 * argv like any snapshot; never logged or persisted.
 */
let lastSnapshot: ProcessSnapshot | null = null;

/**
 * Assembles the icon table for `snapshot` (which arrives with an empty one):
 * held keys come from the previous table, unseen keys are fetched once. Keys
 * are content hashes, so a held value can never be stale, and the rebuilt
 * table carries exactly the keys the new rows reference. A failed fetch
 * degrades to the held icons; affected rows render the generic glyph and the
 * next pull retries.
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
 * Renderer-side wrapper over the process explorer client. Full snapshots are
 * pulled with {@link getSnapshot} (a cached unary read owned by main) while
 * {@link subscribeRevisions} delivers lightweight pings so a component pulls
 * only when the revision advances. Command-line arguments on rows are
 * display/search data only and must never be logged or persisted by callers.
 */
export const processExplorerGateway = {
  /** An explicit empty/loading snapshot for first paint before any pull. */
  emptySnapshot,

  /**
   * Pulls the latest cached snapshot from main, advertising the snapshot this
   * renderer holds; a delta answer is merged locally and the icon table is
   * assembled (held keys reused, unknown keys fetched once). Callers always
   * receive self-contained data regardless of what went over the wire.
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

  /** Subscribes to revision pings; the cadence is owned by main. */
  subscribeRevisions(
    onRevision: (revision: ProcessSnapshotRevision) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    const subscription = ipc.processExplorer.StreamRevisions({}).subscribe({
      next: onRevision,
      error: (error) => onError?.(error),
    });

    return () => subscription.unsubscribe();
  },

  /** Reads per-action availability for a target, validated in main. */
  async getActionStates(target: ProcessIdentity): Promise<GetProcessActionStatesResponse> {
    return ipc.processExplorer.GetProcessActionStates({ target });
  },

  /** Requests a validated action; main re-checks every protection. */
  async runAction(
    action: ProcessActionKind,
    target: ProcessIdentity,
  ): Promise<RunProcessActionResponse> {
    return ipc.processExplorer.RunProcessAction({ action, target });
  },
};
