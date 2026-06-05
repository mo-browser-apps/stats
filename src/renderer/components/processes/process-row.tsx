import { memo, useState } from "react"
import { Box } from "lucide-react"

import { cn } from "@/lib/utils"
import { UNAVAILABLE_TEXT } from "@/lib/format"
import type { ProcessGroup } from "@/components/processes/process-view"

/**
 * One fixed-height process row: app icon (or a generic fallback), the process or
 * app name, an optional "+N" grouped-child badge, and the right-aligned active
 * metric. Height is fixed and the name truncates, so long names or large values
 * never reflow the list. The whole row is a button that opens the detail view
 * for the group; grouped rows open the detail panel rather than expanding inline.
 *
 * Wrapped in {@link memo} with a field-wise comparator: the projection rebuilds
 * fresh group objects every 2s tick, but most rows' displayed fields are
 * identical between ticks, so comparing the rendered fields lets an unchanged
 * row skip re-rendering entirely instead of reconciling on every snapshot.
 */
export const ProcessRow = memo(function ProcessRow({
  group,
  onOpen,
}: {
  group: ProcessGroup
  onOpen: (key: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(group.key)}
      aria-label={`Show details for ${group.name}`}
      className="flex h-11 w-full items-center gap-2.5 rounded-md px-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ProcessIcon iconPngBase64={group.iconPngBase64} name={group.name} />

      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{group.name}</span>

      {group.childCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
          title={`${group.memberCount} processes`}
        >
          +{group.childCount}
        </span>
      ) : null}

      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-right text-[13px] font-medium tabular-nums",
          group.metricState === "ok" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {metricText(group)}
      </span>
    </button>
  )
}, areGroupsEqual)

/**
 * Equality check for the memoized row: a row only needs to re-render when one of
 * its visible fields changes. The projection produces new group objects every
 * tick, so a referential compare would always miss; comparing the displayed
 * fields lets a steady row skip rendering. `key` is the group identity and is
 * compared too so React never reuses a row across distinct groups. `onOpen` is a
 * stable callback from the parent, so it does not need comparing.
 */
function areGroupsEqual(
  previous: { group: ProcessGroup; onOpen: (key: string) => void },
  next: { group: ProcessGroup; onOpen: (key: string) => void },
): boolean {
  const a = previous.group
  const b = next.group
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.iconPngBase64 === b.iconPngBase64 &&
    a.childCount === b.childCount &&
    a.memberCount === b.memberCount &&
    a.metricState === b.metricState &&
    a.metricText === b.metricText
  )
}

/**
 * The right-aligned value text for a row: the formatted value when OK, a quiet
 * `--` while the metric is still pending (e.g. a first-sample CPU delta), and the
 * explicit unavailable text only when the source was tried and could not be read.
 * Mirrors the overview's MetricRow so the two views read the same.
 */
function metricText(group: ProcessGroup): string {
  switch (group.metricState) {
    case "ok":
      return group.metricText ?? UNAVAILABLE_TEXT
    case "pending":
      return "--"
    default:
      return UNAVAILABLE_TEXT
  }
}

/**
 * App icon for a process row or the detail header. Renders the volatile base64
 * PNG from NSWorkspace when one is available; otherwise (and if the image fails
 * to decode) it falls back to a neutral lucide glyph so every row keeps the same
 * icon footprint. `size` scales the box for the larger detail header.
 */
export function ProcessIcon({
  iconPngBase64,
  name,
  size = "sm",
}: {
  iconPngBase64?: string
  name: string
  size?: "sm" | "lg"
}) {
  const [failed, setFailed] = useState(false)
  const box = size === "lg" ? "h-9 w-9 rounded-xl" : "h-5 w-5 rounded-lg"
  const glyph = size === "lg" ? "h-5 w-5" : "h-3 w-3"

  if (iconPngBase64 && !failed) {
    return (
      <img
        src={`data:image/png;base64,${iconPngBase64}`}
        alt=""
        aria-hidden="true"
        className={cn("shrink-0", box)}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span
      className={cn("flex shrink-0 items-center justify-center bg-muted", box)}
      aria-hidden="true"
      title={name}
    >
      <Box className={cn("text-muted-foreground", glyph)} strokeWidth={1.75} />
    </span>
  )
}
