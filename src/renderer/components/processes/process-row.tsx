import { memo, useCallback, useMemo, useRef } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { DisclosureContent } from "@/components/processes/disclosure";
import { MemberRow } from "@/components/processes/member-row";
import { ProcessIcon } from "@/components/processes/process-icon";
import { useOrderPin } from "@/components/processes/use-order-pin";
import { memberKey, rankMembers, type DetailMember } from "@/domain/process-detail";
import {
  metricValueText,
  type DetailSelection,
  type IconTable,
  type ProcessGroup,
  type SortMode,
} from "@/domain/process-list";

/**
 * One fixed-height process row: app icon, name, an optional "+N" grouped-child
 * badge, and the right-aligned active metric. The row body is a button opening
 * the detail view; a grouped row also carries a leading chevron that expands
 * its member processes inline (ranked, and held in place while the list is
 * pinned). An app macOS marks Not Responding gets its name in the destructive
 * color plus a matching badge (Activity Monitor's convention), since a hung app
 * often shows nothing abnormal in CPU or memory.
 */
export const ProcessRow = memo(function ProcessRow({
  group,
  sort,
  icons,
  expanded,
  pinned,
  onOpen,
  onToggle,
}: {
  group: ProcessGroup
  sort: SortMode
  icons: IconTable
  expanded: boolean
  pinned: boolean
  onOpen: (selection: DetailSelection) => void
  onToggle: (key: string) => void
}) {
  const expandable = group.childCount > 0;

  // Members ranked by the active metric, held in place while the list is pinned
  // so a tick can't move a child between aiming and clicking. Empty (and skips
  // the ranking) while collapsed, which also re-baselines the pin on reopen.
  const ranked = useMemo<DetailMember[]>(
    () => (expanded ? rankMembers(group, sort, icons) : []),
    [expanded, group, sort, icons],
  );
  const ordered = useOrderPin(ranked, memberKey, pinned, sort);
  const lastChildren = useRef<DetailMember[]>([]);
  if (expanded) {
    lastChildren.current = ordered;
  }
  const children = expanded ? ordered : lastChildren.current;

  // Adapt MemberRow's (pid, startedAt) open to this row's selection open, kept
  // stable so MemberRow's memo holds across ticks.
  const openMember = useCallback(
    (pid: number, startedAtUnixMs?: number) => onOpen({ kind: "process", pid, startedAtUnixMs }),
    [onOpen],
  );

  return (
    <div className="flex flex-col">
      <div className="relative flex h-11 items-center">
        {expandable ? (
          <button
            type="button"
            onClick={() => onToggle(group.key)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name} processes`}
            className="absolute inset-y-0 left-0 z-10 flex w-6 items-center justify-center focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        ) : null}

        <button
          type="button"
          data-process-row
          onClick={() => onOpen(group.openSelection)}
          title={group.name}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pl-6 pr-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ProcessIcon iconPngBase64={group.iconPngBase64} name={group.name} />

          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
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
          </div>

          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-right text-[13px] font-medium tabular-nums",
              group.metricState === "ok" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {metricValueText(group.metricState, group.metricText)}
          </span>
        </button>
      </div>

      {expandable ? (
        <DisclosureContent open={expanded}>
          <ul className="flex flex-col">
            {children.map((child) => (
              <li key={memberKey(child)}>
                <MemberRow member={child} indented onOpen={openMember} />
              </li>
            ))}
          </ul>
        </DisclosureContent>
      ) : null}
    </div>
  );
}, areGroupsEqual);

function areGroupsEqual(
  previous: { group: ProcessGroup; sort: SortMode; expanded: boolean; pinned: boolean },
  next: { group: ProcessGroup; sort: SortMode; expanded: boolean; pinned: boolean },
): boolean {
  const a = previous.group;
  const b = next.group;
  if (
    previous.sort !== next.sort ||
    previous.expanded !== next.expanded ||
    a.key !== b.key ||
    a.name !== b.name ||
    a.iconPngBase64 !== b.iconPngBase64 ||
    a.childCount !== b.childCount ||
    a.memberCount !== b.memberCount ||
    a.metricState !== b.metricState ||
    a.metricText !== b.metricText ||
    a.notResponding !== b.notResponding ||
    !areSelectionsEqual(a.openSelection, b.openSelection)
  ) {
    return false;
  }
  if (!next.expanded) {
    return true;
  }
  return previous.pinned === next.pinned && membersEqual(a.members, b.members);
}

function membersEqual(a: ProcessGroup["members"], b: ProcessGroup["members"]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
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
