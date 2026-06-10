import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";
import type { MetricState } from "@/domain/metric-view";
import { CPU_HISTORY_CAPACITY, sampleIndexAtFraction, type CpuSample } from "@/domain/cpu-history";

const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "text-success",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground/40",
  unavailable: "text-muted-foreground/40",
};

const BAR_GAP = 0.25; // viewBox units between bars (slot width is 1)
const MIN_BAR = 1.5; // floor so a ~0% sample is still a visible nub
const AXIS_FLOOR = 20; // smallest y-axis max, so a flat-idle graph is not "maxed"

/**
 * Column graph of recent CPU usage: one bar per sample in a
 * {@link CPU_HISTORY_CAPACITY} x 100 viewBox, right-aligned (newest at the right).
 * The y-axis scales to the tallest visible sample (never below {@link AXIS_FLOOR})
 * so idle values stay readable and clickable while spikes still fit; bar heights
 * ease to the new scale. Hovering scrubs: `onScrub` reports the index under the
 * cursor (null on leave) and that bar brightens.
 */
export function CpuGraph({
  history,
  scrubIndex,
  state,
  onScrub,
}: {
  history: CpuSample[];
  scrubIndex: number | null;
  state: MetricState;
  onScrub: (index: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const offset = CPU_HISTORY_CAPACITY - history.length;
  const fill = FILL_BY_STATE[state];

  const axisMax = Math.max(AXIS_FLOOR, ...history.map((sample) => sample ?? 0));

  const handleMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onScrub(sampleIndexAtFraction((event.clientX - rect.left) / rect.width, history.length));
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${CPU_HISTORY_CAPACITY} 100`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", fill)}
      onPointerMove={handleMove}
      onPointerLeave={() => onScrub(null)}
    >
      {history.map((sample, index) => {
        if (sample === null) return null;
        const height = Math.max(MIN_BAR, Math.min(100, (sample / axisMax) * 100));
        const active = scrubIndex === index;
        return (
          <rect
            key={index}
            x={offset + index + BAR_GAP / 2}
            y={100 - height}
            width={1 - BAR_GAP}
            height={height}
            rx={0.3}
            // Hovered bar pops to near-white; the rest sit at a calm tinted tone.
            className={active ? "text-foreground" : undefined}
            fill="currentColor"
            fillOpacity={active ? 1 : 0.55}
            style={{ transition: "y 150ms ease-out, height 150ms ease-out" }}
          />
        );
      })}
    </svg>
  );
}
