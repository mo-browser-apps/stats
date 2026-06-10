import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { isLive, type MetricState } from "@/domain/metric-view";
import { UNAVAILABLE_TEXT } from "@/lib/format";

interface MetricRowProps {
  icon: LucideIcon;
  label: string;
  state: MetricState;
  value?: string;
  valueUnit?: string;
  valuePrefix?: string;
  detail?: string;
  percent?: number;
}

const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "bg-success",
  elevated: "bg-warning",
  critical: "bg-destructive",
  pending: "bg-muted-foreground/30",
  unavailable: "bg-muted-foreground/30",
};

/** Shared row chrome: the icon + uppercase label, with `children` on the right. */
export function MetricRowHeader({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 self-center" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[11px] font-light uppercase tracking-[0.18em]">{label}</span>
      </span>
      {children}
    </div>
  );
}

/** A metric as a header + single-fill meter + detail line (CPU, Disk, Network). */
export function MetricRow({ icon, label, state, value, valueUnit, valuePrefix, detail, percent }: MetricRowProps) {
  const live = isLive(state);
  const primaryText = live && value ? value : state === "pending" ? "--" : UNAVAILABLE_TEXT;
  const showAffixes = live && Boolean(value);

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={icon} label={label}>
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
      </MetricRowHeader>
      <Meter label={label} state={state} percent={percent} />
      <span className="h-3.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
        {live && detail ? detail : null}
      </span>
    </div>
  );
}

/** Rounded rail with a fill whose width encodes the value; mirrored onto ARIA. */
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
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 ease-out", FILL_BY_STATE[state])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
