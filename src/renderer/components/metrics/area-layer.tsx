import type { AreaRun } from "@/domain/area-path";

/**
 * Shared SVG layers for the time-series graphs (CPU, network). The graphs draw
 * in a `0..capacity × 0..100` viewBox stretched to the row
 * (`preserveAspectRatio="none"`), so strokes opt out of scaling.
 */

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
