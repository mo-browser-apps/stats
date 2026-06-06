import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer"
import { formatBytes, formatCpuPercent, formatCpuPercentPrecise } from "@/lib/format"

/**
 * Pure presentation logic for the process explorer list.
 *
 * Turns a raw {@link ProcessSnapshot} into ranked, searchable, app-grouped
 * display rows. It is intentionally side-effect free and holds no OS/IPC
 * knowledge, so it stays easy to reason about and to test (I15).
 *
 * Privacy: command-line arguments are used only as a local in-memory search
 * haystack here; they are never emitted into a group's display fields, logged,
 * or persisted.
 */

/** The metrics the list can rank by. */
export type SortMode = "cpu" | "memory"

/**
 * A detail-view selection: either an app group (by its key) or one specific
 * process (drilled into from a group's member list, or opened from a search
 * result that matched a member rather than the whole app group).
 */
export type DetailSelection =
  | { kind: "group"; key: string }
  | { kind: "process"; pid: number; startedAtUnixMs?: number }

/**
 * Display state of a group's active-metric value, mirroring the overview's metric
 * states: `ok` has a value, `pending` is not computed yet (show `--`), and
 * `unavailable` was tried and could not be read (show the unavailable text).
 */
export type MetricState = "ok" | "pending" | "unavailable"

/**
 * One display row in the list. A group collapses an app's processes by owning
 * `.app` bundle path or bundle id; processes without app identity stay singleton
 * rows so unrelated CLIs with the same executable name are not merged.
 */
export interface ProcessGroup {
  /** Stable key for React lists and selection. */
  key: string
  /**
   * Display name for the group: the owning `.app` bundle's name for an app,
   * else the representative member's name (localized/executable/command/PID).
   */
  name: string
  /** Representative PID (the lowest-PID member - the app's main process). */
  pid: number
  /** Base64 PNG app icon when a GUI app supplied one; absent -> fallback icon. */
  iconPngBase64?: string
  /** Number of processes in the group (>= 1). */
  memberCount: number
  /** Extra members beyond the representative, shown as a "+N" badge when > 0. */
  childCount: number
  /** Display state of the active metric (drives ok value vs `--` vs unavailable). */
  metricState: MetricState
  /** Formatted active-metric value for the row; set only when metricState is ok. */
  metricText?: string
  /** Numeric active-metric magnitude used for ranking (0 when not ok). */
  sortValue: number
  /**
   * Detail target for opening this list row. Group rows target the group;
   * searched member rows target the matched process so their visible name matches
   * the opened detail.
   */
  openSelection: DetailSelection
  /**
   * The group's member rows, with the representative (the lowest-PID main
   * process) first. Carried so the detail view can show identity, command line,
   * path, hierarchy, and per-member totals without re-deriving them. Sensitive
   * command-line text on these rows stays display/search-only.
   */
  members: ProcessRow[]
}

/**
 * Maximum number of ranked rows shown at once. The window is a compact popover,
 * not an Activity Monitor table, and past the top consumers the list is a long
 * tail of idle (0%/--) processes; capping keeps it scannable. Any process is
 * still reachable by typing in the search field, which filters the full snapshot
 * before this cap is applied.
 */
export const DISPLAY_LIMIT = 50

/** Result of projecting a snapshot for the current sort/search. */
export interface ProcessListProjection {
  /** The ranked rows to render, capped at {@link DISPLAY_LIMIT}. */
  groups: ProcessGroup[]
}

/** Reads a string field only when it is explicitly OK. */
function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value
  }
  return undefined
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
  )
}

/**
 * A single row's active-metric reading. `value` is set only when the metric is
 * OK; otherwise `pending` distinguishes "not computed yet" (proto UNKNOWN, e.g.
 * a first-sample CPU delta) from "tried and unavailable" so the row can show a
 * quiet `--` while pending versus an explicit unavailable state.
 */
interface MetricCell {
  value?: number
  pending: boolean
}

/** Whether a field status is the proto default UNKNOWN ("not yet determined"). */
function isPending(status: FieldStatus): boolean {
  return status === FieldStatus.FIELD_STATUS_UNKNOWN
}

