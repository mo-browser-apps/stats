import * as os from "node:os";
import { ipc } from "@mobrowser/api";
import { native } from "../gen/native";
import {
  NativeAppBundle,
  NativeAppMetadata,
  NativeCommandLine,
  NativeFieldStatus,
  NativeImage,
  NativeInt64,
  NativeProcessCpu,
  NativeProcessMemory,
  NativeProcessRecord,
  NativeProcessUser,
  NativeString,
} from "../gen/native/process_collector";
import {
  AppBundle,
  AppMetadata,
  CommandLine,
  CpuTime,
  CpuUsage,
  FieldStatus,
  ProcessMemory,
  ProcessRow,
  ProcessSnapshot,
  ProcessSnapshotRevision,
  ProcessUser,
  SnapshotStatus,
  SnapshotWarning,
  SnapshotWarning_Code,
  StringValue,
  UInt64Value,
} from "../gen/process_explorer";
import { ProcessExplorerServiceDescriptor } from "../gen/ipc_service";

/**
 * Interval between process collections, in milliseconds.
 */
const COLLECT_INTERVAL_MS = 3000;

/**
 * Logical-core count. Per-process CPU uses Activity Monitor semantics (a process
 * pegging one core reads ~100%), so usage is NOT divided by this; it only caps
 * the reported value at cores * 100.
 */
const LOGICAL_CORE_COUNT = Math.max(1, os.cpus().length);

/**
 * Upper bound on reported per-process CPU percent: all cores fully busy.
 */
const MAX_CPU_PERCENT = LOGICAL_CORE_COUNT * 100;

/**
 * Identity key for matching a process across snapshots (pid + start time).
 */
type ProcessKey = string;

/**
 * Per-process CPU baseline kept between collections so a usage percent can be
 * derived from the cumulative-counter delta.
 */
interface CpuBaseline {
  /**
   * Cumulative user+system CPU time in nanoseconds at the last collection.
   */
  cumulativeCpuTimeNs: number;
  /**
   * Monotonic clock (ms) when that counter was read.
   */
  sampledAtMs: number;
}

/**
 * Maps a native per-field availability onto the renderer field status. Shared
 * codes line up one to one; the proto3 default (UNSPECIFIED) and native-only
 * PARSE_FAILED collapse to "unavailable" since the renderer has no parse-failed
 * state.
 */
function toFieldStatus(status: NativeFieldStatus): FieldStatus {
  switch (status) {
    case NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE:
      return FieldStatus.FIELD_STATUS_OK;
    case NativeFieldStatus.NATIVE_FIELD_STATUS_PERMISSION_DENIED:
      return FieldStatus.FIELD_STATUS_PERMISSION_DENIED;
    case NativeFieldStatus.NATIVE_FIELD_STATUS_PROCESS_EXITED:
      return FieldStatus.FIELD_STATUS_PROCESS_EXITED;
    case NativeFieldStatus.NATIVE_FIELD_STATUS_UNSUPPORTED:
      return FieldStatus.FIELD_STATUS_UNSUPPORTED;
    case NativeFieldStatus.NATIVE_FIELD_STATUS_UNAVAILABLE:
    case NativeFieldStatus.NATIVE_FIELD_STATUS_PARSE_FAILED:
    default:
      return FieldStatus.FIELD_STATUS_UNAVAILABLE;
  }
}

/**
 * Maps a native string field, preserving availability and value.
 */
function toStringValue(value: NativeString | undefined): StringValue {
  if (value === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: "" };
  }
  return { status: toFieldStatus(value.status), value: value.value };
}

/**
 * Maps the owning `.app` bundle (path + name) the list groups by. An absent
 * bundle or non-AVAILABLE path maps to undefined so the renderer keeps the row
 * as a singleton.
 */
function toAppBundle(bundle: NativeAppBundle | undefined): AppBundle | undefined {
  if (
    bundle?.path === undefined ||
    bundle.path.status !== NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE
  ) {
    return undefined;
  }
  return { path: toStringValue(bundle.path), name: toStringValue(bundle.name) };
}

/**
 * Maps the optional GUI app metadata (bundle id, localized name, icon key) plus
 * the owning app bundle. A record with no app data maps name fields to UNKNOWN
 * and leaves the icon key empty so the UI falls back to a generic icon and the
 * command/executable name. The icon bytes are not on the row: they live once in
 * the snapshot's icon table, keyed by `iconKey`.
 */
