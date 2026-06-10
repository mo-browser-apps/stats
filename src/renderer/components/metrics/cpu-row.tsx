import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";

import { MetricRowHeader } from "@/components/metrics/metric-row-header";
import { CpuGraph } from "@/components/metrics/cpu-graph";
import type { MetricsSnapshot } from "@/gen/metrics";
import { MetricStatus } from "@/gen/metrics";
import { isLive, usageState } from "@/domain/metric-view";
import { CPU_HISTORY_CAPACITY, pushSample, type CpuSample } from "@/domain/cpu-history";
import { formatPercentParts } from "@/lib/format";

export function CpuRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const [history, setHistory] = useState<CpuSample[]>([]);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const cpu = snapshot?.cpu;

  useEffect(() => {
    if (!cpu) return;
    const sample = cpu.status === MetricStatus.METRIC_STATUS_OK ? cpu.usagePercent : null;
    setHistory((prev) => pushSample(prev, sample));
  }, [snapshot, cpu]);

  const live = cpu ? isLive(usageState(cpu.status, cpu.usagePercent)) : false;
  const state = cpu ? usageState(cpu.status, cpu.usagePercent) : "pending";

  const scrubbed = scrubIndex !== null ? history[scrubIndex] : null;
  const shown = scrubbed != null ? scrubbed : live ? cpu!.usagePercent : null;
  const value = shown != null ? formatPercentParts(shown) : undefined;
  // History index -> viewBox slot center, as a percent for the tooltip x.
  const scrubPercent =
    scrubIndex !== null ? ((CPU_HISTORY_CAPACITY - history.length + scrubIndex + 0.5) / CPU_HISTORY_CAPACITY) * 100 : null;

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={Cpu} label="CPU">
        <span className="flex items-baseline gap-1">
          <span className="text-base font-medium tabular-nums leading-none text-foreground">{value?.value ?? "--"}</span>
          {value ? <span className="text-[13px] font-light text-muted-foreground">{value.unit}</span> : null}
        </span>
      </MetricRowHeader>
      <div className="relative h-20 w-full">
        <CpuGraph history={history} scrubIndex={scrubIndex} state={state} onScrub={setScrubIndex} />
        {scrubbed != null && scrubPercent !== null ? (
          <div
            className="pointer-events-none absolute -top-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-popover-foreground shadow-sm"
            style={{ left: `${Math.min(92, Math.max(8, scrubPercent))}%` }}
          >
            {scrubbed.toFixed(0)}%
          </div>
        ) : null}
      </div>
    </div>
  );
}