/** Per-process CPU percent with pending/unavailable distinction. */
function rowCpu(row: ProcessRow): MetricCell {
  const cpu = row.cpu
  if (cpu && cpu.status === FieldStatus.FIELD_STATUS_OK && Number.isFinite(cpu.usagePercent)) {
    return { value: cpu.usagePercent, pending: false }
  }
  return { pending: cpu === undefined || isPending(cpu.status) }
}

/**
 * Per-process memory in bytes: physical footprint when OK, else the resident
 * fallback when OK. Pending only if the primary footprint is still UNKNOWN.
 */
function rowMemory(row: ProcessRow): MetricCell {
  const footprint = row.memory?.physicalFootprintBytes
  if (footprint && footprint.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: footprint.value, pending: false }
  }
  const resident = row.memory?.residentBytes
  if (resident && resident.status === FieldStatus.FIELD_STATUS_OK) {
    return { value: resident.value, pending: false }
  }
  return { pending: footprint === undefined || isPending(footprint.status) }
}

/** The active-metric reading for a single row under the current sort. */
function rowMetric(row: ProcessRow, sort: SortMode): MetricCell {
  return sort === "cpu" ? rowCpu(row) : rowMemory(row)
}

/**
 * Maps a {@link MetricCell} to its display state: `ok` when it has a value,
 * `pending` while it is still being computed, else `unavailable`.
 */
function cellState(cell: MetricCell): MetricState {
  return cell.value !== undefined ? "ok" : cell.pending ? "pending" : "unavailable"
}

/**
 * Group key. Only real app identity groups rows; non-app processes stay as
 * PID/start-time singletons so unrelated `node`/`python`/shell processes do not
 * get summed into one misleading row.
 */
function rowGroupKey(row: ProcessRow): string {
  const bundlePath = okString(row.app?.bundle?.path)
  if (bundlePath) {
    return `app:${bundlePath}`
  }
  const bundleId = okString(row.app?.bundleIdentifier)
  if (bundleId) {
    return `bundle:${bundleId}`
  }
  return rowIdentityKey(row)
}

/** Stable singleton key for one process row, independent of app grouping. */
function rowIdentityKey(row: ProcessRow): string {
  const pid = row.identity?.pid ?? 0
  const startedAt =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : "unknown"
  return `pid:${pid}:${startedAt}`
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
  ]
  const path = okString(row.executablePath)
  if (path) parts.push(path)
  const bundle = okString(row.app?.bundleIdentifier)
  if (bundle) parts.push(bundle)
  const command = okString(row.commandName)
  if (command) parts.push(command)
  if (row.commandLine && row.commandLine.status === FieldStatus.FIELD_STATUS_OK) {
    parts.push(row.commandLine.arguments.join(" "))
  }
  return parts.join(" ").toLowerCase()
}

/**
 * Lowercased search haystack for the grouped app identity. It intentionally
 * excludes member argv so a helper-specific query can open that helper, while an
 * app-name/bundle-id query keeps the group and its Members section.
 */
function groupHaystack(group: ProcessGroup): string {
  const representative = group.members[0]
  const parts: string[] = [
    group.name,
    String(group.pid),
  ]
  const bundle = okString(representative.app?.bundleIdentifier)
  if (bundle) parts.push(bundle)
  const localizedName = okString(representative.app?.localizedName)
  if (localizedName) parts.push(localizedName)
  const bundleName = okString(representative.app?.bundle?.name)
  if (bundleName) parts.push(bundleName)
  const bundlePath = okString(representative.app?.bundle?.path)
  if (bundlePath) parts.push(bundlePath)
  return parts.join(" ").toLowerCase()
}

/**
 * Accumulator while folding member rows into one group. It tracks only what
 * cannot be re-derived from the members afterwards: the summed sort metric and
 * the metric-availability flags. Display identity (representative, name, icon,
 * counts) is derived from `members` when the group is built.
 */
interface GroupAccumulator {
  key: string
  sortValueSum: number
  /** True once any member contributed a real (OK) metric value. */
  hasMetric: boolean
  /** True if any member's metric is pending (UNKNOWN); used when none is OK. */
  anyPending: boolean
  /** All member rows, in snapshot order. */
  members: ProcessRow[]
}

