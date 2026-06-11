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
  };
}

/**
 * The content-addressed icon store: the icon table of the last snapshot this
 * renderer assembled. A held key is never re-fetched (keys are content hashes,
 * so a held value can never be stale). Module state on purpose: it survives
 * view re-mounts but resets with the renderer, so a reload naturally re-fetches.
 * Volatile display-only data: never logged or persisted.
 */
let heldIcons: { [key: string]: string } = {};

/**
 * Assembles the icon table for `snapshot` (which arrives with an empty one):
 * held keys come from {@link heldIcons}, unseen keys are fetched once. The
 * rebuilt table carries exactly the keys the new rows reference. A failed
 * fetch degrades to the held icons; affected rows render the generic glyph
 * and the next pull retries.
 */
async function assembleIcons(snapshot: ProcessSnapshot): Promise<{ [key: string]: string }> {
  const known = heldIcons;
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
   * Pulls the latest cached snapshot from main and assembles its icon table
   * (held keys reused, unknown keys fetched once).
   */
  async getSnapshot(): Promise<ProcessSnapshot> {
    const response = await ipc.processExplorer.GetProcessSnapshot({});
    const snapshot = { ...response, icons: await assembleIcons(response) };
    heldIcons = snapshot.icons;
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