function toAppMetadata(app: NativeAppMetadata | undefined): AppMetadata {
  if (app === undefined) {
    const unknown = { status: FieldStatus.FIELD_STATUS_UNKNOWN, value: "" };
    return {
      bundleIdentifier: { ...unknown },
      localizedName: { ...unknown },
      iconKey: "",
      bundle: undefined,
    };
  }
  return {
    bundleIdentifier: toStringValue(app.bundleIdentifier),
    localizedName: toStringValue(app.localizedName),
    iconKey: app.iconKey,
    bundle: toAppBundle(app.bundle),
  };
}

/**
 * Maps the per-process memory group. Each metric is a non-negative byte count;
 * a negative native value is clamped to zero.
 */
function toProcessMemory(memory: NativeProcessMemory | undefined): ProcessMemory {
  const footprint = memory?.physicalFootprintBytes;
  const resident = memory?.residentBytes;
  const toBytes = (status: FieldStatus, value: number): UInt64Value => ({
    status,
    value: status === FieldStatus.FIELD_STATUS_OK ? Math.max(0, value) : 0,
  });
  return {
    physicalFootprintBytes: footprint
      ? toBytes(toFieldStatus(footprint.status), footprint.value)
      : { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: 0 },
    residentBytes: resident
      ? toBytes(toFieldStatus(resident.status), resident.value)
      : { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: 0 },
  };
}

/**
 * Maps the thread count (a native int64 with availability) onto the renderer's
 * UInt64Value. A negative native value clamps to zero.
 */
function toThreadCount(threadCount: NativeInt64 | undefined): UInt64Value {
  if (threadCount === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: 0 };
  }
  const status = toFieldStatus(threadCount.status);
  return {
    status,
    value: status === FieldStatus.FIELD_STATUS_OK ? Math.max(0, threadCount.value) : 0,
  };
}

/**
 * Maps the cumulative CPU-time counter into the renderer's CpuTime display value.
 * Surfaced directly (no first-sample UNKNOWN) since a cumulative total needs no
 * delta, unlike the percent {@link deriveCpu} computes. A negative value clamps
 * to zero.
 */
function toCpuTime(cpu: NativeProcessCpu | undefined): CpuTime {
  const counter = cpu?.cumulativeCpuTimeNs;
  if (counter === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, nanos: 0 };
  }
  const status = toFieldStatus(counter.status);
  return {
    status,
    nanos: status === FieldStatus.FIELD_STATUS_OK ? Math.max(0, counter.value) : 0,
  };
}

/**
 * Maps the owning user (uid + resolved name). uid and name share one
 * availability; an unmapped uid stays OK with the numeric value and an empty
 * name. The name is a login name, not argv, so it is forwarded for display.
 */
function toProcessUser(user: NativeProcessUser | undefined): ProcessUser {
  if (user === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, uid: 0, name: "" };
  }
  const status = toFieldStatus(user.status);
  return {
    status,
    uid: status === FieldStatus.FIELD_STATUS_OK ? user.uid : 0,
    name: status === FieldStatus.FIELD_STATUS_OK ? user.name : "",
  };
}

/**
 * Builds the snapshot-stable identity key for a record, or null if no PID.
 */
function recordKey(record: NativeProcessRecord): ProcessKey | null {
  const identity = record.identity;
  if (identity === undefined) {
    return null;
  }
  const startedAt =
    identity.startedAtStatus === NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE
      ? identity.startedAtUnixMs
      : "unknown";
  return `${identity.pid}:${startedAt}`;
}

/**
 * Identity key for one renderer row (pid + start time), used to align rows
 * across snapshot revisions when building a delta.
 */
function rowKey(row: ProcessRow): ProcessKey {
  const pid = row.identity?.pid ?? 0;
  const startedAt =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : "unknown";
  return `${pid}:${startedAt}`;
}

/**
 * Value equality for an optional string field (status + value).
 */
function stringValueEqual(a: StringValue | undefined, b: StringValue | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.status === b.status && a.value === b.value;
}

/**
 * Value equality for the optional owning `.app` bundle.
 */