/** Formats a group's summed metric for the compact list under the active sort. */
function formatGroupMetric(sum: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercent(sum) : formatBytes(sum)
}

/**
 * Formats a metric for the detail panel with extra precision (CPU two decimals,
 * memory one extra decimal), so a group's total and its member rows read more
 * finely there than in the compact list.
 */
function formatDetailMetric(value: number, sort: SortMode): string {
  return sort === "cpu" ? formatCpuPercentPrecise(value) : formatBytes(value, true)
}

/** PID of a row, or 0 when the identity is missing. */
function rowPid(row: ProcessRow): number {
  return row.identity?.pid ?? 0
}

/** Snapshot-stable process selection for one row. */
function rowSelection(row: ProcessRow): DetailSelection {
  const startedAtUnixMs =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : undefined
  return { kind: "process", pid: rowPid(row), startedAtUnixMs }
}

/**
 * The representative member of a group: the lowest-PID row - the app's main
 * process, which starts before its helpers. Using this stable identity (rather
 * than the busiest member) keeps the detail header from flipping between members
 * as live usage shifts. Assumes a non-empty member list.
 */
function representativeOf(members: ProcessRow[]): ProcessRow {
  return members.reduce((lowest, row) => (rowPid(row) < rowPid(lowest) ? row : lowest))
}

/**
 * Builds the display {@link ProcessGroup} from an accumulated group: derives the
 * representative and the display name/icon/counts from the members (rather than
 * tracking them during the fold). The representative is hoisted to `members[0]`
 * so the detail header reads its identity; the icon prefers the representative's,
 * falling back to any member that has one (an `.app` group shares one icon).
 */
function buildGroupRow(group: GroupAccumulator, sort: SortMode): ProcessGroup {
  const representative = representativeOf(group.members)
  const isGroup = group.members.length > 1
  const metricState: MetricState = group.hasMetric ? "ok" : group.anyPending ? "pending" : "unavailable"
  const icon =
    okString(representative.app?.iconPngBase64) ??
    group.members.map((row) => okString(row.app?.iconPngBase64)).find(Boolean)
  // A multi-process group shows the owning `.app` name; a single process (incl. a
  // drilled-in member) shows its own display name, not its app's.
  const appName = isGroup ? okString(representative.app?.bundle?.name) : undefined
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
  }
}

/**
 * Folds the snapshot rows into ranked display groups for the given sort and
 * (optional) search query. Buckets rows by their native app key (the owning
 * `.app` bundle or bundle id), sums each app group's metric, and keeps non-app
 * processes as singleton rows. Search keeps app/group matches grouped (so the
 * Members section remains available), but returns helper/member-specific matches
 * as singleton rows so the visible result name matches the opened process.
 * Returns every matched group, ranked by summed metric descending with a stable
 * name tiebreak, with no display cap applied - callers cap for the list, while
 * the detail lookup needs the full set so a selected group stays findable even
 * when it ranks past the list cap.
 */
function buildGroups(rows: ProcessRow[], sort: SortMode, query: string): ProcessGroup[] {
  const trimmed = query.trim().toLowerCase()
  const grouped = buildGroupedRows(rows, sort)
  if (trimmed.length > 0) {
    return buildSearchGroups(grouped, sort, trimmed)
  }

  return grouped
}

/** Builds the normal app-grouped list rows with no search filter applied. */
function buildGroupedRows(rows: ProcessRow[], sort: SortMode): ProcessGroup[] {
  const groups = new Map<string, GroupAccumulator>()

  for (const row of rows) {
    const key = rowGroupKey(row)
    const metric = rowMetric(row, sort)
    const existing = groups.get(key)

    if (existing === undefined) {
      groups.set(key, {
        key,
        sortValueSum: metric.value ?? 0,
        hasMetric: metric.value !== undefined,
        anyPending: metric.pending,
        members: [row],
      })
      continue
    }

    existing.sortValueSum += metric.value ?? 0
    existing.hasMetric = existing.hasMetric || metric.value !== undefined
    existing.anyPending = existing.anyPending || metric.pending
    existing.members.push(row)
  }

  const projected: ProcessGroup[] = Array.from(groups.values()).map((group) =>
    buildGroupRow(group, sort),
  )

  return sortGroups(projected)
}

