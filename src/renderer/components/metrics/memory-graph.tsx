import { useRef } from "react";

import { cn } from "@/lib/utils";
import { scalarGraphScale } from "@/domain/graph-scale";
import {
  HISTORY_CAPACITY,
  pickedIndexAtFraction,
  sampleIndexAtFraction,
  type HistorySample,
} from "@/domain/sample-history";
import { AreaLayer, Baseline, ScrubBand } from "@/components/metrics/area-layer";

const PEAK = 88;
const BASELINE_Y = 99.5;
// Keeps tiny process footprints from drawing as a full-height graph.
const AXIS_FLOOR_BYTES = 64 * 1024 * 1024;

/** Zero-anchored memory trend for one process or group. */
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
  const { offset, runs } = scalarGraphScale(history, {
    axisFloor: AXIS_FLOOR_BYTES,
    peak: PEAK,
  });

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
