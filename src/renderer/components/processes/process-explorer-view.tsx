import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { processExplorerGateway } from "@/gateway/process-explorer-gateway"
import {
  FieldStatus,
  type ActionState,
  type ProcessActionKind,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "@/gen/process_explorer"
import { ProcessDetailView } from "@/components/processes/process-detail"
import { ProcessList } from "@/components/processes/process-list"
import { ProcessSearchField } from "@/components/processes/process-search-field"
import { ProcessSortControl } from "@/components/processes/process-sort-control"
import {
  buildProcessDetail,
  projectProcessList,
  resolveSelection,
  type DetailSelection,
  type SortMode,
} from "@/components/processes/process-view"

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
  )
  const [sort, setSort] = useState<SortMode>("cpu")
  const [query, setQuery] = useState("")
  // The drill-in stack: list -> group -> member. Empty is the list. Each entry is
  // re-resolved from every fresh snapshot so the detail stays live; the top entry
  // is the shown detail, and Back pops one level.
  const [selectionStack, setSelectionStack] = useState<DetailSelection[]>([])

  // Highest revision applied, so an out-of-order pull cannot show stale rows.
  const appliedRevision = useRef(0)

  const pull = useCallback(async () => {
    try {
      const next = await processExplorerGateway.getSnapshot()
      if (next.revision >= appliedRevision.current) {
        appliedRevision.current = next.revision
        setSnapshot(next)
      }
    } catch {
      // A failed pull leaves the last snapshot in place; the next revision ping
      // (or the cadence) retries. No diagnostic is logged - it could carry
      // process-identifying data.
    }
  }, [])

  useEffect(() => {
    // The view stays mounted across tab switches (so it keeps its rows, sort,
    // search, selection, and scroll), but only consumes data while it is the
    // active view. While hidden it holds its last rows and does nothing; main
    // pauses collection then anyway.
    if (!active) {
      return
    }

    let live = true

    // Pull immediately on becoming active so the (cached) rows show at once,
    // then re-pull on each revision ping.
    void pull()

    const unsubscribe = processExplorerGateway.subscribeRevisions(() => {
      if (live) void pull()
    })

    return () => {
      live = false
      unsubscribe()
    }
  }, [active, pull])

  const openSelection = useCallback(
    (selection: DetailSelection) => setSelectionStack([selection]),
    [],
  )
  const openMember = useCallback(
    (pid: number, startedAtUnixMs?: number) =>
      setSelectionStack((stack) => [...stack, { kind: "process", pid, startedAtUnixMs }]),
    [],
  )
  const goBack = useCallback(() => setSelectionStack((stack) => stack.slice(0, -1)), [])

  // The detail model for the deepest still-resolvable selection, re-resolved from
  // the current snapshot and sort so CPU/memory stay live as ticks arrive. If the
  // top selection's process(es) have exited it falls back down the stack (member
  // gone -> its group; group gone -> the list) without mutating state. Back still
  // pops the (now-dead) top entry, so at worst one Back press lands on the level
  // already shown before continuing up.
  const detail = useMemo(() => {
    for (let depth = selectionStack.length - 1; depth >= 0; depth -= 1) {
      const group = resolveSelection(snapshot, sort, selectionStack[depth])
      if (group) {
        return buildProcessDetail(group, sort)
      }
    }
    return undefined
  }, [snapshot, sort, selectionStack])

  const projection = useMemo(
    () => projectProcessList(snapshot, sort, query),
    [snapshot, sort, query],
  )

  // Main-authoritative action states for the open detail's target. Fetched when
  // the target process changes (its enabled/disabled reasons - self/system/path -
  // are stable tick to tick; staleness is re-checked authoritatively in main when
  // an action runs). `actionsBusy` disables the row while an action is in flight.
  // The target is memoized on the primitive identity (pid + start time), not the
  // detail object (which is a fresh reference each tick), so it stays stable while
  // the same process is selected and does not refetch on every revision.
  const targetPid = detail?.pid
  const targetStartedAt = detail?.startedAt === "ok" ? detail.startedAtUnixMs : undefined
  const target = useMemo<ProcessIdentity | undefined>(
    () =>
      targetPid === undefined
        ? undefined
        : {
            pid: targetPid,
            startedAtStatus:
              targetStartedAt === undefined
                ? FieldStatus.FIELD_STATUS_UNKNOWN
                : FieldStatus.FIELD_STATUS_OK,
            startedAtUnixMs: targetStartedAt ?? 0,
          },
    [targetPid, targetStartedAt],
  )
  const targetKey =
    target === undefined
      ? ""
      : `${target.pid}:${target.startedAtStatus}:${target.startedAtUnixMs}`
  const targetKeyRef = useRef(targetKey)
  useEffect(() => {
    targetKeyRef.current = targetKey
  }, [targetKey])
  const [actions, setActions] = useState<ActionState[]>([])
  const [actionsBusy, setActionsBusy] = useState(false)
  // Always read the latest revision when running an action, without making the
  // action-state fetch depend on it (which would refetch every 2s tick).
  const revisionRef = useRef(0)
  useEffect(() => {
    revisionRef.current = snapshot.revision
  }, [snapshot.revision])

  const refreshActionStates = useCallback(async () => {
    if (!target) {
      setActions([])
      return
    }
    const requestedKey = targetKey
    setActions([])
    try {
      const response = await processExplorerGateway.getActionStates(target, revisionRef.current)
      if (targetKeyRef.current === requestedKey) {
        setActions(response.actions)
      }
    } catch {
      // Keep the row disabled for this target until the next successful fetch.
      if (targetKeyRef.current === requestedKey) {
        setActions([])
      }
    }
  }, [target, targetKey])

  useEffect(() => {
    void refreshActionStates()
  }, [refreshActionStates])

  const runAction = useCallback(
    async (kind: ProcessActionKind) => {
      if (!target || actionsBusy) {
        return
      }
      setActionsBusy(true)
      try {
        await processExplorerGateway.runAction(kind, target, revisionRef.current)
      } catch {
        // No diagnostic is logged - the target/result can carry process identity.
      } finally {
        setActionsBusy(false)
      }
      // Re-pull so a quit/force-quit drops the row promptly (the detail then falls
      // back down the stack), and refresh the action availability for what remains.
      await pull()
      await refreshActionStates()
    },
    [target, actionsBusy, pull, refreshActionStates],
  )

  if (detail) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-3">
        <ProcessDetailView
          detail={detail}
          sort={sort}
          actions={actions}
          actionsBusy={actionsBusy}
          onSortChange={setSort}
          onBack={goBack}
          onOpenMember={openMember}
          onRunAction={runAction}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4 pt-3">
      <div className="flex items-center gap-2">
        <ProcessSearchField value={query} onChange={setQuery} />
        <ProcessSortControl sort={sort} onChange={setSort} />
      </div>

      <ProcessList
        projection={projection}
        status={snapshot.status}
        hasQuery={query.trim().length > 0}
        onOpenSelection={openSelection}
      />
    </div>
  )
}
