import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";
import type { MetricState } from "@/domain/metric-view";
import { areaRuns } from "@/domain/area-path";
import { HISTORY_CAPACITY, sampleIndexAtFraction } from "@/domain/sample-history";
import { AreaLayer, ScrubBand } from "@/components/metrics/area-layer";

/** A 0-100 percent reading, or `null` for a tick whose reading was not OK. */
export type CpuSample = number | null;

const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "text-success",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground/40",
  unavailable: "text-muted-foreground/40",
};

const PEAK = 97; // max amplitude; keeps the peak's edge stroke inside the viewBox
const MIN_AMPLITUDE = 1.5; // floor so a ~0% sample still draws a visible line
const AXIS_FLOOR = 20; // smallest y-axis max, so a flat-idle graph is not "maxed"

/**
 * Area graph of recent CPU usage, in the same style as the network chart:
 * a translucent fill under an edge line, rising from the bottom. Color
 * follows the metric state rather than a category.
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
  const offset = HISTORY_CAPACITY - history.length;
  const fill = FILL_BY_STATE[state];

  const axisMax = Math.max(AXIS_FLOOR, ...history.map((sample) => sample ?? 0));
  const runs = areaRuns(history, offset, (sample) => Math.max(MIN_AMPLITUDE, (sample / axisMax) * PEAK), 100, -1);

  const handleMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onScrub(sampleIndexAtFraction((event.clientX - rect.left) / rect.width, history.length));
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${HISTORY_CAPACITY} 100`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", fill)}
      role="img"
      aria-label="Recent CPU usage"
      onPointerMove={handleMove}
      onPointerLeave={() => onScrub(null)}
    >
      <AreaLayer runs={runs} />
      {scrubIndex !== null ? <ScrubBand x={offset + scrubIndex} /> : null}
    </svg>
  );
}
