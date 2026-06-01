import { cn } from "@/lib/utils"
import type { MetricState } from "@/domain/metric-view"

/**
 * Thin, quiet usage bar. Width encodes the value; the fill color encodes the
 * presentation state (green/amber/red), so state is never conveyed by color
 * alone - the card always shows the value too (DESIGN.md accessibility rule).
 *
 * Rendered as a presentation element with the value mirrored onto ARIA so
 * assistive tech reads the usage without depending on the fill color.
 */
const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "bg-success",
  elevated: "bg-warning",
  critical: "bg-destructive",
  // No live value: a muted, empty track communicates "nothing to show".
  pending: "bg-muted-foreground/30",
  unavailable: "bg-muted-foreground/30",
}

interface ProgressBarProps {
  /** 0-100. Clamped; ignored visually when the metric has no live value. */
  value: number
  state: MetricState
  className?: string
}

export function ProgressBar({ value, state, className }: ProgressBarProps) {
  const live = state === "ok" || state === "elevated" || state === "critical"
  const hasValue = live && Number.isFinite(value)
  const clamped = hasValue ? Math.min(100, Math.max(0, value)) : 0

  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={hasValue ? Math.round(clamped) : undefined}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-150 ease-out", FILL_BY_STATE[state])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
