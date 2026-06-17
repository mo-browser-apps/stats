import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { areaRuns } from "@/domain/area-path";
import { HISTORY_CAPACITY, sampleIndexAtFraction, type HistorySample } from "@/domain/sample-history";
import { AreaLayer, Baseline, ScrubBand } from "@/components/metrics/area-layer";

const PEAK = 88;
const BASELINE_Y = 99.5;
// Keep page-sized memory wobble from turning into a dramatic spike.
const MIN_SPAN_BYTES = 16 * 1024 * 1024;

/** Floating-axis memory trend for one process or group. */
export function MemoryGraph({
  history,
  scrubIndex,
  onScrub,
}: {
  history: HistorySample[];
  scrubIndex: number | null;
  onScrub: (index: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const offset = HISTORY_CAPACITY - history.length;

  const values = history.filter((sample): sample is number => sample !== null);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const base = Math.max(0, min - MIN_SPAN_BYTES * 0.25);
  const span = Math.max(MIN_SPAN_BYTES, max - base);
  const runs = areaRuns(history, offset, (sample) => ((sample - base) / span) * PEAK, 100, -1);

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
      className="h-full w-full text-mem-app"
      role="img"
      aria-label="Recent memory footprint"
      onPointerMove={handleMove}
      onPointerLeave={() => onScrub(null)}
    >
      <Baseline y={BASELINE_Y} offset={offset} />
      <AreaLayer runs={runs} />
      {scrubIndex !== null ? <ScrubBand x={offset + scrubIndex} /> : null}
    </svg>
  );
}