function bundleEqual(a: AppBundle | undefined, b: AppBundle | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return stringValueEqual(a.path, b.path) && stringValueEqual(a.name, b.name);
}

/**
 * Value equality for the optional app metadata (including the icon key).
 */
function appEqual(a: AppMetadata | undefined, b: AppMetadata | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    stringValueEqual(a.bundleIdentifier, b.bundleIdentifier) &&
    stringValueEqual(a.localizedName, b.localizedName) &&
    a.iconKey === b.iconKey &&
    bundleEqual(a.bundle, b.bundle)
  );
}

/**
 * Value equality for the optional owning user.
 */
function userEqual(a: ProcessUser | undefined, b: ProcessUser | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.status === b.status && a.uid === b.uid && a.name === b.name;
}

/**
 * Whether the row's stable field group (names, path, app metadata, user) is
 * value-identical to the previous row's, i.e. eligible for the
 * stable_from_prev wire reduction. Every field is compared by value, so any
 * real change (a settling translocated path, an exec, a uid drop) always ships
 * in full - staleness is impossible by construction.
 */
function stableFieldsEqual(row: ProcessRow, previous: ProcessRow): boolean {
  return (
    stringValueEqual(row.commandName, previous.commandName) &&
    stringValueEqual(row.executableName, previous.executableName) &&
    stringValueEqual(row.executablePath, previous.executablePath) &&
    appEqual(row.app, previous.app) &&
    userEqual(row.user, previous.user)
  );
}

/**
 * Builds the delta form of `current` against `previous` for a renderer that
 * proved (via have_revision) it holds `previous` in full:
 *
 * - icon-table entries the previous snapshot already carried are omitted;
 * - a row's argv is replaced by a from_prev marker when it is identical to the
 *   previous row's (unchanged argv is literally the same array instance,
 *   carried across ticks by the per-identity store, so reference equality is
 *   exact - a changed argv always ships in full);
 * - a row's stable field group is dropped behind stable_from_prev when it
 *   compares value-equal to the previous row's (see stableFieldsEqual).
 *
 * The renderer gateway reverses every reduction before presentation code sees
 * the snapshot. Volatile fields (memory, cpu, thread count, parent) always ship.
 */
function buildSnapshotDelta(
  current: ProcessSnapshot,
  previous: ProcessSnapshot,
): ProcessSnapshot {
  const previousRows = new Map<ProcessKey, ProcessRow>();
  for (const row of previous.processes) {
    previousRows.set(rowKey(row), row);
  }

  const processes = current.processes.map((row) => {
    const previousRow = previousRows.get(rowKey(row));
    if (previousRow === undefined) {
      return row;
    }

    const commandLine = row.commandLine;
    const argvFromPrev =
      commandLine !== undefined &&
      commandLine.status === FieldStatus.FIELD_STATUS_OK &&
      commandLine.arguments.length > 0 &&
      previousRow.commandLine?.arguments === commandLine.arguments;
    const stableFromPrev = stableFieldsEqual(row, previousRow);
    if (!argvFromPrev && !stableFromPrev) {
      return row;
    }

    const reduced = { ...row };
    if (stableFromPrev) {
      reduced.commandName = undefined;
      reduced.executableName = undefined;
      reduced.executablePath = undefined;
      reduced.app = undefined;
      reduced.user = undefined;
      reduced.stableFromPrev = true;
    }
    if (argvFromPrev && commandLine !== undefined) {
      reduced.commandLine = {
        status: commandLine.status,
        arguments: [],
        fromPrev: true,
      };
    }
    return reduced;
  });

  const icons: { [key: string]: string } = {};
  for (const [key, bytes] of Object.entries(current.icons)) {
    if (previous.icons[key] === undefined) {
      icons[key] = bytes;
    }
  }

  return { ...current, processes, icons, delta: true };
}

