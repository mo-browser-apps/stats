import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { formatBytes, formatCpuPercent } from "@/lib/format";

/**
 * Pure presentation logic for the process explorer list.
 *
 * Turns a raw {@link ProcessSnapshot} into ranked, searchable, app-grouped
 * display rows. It is intentionally side-effect free and holds no OS/IPC
 * knowledge, so it stays easy to reason about and to test (I15). The detail
 * model in {@link "@/domain/process-detail"} builds on the {@link ProcessGroup}s
 * and shared row readers exported here.
 *
 * Privacy: command-line arguments are used only as a local in-memory search
 * haystack here; they are never emitted into a group's display fields, logged,
 * or persisted.
 */

/**
 * The metrics the list can rank by.
 */
export type SortMode = "cpu" | "memory";

/**
 * The snapshot's deduplicated icon table: content-key -> base64 PNG. A row
 * carries only an `app.iconKey` into this table (icons are sent once per distinct
 * image, not once per row), so the projection resolves a row's icon through
 * {@link rowIcon} rather than reading bytes off the row.
 */
export type IconTable = { [key: string]: string };

/**
 * A detail-view selection: either an app group (by its key) or one specific
 * process (drilled into from a group's member list, or opened from a search
 * result that matched a member rather than the whole app group).
 */
export type DetailSelection =
  | { kind: "group"; key: string }
  | { kind: "process"; pid: number; startedAtUnixMs?: number };

/**
 * Display state of a group's active-metric value, mirroring the overview's metric
 * states: `ok` has a value, `pending` is not computed yet (show `--`), and
 * `unavailable` was tried and could not be read (show the unavailable text).
 *
 * Named distinctly from the overview's {@link "@/domain/metric-view".MetricState}
 * (which additionally models elevated/critical usage thresholds); a process
 * group value is just available / pending / unavailable.
 */
export type ProcessMetricState = "ok" | "pending" | "unavailable";

/**
 * One display row in the list. A group collapses an app's processes by owning
 * `.app` bundle path; processes without that app-bundle identity stay singleton
 * rows so unrelated CLIs and per-host XPC services are not merged.
 */
export interface ProcessGroup {
  /**
   * Stable key for React lists and selection.
   */
  key: string;
  /**
   * Display name for the group: the owning `.app` bundle's name for an app,
   * else the representative member's name (localized/executable/command/PID).
   */
  name: string;
  /**
   * Representative PID (the lowest-PID member - the app's main process).
   */
  pid: number;
  /**
   * Base64 PNG app icon when a GUI app supplied one; absent -> fallback icon.
   */
  iconPngBase64?: string;
  /**
   * Number of processes in the group (>= 1).
   */
  memberCount: number;
  /**
   * Extra members beyond the representative, shown as a "+N" badge when > 0.
   */
  childCount: number;
  /**
   * Display state of the active metric (drives ok value vs `--` vs unavailable).
   */
  metricState: ProcessMetricState;
  /**
   * Formatted active-metric value for the row; set only when metricState is ok.
   */
  metricText?: string;
  /**
   * Numeric active-metric magnitude used for ranking (0 when not ok).
   */
  sortValue: number;
  /**
   * Detail target for opening this list row. Group rows target the group;
   * searched member rows target the matched process so their visible name matches
   * the opened detail.
   */
  openSelection: DetailSelection;
  /**
   * The group's member rows, with the representative (the lowest-PID main
   * process) first. Carried so the detail view can show identity, command line,
   * path, hierarchy, and per-member totals without re-deriving them. Sensitive
   * command-line text on these rows stays display/search-only.
   */
  members: ProcessRow[];
}

/**
 * Maximum number of ranked rows shown at once. The window is a compact popover,
 * not an Activity Monitor table, and past the top consumers the list is a long
 * tail of idle (0%/--) processes; capping keeps it scannable. Any process is
 * still reachable by typing in the search field, which filters the full snapshot
 * before this cap is applied.
 */
export const DISPLAY_LIMIT = 50;

/**
 * Result of projecting a snapshot for the current sort/search.
 */
export interface ProcessListProjection {
  /**
   * The ranked rows to render, capped at {@link DISPLAY_LIMIT}.
   */
  groups: ProcessGroup[];
}

/**
 * Reads a string field only when it is explicitly OK.
 */
export function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value;
  }
  return undefined;
}

