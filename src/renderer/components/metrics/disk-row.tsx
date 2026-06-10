import { HardDrive } from "lucide-react";

import { MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import type { MetricsSnapshot } from "@/gen/metrics";
import { cn } from "@/lib/utils";
import { displayText, isLive, usageState, type MetricState } from "@/domain/metric-view";
import { formatBytes, formatPercentParts } from "@/lib/format";

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

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={HardDrive} label="Disk">
        <ValueUnit
          value={displayText(state, percent?.value ?? "")}
          unit={live ? percent?.unit : undefined}
          valueClassName={VALUE_COLOR_BY_STATE[state]}
        />
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
  const hasValue = isLive(state) && percent !== undefined && Number.isFinite(percent);
  if (!hasValue) {
    return <div className="relative h-1 w-full" aria-hidden="true" />;
  }

  const clamped = Math.min(100, Math.max(0, percent));
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
