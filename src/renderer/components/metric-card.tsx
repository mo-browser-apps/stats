import type { LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { ProgressBar } from "@/components/ui/progress-bar"
import { cn } from "@/lib/utils"
import { isLive, type MetricState } from "@/domain/metric-view"
import { UNAVAILABLE_TEXT } from "@/lib/format"

/**
 * One compact metric card: icon + label, a primary value, an optional secondary
 * line, and an optional usage bar.
 *
 * The four rows are always present (the secondary line and bar row reserve their
 * height even when empty), so with uniform padding and gap the card height is
 * constant across updates without a hand-tuned fixed height (DESIGN.md "stable
 * across updates"). Presentation only - it renders whatever the overview hands it.
 */
export interface MetricCardProps {
  icon: LucideIcon
  label: string
  /** Presentation state; drives value color and bar fill. */
  state: MetricState
  /** Primary value string, already formatted. Ignored when not live. */
  value?: string
  /** Optional secondary line (e.g. "12.0 GB / 16.0 GB" or a CPU model). */
  secondary?: string
  /** When provided, a usage bar is shown (0-100). */
  percent?: number
}

const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
}

export function MetricCard({
  icon: Icon,
  label,
  state,
  value,
  secondary,
  percent,
}: MetricCardProps) {
  const live = isLive(state)
  const showBar = percent !== undefined
  const primaryText = live && value ? value : state === "pending" ? "--" : UNAVAILABLE_TEXT

  return (
    <Card className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted-foreground/10">
          <Icon className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>

      <span
        className={cn(
          "truncate font-semibold tabular-nums",
          live ? "text-2xl" : "text-base",
          VALUE_COLOR_BY_STATE[state],
        )}
      >
        {primaryText}
      </span>

      {/* Reserve the secondary line height even when empty to keep cards even. */}
      <span className="h-4 truncate text-[11px] text-muted-foreground tabular-nums">
        {live && secondary ? secondary : null}
      </span>

      {/* Reserve the bar row height whether a bar is shown. */}
      <div className="h-1">
        {showBar ? <ProgressBar value={percent} state={state} /> : null}
      </div>
    </Card>
  )
}
