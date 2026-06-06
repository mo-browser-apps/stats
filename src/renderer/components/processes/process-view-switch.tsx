import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";

/** The two top-level views in the single window. */
export type AppView = "stats" | "processes";

const VIEW_OPTIONS: ReadonlyArray<SegmentedOption<AppView>> = [
  { value: "stats", label: "Stats" },
  { value: "processes", label: "Processes" },
];

/**
 * Title-bar segmented control switching between the Stats overview and the
 * Processes explorer in the same window. Replaces the former centered wordmark
 * and live dot.
 */
export function ProcessViewSwitch({
  view,
  onChange,
}: {
  view: AppView
  onChange: (view: AppView) => void
}) {
  return (
    <SegmentedControl
      ariaLabel="Switch view"
      options={VIEW_OPTIONS}
      value={view}
      onChange={onChange}
    />
  );
}
