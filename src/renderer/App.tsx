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
        {/* Centered wordmark. Absolutely centered so the left traffic-light room
            and the right pin button never pull it off-center. */}
        <span className="pointer-events-none absolute inset-x-0 text-center text-[13px] font-semibold">
          MoStats
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
