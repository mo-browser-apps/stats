import { ipc } from "@/gen/ipc";
import {
  GetProcessActionStatesResponse,
  GetProcessAssetsResponse,
  ProcessIdentity,
  ProcessActionKind,
  ProcessSnapshot,
  ProcessSnapshotRevision,
  ProcessStatics,
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
 * The renderer's content-addressed asset stores: the statics blobs and icon
 * bytes referenced by the last snapshot this gateway assembled. A held key is
 * never re-fetched (keys are content hashes, so a held value can never be
 * stale); each assembly rebuilds the stores to exactly the keys the new rows
 * reference, so exited processes' data is dropped. Module state on purpose: it
 * survives view re-mounts but resets with the renderer, so a reload naturally
 * re-fetches. Statics hold sensitive argv; never logged or persisted.
 */
let heldStatics: { [key: string]: ProcessStatics } = {};
let heldIcons: { [key: string]: string } = {};

/** Fetches assets for the given keys, degrading to empty maps on failure (the next pull retries). */
async function fetchAssets(staticKeys: string[], iconKeys: string[]): Promise<GetProcessAssetsResponse> {
  if (staticKeys.length === 0 && iconKeys.length === 0) {
    return { statics: {}, icons: {} };
  }
  try {
    return await ipc.processExplorer.GetProcessAssets({ staticKeys, iconKeys });
  } catch {
    // No diagnostic is logged - asset content is sensitive.
    return { statics: {}, icons: {} };
  }
}

/** The distinct non-empty keys produced by `read` across `items`. */
function referencedKeys<T>(items: T[], read: (item: T) => string | undefined): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    const key = read(item);
    if (key !== undefined && key.length > 0) {
      keys.add(key);
    }
  }
  return [...keys];
}

/** Rebuilds a content store to exactly `keys`, reusing held values and filling gaps from `fetched`. */
function rebuildStore<T>(
  keys: string[],
  held: { [key: string]: T },
  fetched: { [key: string]: T },
): { [key: string]: T } {
  const store: { [key: string]: T } = {};
  for (const key of keys) {
    const value = held[key] ?? fetched[key];
    if (value !== undefined) {
      store[key] = value;
    }
  }
  return store;
}

/**
 * Assembles a wire snapshot into the self-contained form presentation code
 * consumes: statics blobs for keys not yet held are fetched and joined onto
 * their rows, then icon bytes for keys those statics reference are fetched and
 * built into the snapshot's icon table. An unresolved key degrades that row
 * (absent statics render as unavailable fields, a missing icon as the fallback
 * glyph) and is retried on the next pull.
 */
async function assembleSnapshot(wire: ProcessSnapshot): Promise<ProcessSnapshot> {
  const staticKeys = referencedKeys(wire.processes, (row) => row.staticKey);
  const missingStatics = staticKeys.filter((key) => heldStatics[key] === undefined);
  const statics = rebuildStore(
    staticKeys,
    heldStatics,
    (await fetchAssets(missingStatics, [])).statics,
  );
  const processes = wire.processes.map((row) => ({ ...row, statics: statics[row.staticKey] }));

  const iconKeys = referencedKeys(processes, (row) => row.statics?.app?.iconKey);
  const missingIcons = iconKeys.filter((key) => heldIcons[key] === undefined);
  const icons = rebuildStore(
    iconKeys,
    heldIcons,
    (await fetchAssets([], missingIcons)).icons,
  );

  heldStatics = statics;
  heldIcons = icons;
  return { ...wire, processes, icons };
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
   * Pulls the latest cached snapshot from main and assembles it locally:
   * statics joined onto rows and the icon table built, with held content
   * reused and unknown keys fetched once. Callers always receive
   * self-contained rows regardless of what went over the wire.
   */
  async getSnapshot(): Promise<ProcessSnapshot> {
    return assembleSnapshot(await ipc.processExplorer.GetProcessSnapshot({}));
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
