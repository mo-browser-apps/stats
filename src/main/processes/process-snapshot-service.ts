import { createHash } from "node:crypto";
import * as os from "node:os";
import { ipc } from "@mobrowser/api";
import { native } from "../gen/native";
import {
  NativeAppBundle,
  NativeAppMetadata,
  NativeCommandLine,
  NativeFieldStatus,
  NativeInt64,
  NativeProcessCpu,
  NativeProcessRecord,
  NativeProcessUser,
  NativeResponsiveness,
  NativeString,
} from "../gen/native/process_collector";
import {
  AppBundle,
  AppMetadata,
  CommandLine,
  CpuTime,
  CpuUsage,
  FieldStatus,
  GetProcessAssetsResponse,
  ProcessMemory,
  ProcessRow,
  ProcessSnapshot,
  ProcessSnapshotRevision,
  ProcessStatics,
  ProcessUser,
  Responsiveness,
  SnapshotStatus,
  SnapshotWarning,
  SnapshotWarning_Code,
  StringValue,
  UInt64Value,
} from "../gen/process_explorer";
import { ProcessExplorerServiceDescriptor } from "../gen/ipc_service";
import { PollLoop } from "../poll-loop";

const COLLECT_INTERVAL_MS = 3000;

/**
 * Per-process CPU uses Activity Monitor semantics (one fully busy core reads
 * ~100%, multi-threaded processes can exceed it), capped at all cores busy.
 */
const MAX_CPU_PERCENT = Math.max(1, os.cpus().length) * 100;

/** Identity key for matching a process across snapshots (pid + start time). */
type ProcessKey = string;

/** CPU baseline kept between collections to derive a usage percent delta. */
interface CpuBaseline {
  cumulativeCpuTimeNs: number;
  sampledAtMs: number;
}

/**
 * Maps native per-field availability onto the renderer field status. The
 * proto3 default (UNSPECIFIED) and native-only PARSE_FAILED collapse to
 * "unavailable" since the renderer has no parse-failed state.
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
    default:
      return FieldStatus.FIELD_STATUS_UNAVAILABLE;
  }
}

function toStringValue(value: NativeString | undefined): StringValue {
  if (value === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: "" };
  }
  return { status: toFieldStatus(value.status), value: value.value };
}

/** Maps a native int64 field to a non-negative value with availability. */
function toUInt64Value(value: NativeInt64 | undefined): UInt64Value {
  if (value === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: 0 };
  }
  const status = toFieldStatus(value.status);
  return {
    status,
    value: status === FieldStatus.FIELD_STATUS_OK ? Math.max(0, value.value) : 0,
  };
}

/**
 * Maps the owning `.app` bundle the list groups by. An absent bundle or
 * non-available path maps to undefined so the renderer keeps the row singleton.
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
 * Maps the optional GUI app metadata (bundle id, localized name, icon key).
 * A record with no app data maps the name fields to UNKNOWN with no icon key,
 * so the UI falls back to a generic icon and the command/executable name.
 * Icon bytes never ride the row; the renderer fetches keys via GetProcessIcons.
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
 * Maps the cumulative CPU-time counter. Surfaced directly (no first-sample
 * UNKNOWN): a cumulative total needs no delta, unlike the derived percent.
 */
function toCpuTime(cpu: NativeProcessCpu | undefined): CpuTime {
  const { status, value } = toUInt64Value(cpu?.cumulativeCpuTimeNs);
  return { status, nanos: value };
}

/**
 * Maps the owning user (uid + login name, sharing one availability). An
 * unmapped uid stays OK with the numeric value and an empty name.
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
 * Maps the window-server responsiveness of a GUI app. Absent in, absent out:
 * only NSWorkspace apps carry the field, and a row without it renders no
 * responsiveness state at all. The flag is only trusted when the native read
 * succeeded.
 */
function toResponsiveness(
  value: NativeResponsiveness | undefined,
): Responsiveness | undefined {
  if (value === undefined) {
    return undefined;
  }
  const status = toFieldStatus(value.status);
  return {
    status,
    unresponsive: status === FieldStatus.FIELD_STATUS_OK ? value.unresponsive : false,
  };
}

