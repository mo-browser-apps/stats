import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProcessActions } from "@/components/processes/process-actions";
import { Field, HeaderStats, ScrollableValue, StateText } from "@/components/processes/process-detail-fields";
import { ProcessDetailGraph } from "@/components/processes/process-detail-graph";
import { ProcessIcon } from "@/components/processes/process-icon";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import { ScrollFade } from "@/components/processes/scroll-fade";
import { useMembersOverlay } from "@/components/processes/use-members-overlay";
import type { ProcessActionKind, ActionState } from "@/gen/process_explorer";
import type { ProcessDetail } from "@/domain/process-detail";
import { type IconTable, type MemberMetricSample, type SortMode } from "@/domain/process-list";
import { type HistorySample } from "@/domain/sample-history";
import { formatStartTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  initialMembersOpen = false,
  onMembersOpenChange,
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
  initialMembersOpen?: boolean
  onMembersOpenChange?: (open: boolean) => void
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
  const clearInspection = useCallback(() => {
    setPinned(null);
    setScrubIndex(null);
  }, []);

  // Freeze history while inspecting so the held tick doesn't scroll off.
  useEffect(() => {
    onInspectingChange?.(inspecting);
  }, [inspecting, onInspectingChange]);
  useEffect(() => () => onInspectingChange?.(false), [onInspectingChange]);

  // Members disclosure. Closed: graph sits at the bottom, stats visible. Open:
  // the graph+members lift into a top overlay covering the stats.
  const canPin = grouped || pinned !== null;
  const {
    closing,
    contentRef,
    inflowGraphRef,
    overlayMounted,
    overlayStyle,
    toggleMembers,
    onOverlayAnimationEnd,
  } = useMembersOverlay({
    initialOpen: initialMembersOpen,
    canShow: canPin,
    forceClosed: !grouped && pinned === null,
    onCloseMembers: clearInspection,
    onOpenChange: onMembersOpenChange,
  });

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
            <ProcessDetailGraph
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
            style={overlayStyle}
            onAnimationEnd={onOverlayAnimationEnd}
          >
            <ProcessDetailGraph
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
