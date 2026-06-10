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

/**
 * Opened from the About dialog's button.
 */
const REPOSITORY_URL = "https://github.com/mo-browser-apps/stats";

/**
 * Composition root for the MoStats main process: owns the single compact window,
 * the menu-bar tray, app lifecycle wiring, and the renderer-facing IPC services
 * (metrics stream + process explorer).
 *
 * The window hides instead of closing, so the app keeps running in the tray.
 * Per-view background work is gated on two signals this class owns, window
 * visibility and the active view, combined in {@link updateServiceActivation} so
 * exactly the on-screen view's service runs and neither while hidden. This keeps
 * the process collector's sensitive command-line reads off until the user is on
 * the Processes view. Quit is routed through {@link quit} so the services and
 * tray are torn down before exit.
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
   * The view the renderer reports as on screen. Defaults to Stats, the launch
   * view, so the metrics gate is correct even before the renderer's first
   * {@link ActiveView} report arrives.
   */
  private activeView: ActiveView = ActiveView.ACTIVE_VIEW_STATS;

  /**
   * Wires lifecycle handlers, registers IPC services, and shows the window.
   */
  initialize(): void {
    // MoStats is dark-only: fix the native theme to dark so the window chrome
    // matches the renderer rather than following the OS appearance. There is no
    // in-app theme switch.
    app.setTheme("dark");

    // Install the macOS app menu so About sits under the app-name menu (the
    // native location) with standard Hide/Quit, Edit, and Window items. Quit is
    // routed through quit() so it disposes services like the tray Quit does.
    app.setMenu(buildApplicationMenu(() => this.showAbout(), () => this.quit()));

    this.registerAppService();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on("activated", () => {
      if (this.quitting) {
        return;
      }
      this.window.show();
    });
    app.on("allWindowsClosed", () => {
      if (process.platform !== "darwin") {
        this.quit();
      }
    });

    this.window.show();
    // Showing the window normally emits the visibility change that drives
    // activation and the tray label; sync explicitly too so startup never
    // depends on event ordering. With the default active view (Stats), this
    // starts metrics and leaves the process collector idle until the renderer
    // reports the Processes view.
    this.handleWindowVisibilityChange();
  }

  /**
   * Tears down runtime services and quits. Disposing the services stops the
   * sampling interval and closes their broadcast streams, and destroying the tray
   * releases the native status item, so nothing is left dangling at exit. This
   * MoBrowser version has no before-quit/will-quit app event, so quit is funneled
   * here (from the menu/tray Quit actions) rather than hooked after the fact.
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

  /**
   * Shows the About dialog from the app menu. A native message dialog keeps the
   * app single-window: it shows the branded name, live version, and description,
   * and offers a button that opens the GitHub repository. The version comes from
   * app metadata, not a hardcoded string.
   */
  private async showAbout(): Promise<void> {
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
  }

  /**
   * Reacts to the window being shown, hidden, or destroyed: keeps the tray menu
   * label in sync and re-evaluates which service should be active, since window
   * visibility is one of the two activation gates.
   */
  private handleWindowVisibilityChange(): void {
    this.tray.refresh();
    this.updateServiceActivation();
  }

  /**
   * Activates exactly the service whose view is on screen, and neither while the
   * window is hidden. The single place the two gates, window visibility and the
   * active view, are combined: each service runs iff the window is visible and
   * its view is the active one. Both setActive calls are idempotent, so
   * re-evaluating on every signal change is cheap.
   */
  private updateServiceActivation(): void {
    const visible = this.window.isVisible;
    this.metrics.setActive(visible && this.activeView === ActiveView.ACTIVE_VIEW_STATS);
    this.processExplorer.setActive(
      visible && this.activeView === ActiveView.ACTIVE_VIEW_PROCESSES,
    );
  }

  /**
   * Registers the app-level IPC service: the always-on-top pin toggle, the
   * active-view report that drives per-view activation, and the user-initiated
   * clipboard copy.
   */
  private registerAppService(): void {
    const window = this.window;
    ipc.registerService(AppServiceDescriptor, {
      async SetAlwaysOnTop(request: SetAlwaysOnTopRequest) {
        window.setAlwaysOnTop(request.alwaysOnTop);
        return {};
      },
      SetActiveView: async (request: SetActiveViewRequest) => {
        this.activeView = request.view;
        this.updateServiceActivation();
        this.window.resizeForView(
          request.view === ActiveView.ACTIVE_VIEW_PROCESSES ? "processes" : "stats",
        );
        return {};
      },
      async CopyText(request: CopyTextRequest) {
        // The renderer is sandboxed and cannot reach the clipboard, so the copy
        // happens here. The text may be a sensitive command line, so it is
        // written to the clipboard on request and never logged or persisted.
        clipboard.write("text/plain", request.text);
        return {};
      },
    });
  }
}
