import { Activity } from "lucide-react";

import { MetricsOverview } from "@/components/metrics-overview";

/**
 * Renderer composition root. MoStats is a dark-only compact utility: the dark
 * design tokens are applied via the `dark` class on the document root (see
 * `index.html`), and the main process fixes the native theme to dark, so there
 * is no in-app theme switch.
 *
 * The shell is a draggable title row plus the live metrics overview, which
 * subscribes to the main-process metrics stream and renders explicit
 * unavailable/pending states until real sampling lands.
 */
function App() {
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header
        className={`title-bar flex items-center px-4 ${isMac ? "title-bar-mac" : ""}`}
      >
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold">MoStats</span>
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        <MetricsOverview />
      </main>
    </div>
  );
}

export default App;
