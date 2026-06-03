import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { processExplorerGateway } from "@/gateway/process-explorer-gateway"
import type { ProcessSnapshot } from "@/gen/process_explorer"
import { ProcessList } from "@/components/processes/process-list"
import { ProcessSearchField } from "@/components/processes/process-search-field"
import { ProcessSortControl } from "@/components/processes/process-sort-control"
import { projectProcessList, type SortMode } from "@/components/processes/process-view"

/**
 * The Processes view: a compact searchable, CPU/Memory-ranked, app-grouped
 * process list.
 *
 * It owns the process-explorer data lifecycle while active: App.tsx keeps the
 * view mounted across tab switches, reports the active top-level view to main,
 * and this component pulls the cached snapshot plus revision updates only while
 * Processes is visible. Search/sort are local presentation state; the heavy
 * projection is memoized and lives in pure code. Command-line arguments are used
 * only as a local search haystack and are never logged or persisted here.
 */
export function ProcessExplorerView({ active }: { active: boolean }) {
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
    // The view stays mounted across tab switches (so it keeps its rows, sort,
    // search, and scroll), but only consumes data while it is the active view.
    // While hidden it holds its last rows and does nothing; main pauses
    // collection then anyway.
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
