import { type ReactNode, useEffect, useState } from "react";
import { Pin } from "lucide-react";

import { MetricsOverview } from "@/components/metrics/metrics-overview";
import { Button } from "@/components/ui/button";
import { appGateway } from "@/gateway/app-gateway";
import { ActiveView } from "@/gen/app";
import { cn } from "@/lib/utils";
import { ProcessExplorerView } from "@/components/processes/process-explorer-view";
import { ProcessViewSwitch, type AppView } from "@/components/processes/process-view-switch";

/**
 * Maps the renderer view vocabulary onto the generated active-view enum.
 */
const ACTIVE_VIEW_BY_VIEW: Record<AppView, ActiveView> = {
  stats: ActiveView.ACTIVE_VIEW_STATS,
  processes: ActiveView.ACTIVE_VIEW_PROCESSES,
};

/**
 * Renderer composition root. Owns the top-level view switch (Stats vs
 * Processes) and reports the active view to main. Each view owns its own data
 * lifecycle while mounted, so this root holds no metric/process state.
 */
function App() {
  const isMac = navigator.userAgent.includes("Mac");
  const [view, setView] = useState<AppView>("stats");

  useEffect(() => {
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
        <ViewPane active={view === "stats"}>
          <MetricsOverview active={view === "stats"} />
        </ViewPane>
        <ViewPane active={view === "processes"}>
          <ProcessExplorerView active={view === "processes"} />
        </ViewPane>
      </main>
    </div>
  );
}

/**
 * Wraps one top-level view, keeping it mounted but hidden when inactive so its
 * state survives tab switches without a remount flicker.
 */
function ViewPane({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={cn("flex-1 flex-col overflow-hidden", active ? "flex" : "hidden")}>{children}</div>;
}

/**
 * Title-bar "pin on top" toggle, keeping the window above others. The visual
 * state changes only after the typed IPC command succeeds.
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
