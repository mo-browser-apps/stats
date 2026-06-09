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
 * Maps the native deduplicated icon table onto the renderer's. The native table
 * keys identical icons once (by content hash); here it becomes a plain
 * key -> base64 map (a table entry is always an available icon, so the per-entry
 * status is dropped). The renderer gateway rehydrates each row's icon from this
 * table by key. Base64 payloads are volatile display data, never logged.
 */
function toIconTable(icons: { [key: string]: NativeImage }): {
  [key: string]: string;
} {
  const table: { [key: string]: string } = {};
  for (const [key, icon] of Object.entries(icons)) {
    if (
      icon.status === NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE &&
      icon.pngBase64.length > 0
    ) {
      table[key] = icon.pngBase64;
    }
  }
  return table;
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
 * Maps the sensitive command-line group. Arguments are forwarded verbatim for
 * local display/search only and are never logged or persisted here; they are
 * dropped unless the vector is explicitly available.
 */
function toCommandLine(commandLine: NativeCommandLine | undefined): CommandLine {
  if (commandLine === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, arguments: [] };
  }
  const status = toFieldStatus(commandLine.status);
  return {
    status,
    arguments:
      status === FieldStatus.FIELD_STATUS_OK ? commandLine.arguments : [],
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
   * The most recent snapshot, served from cache by GetProcessSnapshot.
   */
  private snapshot: ProcessSnapshot = {
    status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
    revision: 0,
    timestampMs: 0,
    processes: [],
    warnings: [],
    icons: {},
  };

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
   */
  getSnapshot(): ProcessSnapshot {
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
      this.snapshot = this.buildSnapshot(
        response.available,
        response.records,
        response.icons,
      );
      this.publishRevision();
    } catch {
      // Degrade silently to an unavailable snapshot; the next tick retries. No
      // diagnostic is logged because it could carry process-identifying data.
      if (!this.disposed) {
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
    let permissionLimited = false;
    let permissionDeniedCount = 0;
    let commandLinePartialCount = 0;

    const processes: ProcessRow[] = records.map((record) => {
      const key = recordKey(record);
      const cpu = this.deriveCpu(record.cpu, key, sampledAtMs, nextBaselines);
      const commandLine = toCommandLine(record.commandLine);

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
    this.revision += 1;

    return {
      status: permissionLimited
        ? SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED
        : SnapshotStatus.SNAPSHOT_STATUS_OK,
      revision: this.revision,
      timestampMs: Date.now(),
      processes,
      warnings: buildWarnings(permissionDeniedCount, commandLinePartialCount),
      icons: toIconTable(icons),
    };
  }

  /**
   * An explicit unavailable snapshot (no rows) that still advances the revision.
   */
  private buildUnavailableSnapshot(): ProcessSnapshot {
    this.cpuBaselines.clear();
    this.revision += 1;
    return {
      status: SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE,
      revision: this.revision,
      timestampMs: Date.now(),
      processes: [],
      warnings: [],
      icons: {},
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
