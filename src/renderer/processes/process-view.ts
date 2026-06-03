import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer"
import { formatBytes, formatPercent } from "@/lib/format"

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

/** The metrics the list can rank by. Network has no reliable per-process source. */
export type SortMode = "cpu" | "memory"

/**
 * One display row in the list. A group collapses an app's sibling processes (by
 * bundle id, else executable/command name) into a single row with a summed
 * metric and a child count, mirroring the compact OneMenu list.
 */
export interface ProcessGroup {
  /** Stable key for React lists and selection. */
  key: string
  /** Best human-facing name for the group (localized app name when available). */
  name: string
  /** Representative PID (the highest-usage member); used for stable identity. */
  pid: number
  /** Base64 PNG app icon when a GUI app supplied one; absent -> fallback icon. */
  iconPngBase64?: string
  /** Number of processes in the group (>= 1). */
  memberCount: number
  /** Extra members beyond the representative, shown as a "+N" badge when > 0. */
  childCount: number
  /** Formatted active-metric value for the row, or undefined when none is known. */
  metricText?: string
  /** Numeric active-metric magnitude used for ranking (0 when unknown). */
  sortValue: number
}

/** Result of projecting a snapshot for the current sort/search. */
export interface ProcessListProjection {
  groups: ProcessGroup[]
  /** Total processes considered before grouping/search (for empty-vs-filtered UI). */
  totalProcesses: number
  /** Groups left after applying the search query. */
  matchedGroups: number
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

/** Per-process CPU percent when the reading is OK, else undefined. */
function rowCpuPercent(row: ProcessRow): number | undefined {
  const cpu = row.cpu
  if (cpu && cpu.status === FieldStatus.FIELD_STATUS_OK && Number.isFinite(cpu.usagePercent)) {
    return cpu.usagePercent
  }
  return undefined
}

/**
 * Per-process memory in bytes: physical footprint when OK, else the resident
 * fallback when OK, else undefined.
 */
function rowMemoryBytes(row: ProcessRow): number | undefined {
  const footprint = row.memory?.physicalFootprintBytes
  if (footprint && footprint.status === FieldStatus.FIELD_STATUS_OK) {
    return footprint.value
  }
  const resident = row.memory?.residentBytes
  if (resident && resident.status === FieldStatus.FIELD_STATUS_OK) {
    return resident.value
  }
  return undefined
}

/** The active-metric magnitude for a single row under the current sort. */
function rowMetric(row: ProcessRow, sort: SortMode): number | undefined {
  return sort === "cpu" ? rowCpuPercent(row) : rowMemoryBytes(row)
}

/**
 * Group key: the bundle identifier for a GUI app (so a multi-process app like a
 * browser collapses into one row), else the executable/command name, else a
 * per-PID key so an unnamed process stays its own singleton rather than merging
 * with other unnamed ones.
 */
function rowGroupKey(row: ProcessRow): string {
  const bundle = okString(row.app?.bundleIdentifier)
  if (bundle) {
    return `bundle:${bundle}`
  }
  const name = okString(row.executableName) ?? okString(row.commandName)
  if (name) {
    return `name:${name.toLowerCase()}`
  }
  return `pid:${row.identity?.pid ?? 0}`
}

/**
 * Lowercased search haystack for a row: display name, PID, executable path,
 * bundle id, and command-line arguments when available. Used only for in-memory
 * matching; the sensitive argument text never leaves this module.
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

/** Accumulator while folding member rows into one group. */
interface GroupAccumulator {
  key: string
  name: string
  pid: number
  iconPngBase64?: string
  memberCount: number
  sortValueSum: number
  /** True once any member contributed a real (OK) metric value. */
  hasMetric: boolean
  /** Metric magnitude of the current representative member. */
  bestMemberMetric: number
}

/** Formats a group's summed metric for display under the active sort. */
function formatGroupMetric(sum: number, sort: SortMode): string {
  return sort === "cpu" ? formatPercent(sum) : formatBytes(sum)
}

/**
 * Projects a snapshot into ranked, grouped, searched display rows.
 *
 * Grouping sums each app's member metric and keeps the highest-usage member as
 * the representative (icon, name, pid). Search matches a group when any member
 * matches. Sorting is by summed metric descending, with a stable name tiebreak.
 */
export function projectProcessList(
  snapshot: ProcessSnapshot,
  sort: SortMode,
  query: string,
): ProcessListProjection {
  const rows = snapshot.processes
  const trimmed = query.trim().toLowerCase()
  const groups = new Map<string, GroupAccumulator>()

  for (const row of rows) {
    if (trimmed.length > 0 && !rowHaystack(row).includes(trimmed)) {
      continue
    }

    const key = rowGroupKey(row)
    const metric = rowMetric(row, sort)
    const metricValue = metric ?? 0
    const pid = row.identity?.pid ?? 0
    const existing = groups.get(key)

    if (existing === undefined) {
      groups.set(key, {
        key,
        name: rowDisplayName(row),
        pid,
        iconPngBase64: okString(row.app?.iconPngBase64),
        memberCount: 1,
        sortValueSum: metricValue,
        hasMetric: metric !== undefined,
        bestMemberMetric: metricValue,
      })
      continue
    }

    existing.memberCount += 1
    existing.sortValueSum += metricValue
    existing.hasMetric = existing.hasMetric || metric !== undefined
    // Keep the highest-usage member as the representative so the row's icon and
    // name track the dominant process; ties break to the lower PID for stability.
    if (metricValue > existing.bestMemberMetric || (metricValue === existing.bestMemberMetric && pid < existing.pid)) {
      existing.bestMemberMetric = metricValue
      existing.name = rowDisplayName(row)
      existing.pid = pid
      const icon = okString(row.app?.iconPngBase64)
      if (icon) existing.iconPngBase64 = icon
    }
  }

  const projected: ProcessGroup[] = Array.from(groups.values()).map((group) => ({
    key: group.key,
    name: group.name,
    pid: group.pid,
    iconPngBase64: group.iconPngBase64,
    memberCount: group.memberCount,
    childCount: group.memberCount - 1,
    metricText: group.hasMetric ? formatGroupMetric(group.sortValueSum, sort) : undefined,
    sortValue: group.sortValueSum,
  }))

  projected.sort(
    (left, right) => right.sortValue - left.sortValue || left.name.localeCompare(right.name),
  )

  return {
    groups: projected,
    totalProcesses: rows.length,
    matchedGroups: projected.length,
  }
}
