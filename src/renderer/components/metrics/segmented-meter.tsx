import { useState } from "react";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";

export interface MeterSegment {
  key: string;
  label: string;
  bytes: number;
  fillClass: string;
}

/**
 * A composition bar: a rail split into byte-weighted colored segments that sum to
 * `totalBytes`, with a labels-only legend. Hovering a segment (or its legend
 * item) brightens and lifts it, dims the rest, and shows its value in a tooltip
 * centered above the segment.
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

  // Center of each segment as a clamped percent of the bar, for static tooltips.
  const drawableTotal = drawable.reduce((sum, segment) => sum + segment.bytes, 0) || 1;
  let running = 0;
  const centerByKey = new Map<string, number>();
  for (const segment of drawable) {
    centerByKey.set(segment.key, Math.min(92, Math.max(8, ((running + segment.bytes / 2) / drawableTotal) * 100)));
    running += segment.bytes;
  }

  const hoveredSegment = drawable.find((segment) => segment.key === hovered);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        {/* bg-background (not a rail) so the gaps read as empty space; no clip so
            the hovered slice can lift past its resting height. */}
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
        {hoveredSegment ? <SegmentTooltip segment={hoveredSegment} centerPercent={centerByKey.get(hoveredSegment.key)!} /> : null}
      </div>
      <MeterLegend segments={drawable} hovered={hovered} onEnter={enter} onLeave={leave} />
    </div>
  );
}

function SegmentTooltip({ segment, centerPercent }: { segment: MeterSegment; centerPercent: number }) {
  return (
    <div
      className="pointer-events-none absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-popover-foreground shadow-sm"
      style={{ left: `${centerPercent}%` }}
    >
      {formatBytes(segment.bytes)}
    </div>
  );
}

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
