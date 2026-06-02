import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Minimal Shadcn-style surface primitive. MoStats uses a single flat card per
 * metric (no nested cards per DESIGN.md), so this is just a quiet, bordered,
 * rounded container; metric-specific layout lives in the metric card component.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-border/60 bg-card/60 text-card-foreground",
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = "Card"

export { Card }
