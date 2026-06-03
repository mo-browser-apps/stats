import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { processExplorerGateway } from "@/gateway/process-explorer-gateway"
import type { ProcessSnapshot } from "@/gen/process_explorer"
import { ProcessList } from "@/processes/process-list"
import { ProcessSearchField } from "@/processes/process-search-field"
import { ProcessSortControl } from "@/processes/process-sort-control"
import { projectProcessList, type SortMode } from "@/processes/process-view"

/**
 * The Processes view: a compact searchable, CPU/Memory-ranked, app-grouped
 * process list.
 *
 * It owns the process-explorer data lifecycle while it is mounted (which is only
 * while the Processes tab is selected, since App.tsx mounts it conditionally):
 * it tells main to start collecting, pulls the cached snapshot, and re-pulls
 * whenever main signals a new revision. On unmount it tells main to stop, so the
 * sensitive per-process command-line reads run only while this view is on
 * screen. Search/sort are local presentation state; the heavy projection is
 * memoized and lives in pure code. Command-line arguments are used only as a
 * local search haystack and are never logged or persisted here.
 */
export function ProcessExplorerView() {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot>(() =>
    processExplorerGateway.emptySnapshot(),
  )
  const [sort, setSort] = useState<SortMode>("cpu")
  const [query, setQuery] = useState("")

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
    let active = true

    // Main activates collection while the Processes view is the visible one (it
    // is driven by App.tsx reporting the active view). Here we only consume:
    // pull once for first paint, then re-pull on each revision ping.
    void pull()

    const unsubscribe = processExplorerGateway.subscribeRevisions(() => {
      if (active) void pull()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [pull])

  const projection = useMemo(
    () => projectProcessList(snapshot, sort, query),
    [snapshot, sort, query],
  )

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4">
      <div className="flex flex-col gap-3">
        <div className="flex justify-center">
          <ProcessSortControl sort={sort} onChange={setSort} />
        </div>
        <ProcessSearchField value={query} onChange={setQuery} />
      </div>

      <ProcessList
        projection={projection}
        status={snapshot.status}
        hasQuery={query.trim().length > 0}
      />
    </div>
  )
}
