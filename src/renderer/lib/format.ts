/**
 * Pure presentation formatters for metric values.
 *
 * These convert raw snapshot numbers into compact, human-readable strings for
 * the overview cards. They are intentionally side effect free and hold no OS or
 * IPC knowledge, so they stay easy to reason about and test.
 */

/**
 * Shown wherever a value cannot be read or has not arrived yet.
 */
export const UNAVAILABLE_TEXT = "Unavailable";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A formatted metric value split into its numeric text and unit suffix, so the
 * overview can render the number large and the unit small and muted. `unit` is
 * empty when the input could not be formatted (the value slot then carries
 * {@link UNAVAILABLE_TEXT}).
 */
export interface ValueParts {
  value: string;
  unit: string;
}

/**
 * Formats a 0-100 percentage with a single fractional digit, e.g. `42.0` + `%`.
 * The fixed precision keeps the string width stable across updates. Intended for
 * whole-machine gauges (CPU/memory/disk overview) that are bounded at 100%.
 */
export function formatPercentParts(value: number): ValueParts {
  if (!Number.isFinite(value)) return { value: UNAVAILABLE_TEXT, unit: "" };
  const clamped = Math.min(100, Math.max(0, value));
  return { value: clamped.toFixed(1), unit: "%" };
}

/**
 * Formats a per-process CPU percentage. Uses Activity Monitor semantics, so the
 * value is NOT clamped at 100: one fully busy core is ~100% and a multithreaded
 * process can read higher (e.g. `240.0%`). Negative noise is floored at 0.
 */
export function formatCpuPercent(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE_TEXT;
  return `${Math.max(0, value).toFixed(1)}%`;
}

/**
 * Formats a per-process CPU percentage with two decimals, e.g. `13.04%`. Used in
 * the detail panel, where the extra digit helps distinguish near-idle processes
 * that the list's single-decimal format rounds to the same value.
 */
export function formatCpuPercentPrecise(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE_TEXT;
  return `${Math.max(0, value).toFixed(2)}%`;
}

/**
 * Formats a byte count using binary units (1024) with adaptive precision, e.g.
 * `512 MB`, `15.6 GB`. Sub-GB values stay whole; larger values keep one digit.
 * Pass `precise` for one extra decimal (`512.4 MB`, `15.63 GB`) in the detail
 * panel, where the finer figure is useful.
 */
export function formatBytes(bytes: number, precise = false): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNAVAILABLE_TEXT;
  if (bytes < 1) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // One decimal from GB up, whole below; `precise` adds one more digit each.
  const baseDigits = unit >= 3 ? 1 : 0;
  const digits = precise ? baseDigits + 1 : baseDigits;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * Formats a per-second byte rate split into number and unit, e.g. `2.1` +
 * `KB/s`. Unlike {@link formatBytes}, the unit is promoted at 1000 (not 1024),
 * so the numeric part never exceeds three digits — a rate hovering just under
 * 1 KB/s reads `1.0 KB/s` instead of a wide `1018 B/s`. Sub-10 values keep one
 * decimal so a slow rate still visibly moves; larger values stay whole.
 */
export function formatRateParts(bytesPerSecond: number): ValueParts {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return { value: UNAVAILABLE_TEXT, unit: "" };

  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit > 0 && value < 10 ? 1 : 0;
  return { value: value.toFixed(digits), unit: `${BYTE_UNITS[unit]}/s` };
}

/**
 * Formats a per-second byte rate as one string, e.g. `2.1 KB/s`. Joins
 * {@link formatRateParts} for places that render the rate at a single size
 * (the Network row's up-rate detail line).
 */
export function formatRate(bytesPerSecond: number): string {
  const parts = formatRateParts(bytesPerSecond);
  return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/**
 * Formats an uptime in seconds as a compact duration, e.g. `3d 4h`, `5h 12m`,
 * `8m`. Only the two most significant non-zero units are shown to stay compact.
 */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNAVAILABLE_TEXT;

  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/**
 * Formats the 1/5/15-minute load averages as `3.4 / 2.9 / 2.1` (the order `top`
 * and `uptime` use, newest first), each to one decimal. Trailing missing entries
 * are skipped, so a platform that reports fewer values still renders cleanly.
 * Returns `undefined` when no finite entry exists, letting the caller omit the
 * line rather than show an empty or broken string.
 */
export function formatLoadAverage(loadAverage: readonly number[] | undefined): string | undefined {
  if (!loadAverage) return undefined;
  const parts = loadAverage.slice(0, 3).filter((value) => Number.isFinite(value));
  if (parts.length === 0) return undefined;
  return parts.map((value) => value.toFixed(1)).join(" / ");
}

/**
 * Formats a cumulative CPU time given in nanoseconds as a compact duration,
 * matching Activity Monitor's "CPU Time" column: `4.62s` below a minute and
 * `40:31.84` (m:ss.cc) below an hour both carry centiseconds, so the value
 * visibly advances on each refresh even when a near-idle process only accrues a
 * few milliseconds per tick. From an hour up it is `1:00:05` (h:mm:ss) without
 * centiseconds - it still ticks every second and keeps the width bounded.
 * Tabular figures (applied where it is rendered) keep the width stable as the
 * value changes.
 */
export function formatCpuTime(nanos: number): string {
  if (!Number.isFinite(nanos) || nanos < 0) return UNAVAILABLE_TEXT;

  const totalSeconds = nanos / 1_000_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const wholeSeconds = Math.floor(seconds);
    return `${hours}:${pad2(minutes)}:${pad2(wholeSeconds)}`;
  }
  if (minutes > 0) {
    // m:ss.cc - centiseconds keep the value visibly ticking each refresh.
    return `${minutes}:${pad2(Math.floor(seconds))}.${centis(seconds)}`;
  }
  return `${seconds.toFixed(2)}s`;
}

/**
 * Two-digit zero-padded integer, for the mm/ss fields.
 */
function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * The centiseconds (00-99) of a fractional second, zero-padded.
 */
function centis(seconds: number): string {
  return Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, "0");
}

/**
 * Formats a CPU temperature in Celsius, e.g. `48°C`. Whole degrees keep the
 * width stable and match how macOS surfaces temperatures.
 */
export function formatCelsius(celsius: number): string {
  if (!Number.isFinite(celsius)) return UNAVAILABLE_TEXT;
  return `${Math.round(celsius)}°C`;
}

/**
 * Formats a process start time (Unix milliseconds) as a local date and time,
 * e.g. `Oct 29, 2025, 15:34:39`, for the detail view's "Started" line. Uses the
 * locale's medium date with a 24-hour clock so the string stays compact and
 * stable.
 */
export function formatStartTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return UNAVAILABLE_TEXT;
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
