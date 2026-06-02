import { useState } from "react";
import { Pin } from "lucide-react";

import { MetricsOverview } from "@/components/metrics-overview";
import { Button } from "@/components/ui/button";
import { appGateway } from "@/gateway/app-gateway";
import { cn } from "@/lib/utils";

/**
 * Renderer composition root.
 */
function App() {
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className={cn("title-bar relative flex items-center pr-2", isMac && "title-bar-mac")}>
        <span className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2 text-[13px] font-semibold">
          MoStats
          <LiveDot />
        </span>
        <PinToggle />
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        <MetricsOverview />
      </main>
    </div>
  );
}

/**
 * Small "live" beacon next to the wordmark: a green dot that gently pulses,
 * signaling the metrics stream is updating.
 */
function LiveDot() {
  return (
    <span
      className="h-1 w-1 animate-pulse rounded-full bg-success shadow-[0_0_6px_var(--success)]"
      aria-label="Live"
      title="Live"
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