/**
 * Owns process collection and the renderer-facing snapshot for the process
 * explorer.
 *
 * Runs a single visibility-gated, non-overlapping cadence in main, calls the
 * native collector once per tick, maps the raw records into a renderer
 * {@link ProcessSnapshot}, caches it, bumps a monotonic revision, and broadcasts
 * a lightweight {@link ProcessSnapshotRevision} ping so the renderer pulls the
 * full snapshot only when it changes.
 *
 * Per-process CPU usage is derived here, not in native: the collector reports a
 * cumulative CPU-time counter that this service diffs across collections against
 * wall time using Activity Monitor semantics (one fully busy core reads ~100%,
 * multi-threaded processes can exceed 100%, capped at all logical cores). A first
 * sample, a restarted process (reused PID with a new start time), a missing
 * identity, or a non-positive interval yields an UNKNOWN CPU value rather than a
 * fabricated one.
 *
 * Privacy: command-line arguments pass through to the renderer for local
 * display/search only. This service never logs request targets, argument values,
 * executable paths, or process names; warnings are count-only.
 */
export class ProcessSnapshotService {
  /**
   * Broadcast handle that owns the StreamRevisions subscriber set.
   */
  private readonly revisionHandle = ipc.registerService(
    ProcessExplorerServiceDescriptor,
  );

  /**
   * CPU-time baselines from the previous collection, keyed by process identity.
   */
  private cpuBaselines = new Map<ProcessKey, CpuBaseline>();

  /**
   * Per-identity argv store. Native ships argument bytes only on the pass that
   * first reads them (later passes carry a from_cache marker instead), so this
   * map carries them forward. Rebuilt each pass from the identities actually
   * seen, mirroring the native cache prune; kept across failed passes because
   * the native cache survives those too. Sensitive: display/search data only,
   * never logged or persisted.
   */
  private argvStore = new Map<ProcessKey, string[]>();

  /**
   * Icon bytes by content key. Native ships an icon's bytes only when the
   * previous pass did not reference its key, so this store carries known icons
   * forward. Rebuilt each pass to exactly the referenced keys (an exited app's
   * icon drops out; native re-sends it in full if the app relaunches) and kept
   * across failed passes, mirroring native's delta base.
   */
  private iconStore = new Map<string, string>();

  /**
   * The most recent snapshot, served from cache by GetProcessSnapshot.
   */
  private snapshot: ProcessSnapshot = {
    status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
    revision: 0,
    timestampMs: 0,
    processes: [],
    warnings: [],
    icons: {},
    delta: false,
  };

  /**
   * The snapshot immediately before {@link snapshot}, kept so a renderer that
   * holds it (proved via have_revision) can be served a delta instead of the
   * full payload. Only one generation back: any older revision gets a full
   * snapshot.
   */
  private previousSnapshot: ProcessSnapshot | null = null;

  /**
   * Monotonic revision id; advances each time a new snapshot is produced.
   */
  private revision = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether the process explorer view is on screen and collection should run.
   */
  private active = false;

  /**
   * Set while an async collection is in flight, to guard against overlap.
   */
  private collecting = false;

  /**
   * Set once dispose() has run; blocks any further activation or collection.
   */
  private disposed = false;

  /**
   * Activates or pauses collection. Main activates this only while the Processes
   * view is on screen, so the per-PID syscalls - and the sensitive command-line
   * reads they perform - run only while the user is looking at the process list.
   * Idempotent for repeated calls with the same state.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) {
      return;
    }

    this.active = active;
    if (active) {
      this.startTimer();
    } else {
      this.stopTimer();
    }
  }

  /**
   * Returns the latest cached snapshot, pulled by the renderer after a revision
   * ping or once for first paint. Returns a LOADING snapshot until the first
   * collection completes.
   *
   * When `haveRevision` names the current or the immediately-previous revision,
   * the renderer demonstrably holds that snapshot in full, so a delta is
   * returned instead: icon bytes and argv that the renderer already has are
   * omitted (see {@link buildSnapshotDelta}). Any other value - first pull,
   * renderer reload, or a missed generation - gets the full snapshot. Callers
   * inside main (the action service) pass nothing and always see full data.
   */
  getSnapshot(haveRevision = 0): ProcessSnapshot {
    if (haveRevision !== 0) {
      if (haveRevision === this.snapshot.revision) {
        // Re-pull of a revision the renderer already merged (e.g. returning to
        // the Processes view): everything dedupes against the snapshot itself.
        return buildSnapshotDelta(this.snapshot, this.snapshot);
      }
      if (haveRevision === this.previousSnapshot?.revision) {
        return buildSnapshotDelta(this.snapshot, this.previousSnapshot);
      }
    }
    return this.snapshot;
  }

