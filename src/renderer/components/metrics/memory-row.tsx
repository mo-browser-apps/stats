import { MemoryStick } from "lucide-react";

import { MetricRowHeader } from "@/components/metrics/metric-row";
import { SegmentedMeter, type MeterSegment } from "@/components/metrics/segmented-meter";
import type { MetricsSnapshot } from "@/gen/metrics";
import { isLive, usageState } from "@/domain/metric-view";
import { formatBytes } from "@/lib/format";

type Memory = NonNullable<MetricsSnapshot["memory"]>;

const CATEGORIES: { key: "appBytes" | "wiredBytes" | "compressedBytes" | "cachedBytes"; label: string; fillClass: string }[] = [
  { key: "appBytes", label: "App", fillClass: "bg-mem-app" },
  { key: "wiredBytes", label: "Wired", fillClass: "bg-mem-wired" },
  { key: "compressedBytes", label: "Compressed", fillClass: "bg-mem-compressed" },
  { key: "cachedBytes", label: "Cache", fillClass: "bg-mem-cached" },
];

function freeBytes(memory: Memory): number {
  const accounted = CATEGORIES.reduce((sum, category) => sum + memory[category.key], 0);
  return Math.max(0, memory.totalBytes - accounted);
}

function buildSegments(memory: Memory): MeterSegment[] {
  return [
    ...CATEGORIES.map((category) => ({ ...category, bytes: memory[category.key] })),
    { key: "free", label: "Free", fillClass: "bg-mem-free", bytes: freeBytes(memory) },
  ];
}

function ariaLabel(segments: MeterSegment[], totalBytes: number): string {
  const parts = segments.map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`);
  return `Memory of ${formatBytes(totalBytes)}: ${parts.join(", ")}`;
}

export function MemoryRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory;
  const live = memory ? isLive(usageState(memory.status, memory.usedPercent)) : false;
  const segments = memory ? buildSegments(memory) : [];

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={MemoryStick} label="Memory">
        {live && memory ? (
          <span className="text-[13px] font-light tabular-nums text-muted-foreground">{formatBytes(memory.totalBytes)}</span>
        ) : null}
      </MetricRowHeader>
      {memory ? (
        <SegmentedMeter segments={segments} totalBytes={memory.totalBytes} ariaLabel={ariaLabel(segments, memory.totalBytes)} />
      ) : (
        <div className="h-1 w-full" aria-hidden="true" />
      )}
    </div>
  );
}
