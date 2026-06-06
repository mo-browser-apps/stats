import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import { UNAVAILABLE_TEXT, formatStartTime } from "@/lib/format"
import type { ActionState, ProcessActionKind } from "@/gen/process_explorer"
import { CommandLineBlock, TextDisclosure } from "@/components/processes/command-line-block"
import { ProcessActions } from "@/components/processes/process-actions"
import { ProcessIcon } from "@/components/processes/process-row"
import { ProcessSortControl } from "@/components/processes/process-sort-control"
import type {
  DetailMember,
  DetailMetric,
  DetailState,
  ProcessDetail,
  SortMode,
} from "@/components/processes/process-view"

/** Human label for the group total under the active metric. */
const TOTAL_LABEL: Record<SortMode, string> = {
  cpu: "CPU",
  memory: "RAM",
}

/**
 * The compact process detail view for one selected group (or one process, when a
 * group member is drilled into).
 *
 * Reached by opening a process row; it answers the debugging question directly -
 * identity, started-at, executable path (with copy), command-line arguments, the
 * parent PID, the group's CPU and memory totals so the user does not add member
 * usage by hand, and - for a multi-process app - an expandable Members section
 * whose rows drill into each member's own detail. `onBack` pops one navigation
 * level (member -> group -> list); `onOpenMember` drills into a member. It is
 * presentation-only: every field comes from the pure {@link ProcessDetail} model
 * with explicit availability, so unavailable/pending states render honestly
 * instead of as blanks or faked values. Command-line text is shown/copied only on
 * user action and is never logged or persisted.
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
  const secondary = detail.bundleIdentifier ?? detail.executableName
  const metadata = `${secondary ? `${secondary} - ` : ""}PID ${detail.pid}${
    detail.parent.available ? ` - Parent ${detail.parent.pid}` : ""
  }`
  const grouped = detail.memberCount > 1

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
            <div className="scrollbar-hidden min-w-0 overflow-x-auto" title={detail.name}>
              <h2 className="w-max whitespace-nowrap text-[15px] font-medium text-foreground">
                {detail.name}
              </h2>
            </div>
            <div className="scrollbar-hidden min-w-0 overflow-x-auto" title={metadata}>
              <p className="w-max whitespace-nowrap text-[11px] text-muted-foreground">
                {metadata}
              </p>
            </div>
          </div>
        </header>

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
        </dl>

        <TextDisclosure
          label="Path"
          value={detail.path === "ok" ? (detail.pathText ?? "") : undefined}
          state={detail.path}
          copyLabel="Copy executable path"
        />

        <CommandLineBlock commandLine={detail.commandLine} />

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
  )
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
  )
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
  )
}

/**
 * A labeled detail field: a quiet uppercase label, an optional right-aligned
 * action (e.g. a copy button), and the value content below.
 */
function Field({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </dt>
        {action}
      </div>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** Renders a value's pending/unavailable state, or the provided OK text. */
function StateText({ state, text }: { state: DetailState; text?: string }) {
  if (state === "ok" && text !== undefined) {
    return <span className="text-[12px] text-foreground">{text}</span>
  }
  return (
    <span className="text-[12px] text-muted-foreground">
      {state === "pending" ? "--" : UNAVAILABLE_TEXT}
    </span>
  )
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
  const [expanded, setExpanded] = useState(false)

  return (
    <section className="flex flex-col gap-1.5 border-t border-border/60 pt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Members ({memberCount})
        </span>
        <MetricValue metric={total} className="ml-auto text-[13px]" />
      </button>

      {expanded ? (
        <ul className="scrollbar-hidden flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {members.map((member) => (
            <li key={member.pid}>
              <MemberRow member={member} onOpen={onOpenMember} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
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
  )
}