  /**
   * Stops the cadence and closes the revision stream. Idempotent; after this the
   * service cannot be reactivated. Intended for app shutdown.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.active = false;
    this.stopTimer();
    this.cpuBaselines.clear();
    this.argvStore.clear();
    this.iconStore.clear();
    this.previousSnapshot = null;
    this.revisionHandle.dispose();
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }

    void this.collect();
    this.timer = setInterval(() => void this.collect(), COLLECT_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // CPU baselines are kept across a pause so re-entering the Processes view
    // computes a real per-process CPU delta on the first tick instead of a cold
    // valueless start. The delta stays correct because CPU-time and wall deltas
    // span the same elapsed gap. A reused PID is a different (pid, started_at)
    // key, so it still reports UNKNOWN rather than diffing an unrelated process.
  }

  /**
   * Collects once, rebuilds the cached snapshot, and broadcasts a revision ping.
   * A tick that overlaps an in-flight collection is skipped so a slow collector
   * cannot stack work. Never rejects: a native/runtime failure degrades to an
   * unavailable snapshot rather than an unhandled rejection or a retry storm.
   */
  private async collect(): Promise<void> {
    if (this.collecting || this.disposed) {
      return;
    }

    this.collecting = true;
    try {
      const response = await native.processCollector.CollectProcesses({});
      if (this.disposed) {
        return;
      }
      const next = this.buildSnapshot(
        response.available,
        response.records,
        response.icons,
      );
      this.previousSnapshot = this.snapshot;
      this.snapshot = next;
      this.publishRevision();
    } catch {
      // Degrade silently to an unavailable snapshot; the next tick retries. No
      // diagnostic is logged because it could carry process-identifying data.
      if (!this.disposed) {
        this.previousSnapshot = this.snapshot;
        this.snapshot = this.buildUnavailableSnapshot();
        this.publishRevision();
      }
    } finally {
      this.collecting = false;
    }
  }

  /**
   * Broadcasts the current snapshot's revision/status (no rows) to subscribers.
   */
  private publishRevision(): void {
    if (this.disposed) {
      return;
    }
    const ping: ProcessSnapshotRevision = {
      revision: this.snapshot.revision,
      timestampMs: this.snapshot.timestampMs,
      status: this.snapshot.status,
    };
    this.revisionHandle.StreamRevisions(ping);
  }

  /**
   * Builds a renderer snapshot from native records and updates the CPU baselines
   * for the next collection. When native reports the list itself unavailable,
   * returns an explicit unavailable snapshot with no rows.
   */
  private buildSnapshot(
    available: boolean,
    records: NativeProcessRecord[],
    icons: { [key: string]: NativeImage },
  ): ProcessSnapshot {
    if (!available) {
      return this.buildUnavailableSnapshot();
    }

    const sampledAtMs = performance.now();
    const nextBaselines = new Map<ProcessKey, CpuBaseline>();
    const nextArgvStore = new Map<ProcessKey, string[]>();
    let permissionLimited = false;
    let permissionDeniedCount = 0;
    let commandLinePartialCount = 0;

    const processes: ProcessRow[] = records.map((record) => {
      const key = recordKey(record);
      const cpu = this.deriveCpu(record.cpu, key, sampledAtMs, nextBaselines);
      const commandLine = this.deriveCommandLine(
        record.commandLine,
        key,
        nextArgvStore,
      );

      // Permission-limited if macOS denied ANY field, not just the task-info read:
      // argv, path, memory, and CPU can each be denied while task info is readable.
      if (hasDeniedField(record)) {
        permissionLimited = true;
        permissionDeniedCount += 1;
      }
      if (commandLine.status !== FieldStatus.FIELD_STATUS_OK) {
        commandLinePartialCount += 1;
      }

      return this.toProcessRow(record, cpu, commandLine);
    });

    this.cpuBaselines = nextBaselines;
    this.argvStore = nextArgvStore;
    this.revision += 1;

    return {
      status: permissionLimited
        ? SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED
        : SnapshotStatus.SNAPSHOT_STATUS_OK,
      revision: this.revision,
      timestampMs: Date.now(),
      processes,
      warnings: buildWarnings(permissionDeniedCount, commandLinePartialCount),
      icons: this.buildIconTable(records, icons),
      delta: false,
    };
  }

