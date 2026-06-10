import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { UNAVAILABLE_TEXT, formatBytes, formatCpuPercent } from "@/lib/format";

/**
 * Pure presentation logic for the process explorer list: turns a raw
 * {@link ProcessSnapshot} into ranked, searchable, app-grouped display rows.
 * Side-effect free and OS/IPC-agnostic; the detail model in
 * {@link "@/domain/process-detail"} builds on the groups and row readers here.
 *
 * Privacy: command-line arguments are used only as a local in-memory search
 * haystack; they are never emitted into display fields, logged, or persisted.
 */

/** The metrics the list can rank by. */
export type SortMode = "cpu" | "memory";

/**
 * The snapshot's deduplicated icon table: content key -> base64 PNG. Rows
 * carry only an `app.iconKey`; {@link rowIcon} resolves it through this table.
 */
export type IconTable = { [key: string]: string };

/**
 * A detail-view selection: an app group (by key) or one specific process
 * (drilled into from a member list or a member-matched search result).
 */
export type DetailSelection =
  | { kind: "group"; key: string }
  | { kind: "process"; pid: number; startedAtUnixMs?: number };

/**
 * Display state of a metric value: `ok` has a value, `pending` is not yet
 * computed (show `--`), `unavailable` was tried and could not be read.
 */
export type ProcessMetricState = "ok" | "pending" | "unavailable";

/**
 * One display row in the list. A group collapses an app's processes by owning
 * `.app` bundle path; processes without that identity stay singleton rows so
 * unrelated CLIs and per-host XPC services are not merged.
 */
export interface ProcessGroup {
  /** Stable key for React lists and selection. */
  key: string;
  /** The owning `.app` bundle's name for an app, else the representative's name. */
  name: string;
  /** Representative PID (the lowest-PID member - the app's main process). */
  pid: number;
  /** Base64 PNG app icon when available; absent -> fallback icon. */
  iconPngBase64?: string;
  /** Number of processes in the group (>= 1). */
  memberCount: number;
  /** Extra members beyond the representative, shown as a "+N" badge when > 0. */
  childCount: number;
  metricState: ProcessMetricState;
  /** Formatted active-metric value; set only when metricState is ok. */
  metricText?: string;
  /** Numeric active-metric magnitude used for ranking (0 when not ok). */
  sortValue: number;
  /**
   * Detail target for opening this row. Group rows target the group; searched
   * member rows target the matched process so the visible name matches the
   * opened detail.
   */
  openSelection: DetailSelection;
  /**
   * True only for the synthetic System group: it gets the gear glyph and a
   * member-count subtitle, and hides single-process fields and actions.
   */
  system: boolean;
  /**
   * The member rows with the representative first, so the detail view can show
   * identity, command line, hierarchy, and per-member totals without
   * re-deriving them.
   */
  members: ProcessRow[];
}

/**
 * Maximum number of ranked rows shown at once: past the top consumers the list
 * is a long tail of idle processes. Any process stays reachable via search,
 * which filters the full snapshot before this cap is applied.
 */
export const DISPLAY_LIMIT = 50;

/** Reads a string field only when it is explicitly OK and non-empty. */
export function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value;
  }
  return undefined;
}

/**
 * Resolves a row's display icon from the snapshot's {@link IconTable} by the
 * row's `app.iconKey`; undefined (-> fallback glyph) when the row has no icon
 * or the key is not in the table.
 */
export function rowIcon(row: ProcessRow, icons: IconTable): string | undefined {
  const key = row.app?.iconKey;
  if (key === undefined || key.length === 0) {
    return undefined;
  }
  const bytes = icons[key];
  return bytes !== undefined && bytes.length > 0 ? bytes : undefined;
}

/**
 * Best display name for a row: localized app name, then executable name, then
 * command name, falling back to the PID so a row is never blank.
 */
export function rowDisplayName(row: ProcessRow): string {
  return (
    okString(row.app?.localizedName) ??
    okString(row.executableName) ??
    okString(row.commandName) ??
    `PID ${row.identity?.pid ?? 0}`
  );
}

/**
 * A row's metric reading. `value` is set only when the metric is OK;
 * otherwise `pending` distinguishes "not computed yet" from "unavailable".
 */
export interface MetricCell {
  value?: number;
  pending: boolean;
}

/** Whether a field status is the proto default UNKNOWN ("not yet determined"). */
export function isPending(status: FieldStatus): boolean {
  return status === FieldStatus.FIELD_STATUS_UNKNOWN;
}

/** Per-process CPU percent with pending/unavailable distinction. */
export function rowCpu(row: ProcessRow): MetricCell {
  const cpu = row.cpu;
  if (cpu && cpu.status === FieldStatus.FIELD_STATUS_OK && Number.isFinite(cpu.usagePercent)) {
    return { value: cpu.usagePercent, pending: false };
  }
  return { pending: cpu === undefined || isPending(cpu.status) };
}