/**
 * Maps the sensitive command-line group. Arguments are forwarded verbatim for
 * local display/search only and are never logged or persisted here.
 */
function toCommandLine(commandLine: NativeCommandLine | undefined): CommandLine {
  if (commandLine === undefined) {
    return { status: FieldStatus.FIELD_STATUS_UNAVAILABLE, arguments: [] };
  }
  const status = toFieldStatus(commandLine.status);
  return {
    status,
    arguments: status === FieldStatus.FIELD_STATUS_OK ? commandLine.arguments : [],
  };
}

/**
 * Maps a native record's image-lifetime-stable fields into the statics blob
 * rows reference by content key. Forwarded for local display/search only;
 * never logged or persisted here.
 */
function toStatics(record: NativeProcessRecord, commandLine: CommandLine): ProcessStatics {
  return {
    parentStatus: toFieldStatus(record.parentStatus),
    parentPid: record.parentPid,
    commandName: toStringValue(record.commandName),
    executableName: toStringValue(record.executableName),
    executablePath: toStringValue(record.executablePath),
    app: toAppMetadata(record.app),
    commandLine,
    user: toProcessUser(record.user),
  };
}

/**
 * Content-hash key of a statics blob: a hash over its deterministic proto
 * encoding, so identical blobs dedupe (twin processes share one entry) and any
 * value change - including an exec - yields a new key, making a held blob
 * stale-proof by construction. 128 hash bits; collisions are not a concern at
 * process-list cardinality.
 */
function staticsKey(statics: ProcessStatics): string {
  return createHash("sha256")
    .update(ProcessStatics.encode(statics).finish())
    .digest("base64url")
    .slice(0, 22);
}

/**
 * Builds one row: identity plus the per-tick dynamic readings, with the
 * statics blob joined for main-side consumers (the action service). The wire
 * form published to the renderer strips the join and keeps only its key.
 */
function toProcessRow(
  record: NativeProcessRecord,
  cpu: CpuUsage,
  staticKey: string,
  statics: ProcessStatics,
): ProcessRow {
  const identity = record.identity;
  return {
    identity: {
      pid: identity?.pid ?? 0,
      startedAtStatus: toFieldStatus(
        identity?.startedAtStatus ?? NativeFieldStatus.NATIVE_FIELD_STATUS_UNAVAILABLE,
      ),
      startedAtUnixMs: identity?.startedAtUnixMs ?? 0,
    },
    staticKey,
    memory: {
      physicalFootprintBytes: toUInt64Value(record.memory?.physicalFootprintBytes),
      residentBytes: toUInt64Value(record.memory?.residentBytes),
    } satisfies ProcessMemory,
    cpu,
    threadCount: toUInt64Value(record.threadCount),
    cpuTime: toCpuTime(record.cpu),
    responsiveness: toResponsiveness(record.responsiveness),
    statics,
  };
}

/** Snapshot-stable identity key for a native record, or null without a PID. */
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
 * explorer: a visibility-gated cadence calls the native collector, maps the
 * records into a {@link ProcessSnapshot}, caches it under a monotonic revision,
 * and broadcasts a lightweight revision ping so the renderer pulls the full
 * snapshot only when it changes.
 *
 * Per-process CPU percent is derived here by diffing the native cumulative
 * CPU-time counter against wall time (Activity Monitor semantics). A first
 * sample, a restarted process (reused PID, new start time), or a non-positive
 * interval yields UNKNOWN rather than a fabricated value.
 *
 * Privacy: command lines pass through for local display/search only; nothing
 * process-identifying is ever logged, and warnings are count-only.
 */
export class ProcessSnapshotService {
  private readonly revisionHandle = ipc.registerService(ProcessExplorerServiceDescriptor);

  private readonly loop = new PollLoop(COLLECT_INTERVAL_MS, () => this.collect());

  private cpuBaselines = new Map<ProcessKey, CpuBaseline>();

  private snapshot: ProcessSnapshot = {
    status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
    revision: 0,
    timestampMs: 0,
    processes: [],
    warnings: [],
    icons: {},
  };

