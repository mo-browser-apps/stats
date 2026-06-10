import { HardDrive } from "lucide-react";

import { MetricRowHeader, Meter, VALUE_COLOR_BY_STATE } from "@/components/metrics/metric-row";
import type { MetricsSnapshot } from "@/gen/metrics";
import { cn } from "@/lib/utils";
import { isLive, usageState } from "@/domain/metric-view";
import { UNAVAILABLE_TEXT, formatBytes, formatPercentParts } from "@/lib/format";

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
      <Meter label="Disk" state={state} percent={live ? disk?.usedPercent : undefined} />
      <span className="h-3.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
        {live && disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : null}
      </span>
    </div>
  );
}
