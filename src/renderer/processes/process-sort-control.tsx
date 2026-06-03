import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control"
import type { SortMode } from "@/processes/process-view"

/**
 * Sort selector for the process list. CPU and Memory are live; Network is shown
 * disabled because macOS has no reliable, non-brittle per-process network source
 * (modeled as unsupported in the contract), so it is never faked - the disabled
 * segment is the honest unsupported state.
 */
const SORT_OPTIONS: ReadonlyArray<SegmentedOption<SortMode | "network">> = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  {
    value: "network",
    label: "Network",
    disabled: true,
    title: "Per-process network is not available on macOS",
  },
]

export function ProcessSortControl({
  sort,
  onChange,
}: {
  sort: SortMode
  onChange: (sort: SortMode) => void
}) {
  return (
    <SegmentedControl
      ariaLabel="Sort processes by"
      size="sm"
      options={SORT_OPTIONS}
      value={sort}
      onChange={(value) => {
        if (value === "cpu" || value === "memory") onChange(value)
      }}
    />
  )
}
