import { useCallback, useState, type KeyboardEvent, type Ref } from "react";

import { SnapshotStatus } from "@/gen/process_explorer";
import { ProcessRow } from "@/components/processes/process-row";
import { useOrderPin } from "@/components/processes/use-order-pin";
import {
  groupKey,
  type DetailSelection,
  type IconTable,
  type ProcessGroup,
  type SortMode,
} from "@/domain/process-list";

/**
 * The ranked, grouped process rows plus the loading/empty/unavailable states,
 * sharing one scroll area so the panel never resizes.
 *
 * While the pointer is inside the list - or a row has keyboard focus - row
 * order is pinned via {@link useOrderPin}: a snapshot tick re-ranks rows, and a
 * reorder landing between aiming and clicking (or between arrow presses) would
 * open the wrong process. Values keep updating; only the order holds. Live
 * ranking resumes when the pointer and focus leave (opening a detail unmounts
 * the list, so a stale pin cannot outlive the interaction).
 */
export function ProcessList({
  groups: rankedGroups,
  sort,
  icons,
  status,
  hasQuery,
  onOpenSelection,
  containerRef,
  onExitTop,
}: {
  groups: ProcessGroup[]
  sort: SortMode
  icons: IconTable
  status: SnapshotStatus
  hasQuery: boolean
  onOpenSelection: (selection: DetailSelection) => void
  containerRef?: Ref<HTMLDivElement>
  onExitTop?: () => void
}) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  // Keys of groups expanded to show their member processes inline. Survives
  // snapshot ticks; a key whose group has vanished is simply never read.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const pinActive = pointerInside || focusInside;
  const groups = useOrderPin(rankedGroups, groupKey, pinActive, sort);

  // Moves focus between row buttons on ArrowDown/ArrowUp. Focus may sit on a
  // row's content button or on its expand chevron; both live in the same <li>,
  // so resolve the active element to its row before stepping. Focusing scrolls
  // the row into view natively.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-process-row]"),
    );
    const active = document.activeElement as Element | null;
    const activeRow = active?.closest("li")?.querySelector<HTMLButtonElement>("button[data-process-row]");
    const current = activeRow ? rows.indexOf(activeRow) : -1;
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
      onFocusCapture={(event) => {
        if (event.target instanceof Element && event.target.matches(":focus-visible")) {
          setFocusInside(true);
        }
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusInside(false);
        }
      }}
      onKeyDown={handleKeyDown}
    >
      {groups.length > 0 ? (
        <ul>
          {groups.map((group) => (
            <li key={group.key}>
              <ProcessRow
                group={group}
                sort={sort}
                icons={icons}
                expanded={expandedKeys.has(group.key)}
                pinned={pinActive}
                onOpen={onOpenSelection}
                onToggle={toggleExpanded}
              />
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
