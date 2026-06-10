import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";

import { SnapshotStatus } from "@/gen/process_explorer";
import { ProcessRow } from "@/components/processes/process-row";
import { pinGroupOrder, type DetailSelection, type ProcessGroup } from "@/domain/process-list";

/**
 * The ranked, grouped process rows plus the loading/empty/unavailable states,
 * sharing one scroll area so the panel never resizes.
 *
 * While the pointer is inside the list, row order is pinned via
 * {@link pinGroupOrder}: a snapshot tick re-ranks rows, and a reorder landing
 * between aiming and clicking would open the wrong process. Values keep
 * updating; only the order holds. Live ranking resumes when the pointer
 * leaves (opening a detail unmounts the list, so a stale pin cannot outlive
 * the interaction).
 */
export function ProcessList({
  groups: rankedGroups,
  status,
  hasQuery,
  onOpenSelection,
  containerRef,
  onExitTop,
}: {
  groups: ProcessGroup[]
  status: SnapshotStatus
  hasQuery: boolean
  onOpenSelection: (selection: DetailSelection) => void
  containerRef?: Ref<HTMLDivElement>
  onExitTop?: () => void
}) {
  const [pointerInside, setPointerInside] = useState(false);
  // The key order last shown on screen; the baseline the next pinned tick replays.
  const pinnedKeys = useRef<string[]>([]);

  const groups = useMemo(
    () => (pointerInside ? pinGroupOrder(rankedGroups, pinnedKeys.current) : rankedGroups),
    [pointerInside, rankedGroups],
  );

  // Track the order actually displayed: unpinned it follows the live ranking;
  // pinned it evolves only by drop-outs and bottom appends, so a row that left
  // the capped set and returned cannot reclaim a mid-list slot under the cursor.
  useEffect(() => {
    pinnedKeys.current = groups.map((group) => group.key);
  }, [groups]);

  // Moves focus between row buttons on ArrowDown/ArrowUp; rows are the only
  // buttons inside the container. Focusing scrolls the row into view natively.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowUp" && current === 0) {
      onExitTop?.();
      return;
    }
    const next = event.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : current - 1;
    rows[next]?.focus();
  }

  return (
    <div
      ref={containerRef}
      className="scrollbar-hidden flex-1 overflow-y-auto bg-background"
      onPointerOver={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onKeyDown={handleKeyDown}
    >
      {groups.length > 0 ? (
        <ul>
          {groups.map((group) => (
            <li key={group.key}>
              <ProcessRow group={group} onOpen={onOpenSelection} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <p className="text-[12px] text-muted-foreground">{placeholderMessage(status, hasQuery)}</p>
        </div>
      )}
    </div>
  );
}

/** Honest placeholder line for the non-row states; no-matches takes priority. */
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