  /**
   * Maps the sensitive command-line group. Native ships the argument bytes only
   * on the pass that first reads them; later passes carry a from_cache marker
   * with the arguments omitted, and the value is rehydrated from the
   * per-identity store this method rolls forward (an unchanged argv stays the
   * same array instance across ticks, which the delta builder relies on).
   * Arguments are forwarded verbatim for local display/search only and are
   * never logged or persisted here.
   */
  private deriveCommandLine(
    commandLine: NativeCommandLine | undefined,
    key: ProcessKey | null,
    nextArgvStore: Map<ProcessKey, string[]>,
  ): CommandLine {
    const status =
      commandLine === undefined
        ? FieldStatus.FIELD_STATUS_UNAVAILABLE
        : toFieldStatus(commandLine.status);
    if (commandLine === undefined || status !== FieldStatus.FIELD_STATUS_OK) {
      return { status, arguments: [], fromPrev: false };
    }

    const args = commandLine.fromCache
      ? key === null
        ? undefined
        : this.argvStore.get(key)
      : commandLine.arguments;
    if (args === undefined) {
      // The pass that read this argv never made it into the store (a mid-build
      // failure on that tick); degrade honestly rather than fabricate. Native
      // re-reads when the process execs or restarts, which heals this.
      return {
        status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
        arguments: [],
        fromPrev: false,
      };
    }

    if (key !== null) {
      nextArgvStore.set(key, args);
    }
    return { status, arguments: args, fromPrev: false };
  }

  /**
   * Builds the snapshot icon table and rolls the key -> bytes store forward.
   * Native ships bytes only for keys the previous pass did not reference, so a
   * referenced key resolves from the fresh response first and the store second.
   * The store is then replaced with exactly the referenced keys, mirroring the
   * native-side delta base, so an exited app's icon drops out (native re-sends
   * it in full if the app relaunches). A key that resolves to no bytes at all
   * is left out of the table; its rows fall back to the generic glyph.
   */
  private buildIconTable(
    records: NativeProcessRecord[],
    fresh: { [key: string]: NativeImage },
  ): { [key: string]: string } {
    const next = new Map<string, string>();
    for (const record of records) {
      const key = record.app?.iconKey;
      if (key === undefined || key.length === 0 || next.has(key)) {
        continue;
      }
      const image = fresh[key];
      const bytes =
        image !== undefined &&
        image.status === NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE &&
        image.pngBase64.length > 0
          ? image.pngBase64
          : this.iconStore.get(key);
      if (bytes !== undefined) {
        next.set(key, bytes);
      }
    }
    this.iconStore = next;
    return Object.fromEntries(next);
  }

  /**
   * An explicit unavailable snapshot (no rows) that still advances the revision.
   */
  private buildUnavailableSnapshot(): ProcessSnapshot {
    // CPU baselines reset (a fresh delta will be derived), but the argv/icon
    // stores are kept: the native session caches survive a failed pass too, so
    // the next successful pass still serves from_cache markers and omits known
    // icon keys against them.
    this.cpuBaselines.clear();
    this.revision += 1;
    return {
      status: SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE,
      revision: this.revision,
      timestampMs: Date.now(),
      processes: [],
      warnings: [],
      icons: {},
      delta: false,
    };
  }

  /**
   * Assembles one renderer row from a native record and the derived fields.
   */
  private toProcessRow(
    record: NativeProcessRecord,
    cpu: CpuUsage,
    commandLine: CommandLine,
  ): ProcessRow {
    const identity = record.identity;
    return {
      identity: {
        pid: identity?.pid ?? 0,
        startedAtStatus: toFieldStatus(
          identity?.startedAtStatus ??
            NativeFieldStatus.NATIVE_FIELD_STATUS_UNAVAILABLE,
        ),
        startedAtUnixMs: identity?.startedAtUnixMs ?? 0,
      },
      parentStatus: toFieldStatus(record.parentStatus),
      parentPid: record.parentPid,
      commandName: toStringValue(record.commandName),
      executableName: toStringValue(record.executableName),
      executablePath: toStringValue(record.executablePath),
      // GUI app metadata/icon from NSWorkspace when the process is a known app;
      // otherwise every app field is UNKNOWN and the UI uses a fallback icon.
      app: toAppMetadata(record.app),
      commandLine,
      memory: toProcessMemory(record.memory),
      cpu,
      threadCount: toThreadCount(record.threadCount),
      cpuTime: toCpuTime(record.cpu),
      user: toProcessUser(record.user),
      stableFromPrev: false,
    };
  }

