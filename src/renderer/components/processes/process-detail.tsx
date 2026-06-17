import { ChevronLeft, ChevronRight, Clock, Cpu, MemoryStick, User } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { UNAVAILABLE_TEXT, formatBytes, formatCpuPercentPrecise, formatStartTime } from "@/lib/format";
import type { ActionState, ProcessActionKind } from "@/gen/process_explorer";
import { CopyButton } from "@/components/processes/disclosure";
import { MemberRow } from "@/components/processes/member-row";
import { ProcessActions } from "@/components/processes/process-actions";
import { ScrollFade } from "@/components/processes/scroll-fade";
import { ProcessIcon } from "@/components/processes/process-icon";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import { MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import { CpuGraph } from "@/components/metrics/cpu-graph";
import { MemoryGraph } from "@/components/metrics/memory-graph";
import { useOrderPin } from "@/components/processes/use-order-pin";
import { type HistorySample } from "@/domain/sample-history";
import {
  metricValueText,
  type IconTable,
  type MemberMetricSample,
  type SortMode,
} from "@/domain/process-list";
import { memberKey, rankMemberSamples } from "@/domain/process-detail";
import type {
  DetailField,
  DetailMember,
  DetailState,
  ProcessDetail,
} from "@/domain/process-detail";

/** Human label for the group total under the active metric. */
const TOTAL_LABEL: Record<SortMode, string> = {
  cpu: "CPU",
  memory: "RAM",
};

function shouldAnimatePanelClose(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia !== undefined &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The process detail view for one selected group (or one drilled-in process):
 * identity, started-at, executable path (with copy), command line, parent PID,
 * the group's CPU/memory totals, and, for a multi-process app, an expandable
 * Members section whose rows drill into each member.
 *
 * Presentation-only: every field comes from the pure {@link ProcessDetail}
 * model with explicit availability, and the bottom action row reflects main's
 * authoritative {@link ActionState} list - running an action just forwards
 * the kind to main. Command-line text is shown/copied only on user action.
 */
export function ProcessDetailView({
  detail,
  history,
  memberHistory,
  icons,
  sort,
  actions,
  actionsBusy,
  actionMessage,
  onSortChange,
  onBack,
  onOpenMember,
  onRunAction,
  onInspectingChange,
}: {
  detail: ProcessDetail
  history: HistorySample[]
  memberHistory: MemberMetricSample[][]
  icons: IconTable
  sort: SortMode
  actions: ActionState[]
  actionsBusy: boolean
  actionMessage?: string
  onSortChange: (sort: SortMode) => void
  onBack: () => void
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
  onRunAction: (kind: ProcessActionKind) => void
  onInspectingChange?: (inspecting: boolean) => void
}) {
  const secondary = detail.bundleIdentifier ?? detail.executableName;
  const metadata = `${secondary ? `${secondary} - ` : ""}PID ${detail.pid}${
    detail.parentPid !== undefined ? ` - Parent ${detail.parentPid}` : ""
  }`;
  const metadataTitle = detail.notResponding ? `Not Responding - ${metadata}` : metadata;
  const grouped = detail.memberCount > 1;

  // scrubIndex = transient hover (moves only the readout/band); pinned = a
  // clicked tick that freezes the graph and drives the breakdown. Hover never freezes.
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const bandIndex = pinned ?? scrubIndex;
  const inspecting = pinned !== null;

  const pickIndex = useCallback((index: number | null) => {
    setPinned((current) => (index === null || current === index ? null : index));
  }, []);

  // Freeze history while inspecting so the held tick doesn't scroll off.
  useEffect(() => {
    onInspectingChange?.(inspecting);
  }, [inspecting, onInspectingChange]);
  useEffect(() => () => onInspectingChange?.(false), [onInspectingChange]);

  // Members disclosure. Closed: graph sits at the bottom, stats visible. Open: the
  // graph+members lift into a top overlay covering the stats (see GraphAndMembers).
  const [membersOpen, setMembersOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [slideFrom, setSlideFrom] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const inflowGraphRef = useRef<HTMLDivElement>(null);

  const measureSlide = useCallback((): number => {
    const content = contentRef.current?.getBoundingClientRect();
    const graph = inflowGraphRef.current?.getBoundingClientRect();
    if (!content || !graph) {
      return 0;
    }
    return Math.max(0, graph.top - content.top);
  }, []);

  const toggleMembers = useCallback(() => {
    setMembersOpen((open) => {
      setSlideFrom(measureSlide());
      setClosing(open && shouldAnimatePanelClose());
      if (open) {
        setPinned(null);
        setScrubIndex(null);
      }
      return !open;
    });
  }, [measureSlide]);
  const onOverlayAnimationEnd = useCallback(
    (event: ReactAnimationEvent) => {
      if (event.target === event.currentTarget && closing) {
        setClosing(false);
      }
    },
    [closing],
  );
  const canPin = grouped || pinned !== null;
  const overlayMounted = (membersOpen || closing) && canPin;

  useEffect(() => {
    if (!grouped && pinned === null) {
      setMembersOpen(false);
      setClosing(false);
    }
  }, [grouped, pinned]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 pb-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 items-center gap-1 rounded-lg pl-2 pr-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          Back
        </button>
        <ProcessSortControl sort={sort} onChange={onSortChange} className="ml-auto" />
      </div>

      <div ref={contentRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "scrollbar-hidden flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1",
            overlayMounted && "pointer-events-none",
          )}
          aria-hidden={overlayMounted ? true : undefined}
          inert={overlayMounted ? true : undefined}
        >
          <header className="flex items-center gap-3">
            <ProcessIcon iconPngBase64={detail.iconPngBase64} name={detail.name} size="lg" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <ScrollFade title={detail.name}>
                <h2
                  ref={headingRef}
                  tabIndex={-1}
                  className="w-max whitespace-nowrap text-[15px] font-medium text-foreground outline-none"
                >
                  {detail.name}
                </h2>
              </ScrollFade>
              <ScrollFade title={metadataTitle}>
                <p className="w-max whitespace-nowrap text-[11px] text-muted-foreground">
                  {detail.notResponding ? (
                    <span className="font-medium text-destructive">Not Responding - </span>
                  ) : null}
                  {metadata}
                </p>
              </ScrollFade>
            </div>
          </header>

          <HeaderStats detail={detail} grouped={grouped} />

          <dl className="flex flex-col gap-2.5">
            <Field label="Started">
              <StateText
                state={detail.startedAt}
                text={
                  detail.startedAtUnixMs !== undefined
                    ? formatStartTime(detail.startedAtUnixMs)
                    : undefined
                }
              />
            </Field>

            <Field label="Path">
              <ScrollableValue field={detail.path} copyLabel="Copy executable path" />
            </Field>

            <Field label="Command line">
              <ScrollableValue
                field={detail.commandLine}
                copyLabel="Copy command line"
                emptyText="No arguments"
                pendingText="..."
              />
            </Field>
          </dl>

          <div ref={inflowGraphRef} className={cn(!canPin && "flex min-h-0 flex-1 flex-col")}>
            <GraphAndMembers
              detail={detail}
              history={history}
              memberHistory={memberHistory}
              icons={icons}
              sort={sort}
              scrubIndex={overlayMounted ? null : bandIndex}
              pinnedIndex={null}
              membersOpen={false}
              canPin={canPin}
              onScrub={setScrubIndex}
              onPick={pickIndex}
              onToggleMembers={toggleMembers}
              onOpenMember={onOpenMember}
            />
          </div>
        </div>

        {overlayMounted ? (
          <div
            className={cn(
              "absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-background pb-2",
              closing ? "panel-pin-out pointer-events-none" : "panel-pin-in",
            )}
            style={{ "--pin-from": `${slideFrom}px` } as CSSProperties}
            onAnimationEnd={onOverlayAnimationEnd}
          >
            <GraphAndMembers
              detail={detail}
              history={history}
              memberHistory={memberHistory}
              icons={icons}
              sort={sort}
              scrubIndex={bandIndex}
              pinnedIndex={pinned}
              membersOpen
              canPin={canPin}
              onScrub={setScrubIndex}
              onPick={pickIndex}
              onToggleMembers={toggleMembers}
              onOpenMember={onOpenMember}
            />
          </div>
        ) : null}
      </div>

      <ProcessActions
        actions={actions}
        busy={actionsBusy}
        message={actionMessage}
        onRun={onRunAction}
      />
    </div>
  );
}

/**
 * The graph + members card: the trend graph and, for a grouped process, a
 * "Members (N)" disclosure. Closed, it shows just the graph and sits in the
 * detail's normal flow. Open, the members list appears and the owner lifts the
 * whole card into a top overlay.
 */
function GraphAndMembers({
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
 * scrub index is controlled by the parent: `onScrub` reports the hover (graph
 * read-out only), while `onPick` (wired only when the members list is open)
 * holds a tick that drives the breakdown. The header value reflects the
 * inspected tick, else the live total.
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

/** The secondary-stat strip under the header: user, threads, CPU time. */
function HeaderStats({ detail, grouped }: { detail: ProcessDetail; grouped: boolean }) {
  const threadsText =
    detail.threadCount.state === "ok"
      ? `${detail.threadCount.text} ${detail.threadCount.text === "1" ? "thread" : "threads"}`
      : undefined;

  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      <HeaderStat
        icon={<User className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
        state={detail.user.state}
        text={detail.user.text}
        label="User"
        className="min-w-0 flex-1"
        valueClassName="truncate"
      />
      <div className="flex shrink-0 items-center gap-2">
        <HeaderStat
          icon={<Cpu className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          state={detail.threadCount.state}
          text={threadsText}
          label={grouped ? "Total threads" : "Threads"}
        />
        <HeaderStat
          icon={<Clock className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          state={detail.cpuTime.state}
          text={detail.cpuTime.text}
          label={grouped ? "Total CPU time" : "CPU time"}
        />
      </div>
    </div>
  );
}

/** One stat in the {@link HeaderStats} strip: a small icon plus its value. */
function HeaderStat({
  icon,
  state,
  text,
  label,
  className,
  valueClassName,
}: {
  icon: ReactNode
  state: DetailState
  text?: string
  label: string
  className?: string
  valueClassName?: string
}) {
  const value = state === "ok" && text !== undefined ? text : "n/a";
  return (
    <span className={cn("flex items-center gap-1", className)} title={`${label}: ${value}`}>
      {icon}
      <span
        className={cn(
          "tabular-nums",
          state === "ok" ? "text-foreground" : "text-muted-foreground",
          valueClassName,
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** A labeled detail field: a quiet uppercase label, the value below. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Renders a value's pending/unavailable state, or the provided OK text. */
function StateText({ state, text }: { state: DetailState; text?: string }) {
  if (state === "ok" && text !== undefined) {
    return <span className="text-[12px] text-foreground">{text}</span>;
  }
  return (
    <span className="text-[12px] text-muted-foreground">
      {state === "pending" ? "--" : UNAVAILABLE_TEXT}
    </span>
  );
}

/** Long single-line value (path, command line) with a copy button routed through main. */
function ScrollableValue({
  field,
  copyLabel,
  emptyText = UNAVAILABLE_TEXT,
  pendingText = "--",
}: {
  field: DetailField
  copyLabel: string
  emptyText?: string
  pendingText?: string
}) {
  const text = field.state === "ok" ? field.text ?? "" : undefined;

  if (text === undefined || text.length === 0) {
    const placeholder =
      text !== undefined ? emptyText : field.state === "pending" ? pendingText : UNAVAILABLE_TEXT;
    return <span className="text-[12px] text-muted-foreground">{placeholder}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <ScrollFade className="flex-1" title={text}>
        <span className="block w-max whitespace-nowrap font-mono text-[11px] leading-relaxed text-foreground">
          {text}
        </span>
      </ScrollFade>
      <CopyButton text={text} label={copyLabel} />
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
