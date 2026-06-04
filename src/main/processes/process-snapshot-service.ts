import * as os from 'node:os';
import { ipc } from '@mobrowser/api';
import { native } from '../gen/native';
import {
  NativeAppMetadata,
  NativeCommandLine,
  NativeFieldStatus,
  NativeImage,
  NativeProcessCpu,
  NativeProcessMemory,
  NativeProcessRecord,
  NativeString,
} from '../gen/native/process_collector';
import {
  AppMetadata,
  CommandLine,
  CpuUsage,
  FieldStatus,
  ProcessMemory,
  ProcessRow,
  ProcessSnapshot,
  ProcessSnapshotRevision,
  SnapshotStatus,
  SnapshotWarning,
  SnapshotWarning_Code,
  StringValue,
  UInt64Value,
} from '../gen/process_explorer';
import { ProcessExplorerServiceDescriptor } from '../gen/ipc_service';

/**
 * Interval between process collections, in milliseconds. Slower than the 1s
 * metrics cadence: a full process enumeration touches every PID with several
 * syscalls, and the list barely changes second to second, so a 2s cadence keeps
 * the overhead bounded while staying responsive.
 */
const COLLECT_INTERVAL_MS = 2000;

/**
 * Logical-core count. Per-process CPU uses Activity Monitor semantics (a process
 * pegging one core reads ~100%), so usage is NOT divided by this; it only caps
 * the reported value at cores * 100 (a fully busy machine).
 */
const LOGICAL_CORE_COUNT = Math.max(1, os.cpus().length);

/** Upper bound on reported per-process CPU percent: all cores fully busy. */
const MAX_CPU_PERCENT = LOGICAL_CORE_COUNT * 100;

/** Identity key for matching a process across snapshots (pid + start time). */
type ProcessKey = string;

/**
 * Per-process CPU baseline kept between collections so a usage percent can be
 * derived from the cumulative-counter delta.
 */
interface CpuBaseline {
  /** Cumulative user+system CPU time in nanoseconds at the last collection. */
  cumulativeCpuTimeNs: number;
  /** Monotonic clock (ms) when that counter was read. */
  sampledAtMs: number;
}

/**
 * Maps a native per-field availability onto the renderer field status. The
 * shared codes line up one to one; the proto3 default (UNSPECIFIED) and the
 * native-only PARSE_FAILED both collapse to a renderer "unavailable" since the
 * renderer contract has no parse-failed state.
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

/** Maps a native string field, preserving availability and value. */
function toStringValue(value: NativeString | undefined): StringValue {
  if (value === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: '' };
  }
  return { status: toFieldStatus(value.status), value: value.value };
}

/**
 * Maps the optional GUI app icon (a native PNG payload) onto the renderer's
 * base64 string value, preserving availability. The base64 payload is volatile
 * display data forwarded for rendering only; it is never logged or persisted.
 */
function toIconValue(icon: NativeImage | undefined): StringValue {
  if (icon === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: '' };
  }
  const status = toFieldStatus(icon.status);
  return {
    status,
    value: status === FieldStatus.FIELD_STATUS_OK ? icon.pngBase64 : '',
  };
}

/**
 * Maps the optional GUI app metadata (bundle id, localized name, icon). Only
 * NSWorkspace-known GUI apps carry this; a record without it (most daemons and
 * helpers) maps every field to UNKNOWN so the UI falls back to a generic icon
 * and the command/executable name. Icons are volatile display data, never logged.
 */
function toAppMetadata(app: NativeAppMetadata | undefined): AppMetadata {
  if (app === undefined) {
    const unknown = { status: FieldStatus.FIELD_STATUS_UNKNOWN, value: '' };
    return {
      bundleIdentifier: { ...unknown },
      localizedName: { ...unknown },
      iconPngBase64: { ...unknown },
    };
  }
  return {
    bundleIdentifier: toStringValue(app.bundleIdentifier),
    localizedName: toStringValue(app.localizedName),
    iconPngBase64: toIconValue(app.iconPng),
  };
}

/**
 * Maps the per-process memory group. Each metric is a non-negative byte count;
 * a negative native value (should not happen) is clamped to a real zero.
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
 * Maps the sensitive command-line group. Arguments are forwarded verbatim for
 * local display/search only; they are never logged or persisted here. Arguments
 * are dropped unless the vector is explicitly available.
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

/** Builds the snapshot-stable identity key for a record, or null if no PID. */
function recordKey(record: NativeProcessRecord): ProcessKey | null {
  const identity = record.identity;
  if (identity === undefined) {
    return null;
  }
  const startedAt =
    identity.startedAtStatus === NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE
      ? identity.startedAtUnixMs
      : 'unknown';
  return `${identity.pid}:${startedAt}`;
}

