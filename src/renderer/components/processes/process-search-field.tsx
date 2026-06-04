import { Search, X } from "lucide-react"

/**
 * Compact search field above the process list. Matches process/app name, PID,
 * executable path, bundle id, and command-line arguments (the matching itself
 * lives in the pure projection). Fixed height with a clear affordance; no
 * instructional copy beyond the placeholder.
 */
export function ProcessSearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="no-drag relative flex h-9 min-w-0 flex-1 items-center">
      <Search
        className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search processes"
        aria-label="Search processes"
        spellCheck={false}
        autoComplete="off"
        className="h-full w-full rounded-lg border border-border bg-muted/40 pl-9 pr-8 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-2 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
