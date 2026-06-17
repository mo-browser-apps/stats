/**
 * Pure presentation formatters for metric values.
 */

/** Shown wherever a value cannot be read or has not arrived yet. */
export const UNAVAILABLE_TEXT = "Unavailable";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A formatted value split into numeric text and unit suffix, so the overview
 * can render the number large and the unit small and muted. `unit` is empty
 * when the input could not be formatted (`value` then carries
 * {@link UNAVAILABLE_TEXT}).
 */
export interface ValueParts {
  value: string;
  unit: string;
}

/**
 * Formats a 0-100 percentage with one fractional digit (stable width), e.g.
 * `42.0` + `%`. For whole-machine gauges bounded at 100%.
 */
export function formatPercentParts(value: number): ValueParts {
  if (!Number.isFinite(value)) return { value: UNAVAILABLE_TEXT, unit: "" };
  const clamped = Math.min(100, Math.max(0, value));
  return { value: clamped.toFixed(1), unit: "%" };
}

/**
 * Formats a per-process CPU percentage with Activity Monitor semantics: NOT
 * clamped at 100 (a multithreaded process can read e.g. `240.0%`).
 */
export function formatCpuPercent(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE_TEXT;
  return `${Math.max(0, value).toFixed(1)}%`;
}

/**
 * Two-decimal per-process CPU percentage for the detail panel, where the extra
 * digit distinguishes near-idle processes the list rounds to the same value.
 */
export function formatCpuPercentPrecise(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE_TEXT;
  return `${Math.max(0, value).toFixed(2)}%`;
}

/**
 * Formats a byte count using binary units (1024), e.g. `512 MB`, `15.6 GB`.
 * Sub-GB values stay whole; larger keep one digit. `precise` adds one more
 * digit each for the detail panel.
 */
export function formatBytes(bytes: number, precise = false): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNAVAILABLE_TEXT;
  if (bytes < 1) return "0 B";

  // Promote on the ROUNDED value: 1023.5 KB would otherwise render "1024 KB"
  // instead of promoting to "1 MB".
  let value = bytes;
  let unit = 0;
  let digits = digitsForByteUnit(0, precise);
  while (Number(value.toFixed(digits)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
    digits = digitsForByteUnit(unit, precise);
  }

  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Sub-GB values stay whole; larger keep one digit; `precise` adds one more. */
function digitsForByteUnit(unit: number, precise: boolean): number {
  const baseDigits = unit >= 3 ? 1 : 0;
  return precise ? baseDigits + 1 : baseDigits;
}

/**
 * Formats a per-second byte rate, e.g. `2.1` + `KB/s`. Unlike
 * {@link formatBytes}, the unit is promoted at 1000 (not 1024) so the numeric
 * part never exceeds three digits - a rate just under 1 KB/s reads `1.0 KB/s`
 * instead of a wide `1018 B/s`. Sub-10 values keep one decimal so a slow rate
 * still visibly moves.
 */
export function formatRateParts(bytesPerSecond: number): ValueParts {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return { value: UNAVAILABLE_TEXT, unit: "" };

  // Promote on the ROUNDED value: 999.7 would otherwise render a four-digit
  // "1000", violating the three-digit bound above.
  let value = bytesPerSecond;
  let unit = 0;
  let digits = 0;
  for (;;) {
    digits = unit > 0 && value < 10 ? 1 : 0;
    if (Number(value.toFixed(digits)) < 1000 || unit >= BYTE_UNITS.length - 1) {
      break;
    }
    value /= 1024;
    unit += 1;
  }

  return { value: value.toFixed(digits), unit: `${BYTE_UNITS[unit]}/s` };
}

/**
 * Formats an uptime in seconds as a compact duration showing the two most
 * significant non-zero units, e.g. `3d 4h`, `5h 12m`, `8m`.
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
 * Formats cumulative CPU time (nanoseconds) like Activity Monitor's "CPU
 * Time" column: `4.62s` below a minute and `40:31.84` (m:ss.cc) below an hour
 * carry centiseconds so a near-idle process still visibly advances each
 * refresh; from an hour up `1:00:05` (h:mm:ss) keeps the width bounded.
 */
export function formatCpuTime(nanos: number): string {
  if (!Number.isFinite(nanos) || nanos < 0) return UNAVAILABLE_TEXT;

  const totalSeconds = nanos / 1_000_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(Math.floor(seconds))}`;
  }
  if (minutes > 0) {
    return `${minutes}:${pad2(Math.floor(seconds))}.${centis(seconds)}`;
  }
  // Truncate like the m:ss.cc tier: toFixed would round 59.996 up to a
  // "60.00s" that belongs to the next tier.
  return `${(Math.floor(seconds * 100) / 100).toFixed(2)}s`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** The centiseconds (00-99) of a fractional second, zero-padded. */
function centis(seconds: number): string {
  return Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, "0");
}

/** Whole-degree Celsius, e.g. `48°C`, matching how macOS surfaces temperatures. */
export function formatCelsius(celsius: number): string {
  if (!Number.isFinite(celsius)) return UNAVAILABLE_TEXT;
  return `${Math.round(celsius)}°C`;
}

/**
 * Formats a process start time (Unix ms) as a compact local date and time
 * with a 24-hour clock, e.g. `Oct 29, 2025, 15:34:39`.
 */
export function formatStartTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return UNAVAILABLE_TEXT;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE_TEXT;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
