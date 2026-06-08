import { SnapshotStatus } from "@/gen/process_explorer";
import { ProcessRow } from "@/components/processes/process-row";
import type { DetailSelection, ProcessListProjection } from "@/domain/process-list";

/**
 * The ranked, grouped process rows plus the loading/empty/unavailable/
 * permission-limited states, all sharing one scroll area so the panel never
 * resizes. Each row opens the detail view via {@link onOpenSelection} (a stable
 * callback, so the memoized rows are not invalidated each tick).
 */
export function ProcessList({
  projection,
  status,
  hasQuery,
  onOpenSelection,
}: {
  projection: ProcessListProjection
  status: SnapshotStatus
  hasQuery: boolean
  onOpenSelection: (selection: DetailSelection) => void
}) {
  const { groups } = projection;

  return (
    <div className="scrollbar-hidden flex-1 overflow-y-auto">
      {groups.length > 0 ? (
        <ul>
          {groups.map((group) => (
            <li key={group.key}>
              <ProcessRow group={group} onOpen={onOpenSelection} />
            </li>
          ))}
        </ul>
      ) : (
        <ListPlaceholder status={status} hasQuery={hasQuery} />
      )}
    </div>
  );
}

/**
 * Quiet centered message for the non-row states (loading, unavailable,
 * permission-limited, empty, or a search with no matches), so the panel shows an
 * honest line rather than a blank.
 */
function ListPlaceholder({ status, hasQuery }: { status: SnapshotStatus; hasQuery: boolean }) {
  const message = placeholderMessage(status, hasQuery);
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-[12px] text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * Picks the placeholder line; search-with-no-matches takes priority over state.
 */
function placeholderMessage(status: SnapshotStatus, hasQuery: boolean): string {
  if (hasQuery) {
    return "No matching processes";
  }
  switch (status) {
    case SnapshotStatus.SNAPSHOT_STATUS_LOADING:
    case SnapshotStatus.SNAPSHOT_STATUS_UNKNOWN:
      return "Loading processes...";
    case SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE:
      return "Process list is unavailable";
    case SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED:
      return "No processes available";
    default:
      return "No processes";
  }
}
