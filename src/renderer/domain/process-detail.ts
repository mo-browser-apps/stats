import { FieldStatus, type ProcessRow } from "@/gen/process_explorer";
import { formatBytes, formatCpuPercentPrecise, formatCpuTime } from "@/lib/format";
import {
  cellState,
  isPending,
  okString,
  rowCpu,
  rowDisplayName,
  rowIcon,
  rowMemory,
  rowMetric,
  rowNotResponding,
  rowPid,
  rowStartedAt,
  type IconTable,
  type MemberMetricSample,
  type MetricCell,
  type ProcessGroup,
  type ProcessMetricState,
  type SortMode,
} from "@/domain/process-list";

/**
 * Pure presentation logic for the process detail view: what the selected group
 * is, where it lives, what it was launched with, and how much CPU/memory the
 * whole group uses. Every field carries explicit availability so the component
 * renders honest unavailable/pending states instead of blanks or faked values.
 *
 * Privacy: command-line text is read into the display model only on an
 * explicit selection; it is never logged or persisted.
 */

/** Availability of a detail field, mirroring the list's metric states. */
export type DetailState = ProcessMetricState;

/** A detail value with availability; `text` is set only when state is `ok`. */
export interface DetailField {
  state: DetailState;
  text?: string;
}

/**
 * One member process of a group, shown in the expandable Members section and
 * drillable into its own single-process detail.
 */
export interface DetailMember {
  pid: number;
  /** Start time (Unix ms) when known, to disambiguate a reused PID on drill-in. */
  startedAtUnixMs?: number;
  name: string;
  iconPngBase64?: string;
  metricState: ProcessMetricState;
  /** Formatted active-metric value; set only when metricState is `ok`. */
  metricText?: string;
  /** True when macOS currently marks this member Not Responding. */
  notResponding: boolean;
}

/** Stable identity reader for a member, for order-pinning member lists. */
export function memberKey(member: DetailMember): string {
  return `${member.pid}:${member.startedAtUnixMs ?? "unknown"}`;
}

/**
 * Presentation model for the detail view of one selected group (or one
 * process - then a single-member group).
 */
export interface ProcessDetail {
  /** Group identity key (matches {@link ProcessGroup.key}). */
  key: string;
  /** Representative display name (the app name for a group, else the process). */
  name: string;
  pid: number;
  iconPngBase64?: string;
  /** Bundle identifier when known (e.g. com.apple.dt.Xcode). */
  bundleIdentifier?: string;
  /** Executable name, the secondary identity when no bundle id exists. */
  executableName?: string;
  /** Parent PID of the representative, when known and > 0. */
  parentPid?: number;
  startedAt: DetailState;
  /** Started-at value in Unix ms; set only when startedAt is `ok`. */
  startedAtUnixMs?: number;
  /** Executable path of the representative. */
  path: DetailField;
  /** Command line of the representative. */
  commandLine: DetailField;
  /** Thread count, summed across the group's members. */
  threadCount: DetailField;
  /** Total CPU time since launch, summed across members, as a duration. */
  cpuTime: DetailField;
  /** Owning user (login name, or `uid N`), from the representative. */
  user: DetailField;
  /** The group's total for the selected metric, with detail precision. */
  total: DetailField;
  /** Raw active-metric total for the trend graph. */
  totalValue: number | null;
  /** Which metric {@link total} reflects, for the "Total CPU"/"Total RAM" label. */
  totalSort: SortMode;
  memberCount: number;
  /**
   * All member rows for the Members section (representative first, then ranked
   * by the active metric). Empty for a single-process detail.
   */
  members: DetailMember[];
  /** True when macOS marks any member app Not Responding (see ProcessGroup). */
  notResponding: boolean;
}

/**
 * Detail-precision metric formatting (CPU two decimals, memory one extra
 * decimal), finer than the compact list.
 */
function formatDetailMetric(value: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercentPrecise(value) : formatBytes(value, true);
}

/** The non-ok state for a field status: pending while UNKNOWN, else unavailable. */
function missingState(status: FieldStatus | undefined): DetailState {
  return isPending(status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable";
}

/** Reads a StringValue field as a {@link DetailField}. */
function detailString(value: { status: FieldStatus; value: string } | undefined): DetailField {
  const text = okString(value);
  return text !== undefined ? { state: "ok", text } : { state: missingState(value?.status) };
}

/** Reads the representative's command line as a joined string with availability. */
function detailCommandLine(row: ProcessRow): DetailField {
  const commandLine = row.statics?.commandLine;
  if (commandLine && commandLine.status === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", text: commandLine.arguments.join(" ") };
  }
  return { state: missingState(commandLine?.status) };
}

/**
 * Sums one value across the group's members: `ok` when at least one member has
 * a real value (others contribute 0), `pending` when none is OK but some are
 * still being computed, `unavailable` otherwise.
 */
function sumGroup(
  members: ProcessRow[],
  read: (row: ProcessRow) => MetricCell,
  format: (value: number) => string,
): DetailField {
  let sum = 0;
  let hasValue = false;
  let anyPending = false;
  for (const row of members) {
    const cell = read(row);
    if (cell.value !== undefined) {
      sum += cell.value;
      hasValue = true;
    } else if (cell.pending) {
      anyPending = true;
    }
  }
  if (hasValue) {
    return { state: "ok", text: format(sum) };
  }
  return { state: anyPending ? "pending" : "unavailable" };
}

/** Raw counterpart to {@link sumGroup}; `null` means the graph should draw a gap. */
function sumGroupValue(members: ProcessRow[], read: (row: ProcessRow) => MetricCell): number | null {
  let sum = 0;
  let hasValue = false;
  for (const row of members) {
    const value = read(row).value;
    if (value !== undefined) {
      sum += value;
      hasValue = true;
    }
  }
  return hasValue ? sum : null;
}

function rowThreadCount(row: ProcessRow): MetricCell {
  const threads = row.threadCount;
  if (threads && threads.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: threads.value, pending: false };
  }
  return { pending: threads === undefined || isPending(threads.status) };
}

