import { areaRuns, type AreaRun } from "@/domain/area-path";
import { HISTORY_CAPACITY, type HistorySample } from "@/domain/sample-history";

export interface NetworkThroughputSample {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

interface ScalarGraphScaleOptions {
  /** Smallest top of the zero-anchored y-axis. */
  axisFloor: number;
  /** ViewBox units used by the largest sample. */
  peak: number;
  /** Optional visible floor for non-zero samples. */
  minAmplitude?: number;
  /** Area fill baseline in the graph viewBox. */
  baseline?: number;
  direction?: 1 | -1;
  capacity?: number;
}

interface ScalarGraphScale {
  offset: number;
  runs: AreaRun[];
}

interface NetworkGraphScaleOptions {
  /** Smallest top of the shared zero-anchored throughput axis. */
  axisFloor: number;
  /** ViewBox units available above/below the mirrored baseline. */
  lane: number;
  baseline?: number;
  capacity?: number;
}

interface NetworkGraphScale {
  offset: number;
  down: AreaRun[];
  up: AreaRun[];
}

/** Largest visible sample with a zero-anchored floor. */
function scalarAxisMax(history: HistorySample[], floor: number): number {
  const max = history.reduce<number>(
    (peak, sample) => (sample === null || !Number.isFinite(sample) || sample <= 0 ? peak : Math.max(peak, sample)),
    0,
  );
  return Math.max(floor, max);
}

/** Maps a scalar sample onto a zero-anchored 0..1 graph domain. */
function scalarGraphRatio(value: number, axisMax: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(axisMax) || value <= 0 || axisMax <= 0) return 0;
  return Math.min(1, value / axisMax);
}

/** ViewBox-height amplitude for one zero-anchored scalar sample. */
function scalarGraphAmplitude(value: number, axisMax: number, peak: number, minAmplitude = 0): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const amplitude = scalarGraphRatio(value, axisMax) * peak;
  return minAmplitude > 0 ? Math.max(minAmplitude, amplitude) : amplitude;
}

/** Shared zero-anchored area graph geometry for scalar CPU/memory histories. */
export function scalarGraphScale(
  history: HistorySample[],
  {
    axisFloor,
    peak,
    minAmplitude = 0,
    baseline = 100,
    direction = -1,
    capacity = HISTORY_CAPACITY,
  }: ScalarGraphScaleOptions,
): ScalarGraphScale {
  const axisMax = scalarAxisMax(history, axisFloor);
  const offset = capacity - history.length;
  const runs = areaRuns(
    history,
    offset,
    (sample) => scalarGraphAmplitude(sample, axisMax, peak, minAmplitude),
    baseline,
    direction,
  );

  return { offset, runs };
}

/** Shared rx/tx throughput axis so both network directions stay comparable. */
function networkAxisMax(history: (NetworkThroughputSample | null)[], floor: number): number {
  const max = history.reduce<number>((peak, sample) => {
    if (sample === null) return peak;
    return Math.max(peak, positiveFinite(sample.rxBytesPerSec), positiveFinite(sample.txBytesPerSec));
  }, 0);
  return Math.max(floor, max);
}

/** Square-root compression keeps bursts visible without flattening routine traffic. */
function networkGraphAmplitude(bytesPerSec: number, axisMax: number, lane: number): number {
  return Math.sqrt(scalarGraphRatio(bytesPerSec, axisMax)) * lane;
}

/** Mirrored zero-anchored geometry for network download/upload histories. */
export function networkGraphScale(
  history: (NetworkThroughputSample | null)[],
  { axisFloor, lane, baseline = 50, capacity = HISTORY_CAPACITY }: NetworkGraphScaleOptions,
): NetworkGraphScale {
  const axisMax = networkAxisMax(history, axisFloor);
  const offset = capacity - history.length;

  return {
    offset,
    down: areaRuns(history, offset, (sample) => networkGraphAmplitude(sample.rxBytesPerSec, axisMax, lane), baseline, -1),
    up: areaRuns(history, offset, (sample) => networkGraphAmplitude(sample.txBytesPerSec, axisMax, lane), baseline, 1),
  };
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