  /** The wire form of {@link snapshot}: rows carry static_key, never the blob. */
  private wireSnapshot: ProcessSnapshot = this.snapshot;

  /**
   * The statics blobs of the current and previous snapshot generations, by
   * content key. Two generations so an asset fetch racing the next tick (the
   * renderer pulled revision N, main already produced N+1) still resolves.
   */
  private currentStatics = new Map<string, ProcessStatics>();

  private previousStatics = new Map<string, ProcessStatics>();

  private revision = 0;

  private disposed = false;

  /**
   * Activates or pauses collection. Active only while the Processes view is on
   * screen, so the per-PID syscalls - including the sensitive command-line
   * reads - run only while the user is looking at the list. CPU baselines are
   * kept across a pause: CPU-time and wall deltas span the same gap, so the
   * first tick after resume still computes a real per-process delta.
   */
  setActive(active: boolean): void {
    this.loop.setActive(active);
  }

  /**
   * Returns the latest cached snapshot in its main-side form, with statics
   * joined onto every row (the action service reads names and paths from it).
   * The renderer pull is served by {@link getWireSnapshot}.
   */
  getSnapshot(): ProcessSnapshot {
    return this.snapshot;
  }

  /**
   * Returns the wire form of the latest snapshot: rows carry only static_key;
   * the renderer gateway joins blobs fetched through GetProcessAssets.
   */
  getWireSnapshot(): ProcessSnapshot {
    return this.wireSnapshot;
  }

  /**
   * Resolves content-addressed assets the renderer does not hold: statics from
   * the two retained snapshot generations, icon bytes passed through to the
   * native session cache. A key that resolves nowhere is omitted; the renderer
   * degrades that row honestly and the next pull retries.
   */
  async getAssets(staticKeys: string[], iconKeys: string[]): Promise<GetProcessAssetsResponse> {
    if (this.disposed) {
      return { statics: {}, icons: {} };
    }

    const statics: { [key: string]: ProcessStatics } = {};
    for (const key of staticKeys) {
      const blob = this.currentStatics.get(key) ?? this.previousStatics.get(key);
      if (blob !== undefined) {
        statics[key] = blob;
      }
    }

    let icons: { [key: string]: string } = {};
    if (iconKeys.length > 0) {
      try {
        icons = (await native.processCollector.GetIcons({ keys: iconKeys })).icons;
      } catch {
        // Degrade to empty; the next pull retries the still-missing keys.
      }
    }

    return { statics, icons };
  }

  /** Stops the cadence and closes the revision stream. Idempotent and final. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loop.dispose();
    this.cpuBaselines.clear();
    this.currentStatics.clear();
    this.previousStatics.clear();
    this.revisionHandle.dispose();
  }

  /**
   * Collects once, rebuilds the cached snapshot, and broadcasts a revision
   * ping. Never rejects: a native failure degrades to an unavailable snapshot
   * (no diagnostic is logged - it could carry process-identifying data).
   */
  private async collect(): Promise<void> {
    try {
      const response = await native.processCollector.CollectProcesses({});
      if (this.disposed) {
        return;
      }
      const built = this.buildSnapshot(response.available, response.records);
      this.publishSnapshot(built.snapshot, built.statics);
    } catch {
      if (!this.disposed) {
        this.publishSnapshot(this.buildUnavailableSnapshot(), new Map());
      }
    }
  }

  /**
   * Publishes a built snapshot: rotates the statics generations, caches the
   * main-side (statics-joined) and wire (statics-stripped) forms, and
   * broadcasts the revision ping.
   */
  private publishSnapshot(next: ProcessSnapshot, statics: Map<string, ProcessStatics>): void {
    this.previousStatics = this.currentStatics;
    this.currentStatics = statics;
    this.snapshot = next;
    this.wireSnapshot = {
      ...next,
      processes: next.processes.map((row) => ({ ...row, statics: undefined })),
    };
    this.revisionHandle.StreamRevisions({
      revision: next.revision,
      timestampMs: next.timestampMs,
      status: next.status,
    } satisfies ProcessSnapshotRevision);
  }

