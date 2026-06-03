import { useEffect, useState } from "react";
import { Pin } from "lucide-react";

import { MetricsOverview } from "@/components/metrics-overview";
import { Button } from "@/components/ui/button";
import { appGateway } from "@/gateway/app-gateway";
import { metricsGateway } from "@/gateway/metrics-gateway";
import { ActiveView } from "@/gen/app";
import type { MetricsSnapshot } from "@/gen/metrics";
import { cn } from "@/lib/utils";
import { ProcessExplorerView } from "@/processes/process-explorer-view";
import { ProcessViewSwitch, type AppView } from "@/processes/process-view-switch";

/** Maps the renderer view vocabulary onto the generated active-view enum. */
const ACTIVE_VIEW_BY_VIEW: Record<AppView, ActiveView> = {
  stats: ActiveView.ACTIVE_VIEW_STATS,
  processes: ActiveView.ACTIVE_VIEW_PROCESSES,
};

/**
 * Renderer composition root.
 *
 * Owns the top-level view switch (Stats overview vs Processes explorer) inside
 * the single window, plus the always-on metrics-stream subscription that feeds
 * the overview. The process explorer owns its own data lifecycle while it is
 * mounted, so it is rendered only on the Processes view.
 */
function App() {
  const isMac = navigator.userAgent.includes("Mac");
  const [view, setView] = useState<AppView>("stats");
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    // One subscription per mount; the returned unsubscribe is the cleanup. Main
    // gates the metrics cadence on visibility + active view, so the latest
    // snapshot may be a moment stale after returning to Stats; it refreshes on
    // the next tick.
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null));
  }, []);

  useEffect(() => {
    // Report the on-screen view so main runs only the visible view's service
    // (metrics on Stats, process collection on Processes) and neither while the
    // window is hidden. Fire-and-forget; main re-evaluates on window visibility.
    void appGateway.setActiveView(ACTIVE_VIEW_BY_VIEW[view]);
  }, [view]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className={cn("title-bar relative flex items-center pr-2", isMac && "title-bar-mac")}>
        <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <ProcessViewSwitch view={view} onChange={setView} />
          </div>
        </div>
        <PinToggle />
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        {view === "stats" ? <MetricsOverview snapshot={snapshot} /> : <ProcessExplorerView />}
      </main>
    </div>
  );
}

/**
 * Title-bar "pin on top" toggle. Keeps the compact monitor above other windows
 * so it stays visible while working elsewhere. The visual state changes only
 * after the typed IPC command succeeds.
 */
function PinToggle() {
  const [pinned, setPinned] = useState(false);
  const [pending, setPending] = useState(false);

  function toggle() {
    if (pending) return;

    const next = !pinned;
    setPending(true);
    void appGateway.setAlwaysOnTop(next)
      .then(() => setPinned(next))
      .catch(() => undefined)
      .finally(() => setPending(false));
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      disabled={pending}
      aria-label={pinned ? "Unpin from top" : "Pin on top"}
      aria-pressed={pinned}
      title={pinned ? "Unpin from top" : "Keep on top"}
      className={cn(
        "ml-auto h-7 w-7",
        pinned ? "text-foreground hover:text-foreground" : "text-muted-foreground",
      )}
    >
      <Pin
        className={cn(
          "h-4 w-4 transition-transform duration-150",
          pinned ? "rotate-45 fill-current" : "rotate-0",
        )}
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </Button>
  );
}

export default App;
