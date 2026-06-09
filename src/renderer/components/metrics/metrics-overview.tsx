import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Clock, Cpu, HardDrive, MemoryStick, Network, Thermometer } from "lucide-react";

import { MetricRow } from "@/components/metrics/metric-row";
import { metricsGateway } from "@/gateway/metrics-gateway";
import type { MetricsSnapshot } from "@/gen/metrics";
import { baseState, isLive, usageState } from "@/domain/metric-view";
import {
  UNAVAILABLE_TEXT,
  formatBytes,
  formatCelsius,
  formatPercentParts,
  formatRate,
  formatRateParts,
  formatUptime,
} from "@/lib/format";

/**
 * Live overview (the Stats view). Owns the metrics-stream subscription but only
 * while active: it subscribes when `active` and unsubscribes when hidden,
 * retaining the last rows across tab switches. The renderer holds no sampling
 * timer.
 */
export function MetricsOverview({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    // Subscribe while active; the returned unsubscribe is the cleanup on hide.
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null));
  }, [active]);

  return (
    <div className="flex flex-1 flex-col px-6 pb-5">
      <div className="flex flex-1 flex-col justify-center divide-y divide-border/50">
        <div className="pb-4">
          <CpuRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <MemoryRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <DiskRow snapshot={snapshot} />
        </div>
        <div className="pt-4">
          <NetworkRow snapshot={snapshot} />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="h-px bg-border/50" />
        <FooterStats snapshot={snapshot} />
      </div>
    </div>
  );
}

function CpuRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const cpu = snapshot?.cpu;
  const state = cpu ? usageState(cpu.status, cpu.usagePercent) : "pending";
  const live = isLive(state);
  const detail = cpu && cpu.model ? `${cpu.model}${cpu.coreCount ? ` - ${cpu.coreCount} cores` : ""}` : undefined;
  const percent = cpu ? formatPercentParts(cpu.usagePercent) : undefined;
  return (
    <MetricRow
      icon={Cpu}
      label="CPU"
      state={state}
      value={percent?.value}
      valueUnit={percent?.unit}
      detail={live ? detail : undefined}
      percent={live ? cpu?.usagePercent : undefined}
    />
  );
}

function MemoryRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory;
  const state = memory ? usageState(memory.status, memory.usedPercent) : "pending";
  const live = isLive(state);
  const percent = memory ? formatPercentParts(memory.usedPercent) : undefined;
  return (
    <MetricRow
      icon={MemoryStick}
      label="Memory"
      state={state}
      value={percent?.value}
      valueUnit={percent?.unit}
      detail={live ? `${formatBytes(memory!.usedBytes)} / ${formatBytes(memory!.totalBytes)}` : undefined}
      percent={live ? memory?.usedPercent : undefined}
    />
  );
}

function DiskRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const disk = snapshot?.disk;
  const state = disk ? usageState(disk.status, disk.usedPercent) : "pending";
  const live = isLive(state);
  const percent = disk ? formatPercentParts(disk.usedPercent) : undefined;
  return (
    <MetricRow
      icon={HardDrive}
      label="Disk"
      state={state}
      value={percent?.value}
      valueUnit={percent?.unit}
      detail={live ? `${formatBytes(disk!.usedBytes)} / ${formatBytes(disk!.totalBytes)}` : undefined}
      percent={live ? disk?.usedPercent : undefined}
    />
  );
}

function NetworkRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const network = snapshot?.network;
  const state = network ? baseState(network.status) : "pending";
  const live = isLive(state);
  const down = network && live ? formatRateParts(network.rxBytesPerSec) : undefined;
  return (
    <MetricRow
      icon={Network}
      label="Network"
      state={state}
      value={down?.value}
      valueUnit={down?.unit}
      valuePrefix="↓"
      detail={network && live ? `↑ ${formatRate(network.txBytesPerSec)}` : undefined}
    />
  );
}

/**
 * Compact footer: Uptime on the left, CPU temperature on the right. Temperature
 * is best-effort on Apple Silicon, so it is shown only when a sensor reading is
 * actually available rather than as a dead placeholder.
 */
function FooterStats({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const uptime = snapshot?.uptime;
  const uptimeState = uptime ? baseState(uptime.status) : "pending";
  const uptimeLive = isLive(uptimeState);
  const uptimeValue = uptime && uptimeLive
    ? formatUptime(uptime.uptimeSeconds)
    : uptimeState === "pending"
      ? "--"
      : UNAVAILABLE_TEXT;

  const temperature = snapshot?.temperature;
  const temperatureLive = temperature ? isLive(baseState(temperature.status)) : false;

  return (
    <div className="flex items-center justify-between text-[11px]">
      <div>
        <FooterStat icon={Clock} label="Uptime" value={uptimeValue} />
      </div>

      <div>
        {temperature && temperatureLive ? (
          <FooterStat icon={Thermometer} label="CPU Temp" value={formatCelsius(temperature.celsius)} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A single footer stat: quiet icon + label, then the value.
 */
function FooterStat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