  /**
   * Builds a renderer snapshot from native records, collecting each row's
   * statics blob into the content-keyed map served by {@link getAssets}, and
   * updates the CPU baselines for the next collection.
   */
  private buildSnapshot(
    available: boolean,
    records: NativeProcessRecord[],
  ): { snapshot: ProcessSnapshot; statics: Map<string, ProcessStatics> } {
    if (!available) {
      return { snapshot: this.buildUnavailableSnapshot(), statics: new Map() };
    }

    const sampledAtMs = performance.now();
    const nextBaselines = new Map<ProcessKey, CpuBaseline>();
    const statics = new Map<string, ProcessStatics>();
    let permissionDeniedCount = 0;
    let commandLinePartialCount = 0;

    const processes: ProcessRow[] = records.map((record) => {
      const key = recordKey(record);
      const cpu = this.deriveCpu(record.cpu, key, sampledAtMs, nextBaselines);
      const commandLine = toCommandLine(record.commandLine);

      if (hasDeniedField(record)) {
        permissionDeniedCount += 1;
      }
      if (commandLine.status !== FieldStatus.FIELD_STATUS_OK) {
        commandLinePartialCount += 1;
      }

      const blob = toStatics(record, commandLine);
      const blobKey = staticsKey(blob);
      statics.set(blobKey, blob);
      return toProcessRow(record, cpu, blobKey, blob);
    });

    this.cpuBaselines = nextBaselines;
    this.revision += 1;

    return {
      snapshot: {
        status: permissionDeniedCount > 0
          ? SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED
          : SnapshotStatus.SNAPSHOT_STATUS_OK,
        revision: this.revision,
        timestampMs: Date.now(),
        processes,
        warnings: buildWarnings(permissionDeniedCount, commandLinePartialCount),
        icons: {},
      },
      statics,
    };
  }

  /** An explicit unavailable snapshot (no rows) that still advances the revision. */
  private buildUnavailableSnapshot(): ProcessSnapshot {
    // CPU baselines reset; a fresh delta is derived on the next success.
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
   * Derives a CPU usage percent from the cumulative-counter delta and records
   * the new baseline. UNKNOWN on a first sample, a missing identity or counter,
   * a process restart (the key resets), or a non-positive elapsed interval, so
   * a fresh or ambiguous row never shows a fabricated value.
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
      return { status: FieldStatus.FIELD_STATUS_UNKNOWN, usagePercent: 0 };
    }

    const cpuDeltaNs = cumulativeCpuTimeNs - previous.cumulativeCpuTimeNs;
    const wallDeltaMs = sampledAtMs - previous.sampledAtMs;
    if (cpuDeltaNs < 0 || wallDeltaMs <= 0) {
      // Counter reset or non-monotonic clock; re-arm from this sample.
      return { status: FieldStatus.FIELD_STATUS_UNKNOWN, usagePercent: 0 };
    }

    const usagePercent = Math.min(
      MAX_CPU_PERCENT,
      Math.max(0, (cpuDeltaNs / (wallDeltaMs * 1_000_000)) * 100),
    );
    return { status: FieldStatus.FIELD_STATUS_OK, usagePercent };
  }
}

/**
 * True when macOS denied any independently-readable field on the record. macOS
 * can deny argv, path, memory, or CPU separately even when task info reads, so
 * every per-field status is checked (statuses only, never values).
 */
function hasDeniedField(record: NativeProcessRecord): boolean {
  const statuses = [
    record.parentStatus,
    record.commandName?.status,
    record.executableName?.status,
    record.executablePath?.status,
    record.commandLine?.status,
    record.memory?.physicalFootprintBytes?.status,
    record.memory?.residentBytes?.status,
    record.cpu?.cumulativeCpuTimeNs?.status,
  ];
  return statuses.some(
    (status) => status === NativeFieldStatus.NATIVE_FIELD_STATUS_PERMISSION_DENIED,
  );
}

/** Builds the count-only snapshot warnings from the per-pass tallies. */
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
