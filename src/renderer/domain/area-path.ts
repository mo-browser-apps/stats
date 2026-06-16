/**
 * SVG area geometry for the time-series graphs: converts a sample history into
 * filled-area and edge-line path data in the graphs' shared
 * `0..capacity × 0..100` viewBox space.
 */

/** Fill + edge path data for one contiguous run of non-null samples. */
export interface AreaRun {
  fill: string;
  edge: string;
}

/**
 * Builds one run per contiguous stretch of non-null samples, splitting at
 * nulls so a failed tick reads as a gap. `amplitude` maps a sample to its
 * viewBox-unit height; the area extends from `baseline` toward `direction`
 * (-1 up, +1 down). Vertices sit at slot centers (slot width 1, starting at
 * `offset`), padded half a slot at each end so an isolated sample still has
 * visible width.
 */
export function areaRuns<T>(
  history: (T | null)[],
  offset: number,
  amplitude: (sample: T) => number,
  baseline: number,
  direction: 1 | -1,
): AreaRun[] {
  const runs: AreaRun[] = [];
  let run: { x: number; y: number }[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const points = [{ x: first.x - 0.5, y: first.y }, ...run, { x: last.x + 0.5, y: last.y }];
    runs.push({
      edge: points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" "),
      fill: `M ${points[0].x},${baseline} ${points.map((point) => `L ${point.x},${point.y}`).join(" ")} L ${points[points.length - 1].x},${baseline} Z`,
    });
    run = [];
  };

  history.forEach((sample, index) => {
    if (sample === null) {
      flush();
      return;
    }
    run.push({ x: offset + index + 0.5, y: round2(baseline + direction * amplitude(sample)) });
  });
  flush();
  return runs;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
