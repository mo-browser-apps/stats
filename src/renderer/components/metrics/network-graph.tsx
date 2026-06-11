import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { HISTORY_CAPACITY, sampleIndexAtFraction } from "@/domain/sample-history";

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
  const down = laneRuns(history, offset, (sample) => sample.rxBytesPerSec, axisMax, -1);
  const up = laneRuns(history, offset, (sample) => sample.txBytesPerSec, axisMax, 1);

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
      <Lane runs={down} className="text-net-down" />
      <Lane runs={up} className="text-net-up" />
      {scrubIndex !== null ? (
        <rect
          x={offset + scrubIndex}
          y={0}
          width={1}
          height={100}
          className="text-foreground"
          fill="currentColor"
          fillOpacity={0.12}
        />
      ) : null}
    </svg>
  );
}

/** Fill + edge path data for one contiguous run of non-null samples. */
interface LaneRun {
  fill: string;
  edge: string;
}

/**
 * Converts one direction's history into area paths, splitting at null samples
 * so a failed tick reads as a gap. Vertices sit at slot centers, padded half a
 * slot at each end so an isolated sample still has visible width.
 */
function laneRuns(
  history: NetSample[],
  offset: number,
  rate: (sample: NonNullable<NetSample>) => number,
  axisMax: number,
  direction: 1 | -1,
): LaneRun[] {
  const runs: LaneRun[] = [];
  let run: { x: number; y: number }[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const points = [{ x: first.x - 0.5, y: first.y }, ...run, { x: last.x + 0.5, y: last.y }];
    const edge = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ");
    runs.push({
      edge,
      fill: `M ${points[0].x},${BASELINE} ${points.map((point) => `L ${point.x},${point.y}`).join(" ")} L ${points[points.length - 1].x},${BASELINE} Z`,
    });
    run = [];
  };

  history.forEach((sample, index) => {
    if (sample === null) {
      flush();
      return;
    }
    const amplitude = Math.sqrt(Math.min(1, rate(sample) / axisMax)) * LANE;
    run.push({ x: offset + index + 0.5, y: round2(BASELINE + direction * amplitude) });
  });
  flush();
  return runs;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function Lane({ runs, className }: { runs: LaneRun[]; className: string }) {
  return (
    <g className={className}>
      {runs.map((run, index) => (
        <g key={index}>
          <path d={run.fill} fill="currentColor" fillOpacity={0.3} />
          <path
            d={run.edge}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeOpacity={0.9}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </g>
  );
}
