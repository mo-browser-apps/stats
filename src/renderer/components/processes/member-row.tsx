import { memo } from "react";

import { cn } from "@/lib/utils";
import { ProcessIcon } from "@/components/processes/process-icon";
import { metricValueText } from "@/domain/process-list";
import type { DetailMember } from "@/domain/process-detail";

/**
 * One member-process row - icon, name, active-metric value - drillable into its
 * own detail. Shared by the detail view's Members section and the inline
 * expanded list under a grouped row, where `indented` sits the row under the
 * parent icon and mutes its name to read as a child. Memoized field-wise so an
 * unchanged member skips re-rendering across snapshot ticks.
 */
export const MemberRow = memo(
  function MemberRow({
    member,
    indented = false,
    onOpen,
  }: {
    member: DetailMember
    indented?: boolean
    onOpen: (pid: number, startedAtUnixMs?: number) => void
  }) {
    return (
      <button
        type="button"
        onClick={() => onOpen(member.pid, member.startedAtUnixMs)}
        aria-label={`Show details for ${member.name}, PID ${member.pid}`}
        title={`${member.name} - PID ${member.pid}`}
        className={cn(
          "flex h-9 w-full items-center gap-2.5 rounded-md pr-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          indented ? "pl-8" : "pl-2",
        )}
      >
        <ProcessIcon iconPngBase64={member.iconPngBase64} name={member.name} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            member.notResponding
              ? "text-destructive"
              : indented
                ? "text-muted-foreground"
                : "text-foreground",
          )}
        >
          {member.name}
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-right text-[12px] tabular-nums",
            member.metricState === "ok" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {metricValueText(member.metricState, member.metricText)}
        </span>
      </button>
    );
  },
  (prev, next) =>
    prev.onOpen === next.onOpen &&
    prev.indented === next.indented &&
    prev.member.pid === next.member.pid &&
    prev.member.startedAtUnixMs === next.member.startedAtUnixMs &&
    prev.member.name === next.member.name &&
    prev.member.iconPngBase64 === next.member.iconPngBase64 &&
    prev.member.metricState === next.member.metricState &&
    prev.member.metricText === next.member.metricText &&
    prev.member.notResponding === next.member.notResponding,
);
