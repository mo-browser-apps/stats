/**
 * Pure helpers shared by the time-series metric graphs (CPU, network): a
 * fixed-capacity ring buffer of recent samples and the geometry to scrub them.
 * A `null` sample marks a tick whose reading was not OK (drawn as a gap, not a
 * fake 0).
 */

export const HISTORY_CAPACITY = 60;

/** Appends `sample`, keeping at most `capacity` newest entries (oldest dropped). */
export function pushSample<T>(history: T[], sample: T, capacity = HISTORY_CAPACITY): T[] {
  const next = [...history, sample];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * History-array index of the sample under a pointer at `fraction` (0 left, 1
 * right) of the graph. Samples are right-aligned in a `capacity`-wide track;
 * a cursor over the still-empty left part of the track clamps to the oldest
 * sample (index 0), so scrubbing never dead-zones. Returns null only when
 * there is no history yet.
 */
export function sampleIndexAtFraction(fraction: number, filled: number, capacity = HISTORY_CAPACITY): number | null {
  if (filled <= 0) return null;
  // Math.max also normalizes the -0 that Math.round(-0.5) yields at the left edge.
  const slot = Math.max(0, Math.round(Math.min(1, Math.max(0, fraction)) * capacity - 0.5));
  const firstFilled = capacity - filled;
  if (slot < firstFilled) return 0;
  return Math.min(filled - 1, slot - firstFilled);
}