/**
 * Builds search results from already-grouped rows. App identity or representative
 * matches keep the group; otherwise only the matching member processes are shown.
 */
function buildSearchGroups(
  groups: ProcessGroup[],
  sort: SortMode,
  query: string,
): ProcessGroup[] {
  const projected: ProcessGroup[] = []

  for (const group of groups) {
    const representative = group.members[0]
    if (groupHaystack(group).includes(query) || rowHaystack(representative).includes(query)) {
      projected.push(group)
      continue
    }

    for (const member of group.members) {
      if (rowHaystack(member).includes(query)) {
        projected.push(singleProcessGroup(member, sort))
      }
    }
  }

  return sortGroups(projected)
}

/** Sorts list groups by active metric, with stable cold-start behavior. */
function sortGroups(projected: ProcessGroup[]): ProcessGroup[] {
  // Rank by summed metric descending. The name tiebreak applies only between two
  // rows that both have a real value, so on a first-sample cold start (every row
  // pending, all sortValue 0) the list keeps the snapshot's insertion order
  // instead of snapping to an alphabetical layout that then reshuffles a tick
  // later. Array.sort is stable, so equal comparisons preserve that order.
  projected.sort((left, right) => {
    if (right.sortValue !== left.sortValue) {
      return right.sortValue - left.sortValue
    }
    if (left.metricState === "ok" && right.metricState === "ok") {
      return left.name.localeCompare(right.name)
    }
    return 0
  })

  return projected
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
    groups: buildGroups(snapshot.processes, sort, query).slice(0, DISPLAY_LIMIT),
  }
}

/**
 * Finds one group by its {@link ProcessGroup.key} for the detail view, grouping
 * the full snapshot with no search filter and no display cap. Returns undefined
 * when the group is gone (its processes all exited), so the detail can fall back
 * to the list. The active sort is passed so the representative and member order
 * match the list the user opened from.
 */
export function findGroupByKey(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  key: string,
): ProcessGroup | undefined {
  return buildGroups(snapshot.processes, sort, "").find((group) => group.key === key)
}

/**
 * Returns the group's members with `representative` at index 0. The detail reads
 * `members[0]` for its header identity (name/PID/path/argv), so the representative
 * must be first; the order of the rest does not matter here because the detail
 * re-ranks the displayed member list by the active metric in
 * {@link buildProcessDetail}.
 */
function representativeFirst(members: ProcessRow[], representative: ProcessRow): ProcessRow[] {
  const index = members.indexOf(representative)
  if (index <= 0) {
    return members
  }
  const ordered = members.slice()
  ordered.splice(index, 1)
  ordered.unshift(representative)
  return ordered
}

// ---------------------------------------------------------------------------
// Process detail model
//
// The detail view answers the debugging question for one selected group: what
// is it, where does it live, what was it launched with, how is it nested, and
// how much CPU/memory does the whole group use. Like the list projection this is
// pure: it turns the already-collected member rows into explicit display fields
// (with availability), so the detail component stays presentation-only and the
// derivation is test-ready (I15). Command-line text is read only into the
// display model on an explicit selection; it is never logged or persisted.
// ---------------------------------------------------------------------------

/**
 * Availability of a detail field, mirroring the list's metric states: `ok` has a
 * value, `pending` is not yet determined (proto UNKNOWN), `unavailable` was tried
 * and could not be read (including permission-denied / process-exited, which the
 * compact detail surfaces as a single "unavailable" line rather than separate
 * copy).
 */
export type DetailState = "ok" | "pending" | "unavailable"

/** A summed group metric with its display state. */
export interface DetailMetric {
  state: DetailState
  /** Formatted value; set only when state is `ok`. */
  text?: string
}

/** The command-line block's content with explicit availability. */
export interface DetailCommandLine {
  state: DetailState
  /** Joined argument string for display/copy; set only when state is `ok`. */
  text?: string
}

/**
 * One member process of a group, shown in the expandable Members section and
 * drillable into its own (single-process) detail. Carries the per-member value
 * under the active sort so the member list reads like the main list.
 */
