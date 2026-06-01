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
 * Dimensions are fixed (`h-[112px]`) so values changing every tick never resize
 * the card or shift the grid (DESIGN.md "stable across updates"). Presentation
 * only - it renders whatever derived view the overview hands it.
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
    <Card className="flex h-[112px] flex-col justify-between p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate text-[13px] font-medium">{label}</span>
      </div>

      <div className="flex flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-xl font-semibold tabular-nums leading-tight",
            VALUE_COLOR_BY_STATE[state],
          )}
        >
          {primaryText}
        </span>
        {/* Reserve the secondary line height even when empty to keep cards even. */}
        <span className="h-4 truncate text-[11px] text-muted-foreground tabular-nums">
          {live && secondary ? secondary : null}
        </span>
      </div>

      {/* Reserve the bar row height whether or not a bar is shown. */}
      <div className="h-1.5">{showBar ? <ProgressBar value={percent} state={state} /> : null}</div>
    </Card>
  )
}
