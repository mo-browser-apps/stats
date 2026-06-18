import { ChevronRight, Cpu, MemoryStick } from "lucide-react";
import { useMemo, useState } from "react";

import { CpuGraph } from "@/components/metrics/cpu-graph";
import { MemoryGraph } from "@/components/metrics/memory-graph";
import { MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import { MemberRow } from "@/components/processes/member-row";
import { useOrderPin } from "@/components/processes/use-order-pin";
import { memberKey, rankMemberSamples, type DetailMember, type ProcessDetail } from "@/domain/process-detail";
import {
  metricValueText,
  type IconTable,
  type MemberMetricSample,
  type SortMode,
} from "@/domain/process-list";
import { type HistorySample } from "@/domain/sample-history";
import { formatBytes, formatCpuPercentPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Human label for the group total under the active metric. */
const TOTAL_LABEL: Record<SortMode, string> = {
  cpu: "CPU",
  memory: "RAM",
};

/**
 * The graph + members card: the trend graph and, for a grouped process, a
 * "Members (N)" disclosure. Closed, it shows just the graph and sits in the
 * detail's normal flow. Open, the detail view lifts it into a top overlay.
 */
export function ProcessDetailGraph({
  detail,
  history,
  memberHistory,
  icons,
  sort,
  scrubIndex,
  pinnedIndex,
  membersOpen,
  canPin,
  onScrub,
  onPick,
  onToggleMembers,
  onOpenMember,
}: {
  detail: ProcessDetail
  history: HistorySample[]
  memberHistory: MemberMetricSample[][]
  icons: IconTable
  sort: SortMode
  scrubIndex: number | null
  pinnedIndex: number | null
  membersOpen: boolean
  canPin: boolean
  onScrub: (index: number | null) => void
  onPick: (index: number | null) => void
  onToggleMembers: () => void
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
}) {
  const showMembers = membersOpen && canPin;
  const pinnedMembers = pinnedIndex !== null ? memberHistory[pinnedIndex] : undefined;
  const memberCount = pinnedMembers !== undefined ? pinnedMembers.length : detail.memberCount;
  const fillGraph = !canPin;
  return (
    <section className={cn("flex flex-col gap-2", showMembers || fillGraph ? "min-h-0 flex-1" : "shrink-0")}>
      <ProcessMetricGraph
        detail={detail}
        history={history}
        scrubIndex={scrubIndex}
        pinned={pinnedIndex !== null}
        divider={!showMembers}
        fill={fillGraph}
        onScrub={onScrub}
        onPick={showMembers ? onPick : undefined}
      />

      {canPin ? (
        <button
          type="button"
          onClick={onToggleMembers}
          aria-expanded={membersOpen}
          className="group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-foreground/70 transition-[transform,color] duration-150 ease-out group-hover:text-foreground motion-reduce:transition-none",
              membersOpen && "rotate-90",
            )}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition-colors group-hover:text-foreground">
            Members ({memberCount})
          </span>
        </button>
      ) : null}

      {showMembers ? (
        <Members
          liveMembers={detail.members}
          memberHistory={memberHistory}
          pinnedIndex={pinnedIndex}
          sort={sort}
          icons={icons}
          resetKey={`${detail.pid}:${detail.startedAtUnixMs}:${detail.totalSort}`}
          onOpenMember={onOpenMember}
        />
      ) : null}
    </section>
  );
}

/**
 * Recent trend for the selected process or group under the active metric. The
 * scrub index is controlled by the parent: `onScrub` reports the hover, while
 * `onPick` holds a tick when the members list is open.
 */
function ProcessMetricGraph({
  detail,
  history,
  scrubIndex,
  pinned,
  divider = true,
  fill = false,
  onScrub,
  onPick,
}: {
  detail: ProcessDetail
  history: HistorySample[]
  scrubIndex: number | null
  pinned: boolean
  divider?: boolean
  fill?: boolean
  onScrub: (index: number | null) => void
  onPick?: (index: number | null) => void
}) {
  const isCpu = detail.totalSort === "cpu";
  const format = isCpu ? formatCpuPercentPrecise : (value: number) => formatBytes(value, true);
  const scrubbed = scrubIndex !== null ? history[scrubIndex] ?? null : null;
  const valueText = scrubIndex !== null
    ? scrubbed !== null
      ? format(scrubbed)
      : "--"
    : detail.totalValue !== null
      ? format(detail.totalValue)
      : metricValueText(detail.total.state, detail.total.text);

  return (
    <div className={cn("flex flex-col gap-2 pt-3", fill ? "min-h-0 flex-1" : "shrink-0", divider && "border-t border-border/60")}>
      <MetricRowHeader icon={isCpu ? Cpu : MemoryStick} label={TOTAL_LABEL[detail.totalSort]}>
        <ValueUnit value={valueText} valueClassName="text-foreground" />
      </MetricRowHeader>
      <div className={cn("relative w-full", fill ? "mb-3 min-h-0 flex-1" : "h-20")}>
        {isCpu ? (
          <CpuGraph
            history={history}
            scrubIndex={scrubIndex}
            pinned={pinned}
            state="ok"
            onScrub={onScrub}
            onPick={onPick}
          />
        ) : (
          <MemoryGraph
            history={history}
            scrubIndex={scrubIndex}
            pinned={pinned}
            onScrub={onScrub}
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}

/** Members list (shown when the disclosure is open), ranked by the active metric. */
function Members({
  liveMembers,
  memberHistory,
  pinnedIndex,
  sort,
  icons,
  resetKey,
  onOpenMember,
}: {
  liveMembers: DetailMember[]
  memberHistory: MemberMetricSample[][]
  pinnedIndex: number | null
  sort: SortMode
  icons: IconTable
  resetKey: string
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
}) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);

  const tick = pinnedIndex !== null ? memberHistory[pinnedIndex] : undefined;
  const showingTick = pinnedIndex !== null && tick !== undefined;
  const rankedMembers = useMemo(
    () => (showingTick ? rankMemberSamples(tick, sort, icons) : liveMembers),
    [showingTick, tick, sort, icons, liveMembers],
  );

  // Suspended while showing a held tick (rows already frozen).
  const ordered = useOrderPin(
    rankedMembers,
    memberKey,
    !showingTick && (pointerInside || focusInside),
    resetKey,
  );
  const members = showingTick ? rankedMembers : ordered;

  return (
    <ul
      className="scrollbar-hidden flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-1"
      onPointerOver={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocusCapture={() => setFocusInside(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusInside(false);
        }
      }}
    >
      {members.map((member) => (
        <li key={memberKey(member)}>
          <MemberRow member={member} onOpen={onOpenMember} />
        </li>
      ))}
    </ul>
  );
}
