import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";

import { MeterTooltip, MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import { CpuGraph, type CpuSample } from "@/components/metrics/cpu-graph";
import type { MetricsSnapshot } from "@/gen/metrics";
import { MetricStatus } from "@/gen/metrics";
import { isLive, usageState } from "@/domain/metric-view";
import { HISTORY_CAPACITY, pushSample } from "@/domain/sample-history";
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

  const state = cpu ? usageState(cpu.status, cpu.usagePercent) : "pending";
  const live = isLive(state);

  const scrubbed = scrubIndex !== null ? history[scrubIndex] : null;
  const shown = scrubbed ?? (live && cpu ? cpu.usagePercent : null);
  const value = shown != null ? formatPercentParts(shown) : undefined;
  // History index -> viewBox slot center, as a percent for the tooltip x.
  const scrubPercent =
    scrubIndex !== null ? ((HISTORY_CAPACITY - history.length + scrubIndex + 0.5) / HISTORY_CAPACITY) * 100 : null;

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={Cpu} label="CPU">
        <ValueUnit value={value?.value ?? "--"} unit={value?.unit} />
      </MetricRowHeader>
      <div className="relative h-20 w-full">
        <CpuGraph history={history} scrubIndex={scrubIndex} state={state} onScrub={setScrubIndex} />
        {scrubbed != null && scrubPercent !== null ? (
          <MeterTooltip leftPercent={scrubPercent} className="-top-1">
            {scrubbed.toFixed(0)}%
          </MeterTooltip>
        ) : null}
      </div>
    </div>
  );
}
