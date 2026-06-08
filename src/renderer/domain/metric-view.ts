import { MetricStatus } from "@/gen/metrics";

/**
 * UI-facing types and pure derivations that sit between the generated snapshot
 * shape and the presentation components. This keeps components free of raw enum
 * checks and threshold math, and keeps that logic testable in isolation.
 *
 * Nothing here touches the OS or IPC; it only interprets values main already
 * sent.
 */

/**
 * Presentation availability of a single metric card.
 *
 * - `pending`: not yet determined (proto UNKNOWN / before the first real sample).
 * - `ok` / `elevated` / `critical`: live value, colored by usage thresholds.
 * - `unavailable`: the source was tried and could not be read reliably.
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
 * Refines an OK metric to `ok` / `elevated` / `critical` by percent used. Non-OK
 * states pass through unchanged. Thresholds follow DESIGN.md metric guidance.
 */
export function usageState(
  status: MetricStatus,
  usedPercent: number,
  elevatedAt = 70,
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
