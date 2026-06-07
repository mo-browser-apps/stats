/**
 * Pure presentation formatters for metric values.
 *
 * These convert raw snapshot numbers into compact, human-readable strings for
 * the overview cards. They are intentionally side-effect free and hold no OS or
 * IPC knowledge, so they stay easy to reason about and test.
 */

/** Shown wherever a value cannot be read or has not arrived yet. */
export const UNAVAILABLE_TEXT = "Unavailable";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Formats a 0-100 percentage with a single fractional digit, e.g. `42.0%`.
 * The fixed precision keeps the string width stable across updates. Intended for
 * whole-machine gauges (CPU/memory/disk overview) that are bounded at 100%.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE_TEXT;
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped.toFixed(1)}%`;
}

/**
 * Formats a per-process CPU percentage. Uses Activity Monitor semantics, so the
 * value is NOT clamped at 100: one fully busy core is ~100% and a multi-threaded
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
 * Formats a per-second byte rate, e.g. `1.2 MB/s`. Reuses {@link formatBytes}
 * and appends `/s`.
 */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return UNAVAILABLE_TEXT;
  return `${formatBytes(bytesPerSecond)}/s`;
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

/** Two-digit zero-padded integer, for the mm/ss fields. */
function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** The centiseconds (00-99) of a fractional second, zero-padded. */
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
 * Formats a load-average triple (1/5/15 min) as `1.20 / 0.80 / 0.50`. Returns
 * unavailable text when the platform supplied no entries.
 */
export function formatLoadAverage(load: number[]): string {
  if (!load || load.length === 0) return UNAVAILABLE_TEXT;
  return load
    .slice(0, 3)
    .map((value) => (Number.isFinite(value) ? value.toFixed(2) : "?"))
    .join(" / ");
}

/**
 * Formats a snapshot epoch-millisecond timestamp as a local wall-clock time,
 * e.g. `14:05:32`, for the "updated" caption.
 */
export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return UNAVAILABLE_TEXT;
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
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
