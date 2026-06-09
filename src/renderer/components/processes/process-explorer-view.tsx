import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { processExplorerGateway } from "@/gateway/process-explorer-gateway";
import { type ProcessSnapshot } from "@/gen/process_explorer";
import { ProcessDetailView } from "@/components/processes/process-detail";
import { ProcessList } from "@/components/processes/process-list";
import { ProcessSearchField } from "@/components/processes/process-search-field";
import { ProcessSortControl } from "@/components/processes/process-sort-control";
import { useProcessActions } from "@/components/processes/use-process-actions";
import {
  projectProcessList,
  resolveSelection,
  type DetailSelection,
  type SortMode,
} from "@/domain/process-list";
import { buildProcessDetail } from "@/domain/process-detail";

/**
 * The Processes view: a compact searchable, CPU/Memory-ranked, app-grouped
 * process list, plus the in-panel detail view that can drill from a group into
 * its individual member processes.
 *
 * It owns the process-explorer data lifecycle while active: App.tsx keeps the
 * view mounted across tab switches, reports the active top-level view to main,
 * and this component pulls the cached snapshot plus revision updates only while
 * Processes is visible. Search/sort and the drill-in stack are local presentation
 * state; the heavy projection and the detail model are memoized and live in pure
 * code. Command-line arguments are used only as a local search haystack and, once
 * a process is selected, in the detail display model; they are never logged or
 * persisted here.
 */
export function ProcessExplorerView({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot>(() =>
    processExplorerGateway.emptySnapshot(),
  );
  const [sort, setSort] = useState<SortMode>("cpu");
  const [query, setQuery] = useState("");
  // The drill-in stack: list -> group -> member. Empty is the list. Each entry is
  // re-resolved from every fresh snapshot so the detail stays live; the top entry
  // is the shown detail, and Back pops one level.
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
      // A failed pull leaves the last snapshot in place; the next revision ping
      // (or the cadence) retries. No diagnostic is logged - it could carry
      // process-identifying data.
    }
  }, []);

  useEffect(() => {
    // The view stays mounted across tab switches (so it keeps its rows, sort,
    // search, selection, and scroll), but only consumes data while it is the
    // active view. While hidden it holds its last rows and does nothing; main
    // pauses collection then anyway.
    if (!active) {
      return;
    }

    let live = true;

    // Pull immediately on becoming active so the (cached) rows show at once,
    // then re-pull on each revision ping.
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
  const popAfterTerminate = useCallback(() => {
    setSelectionStack((stack) => {
      const next = stack.slice(0, -1);
      while (
        next.length > 0 &&
        resolveSelection(snapshotRef.current, sortRef.current, next[next.length - 1]) ===
          undefined
      ) {
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

  const { actions, actionsBusy, actionMessage, runAction } = useProcessActions(
    detail,
    pull,
    popAfterTerminate,
  );

  if (detail) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-3">
        <ProcessDetailView
          key={detail.key}
          detail={detail}
          sort={sort}
          actions={actions}
          actionsBusy={actionsBusy}
          actionMessage={actionMessage}
          onSortChange={setSort}
          onBack={goBack}
          onOpenMember={openMember}
          onRunAction={runAction}
        />
      </div>
    );
  }

  return (
    <ProcessListPanel
      snapshot={snapshot}
      sort={sort}
      query={query}
      onSortChange={setSort}
      onQueryChange={setQuery}
      onOpenSelection={openSelection}
    />
  );
}

function ProcessListPanel({
  snapshot,
  sort,
  query,
  onSortChange,
  onQueryChange,
  onOpenSelection,
}: {
  snapshot: ProcessSnapshot;
  sort: SortMode;
  query: string;
  onSortChange: (sort: SortMode) => void;
  onQueryChange: (query: string) => void;
  onOpenSelection: (selection: DetailSelection) => void;
}) {
  const projection = useMemo(
    () => projectProcessList(snapshot, sort, query),
    [snapshot, sort, query],
  );

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4 pt-3">
      <div className="flex items-center gap-2">
        <ProcessSearchField value={query} onChange={onQueryChange} />
        <ProcessSortControl sort={sort} onChange={onSortChange} />
      </div>

      <ProcessList
        projection={projection}
        status={snapshot.status}
        hasQuery={query.trim().length > 0}
        onOpenSelection={onOpenSelection}
      />
    </div>
  );
}