function rowCpuTime(row: ProcessRow): MetricCell {
  const cpuTime = row.cpuTime;
  if (cpuTime && cpuTime.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: cpuTime.nanos, pending: false };
  }
  return { pending: cpuTime === undefined || isPending(cpuTime.status) };
}

/** The owning user as a display stat: login name, else `uid N`. */
function detailUser(row: ProcessRow): DetailField {
  const user = row.statics?.user;
  if (user && user.status === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", text: user.name.length > 0 ? user.name : `uid ${user.uid}` };
  }
  return { state: missingState(user?.status) };
}

/** Projects one process row into a member display item under the active sort. */
export function buildMember(row: ProcessRow, sort: SortMode, icons: IconTable): DetailMember {
  const cell = rowMetric(row, sort);
  const metricState = cellState(cell);
  return {
    pid: rowPid(row),
    startedAtUnixMs: rowStartedAt(row),
    name: rowDisplayName(row),
    iconPngBase64: rowIcon(row, icons),
    metricState,
    metricText: metricState === "ok" ? formatDetailMetric(cell.value ?? 0, sort) : undefined,
    notResponding: rowNotResponding(row),
  };
}

/**
 * A group's members as display rows ranked by the active metric (descending),
 * with a PID tie-break so equal-value rows (e.g. idle 0.00% members) stay
 * stable across ticks. Shared by the detail view and the inline expanded list
 * so both order members identically.
 */
export function rankMembers(group: ProcessGroup, sort: SortMode, icons: IconTable): DetailMember[] {
  const read = sort === "cpu" ? rowCpu : rowMemory;
  return group.members
    .slice()
    .sort((left, right) => {
      const delta = (read(right).value ?? 0) - (read(left).value ?? 0);
      return delta !== 0 ? delta : rowPid(left) - rowPid(right);
    })
    .map((row) => buildMember(row, sort, icons));
}

/**
 * Ranks a stored per-tick member breakdown into display rows under the active
 * sort, mirroring {@link rankMembers} but for a historical tick.
 */
export function rankMemberSamples(
  samples: MemberMetricSample[],
  sort: SortMode,
  icons: IconTable,
): DetailMember[] {
  return samples
    .slice()
    .sort((left, right) => {
      const delta = (right[sort] ?? 0) - (left[sort] ?? 0);
      return delta !== 0 ? delta : left.pid - right.pid;
    })
    .map((sample) => {
      const value = sample[sort];
      const hasValue = value !== null;
      return {
        pid: sample.pid,
        startedAtUnixMs: sample.startedAtUnixMs,
        name: sample.name,
        iconPngBase64: sample.iconKey ? icons[sample.iconKey] || undefined : undefined,
        metricState: hasValue ? "ok" : "unavailable",
        metricText: hasValue ? formatDetailMetric(value, sort) : undefined,
        notResponding: false,
      } satisfies DetailMember;
    });
}

/**
 * Projects a selected {@link ProcessGroup} into its display model. Identity,
 * path, argv, and started-at come from the representative (the row the
 * collapsed list shows); CPU/memory/threads/CPU-time are summed across all
 * members so a grouped app reports its whole footprint.
 */
export function buildProcessDetail(group: ProcessGroup, sort: SortMode, icons: IconTable): ProcessDetail {
  const representative = group.members[0];
  const statics = representative.statics;
  const startedAtUnixMs = rowStartedAt(representative);
  const read = sort === "cpu" ? rowCpu : rowMemory;

  const parentAvailable =
    statics?.parentStatus === FieldStatus.FIELD_STATUS_OK && statics.parentPid > 0;

  // The representative stays group.members[0] for the header identity; only the
  // displayed list is ranked.
  const members = group.memberCount > 1 ? rankMembers(group, sort, icons) : [];

  return {
    key: group.key,
    name: group.name,
    pid: group.pid,
    iconPngBase64: group.iconPngBase64,
    bundleIdentifier: okString(statics?.app?.bundleIdentifier),
    executableName: okString(statics?.executableName),
    parentPid: parentAvailable ? statics?.parentPid : undefined,
    startedAt: startedAtUnixMs !== undefined
      ? "ok"
      : missingState(representative.identity?.startedAtStatus),
    startedAtUnixMs,
    path: detailString(statics?.executablePath),
    commandLine: detailCommandLine(representative),
    threadCount: sumGroup(group.members, rowThreadCount, (value) => Math.round(value).toString()),
    cpuTime: sumGroup(group.members, rowCpuTime, formatCpuTime),
    user: detailUser(representative),
    total: sumGroup(group.members, read, (value) => formatDetailMetric(value, sort)),
    totalValue: sumGroupValue(group.members, read),
    totalSort: sort,
    memberCount: group.memberCount,
    members,
    notResponding: group.notResponding,
  };
}
