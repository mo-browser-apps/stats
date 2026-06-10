import { HardDrive } from "lucide-react";

import { MetricRowHeader } from "@/components/metrics/metric-row-header";
import type { MetricsSnapshot } from "@/gen/metrics";
import { cn } from "@/lib/utils";
import { isLive, usageState, type MetricState } from "@/domain/metric-view";
import { UNAVAILABLE_TEXT, formatBytes, formatPercentParts } from "@/lib/format";

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

export function DiskRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const disk = snapshot?.disk;
  const state = disk ? usageState(disk.status, disk.usedPercent) : "pending";
  const live = isLive(state);
  const percent = disk ? formatPercentParts(disk.usedPercent) : undefined;
  const primary = live && percent ? percent.value : state === "pending" ? "--" : UNAVAILABLE_TEXT;

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={HardDrive} label="Disk">
        <span className="flex items-baseline gap-1">
          <span className={cn("text-base font-medium tabular-nums leading-none", VALUE_COLOR_BY_STATE[state])}>{primary}</span>
          {live && percent ? <span className="text-[13px] font-light text-muted-foreground">{percent.unit}</span> : null}
        </span>
      </MetricRowHeader>
      <Meter state={state} percent={live ? disk?.usedPercent : undefined} />
      <span className="h-3.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
        {live && disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : null}
      </span>
    </div>
  );
}

/** Rounded rail with a fill whose width encodes the value; mirrored onto ARIA. */
function Meter({ state, percent }: { state: MetricState; percent?: number }) {
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
      aria-label="Disk usage"
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
