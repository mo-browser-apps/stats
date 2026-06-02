import { useEffect, useState } from "react";
import { Pin } from "lucide-react";

import { MetricsOverview } from "@/components/metrics-overview";
import { Button } from "@/components/ui/button";
import { appGateway } from "@/gateway/app-gateway";
import { metricsGateway } from "@/gateway/metrics-gateway";
import type { MetricsSnapshot } from "@/gen/metrics";
import { cn } from "@/lib/utils";

/**
 * Renderer composition root.
 */
function App() {
  const isMac = navigator.userAgent.includes("Mac");
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    // One subscription per mount; the returned unsubscribe is the cleanup.
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null));
  }, []);

  const live = snapshot !== null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className={cn("title-bar relative flex items-center pr-2", isMac && "title-bar-mac")}>
        <span className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2 text-[13px] font-semibold">
          MoStats
          <LiveDot live={live} />
        </span>
        <PinToggle />
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        <MetricsOverview snapshot={snapshot} />
      </main>
    </div>
  );
}

/**
 * Header status beacon next to the wordmark. When the metrics stream is
 * delivering snapshots it is a green dot that gently pulses; when no data is
 * arriving (startup or a dropped stream) it goes quiet and static.
 */
function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={cn(
        "h-1 w-1 rounded-full",
        live
          ? "animate-pulse bg-success shadow-[0_0_6px_var(--success)]"
          : "bg-muted-foreground/60",
      )}
      aria-label={live ? "Live" : "Offline"}
      title={live ? "Live" : "Offline"}
    />
  );
}

/**
 * Title-bar "pin on top" toggle. Keeps the compact monitor above other windows
 * so it stays visible while working elsewhere. Local state drives the visual,
 * and the main process applies the actual window flag over typed IPC.
 */
function PinToggle() {
  const [pinned, setPinned] = useState(false);

  function toggle() {
    const next = !pinned;
    setPinned(next);
    void appGateway.setAlwaysOnTop(next);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
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
