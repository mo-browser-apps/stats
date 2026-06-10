import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { isLive, type MetricState } from "@/domain/metric-view";
import { UNAVAILABLE_TEXT } from "@/lib/format";

/**
 * One metric as a horizontal row.
 */
interface MetricRowProps {
  icon: LucideIcon;
  label: string;
  /**
   * Presentation state; drives value color and meter fill.
   */
  state: MetricState;
  /**
   * Primary value string (numeric part only), already formatted. Ignored when
   * not live.
   */
  value?: string;
  /**
   * Unit suffix rendered small and muted after the value (e.g. "%" or "KB/s"),
   * so the numerals carry the visual weight. Ignored when not live.
   */
  valueUnit?: string;
  /**
   * Quiet prefix glyph rendered small and muted before the value (the Network
   * row's down-arrow). Ignored when not live.
   */
  valuePrefix?: string;
  /**
   * Optional detail line.
   */
  detail?: string;
  /**
   * When provided, a hairline meter is shown with a marker dot at value% (0-100).
   */
  percent?: number;
  /**
   * Replaces the single-fill meter (e.g. a segmented composition bar). When set,
   * `percent` is ignored. Rendered only while live, like the default meter.
   */
  meterSlot?: ReactNode;
  /**
   * Replaces the text detail line (e.g. a swatch legend). When set, `detail` is
   * ignored. Rendered only while live, in the same height-reserved slot.
   */
  detailSlot?: ReactNode;
  /**
   * Replaces the entire right-side value group (the big value + affixes). Use
   * for rows that want a custom headline, e.g. a small muted total instead of a
   * large number. When set, `value`/`valueUnit`/`valuePrefix` are ignored.
   */
  headlineSlot?: ReactNode;
}

const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

/**
 * Meter fill color, mirroring the value color so state never relies on the meter
 * alone.
 */
const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "bg-success",
  elevated: "bg-warning",
  critical: "bg-destructive",
  pending: "bg-muted-foreground/30",
  unavailable: "bg-muted-foreground/30",
};

export function MetricRow({
  icon: Icon,
  label,
  state,
  value,
  valueUnit,
  valuePrefix,
  detail,
  percent,
  meterSlot,
  detailSlot,
  headlineSlot,
}: MetricRowProps) {
  const live = isLive(state);
  const primaryText = live && value ? value : state === "pending" ? "--" : UNAVAILABLE_TEXT;
  const showAffixes = live && Boolean(value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0 self-center" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[11px] font-light uppercase tracking-[0.18em]">{label}</span>
        </span>
        {headlineSlot ? (
          headlineSlot
        ) : (
          <span className="flex items-baseline gap-1">
            {showAffixes && valuePrefix ? (
              <span className="text-sm font-light text-muted-foreground">{valuePrefix}</span>
            ) : null}
            <span className={cn("text-2xl font-medium tabular-nums leading-none", VALUE_COLOR_BY_STATE[state])}>
              {primaryText}
            </span>
            {showAffixes && valueUnit ? (
              <span className="text-[13px] font-light text-muted-foreground">{valueUnit}</span>
            ) : null}
          </span>
        )}
      </div>
      {live && meterSlot ? meterSlot : <Meter label={label} state={state} percent={percent} />}
      {detailSlot !== undefined || detail !== undefined ? (
        <span className="h-3.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
          {live ? (detailSlot ?? detail ?? null) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Rounded 4px track with a fill whose width encodes the value. The value is
 * mirrored onto ARIA so usage reads without depending on color.
 */
function Meter({ label, state, percent }: { label: string; state: MetricState; percent?: number }) {
  const live = isLive(state);
  const hasValue = live && percent !== undefined && Number.isFinite(percent);
  const clamped = hasValue ? Math.min(100, Math.max(0, percent)) : 0;

  if (!hasValue) {
    return <div className="relative h-1 w-full" aria-hidden="true" />;
  }

  return (
    <div
      className="relative h-1 w-full overflow-hidden rounded-full bg-track"
      role="progressbar"
      aria-label={`${label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 ease-out",
          FILL_BY_STATE[state],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