/**
 * Per-process memory in bytes: physical footprint when OK, else the resident
 * fallback. Pending only if the primary footprint is still UNKNOWN.
 */
export function rowMemory(row: ProcessRow): MetricCell {
  const footprint = row.memory?.physicalFootprintBytes;
  if (footprint && footprint.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: footprint.value, pending: false };
  }
  const resident = row.memory?.residentBytes;
  if (resident && resident.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: resident.value, pending: false };
  }
  return { pending: footprint === undefined || isPending(footprint.status) };
}

/** The active-metric reading for one row under the current sort. */
export function rowMetric(row: ProcessRow, sort: SortMode): MetricCell {
  return sort === "cpu" ? rowCpu(row) : rowMemory(row);
}

/** Maps a {@link MetricCell} to its display state. */
export function cellState(cell: MetricCell): ProcessMetricState {
  return cell.value !== undefined ? "ok" : cell.pending ? "pending" : "unavailable";
}

/** Display text for a metric value under the ok/pending/unavailable rule. */
export function metricValueText(state: ProcessMetricState, text: string | undefined): string {
  if (state === "ok") {
    return text ?? UNAVAILABLE_TEXT;
  }
  return state === "pending" ? "--" : UNAVAILABLE_TEXT;
}

/** PID of a row, or 0 when the identity is missing. */
export function rowPid(row: ProcessRow): number {
  return row.identity?.pid ?? 0;
}

/** Start time (Unix ms) of a row, or undefined when not reliably known. */
export function rowStartedAt(row: ProcessRow): number | undefined {
  return row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
    ? row.identity.startedAtUnixMs
    : undefined;
}

/** Stable singleton key for one process row, independent of app grouping. */
export function rowIdentityKey(row: ProcessRow): string {
  return `pid:${rowPid(row)}:${rowStartedAt(row) ?? "unknown"}`;
}

/**
 * Key of the synthetic System group that buckets Apple's non-app system
 * processes (daemons under SIP-protected paths) into one compact row, keeping
 * the list focused on the user's own apps instead of idle macOS daemons.
 */
export const SYSTEM_GROUP_KEY = "system";

/**
 * Apple-owned executable locations - the SIP-protected prefixes. `/usr/local/`
 * is deliberately excluded: it is the user-writable exception where developer
 * tools live, exactly the processes this product surfaces individually.
 */
const SYSTEM_PATH_PREFIXES = ["/System/", "/usr/", "/sbin/", "/bin/"];

