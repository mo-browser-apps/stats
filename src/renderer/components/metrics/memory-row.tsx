import { MemoryStick } from "lucide-react";

import { MetricRowHeader, ValueUnit, VALUE_COLOR_BY_STATE } from "@/components/metrics/metric-row-header";
import { SegmentedMeter, type MeterSegment } from "@/components/metrics/segmented-meter";
import type { MetricsSnapshot } from "@/gen/metrics";
import { displayText, isLive, usageState } from "@/domain/metric-view";
import { formatBytes, formatPercentParts } from "@/lib/format";

type Memory = NonNullable<MetricsSnapshot["memory"]>;

const CATEGORIES: { key: "appBytes" | "wiredBytes" | "compressedBytes" | "cachedBytes"; label: string; fillClass: string }[] = [
  { key: "appBytes", label: "App", fillClass: "bg-mem-app" },
  { key: "wiredBytes", label: "Wired", fillClass: "bg-mem-wired" },
  { key: "compressedBytes", label: "Compressed", fillClass: "bg-mem-compressed" },
  { key: "cachedBytes", label: "Cache", fillClass: "bg-mem-cached" },
];

function buildSegments(memory: Memory): MeterSegment[] {
  const accounted = CATEGORIES.reduce((sum, category) => sum + memory[category.key], 0);
  return [
    ...CATEGORIES.map((category) => ({ ...category, bytes: memory[category.key] })),
    { key: "free", label: "Free", fillClass: "bg-mem-free", bytes: Math.max(0, memory.totalBytes - accounted) },
  ];
}

function ariaLabel(segments: MeterSegment[], totalBytes: number): string {
  const parts = segments.map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`);
  return `Memory of ${formatBytes(totalBytes)}: ${parts.join(", ")}`;
}

export function MemoryRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory;
  const state = memory ? usageState(memory.status, memory.usedPercent) : "pending";
  const live = isLive(state);
  const segments = memory ? buildSegments(memory) : [];
  const percent = memory ? formatPercentParts(memory.usedPercent) : undefined;

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={MemoryStick} label="Memory">
        <ValueUnit
          value={displayText(state, percent?.value ?? "")}
          unit={live ? percent?.unit : undefined}
          valueClassName={VALUE_COLOR_BY_STATE[state]}
        />
      </MetricRowHeader>
      {memory && live ? (
        <SegmentedMeter segments={segments} totalBytes={memory.totalBytes} ariaLabel={ariaLabel(segments, memory.totalBytes)} />
      ) : (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <div className="h-1 w-full" />
          <div className="text-[10px]">&nbsp;</div>
        </div>
      )}
    </div>
  );
}
