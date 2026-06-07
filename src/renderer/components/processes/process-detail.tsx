import { ChevronLeft, ChevronRight, Clock, Cpu, User } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { UNAVAILABLE_TEXT, formatStartTime } from "@/lib/format";
import type { ActionState, ProcessActionKind } from "@/gen/process_explorer";
import { CopyButton, DisclosureContent } from "@/components/processes/disclosure";
import { ProcessActions } from "@/components/processes/process-actions";
import { ScrollFade } from "@/components/processes/scroll-fade";
import { ProcessIcon } from "@/components/processes/process-icon";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import type { SortMode } from "@/domain/process-list";
import type {
  DetailCommandLine,
  DetailMember,
  DetailMetric,
  DetailState,
  ProcessDetail,
} from "@/domain/process-detail";

/** Human label for the group total under the active metric. */
const TOTAL_LABEL: Record<SortMode, string> = {
  cpu: "CPU",
  memory: "RAM",
};

/**
 * The compact process detail view for one selected group (or one process, when a
 * group member is drilled into).
 *
 * Reached by opening a process row; it answers the debugging question directly -
 * identity, started-at, executable path (with copy), command-line arguments, the
 * parent PID, the group's CPU and memory totals so the user does not add member
 * usage by hand, and - for a multi-process app - an expandable Members section
 * whose rows drill into each member's own detail. `onBack` pops one navigation
 * level (member -> group -> list) and `onOpenMember` drills into a member. It is
 * presentation-only: every
 * field comes from the pure {@link ProcessDetail} model with explicit
 * availability, so unavailable/pending states render honestly instead of as
 * blanks or faked values. Command-line text is shown/copied only on user action
 * and is never logged or persisted.
 *
 * The fixed bottom action row (Open / Quit / Force Quit) reflects main's
 * authoritative {@link ActionState} list; running an action just forwards the kind
 * to main via {@link onRunAction}. When a member is drilled into, the row targets
 * that member; otherwise it targets the group's representative.
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
  const metadata = `${secondary ? `${secondary} - ` : ""}PID ${detail.pid}${
    detail.parent.available ? ` - Parent ${detail.parent.pid}` : ""
  }`;
  const grouped = detail.memberCount > 1;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 pb-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="no-drag flex h-9 items-center gap-1 rounded-lg pl-2 pr-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          Back
        </button>
        <ProcessSortControl sort={sort} onChange={onSortChange} className="ml-auto" />
      </div>

      <div className="scrollbar-hidden flex flex-1 flex-col gap-4 overflow-y-auto pb-1">
        <header className="flex items-center gap-3">
          <ProcessIcon iconPngBase64={detail.iconPngBase64} name={detail.name} size="lg" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <ScrollFade title={detail.name}>
              <h2 className="w-max whitespace-nowrap text-[15px] font-medium text-foreground">
                {detail.name}
              </h2>
            </ScrollFade>
            <ScrollFade title={metadata}>
              <p className="w-max whitespace-nowrap text-[11px] text-muted-foreground">
                {metadata}
              </p>
            </ScrollFade>
          </div>
        </header>

        <HeaderStats detail={detail} grouped={grouped} />

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
            <ScrollableValue
              state={detail.path}
              text={detail.path === "ok" ? (detail.pathText ?? "") : undefined}
              copyLabel="Copy executable path"
            />
          </Field>

          <Field label="Command line">
            <CommandLineValue commandLine={detail.commandLine} />
          </Field>
        </dl>

        {grouped ? (
          <Members
            members={detail.members}
            memberCount={detail.memberCount}
            total={detail.total}
            onOpenMember={onOpenMember}
          />
        ) : (
          <SingleProcessMetric detail={detail} />
        )}
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
 * The metric value for a single-process detail (no members): one row in the same
 * slot the group's Members header occupies, carrying the process's CPU/RAM value
 * on the right - like OneMenu's single-process hierarchy row. Non-collapsible and
 * not drillable (it is already the process you are viewing).
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
 * The compact secondary-stat strip under the header: thread count, total CPU
 * time, and owning user, dot-separated with small icons. It sits between the
 * identity header and the inline field stack so the at-a-glance numbers
 * Activity Monitor surfaces (threads, CPU time, user) are visible without
 * scrolling. For a group, thread count and CPU time are the summed totals; the
 * user is the app's (its members share it). Each stat shows its own
 * pending/unavailable placeholder.
 *
 * Layout: the row fills the width and never wraps. Order is user, threads, time.
 * The user comes first and gets the remaining width (it varies most and benefits
 * from the room) - it flexes and truncates, with its full value in the title, so
 * a long login name keeps the line within the window. Threads and CPU time
 * follow in fixed-width slots sized to their realistic worst case, so a value
 * change (a digit, or a minute/hour boundary) never drifts the stat after it;
 * time gets the tighter slot since it needs the least room. `shrink-0` keeps the
 * strip from being collapsed by the scroll column when the Members section below
 * expands.
 */
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
      <Separator />
      <HeaderStat
        icon={<Cpu className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
        state={detail.threadCount.state}
        text={threadsText}
        label={grouped ? "Total threads" : "Threads"}
        // Fits up to a 4-digit count plus "threads"; left-aligned so a smaller
        // count does not drift the next stat.
        valueClassName="w-[4.75rem]"
      />
      <Separator />
      {/* Time is last (nothing drifts after it) and gets the tightest slot, wide
          enough for m:ss.cc or h:mm:ss. */}
      <HeaderStat
        icon={<Clock className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
        state={detail.cpuTime.state}
        text={detail.cpuTime.text}
        label={grouped ? "Total CPU time" : "CPU time"}
        valueClassName="w-16"
      />
    </div>
  );
}