export interface DetailMember {
  /** PID of this member, used as the React key and to drill in. */
  pid: number
  /** Start time (Unix ms) when known, to disambiguate a reused PID on drill-in. */
  startedAtUnixMs?: number
  /** Member display name. */
  name: string
  /**
   * Volatile base64 PNG icon when available; absent -> fallback glyph. App
   * members share their app's icon (helpers carry no distinct icon of their own);
   * a non-bundled member shows its executable's icon.
   */
  iconPngBase64?: string
  /** Active-metric display state for this member (ok / pending / unavailable). */
  metricState: MetricState
  /** Formatted active-metric value; set only when metricState is `ok`. */
  metricText?: string
}

/** The selected process's parent context, shown above its identity. */
export interface DetailParent {
  /** Whether a parent PID is known for the selected process. */
  available: boolean
  /** Parent PID when available and > 0. */
  pid?: number
}

/**
 * Presentation model for the detail view of one selected group (or one process,
 * when a member is drilled into - then it is a single-member group). Every
 * textual field is optional with an availability state so the component can show
 * an explicit unavailable/pending line instead of a blank or a faked value.
 */
export interface ProcessDetail {
  /** Group identity key (matches {@link ProcessGroup.key}). */
  key: string
  /** Representative display name (the app name for a group, else the process). */
  name: string
  /** Representative PID. */
  pid: number
  /** Volatile base64 PNG icon when available; absent -> fallback glyph. */
  iconPngBase64?: string
  /** Bundle identifier when known (e.g. com.apple.dt.Xcode). */
  bundleIdentifier?: string
  /** Executable name, shown as the secondary identity when no bundle id exists. */
  executableName?: string
  /** Parent-process context of the representative. */
  parent: DetailParent
  /** Started-at time of the representative. */
  startedAt: DetailState
  /** Started-at value in Unix ms; set only when startedAt is `ok`. */
  startedAtUnixMs?: number
  /** Executable path of the representative. */
  path: DetailState
  /** Executable path value; set only when path is `ok` (drives copy). */
  pathText?: string
  /** Command line of the representative. */
  commandLine: DetailCommandLine
  /**
   * The group's total for the currently selected metric (sum of members),
   * formatted with detail precision. Shown above the member list and re-derived
   * when the CPU/RAM switch changes.
   */
  total: DetailMetric
  /** Which metric {@link total} reflects, for the "Total CPU"/"Total RAM" label. */
  totalSort: SortMode
  /** Number of processes in the group (>= 1). */
  memberCount: number
  /**
   * All member rows for the expandable Members section (representative first).
   * Empty for a single-process detail; the section scrolls within a bounded box
   * when there are many, so no cap is applied here.
   */
  members: DetailMember[]
}

