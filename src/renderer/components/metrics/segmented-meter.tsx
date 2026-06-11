import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { MeterTooltip } from "@/components/metrics/metric-row-header";

export interface MeterSegment {
  key: string;
  label: string;
  bytes: number;
  fillClass: string;
}

/**
 * A composition bar: a rail split into byte-weighted colored segments that sum
 * to `totalBytes`, with a labels-only legend. Hovering a segment (or its
 * legend item) brightens and lifts it, dims the rest, and shows its value in a
 * tooltip centered above the segment.
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
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [tooltipLeft, setTooltipLeft] = useState(50);
  const barRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef(new Map<string, HTMLButtonElement>());
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const drawable = total > 0 ? segments.filter((segment) => segment.bytes > 0) : [];

  const enter = (key: string) => setHoveredKey(key);
  const leave = (key: string) => setHoveredKey((current) => (current === key ? null : current));

  // A segment can unmount mid-hover (its bytes dropping to 0 on a tick), with
  // no pointerleave to clear the state; resolve against the current list so
  // the rest of the bar never stays dimmed for a ghost.
  const hovered = drawable.some((segment) => segment.key === hoveredKey) ? hoveredKey : null;
  const hoveredSegment = drawable.find((segment) => segment.key === hovered);

  // Tooltip x from the rendered segment, not its byte share: the gaps and the
  // min-width floor shift real positions, most visibly for tiny segments.
  useLayoutEffect(() => {
    if (hovered === null) return;
    const bar = barRef.current;
    const segment = segmentRefs.current.get(hovered);
    if (!bar || !segment || bar.offsetWidth === 0) return;
    setTooltipLeft(((segment.offsetLeft + segment.offsetWidth / 2) / bar.offsetWidth) * 100);
  }, [hovered, segments]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        {/* bg-background (not a rail) so the gaps read as empty space; no clip so
            the hovered slice can lift past its resting height. */}
        <div ref={barRef} className="flex h-1 w-full items-center gap-1 bg-background" role="img" aria-label={ariaLabel}>
          {drawable.map((segment) => {
            const active = hovered === segment.key;
            return (
              <button
                key={segment.key}
                ref={(element) => {
                  if (element) segmentRefs.current.set(segment.key, element);
                  else segmentRefs.current.delete(segment.key);
                }}
                type="button"
                aria-label={`${segment.label}: ${formatBytes(segment.bytes)}`}
                className={cn(
                  "h-1 min-w-1.5 cursor-default rounded-full outline-none transition-[opacity,height]",
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
        {hoveredSegment ? (
          <MeterTooltip leftPercent={tooltipLeft} className="-top-6">
            {formatBytes(hoveredSegment.bytes)}
          </MeterTooltip>
        ) : null}
      </div>
      <MeterLegend segments={drawable} hovered={hovered} onEnter={enter} onLeave={leave} />
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
