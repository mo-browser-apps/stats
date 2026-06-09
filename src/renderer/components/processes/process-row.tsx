import { memo } from "react";

import { cn } from "@/lib/utils";
import { UNAVAILABLE_TEXT } from "@/lib/format";
import { ProcessIcon } from "@/components/processes/process-icon";
import type { DetailSelection, ProcessGroup } from "@/domain/process-list";

/**
 * One fixed-height process row: app icon, name, an optional "+N" grouped-child
 * badge, and the right-aligned active metric. The whole row is a button opening
 * the detail view for the row's selection target.
 *
 * Wrapped in {@link memo} with a field-wise comparator: the projection rebuilds
 * fresh group objects every 2s tick, so comparing the rendered fields lets an
 * unchanged row skip re-rendering instead of reconciling on every snapshot.
 */
export const ProcessRow = memo(function ProcessRow({
  group,
  onOpen,
}: {
  group: ProcessGroup
  onOpen: (selection: DetailSelection) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(group.openSelection)}
      aria-label={`Show details for ${group.name}`}
      className="flex h-11 w-full items-center gap-2.5 rounded-md px-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ProcessIcon iconPngBase64={group.iconPngBase64} name={group.name} />

      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{group.name}</span>

      {group.childCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
          title={`${group.memberCount} processes`}
        >
          +{group.childCount}
        </span>
      ) : null}

      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-right text-[13px] font-medium tabular-nums",
          group.metricState === "ok" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {metricText(group)}
      </span>
    </button>
  );
}, areGroupsEqual);

/**
 * Equality check for the memoized row: compares the displayed fields plus the
 * group `key` (so React never reuses a row across distinct groups) and the open
 * target (a search can keep the visible name while changing which matched member
 * opens). `onOpen` is a stable callback, so it is not compared.
 */
function areGroupsEqual(
  previous: { group: ProcessGroup; onOpen: (selection: DetailSelection) => void },
  next: { group: ProcessGroup; onOpen: (selection: DetailSelection) => void },
): boolean {
  const a = previous.group;
  const b = next.group;
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.iconPngBase64 === b.iconPngBase64 &&
    a.childCount === b.childCount &&
    a.memberCount === b.memberCount &&
    a.metricState === b.metricState &&
    a.metricText === b.metricText &&
    areSelectionsEqual(a.openSelection, b.openSelection)
  );
}

/**
 * True when two row open targets point to the same detail selection.
 */
function areSelectionsEqual(left: DetailSelection, right: DetailSelection): boolean {
  if (left.kind === "group" && right.kind === "group") {
    return left.key === right.key;
  }
  if (left.kind === "process" && right.kind === "process") {
    return left.pid === right.pid && left.startedAtUnixMs === right.startedAtUnixMs;
  }
  return false;
}

/**
 * The right-aligned value text for a row: the formatted value when OK, a quiet
 * `--` while the metric is still pending (e.g. a first-sample CPU delta), and
 * the explicit unavailable text only when the source could not be read.
 */
function metricText(group: ProcessGroup): string {
  switch (group.metricState) {
    case "ok":
      return group.metricText ?? UNAVAILABLE_TEXT;
    case "pending":
      return "--";
    default:
      return UNAVAILABLE_TEXT;
  }
}
