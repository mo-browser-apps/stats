import { FieldStatus, type ProcessRow } from "@/gen/process_explorer";
import { formatBytes, formatCpuPercentPrecise, formatCpuTime } from "@/lib/format";
import {
  cellState,
  isPending,
  okString,
  rowCpu,
  rowDisplayName,
  rowMemory,
  rowMetric,
  rowPid,
  type MetricCell,
  type ProcessGroup,
  type ProcessMetricState,
  type SortMode,
} from "@/domain/process-list";

/**
 * Pure presentation logic for the process detail view.
 *
 * The detail view answers the debugging question for one selected group: what
 * is it, where does it live, what was it launched with, how is it nested, and
 * how much CPU/memory does the whole group use. Like the list projection in
 * {@link "@/domain/process-list"} this is pure: it turns the already-collected
 * member rows into explicit display fields (with availability), so the detail
 * component stays presentation-only and the derivation is test-ready (I15).
 *
 * Privacy: command-line text is read only into the display model on an explicit
 * selection; it is never logged or persisted.
 */

/**
 * Availability of a detail field, mirroring the list's metric states: `ok` has a
 * value, `pending` is not yet determined (proto UNKNOWN), `unavailable` was tried
 * and could not be read (including permission-denied / process-exited, which the
 * compact detail surfaces as a single "unavailable" line rather than separate
 * copy).
 */
export type DetailState = ProcessMetricState;

/** A summed group metric with its display state. */
export interface DetailMetric {
  state: DetailState;
  /** Formatted value; set only when state is `ok`. */
  text?: string;
}

/**
 * A small secondary stat in the detail header strip (thread count, CPU time,
 * owning user), with explicit availability so an unreadable one renders a muted
 * placeholder rather than a blank.
 */
interface DetailStat {
  state: DetailState;
  /** Formatted value; set only when state is `ok`. */
  text?: string;
}

/** The command-line block's content with explicit availability. */
export interface DetailCommandLine {
  state: DetailState;
  /** Joined argument string for display/copy; set only when state is `ok`. */
  text?: string;
}

/**
 * One member process of a group, shown in the expandable Members section and
 * drillable into its own (single-process) detail. Carries the per-member value
 * under the active sort so the member list reads like the main list.
 */
export interface DetailMember {
  /** PID of this member, used as the React key and to drill in. */
  pid: number;
  /** Start time (Unix ms) when known, to disambiguate a reused PID on drill-in. */
  startedAtUnixMs?: number;
  /** Member display name. */
  name: string;
  /**
   * Volatile base64 PNG icon when available; absent -> fallback glyph. App
   * members share their app's icon (helpers carry no distinct icon of their own);
   * a non-bundled member shows its executable's icon.
   */
  iconPngBase64?: string;
  /** Active-metric display state for this member (ok / pending / unavailable). */
  metricState: ProcessMetricState;
  /** Formatted active-metric value; set only when metricState is `ok`. */
  metricText?: string;
}

/** The selected process's parent context, shown above its identity. */
interface DetailParent {
  /** Whether a parent PID is known for the selected process. */
  available: boolean;
  /** Parent PID when available and > 0. */
  pid?: number;
}

/**
 * Presentation model for the detail view of one selected group (or one process,
 * when a member is drilled into - then it is a single-member group). Every
 * textual field is optional with an availability state so the component can show
 * an explicit unavailable/pending line instead of a blank or a faked value.
 */
export interface ProcessDetail {
  /** Group identity key (matches {@link ProcessGroup.key}). */
  key: string;
  /** Representative display name (the app name for a group, else the process). */
  name: string;
  /** Representative PID. */
  pid: number;
  /** Volatile base64 PNG icon when available; absent -> fallback glyph. */
  iconPngBase64?: string;
  /** Bundle identifier when known (e.g. com.apple.dt.Xcode). */
  bundleIdentifier?: string;
  /** Executable name, shown as the secondary identity when no bundle id exists. */
  executableName?: string;
  /** Parent-process context of the representative. */
  parent: DetailParent;
  /** Started-at time of the representative. */
  startedAt: DetailState;
  /** Started-at value in Unix ms; set only when startedAt is `ok`. */
  startedAtUnixMs?: number;
  /** Executable path of the representative. */
  path: DetailState;
  /** Executable path value; set only when path is `ok` (drives copy). */
  pathText?: string;
  /** Command line of the representative. */
  commandLine: DetailCommandLine;
  /**
   * Thread count: summed across the group's members (an app's total threads),
   * or the single process's own count.
   */
  threadCount: DetailStat;
  /**
   * Total CPU time consumed since launch, summed across the group's members and
   * formatted as a compact duration. The cumulative companion to the percent.
   */
  cpuTime: DetailStat;
  /**
   * Owning user (login name, or `uid N` when the name is unknown), taken from
   * the representative; an app group's members all run as the same user.
   */
  user: DetailStat;
  /**
   * The group's total for the currently selected metric (sum of members),
   * formatted with detail precision. Shown above the member list and re-derived
   * when the CPU/RAM switch changes.
   */
  total: DetailMetric;
  /** Which metric {@link total} reflects, for the "Total CPU"/"Total RAM" label. */
  totalSort: SortMode;
  /** Number of processes in the group (>= 1). */
  memberCount: number;
  /**
   * All member rows for the expandable Members section (representative first).
   * Empty for a single-process detail; the section scrolls within a bounded box
   * when there are many, so no cap is applied here.
   */
  members: DetailMember[];
}

/**
 * Formats a metric for the detail panel with extra precision (CPU two decimals,
 * memory one extra decimal), so a group's total and its member rows read more
 * finely there than in the compact list.
 */
function formatDetailMetric(value: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercentPrecise(value) : formatBytes(value, true);
}

