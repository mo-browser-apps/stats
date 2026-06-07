import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A horizontally scrollable lane that fades the edge(s) with hidden content, so a
 * value that runs past the compact window width reads as scrollable rather than
 * simply clipped. Used by the detail header (name / metadata) and the inline
 * Path / Command line values.
 *
 * The scrollbar stays hidden (wheel/trackpad still scroll) to match the compact
 * panel's other scroll regions.
 */
export function ScrollFade({
  children,
  className,
  title,
}: {
  children: ReactNode
  className?: string
  /** Native tooltip for the full value, since the visible text may be clipped. */
  title?: string
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fadeStart, setFadeStart] = useState(false);
  const [fadeEnd, setFadeEnd] = useState(false);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // A 1px slack absorbs sub-pixel rounding so a fully-scrolled or non-overflowing
    // lane does not flicker a hairline fade.
    const maxScroll = element.scrollWidth - element.clientWidth;
    setFadeStart(element.scrollLeft > 1);
    setFadeEnd(element.scrollLeft < maxScroll - 1);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Observe the content too: its width drives overflow when the lane width is fixed.
    if (element.firstElementChild) {
      observer.observe(element.firstElementChild);
    }
    return () => observer.disconnect();
  }, [measure]);

  const fade = fadeStart && fadeEnd ? "both" : fadeStart ? "start" : fadeEnd ? "end" : undefined;

  return (
    <div
      ref={ref}
      onScroll={measure}
      title={title}
      data-fade={fade}
      className={cn("scroll-fade scrollbar-hidden min-w-0 overflow-x-auto", className)}
    >
      {children}
    </div>
  );
}
