import { memo } from "react";

import { cn } from "@/lib/utils";
import { ProcessIcon } from "@/components/processes/process-icon";
import { metricValueText, type DetailSelection, type ProcessGroup } from "@/domain/process-list";

/**
 * One fixed-height process row: app icon, name, an optional "+N" grouped-child
 * badge, and the right-aligned active metric. The whole row is a button
 * opening the detail view. An app macOS marks Not Responding gets its name in
 * the destructive color plus a matching badge (Activity Monitor's convention),
 * since a hung app often shows nothing abnormal in CPU or memory.
 *
 * Memoized with a field-wise comparator: the projection rebuilds fresh group
 * objects every tick, so comparing the rendered fields lets an unchanged row
 * skip re-rendering. `onOpen` is a stable callback and is not compared.
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
      // No aria-label override: the content (name, badges, metric) is the
      // accessible name, so AT users hear the metric and "Not Responding" too.
      title={group.name}
      className="flex h-11 w-full items-center gap-2.5 rounded-md px-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ProcessIcon iconPngBase64={group.iconPngBase64} name={group.name} system={group.system} />

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          group.notResponding ? "text-destructive" : "text-foreground",
        )}
      >
        {group.name}
      </span>

      {group.notResponding ? (
        <span
          className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
          title={`macOS reports ${group.name} as not responding`}
        >
          Not Responding
        </span>
      ) : null}

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
        {metricValueText(group.metricState, group.metricText)}
      </span>
    </button>
  );
}, areGroupsEqual);

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
    a.system === b.system &&
    a.childCount === b.childCount &&
    a.memberCount === b.memberCount &&
    a.metricState === b.metricState &&
    a.metricText === b.metricText &&
    a.notResponding === b.notResponding &&
    areSelectionsEqual(a.openSelection, b.openSelection)
  );
}

function areSelectionsEqual(left: DetailSelection, right: DetailSelection): boolean {
  if (left.kind === "group" && right.kind === "group") {
    return left.key === right.key;
  }
  if (left.kind === "process" && right.kind === "process") {
    return left.pid === right.pid && left.startedAtUnixMs === right.startedAtUnixMs;
  }
  return false;
}
