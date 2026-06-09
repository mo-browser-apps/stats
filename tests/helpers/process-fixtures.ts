import {
  type AppMetadata,
  type CommandLine,
  type CpuTime,
  type CpuUsage,
  FieldStatus,
  type ProcessIdentity,
  type ProcessMemory,
  type ProcessRow,
  type ProcessSnapshot,
  type ProcessUser,
  SnapshotStatus,
  type StringValue,
  type UInt64Value,
} from "@main/gen/process_explorer";

/**
 * Synthetic process fixtures for the pure-logic tests (I15).
 *
 * The generated {@link ProcessRow} carries many independently-available nested
 * fields, so building one inline in every test is noisy and easy to get wrong.
 * These helpers fill correct defaults (every optional field absent, identity
 * present) and let a test set only the fields it exercises. The renderer and main
 * generated modules are byte-identical, so a row built here is structurally valid
 * for both the renderer domain projections and the main action service.
 *
 * Privacy: all argv/path/name strings here are obviously fake and chosen to read
 * as test data; no real command lines are committed.
 */

/** Options for {@link makeRow}; omitted fields default to absent/unknown. */
export interface RowOptions {
  pid?: number;
  /** Start time in Unix ms; provide to make the identity stable (OK status). */
  startedAtUnixMs?: number;
  /** Override the started-at availability (defaults to OK when a time is given). */
  startedAtStatus?: FieldStatus;
  parentPid?: number;
  parentStatus?: FieldStatus;
  commandName?: string;
  executableName?: string;
  executablePath?: string;
  /** App bundle identifier (e.g. com.example.App). */
  bundleIdentifier?: string;
  /** NSWorkspace localized app name. */
  localizedName?: string;
  /** Base64 PNG icon payload (any non-empty string for tests). */
  iconPngBase64?: string;
  /** Owning `.app` bundle path - the list's grouping key for an app. */
  bundlePath?: string;
  /** Owning `.app` bundle display name. */
  bundleName?: string;
  /** Command-line arguments; sets the command line to OK when provided. */
  commandLine?: string[];
  /** Override the command-line availability (e.g. PERMISSION_DENIED). */
  commandLineStatus?: FieldStatus;
  /** Per-process CPU percent (Activity Monitor semantics); sets CPU OK. */
  cpuPercent?: number;
  /** Override the CPU availability (e.g. UNKNOWN for a first sample). */
  cpuStatus?: FieldStatus;
  /** Physical footprint in bytes; sets the memory footprint OK. */
  footprintBytes?: number;
  /** Resident bytes fallback; sets the resident value OK. */
  residentBytes?: number;
  /** Cumulative CPU time in nanoseconds; sets CpuTime OK. */
  cpuTimeNanos?: number;
  /** Thread count; sets the thread count OK. */
  threadCount?: number;
  /** Owning user id; sets the user OK. */
  uid?: number;
  /** Owning user login name (empty string keeps the numeric uid). */
  userName?: string;
}

/** An OK string wrapper. */
function okStr(value: string): StringValue {
  return { status: FieldStatus.FIELD_STATUS_OK, value };
}

/** An OK uint64 wrapper. */
function okU64(value: number): UInt64Value {
  return { status: FieldStatus.FIELD_STATUS_OK, value };
}

/** Builds the optional app metadata only when at least one app field is set. */
function makeApp(options: RowOptions): AppMetadata | undefined {
  const hasApp =
    options.bundleIdentifier !== undefined ||
    options.localizedName !== undefined ||
    options.iconPngBase64 !== undefined ||
    options.bundlePath !== undefined ||
    options.bundleName !== undefined;
  if (!hasApp) {
    return undefined;
  }
  const hasBundle = options.bundlePath !== undefined || options.bundleName !== undefined;
  return {
    bundleIdentifier: options.bundleIdentifier !== undefined ? okStr(options.bundleIdentifier) : undefined,
    localizedName: options.localizedName !== undefined ? okStr(options.localizedName) : undefined,
    // Icons live in the snapshot's table, not on the row; the row carries a key.
    // In fixtures the test's iconPngBase64 value doubles as both key and bytes
    // (see makeSnapshot), so rowIcon resolves back to the value the test set.
    iconKey: options.iconPngBase64 ?? "",
    bundle: hasBundle
      ? {
        path: options.bundlePath !== undefined ? okStr(options.bundlePath) : undefined,
        name: options.bundleName !== undefined ? okStr(options.bundleName) : undefined,
      }
      : undefined,
  };
}

/** Builds the per-process memory only when a footprint or resident value is set. */
function makeMemory(options: RowOptions): ProcessMemory | undefined {
  if (options.footprintBytes === undefined && options.residentBytes === undefined) {
    return undefined;
  }
  return {
    physicalFootprintBytes: options.footprintBytes !== undefined ? okU64(options.footprintBytes) : undefined,
    residentBytes: options.residentBytes !== undefined ? okU64(options.residentBytes) : undefined,
  };
}

