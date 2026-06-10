import { useState } from "react";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";

/**
 * One slice of a {@link SegmentedMeter}: a byte amount and the fill class that
 * colors both its bar segment and its legend dot. `key` is a stable identity for
 * React and the bar/legend cross-highlight; `label` is the category name.
 */
export interface MeterSegment {
  key: string;
  label: string;
  bytes: number;
  /**
   * Tailwind background utility backing the segment (e.g. `bg-mem-app`). The
   * legend dot reuses the same class so color and label always agree.
   */
  fillClass: string;
}

/**
 * A composition bar plus legend: one rounded rail split into proportional
 * colored segments that sum to `totalBytes`, with a dot + label key beneath it.
 * Replaces the single-fill meter where a metric has meaningful parts rather than
 * one fraction.
 *
 * The legend is labels-only so it always fits the compact width. A segment's byte
 * value is revealed on demand: hovering a bar segment floats a small tooltip with
 * the value above the bar near the cursor, brightens and lifts that segment, and
 * highlights its legend label while the rest dim. The full composition is also
 * mirrored onto ARIA since color and width alone do not convey it.
 *
 * Segments are laid out by flex-grow weighted on bytes, so the rail always fills
 * exactly. The bar's resting height is fixed so the row never shifts.
 */
export function SegmentedMeter({
  segments,
  totalBytes,
  ariaLabel,
}: {
  segments: MeterSegment[];
  totalBytes: number;
  ariaLabel: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const drawable = total > 0 ? segments.filter((segment) => segment.bytes > 0) : [];

  const enter = (key: string) => setHovered(key);
  const leave = (key: string) => setHovered((current) => (current === key ? null : current));

  const drawableTotal = drawable.reduce((sum, segment) => sum + segment.bytes, 0) || 1;
  let runningBytes = 0;
  const centerByKey = new Map<string, number>();
  for (const segment of drawable) {
    const center = ((runningBytes + segment.bytes / 2) / drawableTotal) * 100;
    centerByKey.set(segment.key, Math.min(92, Math.max(8, center)));
    runningBytes += segment.bytes;
  }

  const hoveredSegment = drawable.find((segment) => segment.key === hovered);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div className="flex h-1 w-full items-center gap-1 bg-background" role="img" aria-label={ariaLabel}>
          {drawable.map((segment) => {
            const active = hovered === segment.key;
            return (
              <button
                key={segment.key}
                type="button"
                aria-label={`${segment.label}: ${formatBytes(segment.bytes)}`}
                className={cn(
                  "h-1 cursor-default rounded-full outline-none transition-[opacity,height]",
                  segment.fillClass,
                  active ? "h-2 opacity-100" : hovered ? "opacity-50" : "opacity-90",
                )}
                style={{ flexGrow: segment.bytes, flexBasis: 0 }}
                onPointerEnter={() => enter(segment.key)}
                onPointerLeave={() => leave(segment.key)}
                onFocus={() => enter(segment.key)}
                onBlur={() => leave(segment.key)}
              />
            );
          })}
        </div>
        <SegmentTooltip segment={hoveredSegment} centerPercent={hoveredSegment ? centerByKey.get(hoveredSegment.key) : undefined} />
      </div>
      <MeterLegend segments={drawable} hovered={hovered} onEnter={enter} onLeave={leave} />
    </div>
  );
}

/**
 * Floating value for the hovered segment, centered statically above the segment's
 * middle. Value only: the highlighted dot/segment already identifies the
 * category. Pointer-events-none so it never steals the hover.
 */
function SegmentTooltip({ segment, centerPercent }: { segment?: MeterSegment; centerPercent?: number }) {
  if (!segment || centerPercent === undefined) return null;
  return (
    <div
      className="pointer-events-none absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-popover-foreground shadow-sm"
      style={{ left: `${centerPercent}%` }}
    >
      {formatBytes(segment.bytes)}
    </div>
  );
}

/**
 * Dot + label key for the bar; labels only, so all five entries fit the compact
 * width. Hovering a legend item drives the same shared highlight as the bar (and
 * the hovered category bolds while the rest dim).
 */
function MeterLegend({
  segments,
  hovered,
  onEnter,
  onLeave,
}: {
  segments: MeterSegment[];
  hovered: string | null;
  onEnter: (key: string) => void;
  onLeave: (key: string) => void;
}) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted-foreground/85">
      {segments.map((segment) => {
        const active = hovered === segment.key;
        return (
          <button
            key={segment.key}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={cn(
              "flex shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap outline-none transition-colors",
              active ? "text-foreground" : hovered ? "text-muted-foreground/55" : "hover:text-foreground/90",
            )}
            onPointerEnter={() => onEnter(segment.key)}
            onPointerLeave={() => onLeave(segment.key)}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", segment.fillClass)} />
            <span>{segment.label}</span>
          </button>
        );
      })}
    </div>
  );
}
