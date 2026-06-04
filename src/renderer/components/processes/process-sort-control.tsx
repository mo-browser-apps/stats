import { ChevronDown } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SortMode } from "@/components/processes/process-view"

/**
 * Sort selector for the process list: a compact dropdown button on the search
 * row showing the active metric, opening a small CPU / RAM menu. Per-process
 * network is not a sort option because macOS has no reliable per-process source.
 * The dropdown keeps the only segmented control in the window the title-bar
 * Stats/Processes switch, so the sort no longer reads as a nested second row of
 * tabs.
 */
const SORT_LABELS: Record<SortMode, string> = {
  cpu: "CPU",
  memory: "RAM",
}

export function ProcessSortControl({
  sort,
  onChange,
}: {
  sort: SortMode
  onChange: (sort: SortMode) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Sort by ${SORT_LABELS[sort]}`}
        className="no-drag flex h-9 shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 pl-2.5 pr-1.5 text-[13px] text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted/60"
      >
        <span className="min-w-[2.25rem] text-center font-medium">{SORT_LABELS[sort]}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => onChange(value as SortMode)}
        >
          <DropdownMenuRadioItem value="cpu">{SORT_LABELS.cpu}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="memory">{SORT_LABELS.memory}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
