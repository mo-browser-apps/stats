import { useRef } from "react";

import { cn } from "@/lib/utils";
import type { MetricState } from "@/domain/metric-view";
import { areaRuns } from "@/domain/area-path";
import {
  HISTORY_CAPACITY,
  pickedIndexAtFraction,
  sampleIndexAtFraction,
  type HistorySample,
} from "@/domain/sample-history";
import { AreaLayer, Baseline, ScrubBand } from "@/components/metrics/area-layer";

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

/** Area chart of recent CPU usage, in the same style as the network chart. */
export function CpuGraph({
  history,
  scrubIndex,
  pinned = false,
  state,
  onScrub,
  onPick,
}: {
  history: CpuSample[];
  scrubIndex: number | null;
  pinned?: boolean;
  state: MetricState;
  onScrub: (index: number | null) => void;
  /** Clicking a tick picks it (held until cleared); omit to disable picking. */
  onPick?: (index: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const offset = HISTORY_CAPACITY - history.length;
  const fill = FILL_BY_STATE[state];

  const axisMax = Math.max(AXIS_FLOOR, ...history.map((sample) => sample ?? 0));
  const runs = areaRuns(history, offset, (sample) => Math.max(MIN_AMPLITUDE, (sample / axisMax) * PEAK), 100, -1);

  const fractionAt = (event: { clientX: number }): number | null => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return (event.clientX - rect.left) / rect.width;
  };
  const hoverIndex = (event: { clientX: number }): number | null => {
    const fraction = fractionAt(event);
    return fraction === null ? null : sampleIndexAtFraction(fraction, history.length);
  };
  // Off-data click returns null (resume live); hover clamps to oldest sample.
  const pickIndex = (event: { clientX: number }): number | null => {
    const fraction = fractionAt(event);
    return fraction === null ? null : pickedIndexAtFraction(fraction, history.length);
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${HISTORY_CAPACITY} 100`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", fill, onPick && "cursor-pointer")}
      role="img"
      aria-label="Recent CPU usage"
      onPointerMove={(event) => onScrub(hoverIndex(event))}
      onPointerLeave={() => onScrub(null)}
      onClick={onPick ? (event) => onPick(pickIndex(event)) : undefined}
    >
      <Baseline y={BASELINE_Y} offset={offset} />
      <AreaLayer runs={runs} />
      {scrubIndex !== null ? <ScrubBand x={offset + scrubIndex} pinned={pinned} /> : null}
    </svg>
  );
}