/**
 * One stat in the {@link HeaderStats} strip: a small icon plus its value. The
 * value uses tabular figures; a fixed `valueClassName` width keeps a leading
 * stat from drifting the rest of the line as its value changes, while the final
 * (user) stat instead flexes and truncates via `className` (`flex-1 min-w-0`)
 * and `valueClassName` (`truncate`).
 */
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
  const value = state === "ok" && text !== undefined ? text : state === "pending" ? "--" : UNAVAILABLE_TEXT;
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

/** A faint dot separator between header stats. */
function Separator() {
  return <span className="shrink-0 text-muted-foreground/50">·</span>;
}

/** Renders a {@link DetailMetric}'s value with the ok/pending/unavailable rule. */
function MetricValue({ metric, className }: { metric: DetailMetric; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-right font-medium tabular-nums",
        metric.state === "ok" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {metric.state === "ok"
        ? (metric.text ?? UNAVAILABLE_TEXT)
        : metric.state === "pending"
          ? "--"
          : UNAVAILABLE_TEXT}
    </span>
  );
}

/**
 * A labeled detail field: a quiet uppercase label with the value content on the
 * line below. Used for the inline Started / Path / Command line stack; long
 * values manage their own horizontal scroll and copy affordance.
 */
function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
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
 * A long single-line value (executable path, command line) shown inline beneath
 * its label. Long values do not wrap - the mono text scrolls horizontally in a
 * hidden-scrollbar lane (the same affordance the header name uses) so a deep path
 * or a multi-flag command line stays on one readable line instead of breaking
 * mid-word. A copy button sits at the end when a real value exists; pending and
 * unavailable states render the muted placeholder with no copy affordance.
 *
 * Sensitive process text (paths, argv) is copied only on explicit user action and
 * is never logged or persisted; copy routes through main (the renderer is
 * sandboxed).
 */
function ScrollableValue({
  state,
  text,
  copyLabel,
  emptyText = UNAVAILABLE_TEXT,
  pendingText = "--",
}: {
  state: DetailState
  text?: string
  copyLabel: string
  emptyText?: string
  pendingText?: string
}) {
  const hasContent = text !== undefined && text.length > 0;

  if (!hasContent) {
    const placeholder =
      text !== undefined ? emptyText : state === "pending" ? pendingText : UNAVAILABLE_TEXT;
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
 * The command-line field: a thin specialization of {@link ScrollableValue} with
 * command-line-specific placeholders (an OK-but-empty argv reads "No arguments",
 * a not-yet-collected one reads "..."). Command-line text is shown and copied only
 * on explicit user action and is never logged or persisted.
 */
function CommandLineValue({ commandLine }: { commandLine: DetailCommandLine }) {
  return (
    <ScrollableValue
      state={commandLine.state}
      text={commandLine.state === "ok" ? (commandLine.text ?? "") : undefined}
      copyLabel="Copy command line"
      emptyText="No arguments"
      pendingText="..."
    />
  );
}

/**
 * The expandable Members section for a multi-process app. The disclosure header
 * row carries the group's selected-metric total on the right (OneMenu-style), so
 * there is no separate "Total" line; toggling it reveals the member processes
 * (representative first), each drillable into its own detail. Starts collapsed to
 * keep the detail short. The full list is shown - no cap - inside a bounded
 * scroll box so a large app (e.g. a browser with many helpers) stays scannable
 * without pushing other content off-screen. It is a compact context strip, not a
 * full process-tree browser.
 */
function Members({
  members,
  memberCount,
  total,
  onOpenMember,
}: {
  members: DetailMember[]
  memberCount: number
  total: DetailMetric
  onOpenMember: (pid: number, startedAtUnixMs?: number) => void
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="flex flex-col border-t border-border/60 pt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
        <ul className="scrollbar-hidden flex max-h-48 flex-col gap-0.5 overflow-y-auto">
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

/**
 * One member row in the expanded Members section: icon, name, and the active-metric
 * value (matching the list's sort). The PID is intentionally omitted to give the
 * name more room - long helper names (e.g. "Google Chrome Helper (Renderer)") would
 * otherwise truncate hard; the PID is on the member's own detail page (one tap away)
 * and stays in the hover title / aria-label for disambiguation. App members share
 * their app's icon (helpers have no distinct icon of their own); a non-bundled
 * member shows its executable's icon. The whole row is a button that drills into
 * that member's own single-process detail.
 */
function MemberRow({
  member,
  onOpen,
}: {
  member: DetailMember
  onOpen: (pid: number, startedAtUnixMs?: number) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(member.pid, member.startedAtUnixMs)}
      aria-label={`Show details for ${member.name}, PID ${member.pid}`}
      title={`${member.name} - PID ${member.pid}`}
      className="no-drag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ProcessIcon iconPngBase64={member.iconPngBase64} name={member.name} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{member.name}</span>
      <MetricValue
        metric={{ state: member.metricState, text: member.metricText }}
        className="w-20 text-[12px]"
      />
    </button>
  );
}