/** Reads the started-at identity of a row with pending/unavailable distinction. */
function rowStartedAt(row: ProcessRow): { state: DetailState; value?: number } {
  const identity = row.identity
  if (identity && identity.startedAtStatus === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", value: identity.startedAtUnixMs }
  }
  return { state: isPending(identity?.startedAtStatus ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" }
}

/** Reads a StringValue field as a detail state plus optional text. */
function detailString(
  value: { status: FieldStatus; value: string } | undefined,
): { state: DetailState; text?: string } {
  const text = okString(value)
  if (text !== undefined) {
    return { state: "ok", text }
  }
  return { state: isPending(value?.status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" }
}

/** Reads the representative's command line as a joined string with availability. */
function detailCommandLine(row: ProcessRow): DetailCommandLine {
  const commandLine = row.commandLine
  if (commandLine && commandLine.status === FieldStatus.FIELD_STATUS_OK) {
    return { state: "ok", text: commandLine.arguments.join(" ") }
  }
  return { state: isPending(commandLine?.status ?? FieldStatus.FIELD_STATUS_UNKNOWN) ? "pending" : "unavailable" }
}

/**
 * Sums one metric across the group's members into a {@link DetailMetric}.
 * `ok` when at least one member has a real value (others contribute 0); `pending`
 * when none is OK but some are still being computed; `unavailable` otherwise.
 */
function sumGroupMetric(
  members: ProcessRow[],
  read: (row: ProcessRow) => MetricCell,
  format: (value: number) => string,
): DetailMetric {
  let sum = 0
  let hasMetric = false
  let anyPending = false
  for (const row of members) {
    const cell = read(row)
    if (cell.value !== undefined) {
      sum += cell.value
      hasMetric = true
    } else if (cell.pending) {
      anyPending = true
    }
  }
  if (hasMetric) {
    return { state: "ok", text: format(sum) }
  }
  return { state: anyPending ? "pending" : "unavailable" }
}

/** Projects one member row into a {@link DetailMember} under the active sort. */
function buildMember(row: ProcessRow, sort: SortMode): DetailMember {
  const cell = rowMetric(row, sort)
  const metricState = cellState(cell)
  const startedAt =
    row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK
      ? row.identity.startedAtUnixMs
      : undefined
  return {
    pid: rowPid(row),
    startedAtUnixMs: startedAt,
    name: rowDisplayName(row),
    iconPngBase64: okString(row.app?.iconPngBase64),
    metricState,
    metricText: metricState === "ok" ? formatDetailMetric(cell.value ?? 0, sort) : undefined,
  }
}

/**
 * Projects a selected {@link ProcessGroup} into its {@link ProcessDetail} display
 * model. Identity/path/argv/started-at come from the representative (the row the
 * collapsed list already shows); CPU and memory are summed across all members so
 * a grouped app reports its whole footprint, which the user would otherwise have
 * to add up by hand. For a multi-process group all members (representative first)
 * are projected for the expandable Members section, which scrolls within a
 * bounded box rather than being capped; a single-process detail has no member
 * list. The active `sort` sets each member's displayed value so the section reads
 * like the main list.
 */
export function buildProcessDetail(group: ProcessGroup, sort: SortMode): ProcessDetail {
  const representative = group.members[0]
  const started = rowStartedAt(representative)
  const path = detailString(representative.executablePath)
  const bundleIdentifier = okString(representative.app?.bundleIdentifier)
  const executableName = detailString(representative.executableName).text

  const parentAvailable =
    representative.parentStatus === FieldStatus.FIELD_STATUS_OK && representative.parentPid > 0

  const read = sort === "cpu" ? rowCpu : rowMemory

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
            const delta = (read(right).value ?? 0) - (read(left).value ?? 0)
            if (delta !== 0) {
              return delta
            }
            return (left.identity?.pid ?? 0) - (right.identity?.pid ?? 0)
          })
          .map((row) => buildMember(row, sort))
      : []

  // Only the selected metric's total is shown (the CPU/RAM switch picks which),
  // formatted with detail precision.
  const total = sumGroupMetric(group.members, read, (value) => formatDetailMetric(value, sort))

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
    total,
    totalSort: sort,
    memberCount: group.memberCount,
    members,
  }
}

/**
 * A single-member {@link ProcessGroup} wrapping one member row, so drilling into
 * a member reuses {@link buildProcessDetail} unchanged: its detail shows just
 * that process (its own CPU/memory, no member list). Built through the same
 * {@link buildGroupRow} path as list groups; the key is the row's PID/start-time
 * singleton identity, distinct from any app-bundle group key.
 */
function singleProcessGroup(row: ProcessRow, sort: SortMode): ProcessGroup {
  const cell = rowMetric(row, sort)
  const group = buildGroupRow(
    {
      key: rowIdentityKey(row),
      sortValueSum: cell.value ?? 0,
      hasMetric: cell.value !== undefined,
      anyPending: cell.pending,
      members: [row],
    },
    sort,
  )
  return { ...group, openSelection: rowSelection(row) }
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
    return findGroupByKey(snapshot, sort, selection.key)
  }

  const matches = snapshot.processes.filter((row) => (row.identity?.pid ?? 0) === selection.pid)
  if (matches.length === 0) {
    return undefined
  }

  if (selection.startedAtUnixMs !== undefined) {
    const exact = matches.find(
      (row) =>
        row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK &&
        row.identity.startedAtUnixMs === selection.startedAtUnixMs,
    )
    // No exact (pid, started_at) match: the selected process is gone (its PID may
    // have been reused). Return undefined rather than a different process.
    return exact ? singleProcessGroup(exact, sort) : undefined
  }

  return singleProcessGroup(matches[0], sort)
}
