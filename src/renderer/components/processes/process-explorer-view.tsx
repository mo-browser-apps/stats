import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { processExplorerGateway } from "@/gateway/process-explorer-gateway";
import { type ProcessSnapshot } from "@/gen/process_explorer";
import { ProcessDetailView } from "@/components/processes/process-detail";
import { ProcessList } from "@/components/processes/process-list";
import { ProcessSearchField } from "@/components/processes/process-search-field";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import { useProcessActions } from "@/components/processes/use-process-actions";
import { useProcessHistories } from "@/components/processes/use-process-histories";
import {
  projectProcessList,
  resolveSelection,
  type DetailSelection,
  type SortMode,
} from "@/domain/process-list";
import { buildProcessDetail } from "@/domain/process-detail";

/**
 * The Processes view: a searchable, CPU/Memory-ranked, app-grouped process
 * list plus the in-panel detail view that can drill from a group into its
 * member processes.
 *
 * Owns the process-explorer data lifecycle while active: it pulls the cached
 * snapshot once on activation and again on each revision ping; main pauses
 * collection while the view is hidden. Search/sort and the drill-in stack are
 * local presentation state; the projection and detail model live in pure code.
 */
export function ProcessExplorerView({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot>(() =>
    processExplorerGateway.emptySnapshot(),
  );
  const [sort, setSort] = useState<SortMode>("cpu");
  const [query, setQuery] = useState("");
  // The drill-in stack: list -> group -> member. Empty is the list; the top
  // entry is the shown detail (re-resolved from every fresh snapshot so it
  // stays live), and Back pops one level.
  const [selectionStack, setSelectionStack] = useState<DetailSelection[]>([]);

  // Highest revision applied, so an out-of-order pull cannot show stale rows.
  const appliedRevision = useRef(0);
  const snapshotRef = useRef(snapshot);
  const sortRef = useRef(sort);
  sortRef.current = sort;

  const pull = useCallback(async () => {
    try {
      const next = await processExplorerGateway.getSnapshot();
      if (next.revision >= appliedRevision.current) {
        appliedRevision.current = next.revision;
        snapshotRef.current = next;
        setSnapshot(next);
      }
    } catch {
      // Keep the last snapshot; the next revision ping retries. No diagnostic
      // is logged - it could carry process-identifying data.
    }
  }, []);

  useEffect(() => {
    if (!active) {
      // Stay mounted with the last rows; main pauses collection anyway.
      return;
    }

    let live = true;
    void pull();
    const unsubscribe = processExplorerGateway.subscribeRevisions(() => {
      if (live) void pull();
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, [active, pull]);

  const openSelection = useCallback(
    (selection: DetailSelection) => setSelectionStack([selection]),
    [],
  );
  const openMember = useCallback(
    (pid: number, startedAtUnixMs?: number) =>
      setSelectionStack((stack) => [...stack, { kind: "process", pid, startedAtUnixMs }]),
    [],
  );
  const goBack = useCallback(() => setSelectionStack((stack) => stack.slice(0, -1)), []);

  // Drop stack entries whose process/group no longer exists in the snapshot.
  useEffect(() => {
    setSelectionStack((stack) => {
      let length = stack.length;
      while (length > 0 && resolveSelection(snapshot, sort, stack[length - 1]) === undefined) {
        length -= 1;
      }
      return length === stack.length ? stack : stack.slice(0, length);
    });
  }, [snapshot, sort]);

  // After a quit/force-quit, pop past every level that still resolves to the
  // terminated process so the detail does not linger on a dead target.
  const popAfterTerminate = useCallback((terminatedPid: number) => {
    setSelectionStack((stack) => {
      const next = stack.slice(0, -1);
      while (next.length > 0) {
        const resolved = resolveSelection(snapshotRef.current, sortRef.current, next[next.length - 1]);
        if (resolved !== undefined && resolved.pid !== terminatedPid) {
          break;
        }
        next.pop();
      }
      return next;
    });
  }, []);

  const detail = useMemo(() => {
    for (let depth = selectionStack.length - 1; depth >= 0; depth -= 1) {
      const group = resolveSelection(snapshot, sort, selectionStack[depth]);
      if (group) {
        return buildProcessDetail(group, sort, snapshot.icons);
      }
    }
    return undefined;
  }, [snapshot, sort, selectionStack]);

  // True while the detail view is inspecting a past tick; freezes history so
  // the inspected tick cannot scroll off the graph (see useProcessHistories).
  const [inspecting, setInspecting] = useState(false);
  const readHistory = useProcessHistories(snapshot, inspecting);
  const { actions, actionsBusy, actionMessage, runAction } = useProcessActions(
    detail,
    pull,
    popAfterTerminate,
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasDetail = detail !== undefined;
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape") {
        if (hasDetail) {
          goBack();
        } else {
          setQuery("");
        }
        return;
      }
      if (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey) && !hasDetail) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, hasDetail, goBack]);

  if (detail) {
    const { history, memberHistory } = readHistory(detail.key, sort);
    return (
      <div className="flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-3">
        <ProcessDetailView
          key={detail.key}
          detail={detail}
          history={history}
          memberHistory={memberHistory}
          icons={snapshot.icons}
          sort={sort}
          actions={actions}
          actionsBusy={actionsBusy}
          actionMessage={actionMessage}
          onSortChange={setSort}
          onBack={goBack}
          onOpenMember={openMember}
          onRunAction={runAction}
          onInspectingChange={setInspecting}
        />
      </div>
    );
  }

  return (
    <ProcessListPanel
      active={active}
      snapshot={snapshot}
      sort={sort}
      query={query}
      searchInputRef={searchInputRef}
      onSortChange={setSort}
      onQueryChange={setQuery}
      onOpenSelection={openSelection}
    />
  );
}

function ProcessListPanel({
  active,
  snapshot,
  sort,
  query,
  searchInputRef,
  onSortChange,
  onQueryChange,
  onOpenSelection,
}: {
  active: boolean;
  snapshot: ProcessSnapshot;
  sort: SortMode;
  query: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSortChange: (sort: SortMode) => void;
  onQueryChange: (query: string) => void;
  onOpenSelection: (selection: DetailSelection) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () => projectProcessList(snapshot, sort, query),
    [snapshot, sort, query],
  );

  // Focus the search field whenever the list panel comes on screen.
  useEffect(() => {
    if (active) {
      searchInputRef.current?.focus();
    }
  }, [active, searchInputRef]);

  const focusFirstRow = useCallback(() => {
    listRef.current?.querySelector<HTMLButtonElement>("button[data-process-row]")?.focus();
  }, []);

  const openTopMatch = useCallback(() => {
    const top = groups[0];
    if (query.trim().length > 0 && top) {
      onOpenSelection(top.openSelection);
    }
  }, [query, groups, onOpenSelection]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4 pt-3">
      <div className="flex items-center gap-2">
        <ProcessSearchField
          value={query}
          onChange={onQueryChange}
          inputRef={searchInputRef}
          onArrowDown={focusFirstRow}
          onSubmit={openTopMatch}
        />
        <ProcessSortControl sort={sort} onChange={onSortChange} />
      </div>

      <ProcessList
        groups={groups}
        sort={sort}
        icons={snapshot.icons}
        status={snapshot.status}
        hasQuery={query.trim().length > 0}
        onOpenSelection={onOpenSelection}
        containerRef={listRef}
        onExitTop={() => searchInputRef.current?.focus()}
      />
    </div>
  );
}
