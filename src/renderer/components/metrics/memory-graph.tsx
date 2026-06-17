import { useRef } from "react";

import { cn } from "@/lib/utils";
import { areaRuns } from "@/domain/area-path";
import {
  HISTORY_CAPACITY,
  pickedIndexAtFraction,
  sampleIndexAtFraction,
  type HistorySample,
} from "@/domain/sample-history";
import { AreaLayer, Baseline, ScrubBand } from "@/components/metrics/area-layer";

const PEAK = 88;
const BASELINE_Y = 99.5;
// Keep page-sized memory wobble from turning into a dramatic spike.
const MIN_SPAN_BYTES = 16 * 1024 * 1024;

/** Floating-axis memory trend for one process or group. */
export function MemoryGraph({
  history,
  scrubIndex,
  pinned = false,
  onScrub,
  onPick,
}: {
  history: HistorySample[];
  scrubIndex: number | null;
  pinned?: boolean;
  onScrub: (index: number | null) => void;
  /** Clicking a tick picks it (held until cleared); omit to disable picking. */
  onPick?: (index: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const offset = HISTORY_CAPACITY - history.length;

  const values = history.filter((sample): sample is number => sample !== null);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const base = Math.max(0, min - MIN_SPAN_BYTES * 0.25);
  const span = Math.max(MIN_SPAN_BYTES, max - base);
  const runs = areaRuns(history, offset, (sample) => ((sample - base) / span) * PEAK, 100, -1);

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
      className={cn("h-full w-full text-mem-app", onPick && "cursor-pointer")}
      role="img"
      aria-label="Recent memory footprint"
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
