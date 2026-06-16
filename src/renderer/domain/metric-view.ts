import { MetricStatus } from "@/gen/metrics";
import { UNAVAILABLE_TEXT } from "@/lib/format";

/**
 * Pure derivations between the generated snapshot shape and the presentation
 * components, keeping raw enum checks and threshold math out of the JSX.
 */

/**
 * Presentation availability of a metric: `pending` is not yet determined,
 * `ok`/`elevated`/`critical` is a live value colored by usage thresholds,
 * `unavailable` was tried and could not be read.
 */
export type MetricState = "pending" | "ok" | "elevated" | "critical" | "unavailable";

/** Maps the generated {@link MetricStatus} enum to a base presentation state. */
export function baseState(status: MetricStatus): MetricState {
  switch (status) {
    case MetricStatus.METRIC_STATUS_OK:
      return "ok";
    case MetricStatus.METRIC_STATUS_UNAVAILABLE:
      return "unavailable";
    default:
      // UNKNOWN and UNRECOGNIZED both read as "not yet determined".
      return "pending";
  }
}

/**
 * Refines an OK metric to `ok` / `elevated` / `critical` by percent used;
 * non-OK states pass through unchanged.
 */
export function usageState(
  status: MetricStatus,
  usedPercent: number,
  elevatedAt = 75,
  criticalAt = 90,
): MetricState {
  const base = baseState(status);
  if (base !== "ok") return base;
  if (!Number.isFinite(usedPercent)) return "unavailable";
  if (usedPercent >= criticalAt) return "critical";
  if (usedPercent >= elevatedAt) return "elevated";
  return "ok";
}

/** Whether a state has a live, meaningful value to display. */
export function isLive(state: MetricState): boolean {
  return state === "ok" || state === "elevated" || state === "critical";
}

/** The formatted text when live, else the pending/unavailable placeholder. */
export function displayText(state: MetricState, text: string): string {
  if (isLive(state)) return text;
  return state === "pending" ? "--" : UNAVAILABLE_TEXT;
}