/** Builds the CPU usage cell, honoring an explicit non-OK status override. */
function makeCpu(options: RowOptions): CpuUsage | undefined {
  if (options.cpuStatus !== undefined) {
    return { status: options.cpuStatus, usagePercent: options.cpuPercent ?? 0 };
  }
  if (options.cpuPercent !== undefined) {
    return { status: FieldStatus.FIELD_STATUS_OK, usagePercent: options.cpuPercent };
  }
  return undefined;
}

/** Builds the cumulative CPU time cell when a nanos value is set. */
function makeCpuTime(options: RowOptions): CpuTime | undefined {
  if (options.cpuTimeNanos === undefined) {
    return undefined;
  }
  return { status: FieldStatus.FIELD_STATUS_OK, nanos: options.cpuTimeNanos };
}

/** Builds the owning-user cell when a uid is set. */
function makeUser(options: RowOptions): ProcessUser | undefined {
  if (options.uid === undefined) {
    return undefined;
  }
  return { status: FieldStatus.FIELD_STATUS_OK, uid: options.uid, name: options.userName ?? "" };
}

/** Builds the command-line cell, honoring an explicit non-OK status override. */
function makeCommandLine(options: RowOptions): CommandLine | undefined {
  if (options.commandLineStatus !== undefined) {
    return { status: options.commandLineStatus, arguments: options.commandLine ?? [], fromPrev: false };
  }
  if (options.commandLine !== undefined) {
    return { status: FieldStatus.FIELD_STATUS_OK, arguments: options.commandLine, fromPrev: false };
  }
  return undefined;
}

/** Builds the process identity, defaulting start time to OK when a value is set. */
function makeIdentity(options: RowOptions): ProcessIdentity {
  const startedAtStatus =
    options.startedAtStatus ??
    (options.startedAtUnixMs !== undefined ? FieldStatus.FIELD_STATUS_OK : FieldStatus.FIELD_STATUS_UNKNOWN);
  return {
    pid: options.pid ?? 0,
    startedAtStatus,
    startedAtUnixMs: options.startedAtUnixMs ?? 0,
  };
}

/**
 * Builds one {@link ProcessRow} with correct defaults: identity present, every
 * optional field absent unless the options set it. A field with an explicit
 * status override (e.g. `cpuStatus`) is built with that status so pending /
 * permission-denied paths are testable.
 */
export function makeRow(options: RowOptions = {}): ProcessRow {
  return {
    identity: makeIdentity(options),
    parentStatus:
      options.parentStatus ??
      (options.parentPid !== undefined ? FieldStatus.FIELD_STATUS_OK : FieldStatus.FIELD_STATUS_UNAVAILABLE),
    parentPid: options.parentPid ?? 0,
    commandName: options.commandName !== undefined ? okStr(options.commandName) : undefined,
    executableName: options.executableName !== undefined ? okStr(options.executableName) : undefined,
    executablePath: options.executablePath !== undefined ? okStr(options.executablePath) : undefined,
    app: makeApp(options),
    commandLine: makeCommandLine(options),
    memory: makeMemory(options),
    cpu: makeCpu(options),
    threadCount: options.threadCount !== undefined ? okU64(options.threadCount) : undefined,
    cpuTime: makeCpuTime(options),
    user: makeUser(options),
    stableFromPrev: false,
  };
}

/**
 * Wraps rows in an OK {@link ProcessSnapshot} for projection/lookup tests,
 * rebuilding the icon table from the rows' keys so {@link rowIcon} resolves. Each
 * row's icon key (the test's iconPngBase64 value) maps to itself, so a row with
 * iconPngBase64 set resolves back to that value through the snapshot table.
 */
export function makeSnapshot(rows: ProcessRow[], revision = 1): ProcessSnapshot {
  const icons: { [key: string]: string } = {};
  for (const row of rows) {
    const key = row.app?.iconKey;
    if (key !== undefined && key.length > 0) {
      icons[key] = key;
    }
  }
  return {
    status: SnapshotStatus.SNAPSHOT_STATUS_OK,
    revision,
    timestampMs: 0,
    processes: rows,
    warnings: [],
    icons,
    delta: false,
  };
}

/** Builds a {@link ProcessIdentity} target for the action tests. */
export function makeTarget(pid: number, startedAtUnixMs?: number): ProcessIdentity {
  return {
    pid,
    startedAtStatus: startedAtUnixMs !== undefined ? FieldStatus.FIELD_STATUS_OK : FieldStatus.FIELD_STATUS_UNKNOWN,
    startedAtUnixMs: startedAtUnixMs ?? 0,
  };
}
