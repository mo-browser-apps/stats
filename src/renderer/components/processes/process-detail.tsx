import { ChevronLeft, ChevronRight, Clock, Cpu, User } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { UNAVAILABLE_TEXT, formatStartTime } from "@/lib/format";
import type { ActionState, ProcessActionKind } from "@/gen/process_explorer";
import { CopyButton, DisclosureContent } from "@/components/processes/disclosure";
import { MemberRow } from "@/components/processes/member-row";
import { ProcessActions } from "@/components/processes/process-actions";
import { ScrollFade } from "@/components/processes/scroll-fade";
import { ProcessIcon } from "@/components/processes/process-icon";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import { useOrderPin } from "@/components/processes/use-order-pin";
import { metricValueText, type SortMode } from "@/domain/process-list";
import { memberPid } from "@/domain/process-detail";
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
  sort,
  actions,
  actionsBusy,
  actionMessage,
  onSortChange,
  onBack,
  onOpenMember,
  onRunAction,
}: {
  detail: ProcessDetail
  sort: SortMode
  actions: ActionState[]
  actionsBusy: boolean
  actionMessage?: string
  onSortChange: (sort: SortMode) => void
  onBack: () => void
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
  onRunAction: (kind: ProcessActionKind) => void
}) {
  const secondary = detail.bundleIdentifier ?? detail.executableName;
  // The synthetic System group has no single identity: its subtitle is the
  // member count, and the per-process fields/actions below are omitted.
  const metadata = detail.system
    ? `${detail.memberCount} ${detail.memberCount === 1 ? "process" : "processes"}`
    : `${secondary ? `${secondary} - ` : ""}PID ${detail.pid}${
      detail.parentPid !== undefined ? ` - Parent ${detail.parentPid}` : ""
    }`;
  const metadataTitle = detail.notResponding ? `Not Responding - ${metadata}` : metadata;
  const grouped = detail.memberCount > 1;

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 pb-3">
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

      <div className="scrollbar-hidden flex flex-1 flex-col gap-4 overflow-y-auto pb-1">
        <header className="flex items-center gap-3">
          <ProcessIcon
            iconPngBase64={detail.iconPngBase64}
            name={detail.name}
            size="lg"
            system={detail.system}
          />
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

        {detail.system ? null : (
          <dl className="flex flex-col gap-3">
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
        )}

        {grouped ? (
          <Members
            members={detail.members}
            memberCount={detail.memberCount}
            total={detail.total}
            resetKey={`${detail.pid}:${detail.startedAtUnixMs}:${detail.totalSort}`}
            onOpenMember={onOpenMember}
          />
        ) : (
          <SingleProcessMetric detail={detail} />
        )}
      </div>

      {detail.system ? null : (
        <ProcessActions
          actions={actions}
          busy={actionsBusy}
          message={actionMessage}
          onRun={onRunAction}
        />
      )}
    </div>
  );
}

/**
 * The metric value for a single-process detail (no members): one row in the
 * slot the group's Members header occupies. Not collapsible or drillable.
 */
function SingleProcessMetric({ detail }: { detail: ProcessDetail }) {
  return (
    <div className="flex items-center gap-2 border-t border-border/60 px-2 py-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {TOTAL_LABEL[detail.totalSort]}
      </span>
      <MetricValue metric={detail.total} className="ml-auto text-[15px]" />
    </div>
  );
}

/**
 * The secondary-stat strip under the header (user, threads, CPU time). The
 * System group hides the user stat - its members run as many different users,
 * so the representative's would be misleading.
 */
function HeaderStats({ detail, grouped }: { detail: ProcessDetail; grouped: boolean }) {
  const threadsText =
    detail.threadCount.state === "ok"
      ? `${detail.threadCount.text} ${detail.threadCount.text === "1" ? "thread" : "threads"}`
      : undefined;

  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      {detail.system ? (
        <span className="min-w-0 flex-1" aria-hidden="true" />
      ) : (
        <HeaderStat
          icon={<User className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          state={detail.user.state}
          text={detail.user.text}
          label="User"
          className="min-w-0 flex-1"
          valueClassName="truncate"
        />
      )}
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

/** Renders a {@link DetailField} value with the ok/pending/unavailable rule. */
function MetricValue({ metric, className }: { metric: DetailField; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-right font-medium tabular-nums",
        metric.state === "ok" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {metricValueText(metric.state, metric.text)}
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

/**
 * A long single-line value (executable path, command line) scrolling
 * horizontally in a hidden-scrollbar lane rather than wrapping, with a copy
 * button when a real value exists. Sensitive process text is copied only on
 * explicit user action and routes through main (the renderer is sandboxed).
 */
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

/**
 * The expandable Members section for a multi-process app. The disclosure
 * header carries the group's selected-metric total on the right; toggling it
 * reveals the member processes (ranked by the active metric), each drillable
 * into its own detail. Starts expanded; scrolls within a bounded box.
 */
function Members({
  members: rankedMembers,
  memberCount,
  total,
  resetKey,
  onOpenMember,
}: {
  members: DetailMember[]
  memberCount: number
  total: DetailField
  /** Changes when the drilled target or sort changes, dropping any stale pin. */
  resetKey: string
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
}) {
  const [expanded, setExpanded] = useState(true);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const members = useOrderPin(rankedMembers, memberPid, pointerInside || focusInside, resetKey);

  return (
    <section className="flex flex-col border-t border-border/60 pt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Members ({memberCount})
        </span>
        <MetricValue metric={total} className="ml-auto text-[13px]" />
      </button>

      <DisclosureContent open={expanded}>
        <ul
          className="scrollbar-hidden flex max-h-72 flex-col gap-0.5 overflow-y-auto"
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
            <li key={member.pid}>
              <MemberRow member={member} onOpen={onOpenMember} />
            </li>
          ))}
        </ul>
      </DisclosureContent>
    </section>
  );
}
