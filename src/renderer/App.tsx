import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { ipc } from "@/gen/ipc";
import { Sun, Moon, Monitor, Activity } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MetricsOverview } from "@/components/metrics-overview";

/**
 * Renderer composition root. Dark is the primary design target for the compact
 * utility, so the shell defaults to dark.
 */
function App() {
  return (
    <ThemeProvider defaultTheme="dark">
      <AppShell />
    </ThemeProvider>
  );
}

/**
 * Compact application shell: a draggable title row plus the live metrics
 * overview. The overview subscribes to the main-process metrics stream and
 * renders explicit unavailable/pending states until real sampling lands.
 */
function AppShell() {
  const { theme, setTheme } = useTheme();
  const isMac = navigator.userAgent.includes("Mac");

  function setAppTheme(newTheme: "light" | "dark" | "system") {
    ipc.app.SetTheme({ theme: newTheme }).then(() => setTheme(newTheme));
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header
        className={`title-bar flex items-center justify-between px-4 ${isMac ? "title-bar-mac" : ""}`}
      >
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold">MoStats</span>
        </div>
        <ThemeToggle theme={theme} onChange={setAppTheme} />
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        <MetricsOverview />
      </main>
    </div>
  );
}

/**
 * Compact light/system/dark theme switch for the title row.
 */
function ThemeToggle({
  theme,
  onChange,
}: {
  theme: string;
  onChange: (theme: "light" | "dark" | "system") => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(value) => {
        if (value) onChange(value as "light" | "dark" | "system");
      }}
      className="no-drag gap-0.5"
    >
      <ToggleGroupItem value="light" aria-label="Light theme" className="h-6 w-6 min-w-0 p-0">
        <Sun className="h-3 w-3" />
      </ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="System theme" className="h-6 w-6 min-w-0 p-0">
        <Monitor className="h-3 w-3" />
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark theme" className="h-6 w-6 min-w-0 p-0">
        <Moon className="h-3 w-3" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export default App;
