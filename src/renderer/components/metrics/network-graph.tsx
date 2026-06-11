import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { areaRuns } from "@/domain/area-path";
import { HISTORY_CAPACITY, sampleIndexAtFraction } from "@/domain/sample-history";
import { AreaLayer, ScrubBand } from "@/components/metrics/area-layer";

/** One tick of throughput, or `null` for a tick whose reading was not OK. */
export type NetSample = { rxBytesPerSec: number; txBytesPerSec: number } | null;

const BASELINE = 50; // center y of the 0-100 viewBox
const LANE = 46; // max amplitude per direction; keeps peaks off the edges
// Smallest y-axis max (bytes/s) so idle background chatter is not drawn as a
// storm; the axis grows past it to the largest visible sample.
const AXIS_FLOOR = 100 * 1024;

/**
 * Mirrored area chart of recent network throughput: download fills upward from
 * the center baseline, upload fills downward. Both directions share one axis
 * (so their magnitudes stay comparable) with square-root amplitude scaling, so
 * a single burst does not flatten typical traffic into invisibility.
 */
export function NetworkGraph({
  history,
  scrubIndex,
  onScrub,
}: {
  history: NetSample[];
  scrubIndex: number | null;
  onScrub: (index: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const offset = HISTORY_CAPACITY - history.length;

  const axisMax = Math.max(
    AXIS_FLOOR,
    ...history.flatMap((sample) => (sample ? [sample.rxBytesPerSec, sample.txBytesPerSec] : [])),
  );
  const amplitude = (bytesPerSec: number) => Math.sqrt(Math.min(1, bytesPerSec / axisMax)) * LANE;
  const down = areaRuns(history, offset, (sample) => amplitude(sample.rxBytesPerSec), BASELINE, -1);
  const up = areaRuns(history, offset, (sample) => amplitude(sample.txBytesPerSec), BASELINE, 1);

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
      className="h-full w-full"
      role="img"
      aria-label="Recent network throughput, download above the baseline and upload below"
      onPointerMove={handleMove}
      onPointerLeave={() => onScrub(null)}
    >
      <line
        x1={0}
        y1={BASELINE}
        x2={HISTORY_CAPACITY}
        y2={BASELINE}
        className="text-muted-foreground/30"
        stroke="currentColor"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <AreaLayer runs={down} className="text-net-down" />
      <AreaLayer runs={up} className="text-net-up" />
      {scrubIndex !== null ? <ScrubBand x={offset + scrubIndex} /> : null}
    </svg>
  );
}
