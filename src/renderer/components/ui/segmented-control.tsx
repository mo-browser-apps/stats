import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * One option in a {@link SegmentedControl}.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Disabled options stay visible but unselectable (e.g. an unsupported sort). */
  disabled?: boolean;
  /** Tooltip, used to explain a disabled option's reason. */
  title?: string;
}

/**
 * One segment's classes. The active segment gets a subtle elevated surface
 * rather than a loud accent pill (DESIGN.md); `disabled` dims and freezes hover.
 */
const segment = cva("rounded-md font-medium transition-colors", {
  variants: {
    size: {
      sm: "px-2.5 py-1 text-[11px]",
      md: "px-3 py-1 text-[12px]",
    },
    selected: {
      true: "bg-accent text-foreground shadow-sm",
      false: "text-muted-foreground hover:text-foreground",
    },
    disabled: {
      true: "cursor-not-allowed opacity-40 hover:text-muted-foreground",
      false: "",
    },
  },
  defaultVariants: {
    size: "md",
    selected: false,
    disabled: false,
  },
});

/**
 * Compact macOS-style segmented control: a quiet track with a subtle elevated
 * surface marking the active segment (not a loud accent pill, per DESIGN.md).
 * Used for the title-bar Stats/Processes switch and the list CPU/Memory sort.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "no-drag inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={option.disabled}
            title={option.title}
            onClick={() => !option.disabled && onChange(option.value)}
            className={segment({ size, selected, disabled: option.disabled ?? false })}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
