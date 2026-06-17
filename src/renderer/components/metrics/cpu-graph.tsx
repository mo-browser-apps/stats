import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";
import type { MetricState } from "@/domain/metric-view";
import { areaRuns } from "@/domain/area-path";
import { HISTORY_CAPACITY, sampleIndexAtFraction, type HistorySample } from "@/domain/sample-history";
import { AreaLayer, Baseline, ScrubBand } from "@/components/metrics/area-layer";

/** A CPU percent reading, or `null` for a tick whose reading was not OK. */
export type CpuSample = HistorySample;

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
const BASELINE_Y = 99.5; // bottom axis, inset so its non-scaling stroke is not clipped by the viewBox edge

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
      <Baseline y={BASELINE_Y} offset={offset} />
      <AreaLayer runs={runs} />
      {scrubIndex !== null ? <ScrubBand x={offset + scrubIndex} /> : null}
    </svg>
  );
}
