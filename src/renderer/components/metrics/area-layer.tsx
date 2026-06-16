import type { AreaRun } from "@/domain/area-path";
import { HISTORY_CAPACITY } from "@/domain/sample-history";

/**
 * Shared SVG layers for the time-series graphs (CPU, network). The graphs draw
 * in a `0..capacity × 0..100` viewBox stretched to the row
 * (`preserveAspectRatio="none"`), so strokes opt out of scaling.
 */

/**
 * Axis baseline split at the first filled history slot: dashed over the
 * still-unobserved left region (so a warming-up graph reads as "recording
 * started here", not as broken), solid under the observed slots. `offset` is
 * the first filled slot index (HISTORY_CAPACITY when the history is empty).
 */
export function Baseline({ y, offset }: { y: number; offset: number }) {
  return (
    <g className="text-muted-foreground/30" stroke="currentColor" strokeWidth={1}>
      {offset > 0 ? (
        <line x1={0} y1={y} x2={offset} y2={y} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      ) : null}
      {offset < HISTORY_CAPACITY ? (
        <line x1={offset} y1={y} x2={HISTORY_CAPACITY} y2={y} vectorEffect="non-scaling-stroke" />
      ) : null}
    </g>
  );
}

/** Area runs as a translucent fill under a brighter edge line, in currentColor. */
export function AreaLayer({ runs, className }: { runs: AreaRun[]; className?: string }) {
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

/** Full-height highlight band over the scrubbed history slot. */
export function ScrubBand({ x }: { x: number }) {
  return <rect x={x} y={0} width={1} height={100} className="text-foreground" fill="currentColor" fillOpacity={0.12} />;
}