/**
 * Resolves a row's display icon (base64 PNG) from the snapshot's {@link IconTable}
 * by the row's `app.iconKey`, or undefined when the row has no icon. Icons are
 * carried once per distinct image in the table, not on each row, so this is the
 * single place that turns a key back into bytes. A missing/empty key or a key
 * absent from the table yields undefined and the UI shows its fallback glyph.
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
 * Best display name for a row: the localized app name, then the executable name,
 * then the short command name, falling back to the PID so a row is never blank.
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
 * A single row's active-metric reading. `value` is set only when the metric is
 * OK; otherwise `pending` distinguishes "not computed yet" (proto UNKNOWN, e.g.
 * a first-sample CPU delta) from "tried and unavailable" so the row can show a
 * quiet `--` while pending versus an explicit unavailable state.
 */
export interface MetricCell {
  value?: number;
  pending: boolean;
}

/**
 * Whether a field status is the proto default UNKNOWN ("not yet determined").
 */
export function isPending(status: FieldStatus): boolean {
  return status === FieldStatus.FIELD_STATUS_UNKNOWN;
}

/**
 * Per-process CPU percent with pending/unavailable distinction.
 */
export function rowCpu(row: ProcessRow): MetricCell {
  const cpu = row.cpu;
  if (cpu && cpu.status === FieldStatus.FIELD_STATUS_OK && Number.isFinite(cpu.usagePercent)) {
    return { value: cpu.usagePercent, pending: false };
  }
  return { pending: cpu === undefined || isPending(cpu.status) };
}

/**
 * Per-process memory in bytes: physical footprint when OK, else the resident
 * fallback when OK. Pending only if the primary footprint is still UNKNOWN.
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

/**
 * The active-metric reading for a single row under the current sort.
 */
export function rowMetric(row: ProcessRow, sort: SortMode): MetricCell {
  return sort === "cpu" ? rowCpu(row) : rowMemory(row);
}

/**
 * Maps a {@link MetricCell} to its display state: `ok` when it has a value,
 * `pending` while it is still being computed, else `unavailable`.
 */
export function cellState(cell: MetricCell): ProcessMetricState {
  return cell.value !== undefined ? "ok" : cell.pending ? "pending" : "unavailable";
}

/**
 * Group key. Only an owning `.app` path groups rows.
 */
function rowGroupKey(row: ProcessRow): string {
  const bundlePath = okString(row.app?.bundle?.path);
  if (bundlePath) {
    return `app:${bundlePath}`;
  }
  return rowIdentityKey(row);
}

/**
 * Stable singleton key for one process row, independent of app grouping.
 */
export function rowIdentityKey(row: ProcessRow): string {
  const pid = row.identity?.pid ?? 0;
  const startedAt =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : "unknown";
  return `pid:${pid}:${startedAt}`;
}

/**
 * Lowercased search haystack for one process member: display name, PID,
 * executable path, bundle id, command name, and command-line arguments when
 * available. App/group identity lives in {@link groupHaystack} so searching the
 * app name returns the app group, not every helper as an individual result.
 * Used only for in-memory matching; the sensitive argument text never leaves
 * this module.
 */