  /**
   * Derives a per-process CPU usage percent from the cumulative-counter delta and
   * records the new baseline. The result is UNKNOWN on a first sample, a missing
   * identity, a missing/unavailable counter, a process restart (the key resets),
   * or a non-positive elapsed interval, so a fresh or ambiguous row never shows a
   * fabricated value. Activity Monitor semantics: CPU time over wall time without
   * dividing by core count, so one fully busy core reads ~100% and a multi-threaded
   * process can exceed 100% (capped at cores * 100). The native counter is in real
   * nanoseconds.
   */
  private deriveCpu(
    cpu: NativeProcessCpu | undefined,
    key: ProcessKey | null,
    sampledAtMs: number,
    nextBaselines: Map<ProcessKey, CpuBaseline>,
  ): CpuUsage {
    const counter = cpu?.cumulativeCpuTimeNs;
    if (
      key === null ||
      counter === undefined ||
      counter.status !== NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE
    ) {
      return { status: FieldStatus.FIELD_STATUS_UNKNOWN, usagePercent: 0 };
    }

    const cumulativeCpuTimeNs = counter.value;
    nextBaselines.set(key, { cumulativeCpuTimeNs, sampledAtMs });

    const previous = this.cpuBaselines.get(key);
    if (previous === undefined) {
      // First time we have seen this process: no delta to derive a rate from.
      return { status: FieldStatus.FIELD_STATUS_UNKNOWN, usagePercent: 0 };
    }

    const cpuDeltaNs = cumulativeCpuTimeNs - previous.cumulativeCpuTimeNs;
    const wallDeltaMs = sampledAtMs - previous.sampledAtMs;
    if (cpuDeltaNs < 0 || wallDeltaMs <= 0) {
      // Counter reset or non-monotonic clock; re-arm from this sample.
      return { status: FieldStatus.FIELD_STATUS_UNKNOWN, usagePercent: 0 };
    }

    const wallDeltaNs = wallDeltaMs * 1_000_000;
    const usagePercent = Math.min(
      MAX_CPU_PERCENT,
      Math.max(0, (cpuDeltaNs / wallDeltaNs) * 100),
    );
    return { status: FieldStatus.FIELD_STATUS_OK, usagePercent };
  }
}

/**
 * True when a native field status is an explicit macOS permission denial.
 */
function isFieldDenied(status: NativeFieldStatus): boolean {
  return status === NativeFieldStatus.NATIVE_FIELD_STATUS_PERMISSION_DENIED;
}

/**
 * True when macOS denied any independently-readable field on the record, used to
 * mark the snapshot permission-limited and tally the count-only warning. macOS can
 * deny argv, path, memory, or CPU separately even when the task-info read (parent)
 * succeeds, so every such field is checked. No field value is read here - only the
 * per-field status.
 */
function hasDeniedField(record: NativeProcessRecord): boolean {
  return (
    isFieldDenied(record.parentStatus) ||
    isFieldDenied(record.commandName?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.executableName?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.executablePath?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.commandLine?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.memory?.physicalFootprintBytes?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.memory?.residentBytes?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED) ||
    isFieldDenied(record.cpu?.cumulativeCpuTimeNs?.status ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNSPECIFIED)
  );
}

/**
 * Builds the count-only snapshot warnings from per-pass tallies.
 */
function buildWarnings(
  permissionDeniedCount: number,
  commandLinePartialCount: number,
): SnapshotWarning[] {
  const warnings: SnapshotWarning[] = [];
  if (permissionDeniedCount > 0) {
    warnings.push({
      code: SnapshotWarning_Code.CODE_PERMISSION_DENIED,
      affectedCount: permissionDeniedCount,
    });
  }
  if (commandLinePartialCount > 0) {
    warnings.push({
      code: SnapshotWarning_Code.CODE_COMMAND_LINE_PARTIAL,
      affectedCount: commandLinePartialCount,
    });
  }
  return warnings;
}