/** Reads the started-at identity of a row with pending/unavailable distinction. */
function rowStartedAt(row: ProcessRow): { state: DetailState; value?: number } {
  const identity = row.identity;
  if (identity && identity.startedAtStatus === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", value: identity.startedAtUnixMs };
  }
  return { state: isPending(identity?.startedAtStatus ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" };
}

/** Reads a StringValue field as a detail state plus optional text. */
function detailString(
  value: { status: FieldStatus; value: string } | undefined,
): { state: DetailState; text?: string } {
  const text = okString(value);
  if (text !== undefined) {
    return { state: "ok", text };
  }
  return { state: isPending(value?.status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" };
}

/** Reads the representative's command line as a joined string with availability. */
function detailCommandLine(row: ProcessRow): DetailCommandLine {
  const commandLine = row.commandLine;
  if (commandLine && commandLine.status === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", text: commandLine.arguments.join(" ") };
  }
  return { state: isPending(commandLine?.status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" };
}

/**
 * Sums one value across the group's members for either a metric total or a header
 * stat (DetailMetric and DetailStat share the same `{ state, text }` shape). `ok`
 * when at least one member has a real value (others contribute 0); `pending` when
 * none is OK but some are still being computed; `unavailable` otherwise.
 */
function sumGroup(
  members: ProcessRow[],
  read: (row: ProcessRow) => MetricCell,
  format: (value: number) => string,
): DetailMetric {
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

/** Per-process thread count with pending/unavailable distinction. */
function rowThreadCount(row: ProcessRow): MetricCell {
  const threads = row.threadCount;
  if (threads && threads.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: threads.value, pending: false };
  }
  return { pending: threads === undefined || isPending(threads.status) };
}

/** Per-process cumulative CPU time (nanoseconds) with pending/unavailable. */
function rowCpuTime(row: ProcessRow): MetricCell {
  const cpuTime = row.cpuTime;
  if (cpuTime && cpuTime.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: cpuTime.nanos, pending: false };
  }
  return { pending: cpuTime === undefined || isPending(cpuTime.status) };
}

/**
 * Reads the representative's owning user as a display stat: the login name when
 * known, else `uid N` (the numeric uid is still useful identity), else
 * pending/unavailable.
 */
function detailUser(row: ProcessRow): DetailStat {
  const user = row.user;
  if (user && user.status === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", text: user.name.length > 0 ? user.name : `uid ${user.uid}` };
  }
  return { state: isPending(user?.status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" };
}

/** Projects one member row into a {@link DetailMember} under the active sort. */
function buildMember(row: ProcessRow, sort: SortMode): DetailMember {
  const cell = rowMetric(row, sort);
  const metricState = cellState(cell);
  const startedAt =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : undefined;
  return {
    pid: rowPid(row),
    startedAtUnixMs: startedAt,
    name: rowDisplayName(row),
    iconPngBase64: okString(row.app?.iconPngBase64),
    metricState,
    metricText: metricState === "ok" ? formatDetailMetric(cell.value ?? 0, sort) : undefined,
  };
}

/**
 * Projects a selected {@link ProcessGroup} into its {@link ProcessDetail} display
 * model. Identity/path/argv/started-at come from the representative (the row the
 * collapsed list shows); CPU and memory are summed across all members so a grouped
 * app reports its whole footprint. A multi-process group projects all members
 * (representative first) for the Members section; a single-process detail has no
 * member list. The active `sort` sets each member's displayed value.
 */
export function buildProcessDetail(group: ProcessGroup, sort: SortMode): ProcessDetail {
  const representative = group.members[0];
  const started = rowStartedAt(representative);
  const path = detailString(representative.executablePath);
  const bundleIdentifier = okString(representative.app?.bundleIdentifier);
  const executableName = detailString(representative.executableName).text;

  const parentAvailable =
    representative.parentStatus === FieldStatus.FIELD_STATUS_OK && representative.parentPid > 0;

  const read = sort === "cpu" ? rowCpu : rowMemory;

  // Display the members ranked by the active metric (highest first), like the
  // main list - not in snapshot/PID order. A PID tie-break keeps equal-value rows
  // (e.g. several idle 0.00% members) stable across ticks. The representative is
  // still group.members[0] for the header identity; only the displayed list is
  // ranked here.
  const members =
    group.memberCount > 1
      ? group.members
        .slice()
        .sort((left, right) => {
          const delta = (read(right).value ?? 0) - (read(left).value ?? 0);
          if (delta !== 0) {
            return delta;
          }
          return (left.identity?.pid ?? 0) - (right.identity?.pid ?? 0);
        })
        .map((row) => buildMember(row, sort))
      : [];

  // Only the selected metric's total is shown (the CPU/RAM switch picks which),
  // formatted with detail precision.
  const total = sumGroup(group.members, read, (value) => formatDetailMetric(value, sort));

  // Secondary header stats. Thread count and CPU time sum across the group (an
  // app's whole footprint); the user comes from the representative (members
  // share it). Thread count uses no decimals.
  const threadCount = sumGroup(group.members, rowThreadCount, (value) =>
    Math.round(value).toString(),
  );
  const cpuTime = sumGroup(group.members, rowCpuTime, formatCpuTime);
  const user = detailUser(representative);

  return {
    key: group.key,
    name: group.name,
    pid: group.pid,
    iconPngBase64: group.iconPngBase64,
    bundleIdentifier,
    executableName,
    parent: { available: parentAvailable, pid: parentAvailable ? representative.parentPid : undefined },
    startedAt: started.state,
    startedAtUnixMs: started.value,
    path: path.state,
    pathText: path.text,
    commandLine: detailCommandLine(representative),
    threadCount,
    cpuTime,
    user,
    total,
    totalSort: sort,
    memberCount: group.memberCount,
    members,
  };
}