function rowHaystack(row: ProcessRow): string {
  const parts: string[] = [
    rowDisplayName(row),
    String(row.identity?.pid ?? 0),
  ];
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
 * excludes member argv so a helper-specific query can open that helper, while an
 * app identity query keeps a real app-bundle group and its Members section.
 */
function groupHaystack(group: ProcessGroup): string {
  const representative = group.members[0];
  const parts: string[] = [
    group.name,
    String(group.pid),
  ];
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
 * Accumulator while folding member rows into one group. It tracks only what
 * cannot be re-derived from the members afterwards: the summed sort metric and
 * the metric-availability flags. Display identity (representative, name, icon,
 * counts) is derived from `members` when the group is built.
 */
interface GroupAccumulator {
  key: string;
  sortValueSum: number;
  /**
   * True once any member contributed a real (OK) metric value.
   */
  hasMetric: boolean;
  /**
   * True if any member's metric is pending (UNKNOWN); used when none is OK.
   */
  anyPending: boolean;
  /**
   * All member rows, in snapshot order.
   */
  members: ProcessRow[];
}

/**
 * Starts a group accumulator with the first row that belongs to the group.
 */
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

/**
 * Adds one row's active metric and identity to a group accumulator.
 */
function addRowToGroup(group: GroupAccumulator, row: ProcessRow, sort: SortMode): void {
  const metric = rowMetric(row, sort);
  group.sortValueSum += metric.value ?? 0;
  group.hasMetric = group.hasMetric || metric.value !== undefined;
  group.anyPending = group.anyPending || metric.pending;
  group.members.push(row);
}

/**
 * Formats a group's summed metric for the compact list under the active sort.
 */
function formatGroupMetric(sum: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercent(sum) : formatBytes(sum);
}

/**
 * PID of a row, or 0 when the identity is missing.
 */
export function rowPid(row: ProcessRow): number {
  return row.identity?.pid ?? 0;
}

/**
 * Snapshot-stable process selection for one row.
 */
function rowSelection(row: ProcessRow): DetailSelection {
  const startedAtUnixMs =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : undefined;
  return { kind: "process", pid: rowPid(row), startedAtUnixMs };
}

/**
 * The representative member of a group: the lowest-PID row - the app's main
 * process, which starts before its helpers. Using this stable identity (rather
 * than the busiest member) keeps the detail header from flipping between members
 * as live usage shifts. Assumes a non-empty member list.
 */
function representativeOf(members: ProcessRow[]): ProcessRow {
  return members.reduce((lowest, row) => (rowPid(row) < rowPid(lowest) ? row : lowest));
}

/**
 * Builds the display {@link ProcessGroup} from an accumulated group: derives the
 * representative and the display name/icon/counts from the members (rather than
 * tracking them during the fold). The representative is hoisted to `members[0]`
 * so the detail header reads its identity; the icon prefers the representative's,
 * falling back to any member that has one (an `.app` group shares one icon).
 */
function buildGroupRow(group: GroupAccumulator, sort: SortMode, icons: IconTable): ProcessGroup {
  const representative = representativeOf(group.members);
  const isGroup = group.members.length > 1;
  const metricState: ProcessMetricState = group.hasMetric ? "ok" : group.anyPending ? "pending" : "unavailable";
  const icon =
    rowIcon(representative, icons) ??
    group.members.map((row) => rowIcon(row, icons)).find(Boolean);
  // A multi-process group shows the owning `.app` name; a single process (incl. a
  // drilled-in member) shows its own display name, not its app's.
  const appName = isGroup ? okString(representative.app?.bundle?.name) : undefined;
  return {
    key: group.key,
    name: appName ?? rowDisplayName(representative),
    pid: rowPid(representative),
    iconPngBase64: icon,
    memberCount: group.members.length,
    childCount: group.members.length - 1,
    metricState,
    metricText: metricState === "ok" ? formatGroupMetric(group.sortValueSum, sort) : undefined,
    sortValue: group.sortValueSum,
    openSelection: { kind: "group", key: group.key },
    members: representativeFirst(group.members, representative),
  };
}

/**
 * Folds snapshot rows into ranked display groups for the sort and optional search
 * query: buckets by native app key (owning `.app` bundle path), sums each
 * group's metric, and keeps non-app processes as singletons. Search keeps
 * app/group matches grouped but returns member-specific matches as singletons, so
 * the visible result name matches the process that opens. Ranked by summed metric
 * descending with a stable name tiebreak; no display cap - callers cap for the
 * list, but the detail lookup needs the full set to keep a selection findable.
 */
function buildGroups(rows: ProcessRow[], sort: SortMode, query: string, icons: IconTable): ProcessGroup[] {
  const trimmed = query.trim().toLowerCase();
  const grouped = buildGroupedRows(rows, sort, icons);
  if (trimmed.length > 0) {
    return buildSearchGroups(grouped, sort, trimmed, icons);
  }

  return grouped;
}

/**
 * Builds the normal app-grouped list rows with no search filter applied.
 */
function buildGroupedRows(rows: ProcessRow[], sort: SortMode, icons: IconTable): ProcessGroup[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const row of rows) {
    const key = rowGroupKey(row);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, createGroupAccumulator(key, row, sort));
      continue;
    }

    addRowToGroup(existing, row, sort);
  }

  const projected: ProcessGroup[] = Array.from(groups.values()).map((group) =>
    buildGroupRow(group, sort, icons),
  );

  return sortGroups(projected);
}

/**
 * Builds search results from already-grouped rows. App identity or representative
 * matches keep the group; otherwise only the matching member processes are shown.
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
    if (groupHaystack(group).includes(query) || rowHaystack(representative).includes(query)) {
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
 * Sorts list groups by active metric, with stable cold-start behavior.
 */
