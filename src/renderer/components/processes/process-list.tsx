import { SnapshotStatus } from "@/gen/process_explorer"
import { ProcessRow } from "@/components/processes/process-row"
import type { ProcessListProjection } from "@/components/processes/process-view"

/**
 * The ranked, grouped process rows plus the loading/empty/unavailable/
 * permission-limited states. The states occupy the same scroll area so the
 * panel never resizes as data arrives or a search empties the list. Each row
 * opens the detail view via {@link onOpenGroup} (a stable callback, so the
 * memoized rows are not invalidated each tick).
 */
export function ProcessList({
  projection,
  status,
  hasQuery,
  onOpenGroup,
}: {
  projection: ProcessListProjection
  status: SnapshotStatus
  hasQuery: boolean
  onOpenGroup: (key: string) => void
}) {
  const { groups } = projection

  return (
    <div className="scrollbar-hidden flex-1 overflow-y-auto">
      {groups.length > 0 ? (
        <ul>
          {groups.map((group) => (
            <li key={group.key}>
              <ProcessRow group={group} onOpen={onOpenGroup} />
            </li>
          ))}
        </ul>
      ) : (
        <ListPlaceholder status={status} hasQuery={hasQuery} />
      )}
    </div>
  )
}

/**
 * Quiet centered message for the non-row states. Loading (before the first
 * snapshot), unavailable (collection failed), permission-limited with no rows,
 * an empty table, or a search with no matches each get an honest line rather
 * than a blank panel.
 */
function ListPlaceholder({ status, hasQuery }: { status: SnapshotStatus; hasQuery: boolean }) {
  const message = placeholderMessage(status, hasQuery)
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-[12px] text-muted-foreground">{message}</p>
    </div>
  )
}

/** Picks the placeholder line; search-with-no-matches takes priority over state. */
function placeholderMessage(status: SnapshotStatus, hasQuery: boolean): string {
  if (hasQuery) {
    return "No matching processes"
  }
  switch (status) {
    case SnapshotStatus.SNAPSHOT_STATUS_LOADING:
    case SnapshotStatus.SNAPSHOT_STATUS_UNKNOWN:
      return "Loading processes..."
    case SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE:
      return "Process list is unavailable"
    case SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED:
      return "No processes available"
    default:
      return "No processes"
  }
}
