import process from "node:process";
import { app, clipboard, desktop, ipc } from "@mobrowser/api";
import { ApplicationWindow } from "./application-window";
import { TrayController } from "./tray-controller";
import { buildApplicationMenu } from "./application-menu";
import { MetricsService } from "./metrics/metrics-service";
import { ProcessExplorerService } from "./processes/process-explorer-service";
import { ActiveView, CopyTextRequest, SetActiveViewRequest, SetAlwaysOnTopRequest } from "./gen/app";
import { AppServiceDescriptor } from "./gen/ipc_service";
import { DISPLAY_NAME } from "./branding";

/** Opened from the About dialog's button. */
const REPOSITORY_URL = "https://github.com/mo-browser-apps/stats";

/**
 * Composition root for the main process: the single compact window, the
 * menu-bar tray, lifecycle wiring, and the renderer-facing IPC services.
 *
 * The window hides instead of closing, so the app keeps running in the tray.
 * Per-view background work is gated on window visibility plus the active view
 * (combined in {@link updateServiceActivation}), so exactly the on-screen
 * view's service runs and neither while hidden - keeping the process
 * collector's sensitive command-line reads off until the user is on the
 * Processes view.
 */
export class Application {
  private readonly window = new ApplicationWindow(() => {
    this.handleWindowVisibilityChange();
  });

  private readonly tray = new TrayController(this.window, () => this.quit());

  private readonly metrics = new MetricsService();

  private readonly processExplorer = new ProcessExplorerService(() => this.window.instance);

  private quitting = false;

  /**
   * The view the renderer reports as on screen. Defaults to Stats (the launch
   * view) so the gate is correct before the first renderer report arrives.
   */
  private activeView: ActiveView = ActiveView.ACTIVE_VIEW_STATS;

  initialize(): void {
    // Dark-only app: fix the native theme so the window chrome matches the
    // renderer rather than following the OS appearance.
    app.setTheme("dark");

    // Quit routes through quit() so it disposes services like the tray Quit.
    app.setMenu(buildApplicationMenu(() => this.showAbout(), () => this.quit()));

    this.registerAppService();

    // macOS: reopen on activation (Dock click / Cmd+Tab) after a hide or close.
    app.on("activated", () => {
      if (!this.quitting) {
        this.window.show();
      }
    });
    app.on("allWindowsClosed", () => {
      if (process.platform !== "darwin") {
        this.quit();
      }
    });

    this.window.show();
    // Showing normally emits the visibility change; sync explicitly too so
    // startup never depends on event ordering.
    this.handleWindowVisibilityChange();
  }

  /**
   * Tears down the services and tray, then quits. This MoBrowser version has
   * no before-quit app event, so every quit path (menu, tray) funnels here.
   */
  quit(): void {
    if (this.quitting) {
      return;
    }
    this.quitting = true;
    this.metrics.dispose();
    this.processExplorer.dispose();
    this.tray.destroy();
    app.quit();
  }

  /** Shows the About dialog: branded name, live version, and a repository link. */
  private async showAbout(): Promise<void> {
    try {
      const result = await app.showMessageDialog({
        parentWindow: this.window.instance ?? undefined,
        type: "info",
        message: `${DISPLAY_NAME} ${app.version}`,
        informativeText: `${app.description}\n\nPowered by MōBrowser.\n\n${app.copyright}`,
        buttons: [
          { label: "Close", type: "primary" },
          { label: "Open GitHub Repository...", type: "secondary" },
        ],
      });
      if (result.button.type === "secondary") {
        desktop.openUrl(REPOSITORY_URL);
      }
    } catch {
      // The menu action floats this promise; a dialog failure must not become
      // an unhandled rejection in main.
    }
  }

  private handleWindowVisibilityChange(): void {
    this.tray.refresh();
    this.updateServiceActivation();
  }

  /**
   * Activates exactly the service whose view is on screen, and neither while
   * the window is hidden. Both setActive calls are idempotent, so
   * re-evaluating on every signal change is cheap.
   */
  private updateServiceActivation(): void {
    const visible = this.window.isVisible;
    this.metrics.setActive(visible && this.activeView === ActiveView.ACTIVE_VIEW_STATS);
    this.processExplorer.setActive(
      visible && this.activeView === ActiveView.ACTIVE_VIEW_PROCESSES,
    );
  }

  private registerAppService(): void {
    const window = this.window;
    ipc.registerService(AppServiceDescriptor, {
      async GetApplicationMetadata() {
        return {
          name: app.name,
          version: app.version,
        };
      },
      async SetAlwaysOnTop(request: SetAlwaysOnTopRequest) {
        window.setAlwaysOnTop(request.alwaysOnTop);
        return {};
      },
      SetActiveView: async (request: SetActiveViewRequest) => {
        this.activeView = request.view;
        this.updateServiceActivation();
        return {};
      },
      async CopyText(request: CopyTextRequest) {
        // The sandboxed renderer cannot reach the clipboard. The text may be a
        // sensitive command line; it is never logged or persisted.
        clipboard.write("text/plain", request.text);
        return {};
      },
    });
  }
}
