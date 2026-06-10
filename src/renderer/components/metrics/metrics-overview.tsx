import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Clock, Cpu, HardDrive, MemoryStick, Network, Thermometer } from "lucide-react";

import { MetricRow } from "@/components/metrics/metric-row";
import { SegmentedMeter } from "@/components/metrics/segmented-meter";
import { metricsGateway } from "@/gateway/metrics-gateway";
import type { MetricsSnapshot } from "@/gen/metrics";
import { baseState, isLive, usageState } from "@/domain/metric-view";
import {
  UNAVAILABLE_TEXT,
  formatBytes,
  formatCelsius,
  formatLoadAverage,
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
  const load = formatLoadAverage(cpu?.loadAverage);
  const detail = load ? `Load ${load}` : undefined;
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

/**
 * Memory composition segments in bar order, each mapped to a color token. App,
 * wired, and compressed are the "in-use" family; cached is reclaimable; free is
 * the unfilled remainder (shown via the track rail, not an explicit segment).
 */
const MEMORY_SEGMENTS: {
  key: "appBytes" | "wiredBytes" | "compressedBytes" | "cachedBytes";
  label: string;
  fillClass: string;
}[] = [
  { key: "appBytes", label: "App", fillClass: "bg-mem-app" },
  { key: "wiredBytes", label: "Wired", fillClass: "bg-mem-wired" },
  { key: "compressedBytes", label: "Compressed", fillClass: "bg-mem-compressed" },
  { key: "cachedBytes", label: "Cache", fillClass: "bg-mem-cached" },
];

function MemoryRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory;
  const state = memory ? usageState(memory.status, memory.usedPercent) : "pending";
  const live = isLive(state);

  const segments = memory
    ? [
        ...MEMORY_SEGMENTS.map((segment) => ({
          key: segment.key,
          label: segment.label,
          fillClass: segment.fillClass,
          bytes: memory[segment.key],
        })),
        { key: "free", label: "Free", fillClass: "bg-mem-free", bytes: freeBytes(memory) },
      ]
    : [];

  return (
    <MetricRow
      icon={MemoryStick}
      label="Memory"
      state={state}
      headlineSlot={
        live && memory ? (
          <span className="text-[13px] font-light tabular-nums text-muted-foreground">
            {formatBytes(memory.totalBytes)}
          </span>
        ) : undefined
      }
      meterSlot={
        memory ? (
          <SegmentedMeter
            segments={segments}
            totalBytes={memory.totalBytes}
            ariaLabel={memoryAriaLabel(memory)}
          />
        ) : undefined
      }
    />
  );
}

/**
 * Free memory: whatever the four in-use/cached categories do not account for,
 * floored at zero so rounding can never produce a negative slice.
 */
function freeBytes(memory: NonNullable<MetricsSnapshot["memory"]>): number {
  const accounted = MEMORY_SEGMENTS.reduce((sum, segment) => sum + memory[segment.key], 0);
  return Math.max(0, memory.totalBytes - accounted);
}

/**
 * Spoken composition for the memory bar: the full breakdown that hover reveals
 * visually, so the categories are reachable without a pointer.
 */
function memoryAriaLabel(memory: NonNullable<MetricsSnapshot["memory"]>): string {
  const parts = MEMORY_SEGMENTS.map((segment) => `${segment.label} ${formatBytes(memory[segment.key])}`);
  parts.push(`Free ${formatBytes(freeBytes(memory))}`);
  return `Memory of ${formatBytes(memory.totalBytes)}: ${parts.join(", ")}`;
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