function sortGroups(projected: ProcessGroup[]): ProcessGroup[] {
  // Rank by summed metric descending. The name tiebreak applies only between two
  // rows that both have a real value, so on a first-sample cold start (every row
  // pending, all sortValue 0) the list keeps the snapshot's insertion order
  // instead of snapping to an alphabetical layout that then reshuffles a tick
  // later. Array.sort is stable, so equal comparisons preserve that order.
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
 * Projects a snapshot into ranked, grouped, searched display rows for the list.
 *
 * Grouping and ranking live in {@link buildGroups}; this caps the result to
 * {@link DISPLAY_LIMIT}. Search has already narrowed the groups to matches, so a
 * process beyond the cap is still reachable by typing.
 */
export function projectProcessList(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  query: string,
): ProcessListProjection {
  return {
    groups: buildGroups(snapshot.processes, sort, query, snapshot.icons).slice(
      0,
      DISPLAY_LIMIT,
    ),
  };
}

/**
 * Reorders projected groups to match a previously rendered key order, so the
 * list can pin row positions while the pointer is inside it - a live re-rank
 * otherwise moves rows under the cursor between aiming and clicking, opening
 * the wrong detail. Only the order is held; the group objects (and their live
 * metric values) are the fresh ones. Groups not in `pinnedKeys` (new arrivals)
 * append after the pinned rows in their ranked order, so they never displace a
 * row mid-list; vanished keys drop out naturally. With no pinned keys the
 * groups pass through unchanged.
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
 * Finds one group by its {@link ProcessGroup.key} for the detail view. Collects
 * only the rows whose {@link rowGroupKey} matches (rather than grouping the whole
 * snapshot and discarding the rest - the detail re-resolves on every tick, so this
 * stays cheap), then folds them through the same {@link buildGroupRow} path the
 * list uses, so the representative and member order match the list the user opened
 * from. Returns undefined when the group is gone (its processes all exited), so
 * the detail can fall back to the list. No display cap applies.
 */
export function findGroupByKey(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  key: string,
): ProcessGroup | undefined {
  let group: GroupAccumulator | undefined = undefined;

  for (const row of snapshot.processes) {
    if (rowGroupKey(row) !== key) {
      continue;
    }

    const existing = group;
    if (existing === undefined) {
      group = createGroupAccumulator(key, row, sort);
    } else {
      addRowToGroup(existing, row, sort);
    }
  }

  return group === undefined
    ? undefined
    : buildGroupRow(group, sort, snapshot.icons);
}

/**
 * Returns the group's members with `representative` at index 0. The detail reads
 * `members[0]` for its header identity (name/PID/path/argv), so the representative
 * must be first; the order of the rest does not matter here because the detail
 * re-ranks the displayed member list by the active metric in `buildProcessDetail`.
 */
function representativeFirst(members: ProcessRow[], representative: ProcessRow): ProcessRow[] {
  const index = members.indexOf(representative);
  if (index <= 0) {
    return members;
  }
  const ordered = members.slice();
  ordered.splice(index, 1);
  ordered.unshift(representative);
  return ordered;
}

/**
 * A single-member {@link ProcessGroup} wrapping one member row, so drilling into
 * a member reuses `buildProcessDetail` unchanged: its detail shows just that
 * process (its own CPU/memory, no member list). Built through the same
 * {@link buildGroupRow} path as list groups; the key is the row's PID/start-time
 * singleton identity, distinct from any app-bundle group key.
 */
export function singleProcessGroup(row: ProcessRow, sort: SortMode, icons: IconTable): ProcessGroup {
  const cell = rowMetric(row, sort);
  const group = buildGroupRow(
    {
      key: rowIdentityKey(row),
      sortValueSum: cell.value ?? 0,
      hasMetric: cell.value !== undefined,
      anyPending: cell.pending,
      members: [row],
    },
    sort,
    icons,
  );
  return { ...group, openSelection: rowSelection(row) };
}

/**
 * Resolves a {@link DetailSelection} against the current snapshot into the
 * {@link ProcessGroup} the detail renders, or undefined when it is gone (the
 * group's processes all exited, or the drilled-in process exited / its PID was
 * reused). For a process selection: if the selection carried an exact start time,
 * only an exact (pid, started_at) match resolves - if the process exited and its
 * PID was reused, no match is found and this returns undefined, so the drill-in
 * falls back up the stack rather than silently showing an unrelated process. Only
 * a selection with no recorded start time falls back to PID alone.
 */
export function resolveSelection(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  selection: DetailSelection,
): ProcessGroup | undefined {
  if (selection.kind === "group") {
    return findGroupByKey(snapshot, sort, selection.key);
  }

  const matches = snapshot.processes.filter((row) => (row.identity?.pid ?? 0) === selection.pid);
  if (matches.length === 0) {
    return undefined;
  }

  if (selection.startedAtUnixMs !== undefined) {
    const exact = matches.find(
      (row) =>
        row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK &&
        row.identity.startedAtUnixMs === selection.startedAtUnixMs,
    );
    // No exact (pid, started_at) match: the selected process is gone (its PID may
    // have been reused). Return undefined rather than a different process.
    return exact ? singleProcessGroup(exact, sort, snapshot.icons) : undefined;
  }

  return singleProcessGroup(matches[0], sort, snapshot.icons);
}