function isSystemPath(path: string): boolean {
  if (path.startsWith("/usr/local/")) {
    return false;
  }
  return SYSTEM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Group key: an owning `.app` path groups an app's processes; a non-app
 * process in an Apple-owned path joins the System group; everything else -
 * including a row with no readable path, whose identity is uncertain - stays
 * a singleton.
 */
function rowGroupKey(row: ProcessRow): string {
  const bundlePath = okString(row.app?.bundle?.path);
  if (bundlePath) {
    return `app:${bundlePath}`;
  }
  const path = okString(row.executablePath);
  if (path !== undefined && isSystemPath(path)) {
    return SYSTEM_GROUP_KEY;
  }
  return rowIdentityKey(row);
}

/**
 * Lowercased search haystack for one process member. App/group identity lives
 * in {@link groupHaystack} so searching an app name returns the app group, not
 * every helper individually. In-memory matching only; the sensitive argument
 * text never leaves this module.
 */
function rowHaystack(row: ProcessRow): string {
  const parts: string[] = [rowDisplayName(row), String(rowPid(row))];
  const path = okString(row.executablePath);
  if (path) parts.push(path);
  const bundle = okString(row.app?.bundleIdentifier);
  if (bundle) parts.push(bundle);
  const command = okString(row.commandName);
  if (command) parts.push(command);
  if (row.commandLine && row.commandLine.status === FieldStatus.FIELD_STATUS_OK) {
    parts.push(row.commandLine.arguments.join(" "));
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Lowercased search haystack for the grouped app identity. It intentionally
 * excludes member argv so a helper-specific query opens that helper, while an
 * app identity query keeps the app-bundle group whole.
 */
function groupHaystack(group: ProcessGroup): string {
  const representative = group.members[0];
  const parts: string[] = [group.name, String(group.pid)];
  const bundle = okString(representative.app?.bundleIdentifier);
  if (bundle) parts.push(bundle);
  const localizedName = okString(representative.app?.localizedName);
  if (localizedName) parts.push(localizedName);
  const bundleName = okString(representative.app?.bundle?.name);
  if (bundleName) parts.push(bundleName);
  const bundlePath = okString(representative.app?.bundle?.path);
  if (bundlePath) parts.push(bundlePath);
  return parts.join(" ").toLowerCase();
}

/**
 * Accumulator while folding member rows into one group: the summed sort metric,
 * the metric-availability flags, and the members. Display identity is derived
 * from the members when the group is built.
 */
interface GroupAccumulator {
  key: string;
  sortValueSum: number;
  hasMetric: boolean;
  anyPending: boolean;
  members: ProcessRow[];
}

function createGroupAccumulator(key: string, row: ProcessRow, sort: SortMode): GroupAccumulator {
  const metric = rowMetric(row, sort);
  return {
    key,
    sortValueSum: metric.value ?? 0,
    hasMetric: metric.value !== undefined,
    anyPending: metric.pending,
    members: [row],
  };
}

function addRowToGroup(group: GroupAccumulator, row: ProcessRow, sort: SortMode): void {
  const metric = rowMetric(row, sort);
  group.sortValueSum += metric.value ?? 0;
  group.hasMetric = group.hasMetric || metric.value !== undefined;
  group.anyPending = group.anyPending || metric.pending;
  group.members.push(row);
}

function formatGroupMetric(sum: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercent(sum) : formatBytes(sum);
}

/** Snapshot-stable process selection for one row. */
function rowSelection(row: ProcessRow): DetailSelection {
  return { kind: "process", pid: rowPid(row), startedAtUnixMs: rowStartedAt(row) };
}

/**
 * The representative member of a group: the lowest-PID row - the app's main
 * process. This stable identity (rather than the busiest member) keeps the
 * detail header from flipping between members as live usage shifts.
 */
function representativeOf(members: ProcessRow[]): ProcessRow {
  return members.reduce((lowest, row) => (rowPid(row) < rowPid(lowest) ? row : lowest));
}

/**
 * Builds the display {@link ProcessGroup} from an accumulated group. The
 * representative is hoisted to `members[0]` so the detail header reads its
 * identity; the icon prefers the representative's, falling back to any member
 * that has one (an `.app` group shares one icon).
 */
function buildGroupRow(group: GroupAccumulator, sort: SortMode, icons: IconTable): ProcessGroup {
  const representative = representativeOf(group.members);
  const isSystem = group.key === SYSTEM_GROUP_KEY;
  const metricState: ProcessMetricState = group.hasMetric ? "ok" : group.anyPending ? "pending" : "unavailable";
  const icon =
    rowIcon(representative, icons) ??
    group.members.map((row) => rowIcon(row, icons)).find(Boolean);
  // A multi-process group shows the owning `.app` name; a single process shows
  // its own display name. The System group shows its fixed label and the gear
  // glyph (no member's executable icon should brand the whole bucket).
  const appName = group.members.length > 1 ? okString(representative.app?.bundle?.name) : undefined;
  return {
    key: group.key,
    name: isSystem ? "System" : appName ?? rowDisplayName(representative),
    pid: rowPid(representative),
    iconPngBase64: isSystem ? undefined : icon,
    memberCount: group.members.length,
    childCount: group.members.length - 1,
    metricState,
    metricText: metricState === "ok" ? formatGroupMetric(group.sortValueSum, sort) : undefined,
    sortValue: group.sortValueSum,
    openSelection: { kind: "group", key: group.key },
    members: representativeFirst(group.members, representative),
    system: isSystem,
  };
}

/** Builds the app-grouped, ranked rows with no search filter applied. */
function buildGroupedRows(rows: ProcessRow[], sort: SortMode, icons: IconTable): ProcessGroup[] {
  const groups = new Map<string, GroupAccumulator>();
  for (const row of rows) {
    const key = rowGroupKey(row);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, createGroupAccumulator(key, row, sort));
    } else {
      addRowToGroup(existing, row, sort);
    }
  }

  return sortGroups(
    Array.from(groups.values()).map((group) => buildGroupRow(group, sort, icons)),
  );
}

/**
 * Builds search results from already-grouped rows. App identity or
 * representative matches keep the group whole; otherwise only the matching
 * member processes are shown, as singletons. The representative shortcut is
 * skipped for the System group: its members are unrelated daemons, so a match
 * (e.g. "launchd") surfaces that daemon, not the whole bucket.
 */
function buildSearchGroups(
  groups: ProcessGroup[],
  sort: SortMode,
  query: string,
  icons: IconTable,
): ProcessGroup[] {
  const projected: ProcessGroup[] = [];

  for (const group of groups) {
    const representative = group.members[0];
    if (
      groupHaystack(group).includes(query) ||
      (!group.system && rowHaystack(representative).includes(query))
    ) {
      projected.push(group);
      continue;
    }

    for (const member of group.members) {
      if (rowHaystack(member).includes(query)) {
        projected.push(singleProcessGroup(member, sort, icons));
      }
    }
  }

  return sortGroups(projected);
}

/**
 * Ranks by summed metric descending. The name tiebreak applies only between
 * rows that both have a real value, so a cold start (every row pending, all
 * sortValue 0) keeps the snapshot's insertion order instead of snapping to an
 * alphabetical layout that reshuffles a tick later (Array.sort is stable).
 */
function sortGroups(projected: ProcessGroup[]): ProcessGroup[] {
  projected.sort((left, right) => {
    if (right.sortValue !== left.sortValue) {
      return right.sortValue - left.sortValue;
    }
    if (left.metricState === "ok" && right.metricState === "ok") {
      return left.name.localeCompare(right.name);
    }
    return 0;
  });

  return projected;
}

/**
 * Projects a snapshot into ranked, grouped, searched display rows, capped at
 * {@link DISPLAY_LIMIT}. Search narrows before the cap, so a process beyond it
 * is still reachable by typing.
 */
export function projectProcessList(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  query: string,
): ProcessGroup[] {
  const trimmed = query.trim().toLowerCase();
  const grouped = buildGroupedRows(snapshot.processes, sort, snapshot.icons);
  const groups = trimmed.length > 0
    ? buildSearchGroups(grouped, sort, trimmed, snapshot.icons)
    : grouped;
  return groups.slice(0, DISPLAY_LIMIT);
}

/**
 * Reorders projected groups to match a previously rendered key order, so the
 * list can pin row positions while the pointer is inside it (a live re-rank
 * would move rows between aiming and clicking). Only the order is held; the
 * group objects and their metric values are the fresh ones. New arrivals
 * append after the pinned rows so they never displace a row mid-list; vanished
 * keys drop out naturally.
 */
export function pinGroupOrder(groups: ProcessGroup[], pinnedKeys: string[]): ProcessGroup[] {
  if (pinnedKeys.length === 0) {
    return groups;
  }

  const rankByKey = new Map(pinnedKeys.map((key, index) => [key, index] as const));
  const pinned: ProcessGroup[] = [];
  const fresh: ProcessGroup[] = [];
  for (const group of groups) {
    (rankByKey.has(group.key) ? pinned : fresh).push(group);
  }
  pinned.sort((left, right) => (rankByKey.get(left.key) ?? 0) - (rankByKey.get(right.key) ?? 0));

  return [...pinned, ...fresh];
}

/**
 * Finds one group by key for the detail view, folding only the matching rows
 * through the same {@link buildGroupRow} path the list uses, so the
 * representative and member order match the list the user opened from.
 * Undefined when the group is gone (its processes all exited).
 */
export function findGroupByKey(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  key: string,
): ProcessGroup | undefined {
  let group: GroupAccumulator | undefined;

  for (const row of snapshot.processes) {
    if (rowGroupKey(row) !== key) {
      continue;
    }
    if (group === undefined) {
      group = createGroupAccumulator(key, row, sort);
    } else {
      addRowToGroup(group, row, sort);
    }
  }

  return group && buildGroupRow(group, sort, snapshot.icons);
}

/** Returns the members with `representative` hoisted to index 0. */
function representativeFirst(members: ProcessRow[], representative: ProcessRow): ProcessRow[] {
  if (members[0] === representative) {
    return members;
  }
  return [representative, ...members.filter((member) => member !== representative)];
}

/**
 * A single-member {@link ProcessGroup} wrapping one row, so drilling into a
 * member reuses `buildProcessDetail` unchanged. The key is the row's singleton
 * identity, distinct from any app-bundle group key.
 */
export function singleProcessGroup(row: ProcessRow, sort: SortMode, icons: IconTable): ProcessGroup {
  const group = buildGroupRow(createGroupAccumulator(rowIdentityKey(row), row, sort), sort, icons);
  return { ...group, openSelection: rowSelection(row) };
}

/**
 * Resolves a {@link DetailSelection} against the current snapshot, or
 * undefined when it is gone. A process selection that carried an exact start
 * time resolves only on an exact (pid, started_at) match - if the PID was
 * reused the drill-in falls back up the stack rather than silently showing an
 * unrelated process; only a selection with no recorded start time falls back
 * to PID alone.
 */
export function resolveSelection(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  selection: DetailSelection,
): ProcessGroup | undefined {
  if (selection.kind === "group") {
    return findGroupByKey(snapshot, sort, selection.key);
  }

  const matches = snapshot.processes.filter((row) => rowPid(row) === selection.pid);
  if (matches.length === 0) {
    return undefined;
  }

  if (selection.startedAtUnixMs !== undefined) {
    const exact = matches.find((row) => rowStartedAt(row) === selection.startedAtUnixMs);
    return exact ? singleProcessGroup(exact, sort, snapshot.icons) : undefined;
  }

  return singleProcessGroup(matches[0], sort, snapshot.icons);
}