/**
 * Owns process collection and the renderer-facing snapshot for the process
 * explorer.
 *
 * Mirrors {@link import('../metrics/metrics-service').MetricsService}: it runs a
 * single visibility-gated, non-overlapping cadence in main (the lone consumer is
 * the one compact window), calls the native collector once per tick, maps the
 * raw records into a renderer {@link ProcessSnapshot}, caches it, bumps a
 * monotonic revision, and broadcasts a lightweight {@link ProcessSnapshotRevision}
 * ping so the renderer pulls the full snapshot only when it changes.
 *
 * Per-process CPU usage is derived here, not in native: the collector reports a
 * cumulative CPU-time counter, and this service diffs it across collections and
 * normalizes to logical-core count. A first sample, a restarted process (reused
 * PID with a new start time), a missing identity, or a non-positive interval
 * yields an UNKNOWN CPU value rather than a fabricated one.
 *
 * Privacy: command-line arguments pass through to the renderer for local
 * display/search only. This service never logs request targets, argument
 * values, executable paths, or process names; warnings are count-only.
 */
export class ProcessSnapshotService {
  /** Broadcast handle that owns the StreamRevisions subscriber set. */
  private readonly revisionHandle = ipc.registerService(
    ProcessExplorerServiceDescriptor,
  );

  /** CPU-time baselines from the previous collection, keyed by process identity. */
  private cpuBaselines = new Map<ProcessKey, CpuBaseline>();

  /** The most recent snapshot, served from cache by GetProcessSnapshot. */
  private snapshot: ProcessSnapshot = {
    status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
    revision: 0,
    timestampMs: 0,
    processes: [],
    warnings: [],
  };

  /** Monotonic revision id; advances each time a new snapshot is produced. */
  private revision = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Whether the process explorer view is on screen and collection should run. */
  private active = false;

  /** Set while an async collection is in flight, to guard against overlap. */
  private collecting = false;

  /** Set once dispose() has run; blocks any further activation or collection. */
  private disposed = false;

  /**
   * Activates or pauses collection. The caller (main) activates this service only
   * when the Processes view is the one on screen and the window is visible, so the
   * per-PID syscalls - and the sensitive command-line reads they perform - run
   * only while the user is actually looking at the process list. Idempotent for
   * repeated calls with the same state.
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
   * Returns the latest cached snapshot. The renderer pulls this after a revision
   * ping (or once for first paint). Returns a LOADING snapshot until the first
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
    // CPU baselines are intentionally kept across a pause (matching the metrics
    // sampler, which keeps its CPU tick counters), so re-entering the Processes
    // view computes a real per-process CPU delta on the first collection instead
    // of a cold start that sorts alphabetically with no values. The delta math
    // stays correct: both the CPU-time delta and the wall delta span the same
    // real elapsed gap, so the first post-resume tick reports true average usage
    // across the absence (it converges to instantaneous on the next tick). A
    // reused PID is a different (pid, started_at) key, so it still reports UNKNOWN
    // rather than diffing against an unrelated process.
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
      this.snapshot = this.buildSnapshot(response.available, response.records);
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

  /** Broadcasts the current snapshot's revision/status (no rows) to subscribers. */
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

      // Count a process as permission-limited if macOS denied ANY of its fields,
      // not just the task-info read - argv, path, memory, and CPU can each be
      // denied independently while task info is readable.
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
    };
  }

  /** An explicit unavailable snapshot (no rows) that still advances the revision. */
  private buildUnavailableSnapshot(): ProcessSnapshot {
    this.cpuBaselines.clear();
    this.revision += 1;
    return {
      status: SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE,
      revision: this.revision,
      timestampMs: Date.now(),
      processes: [],
      warnings: [],
    };
  }

  /** Assembles one renderer row from a native record and the derived fields. */
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
    };
  }

  /**
   * Derives a per-process CPU usage percent from the cumulative-counter delta
   * and records the new baseline. The result is UNKNOWN on a first sample, a
   * missing identity, a missing/!available counter, a process restart (the
   * key resets), or a non-positive elapsed interval, so a fresh or ambiguous row
   * never shows a fabricated value. Uses Activity Monitor semantics: the percent
   * is CPU time over wall time without dividing by core count, so one fully busy
   * core reads ~100% and a multi-threaded process can exceed 100% (capped at
   * cores * 100). The native counter is in real nanoseconds (mach ticks are
   * converted in the collector).
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

/** True when a native field status is an explicit macOS permission denial. */
function isFieldDenied(status: NativeFieldStatus): boolean {
  return status === NativeFieldStatus.NATIVE_FIELD_STATUS_PERMISSION_DENIED;
}

/**
 * True when macOS denied any independently-readable field on the record, used to
 * mark the snapshot permission-limited and tally the count-only permission
 * warning. macOS can deny argv, executable path, memory, or CPU separately even
 * when the task-info read (parent) succeeds, so every such field is checked, not
 * just the parent. No field value is read here - only the per-field status.
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

/** Builds the count-only snapshot warnings from per-pass tallies. */
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
