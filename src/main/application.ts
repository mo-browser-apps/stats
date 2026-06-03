import { app, ipc } from '@mobrowser/api';
import { ApplicationWindow } from './application-window';
import { TrayController } from './tray-controller';
import { MetricsService } from './metrics/metrics-service';
import { ProcessExplorerService } from './processes/process-explorer-service';
import { SetAlwaysOnTopRequest } from './gen/app';
import { AppServiceDescriptor } from './gen/ipc_service';

/**
 * Composition root for the MoStats main process.
 *
 * Owns the single compact window, the menu-bar tray, app lifecycle wiring, and
 * registration of renderer-facing IPC services, including the metrics stream.
 * The metrics service samples CPU, memory, disk, network, uptime/load, and
 * optional CPU temperature in main and streams them to the renderer. The process
 * explorer service collects live process snapshots in main and serves them on its
 * own IPC service; its reveal/quit/force-quit actions remain not-yet-implemented
 * until the action iteration.
 *
 * Lifecycle (I09): the window hides instead of closing, so the app keeps running
 * in the background with only the tray present. The metrics cadence follows
 * window visibility - it runs while the window is shown and pauses while it is
 * hidden, since a hidden compact monitor has nothing to display. The process
 * collector instead follows process-view selection (it reads sensitive
 * command-line data, so it must run only while the Processes view is on screen,
 * not whenever the window is visible); the view switch wires it in I12, so it
 * stays idle until then. Quit is routed through {@link quit} so the metrics
 * interval/stream, the process explorer cadence/stream, and the tray are torn
 * down before the process exits.
 */
export class Application {
  private readonly window = new ApplicationWindow(() => {
    this.handleWindowVisibilityChange();
  });

  private readonly tray = new TrayController(this.window, () => {
    this.quit();
  });

  private readonly metrics = new MetricsService();

  private readonly processExplorer = new ProcessExplorerService();

  /**
   * Wires lifecycle handlers, registers IPC services, and shows the window.
   */
  initialize(): void {
    // MoStats is a dark-only compact utility (DESIGN.md): fix the native theme
    // to dark so the window chrome matches the renderer rather than following
    // the OS appearance. There is no in-app theme switch.
    app.setTheme('dark');

    this.registerAppService();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on('activated', () => {
      this.window.show();
    });

    this.window.show();
    // Showing the window normally emits the visibility change that starts the
    // metrics cadence; sync explicitly too so startup never depends on event
    // ordering. setActive is idempotent, so this is a no-op if the event already
    // fired. The process collector is intentionally NOT started here: it is gated
    // on the process explorer view being selected (the app opens on the Stats
    // overview), so it must stay idle - and not read sensitive command-line data -
    // until the Processes view exists. The view switch wires it in I12.
    this.metrics.setActive(this.window.isVisible);
  }

  /**
   * Tears down runtime services and quits. Disposing the metrics and process
   * explorer services stops the sampling interval and closes their broadcast
   * streams/handlers, and destroying the tray releases the native status item, so
   * no timer, stream subscriber, or native resource is left dangling when the
   * process exits. This MoBrowser version has no before-quit/will-quit app event,
   * so quit is funneled here (from the tray Quit action) rather than hooked after
   * the fact.
   */
  quit(): void {
    this.metrics.dispose();
    this.processExplorer.dispose();
    this.tray.destroy();
    app.quit();
  }

  /**
   * Reacts to the window being shown, hidden, or destroyed: keeps the tray menu
   * label in sync and gates the metrics cadence on visibility so the native
   * probes only run while there is a visible window to display them. The process
   * collector is not gated here - it follows process-view selection, not window
   * visibility (see {@link initialize}), and stays idle until the Processes view
   * is wired in I12.
   */
  private handleWindowVisibilityChange(): void {
    this.tray.refresh();
    this.metrics.setActive(this.window.isVisible);
  }

  /**
   * Registers the app-level IPC service.
   */
  private registerAppService(): void {
    const window = this.window;
    ipc.registerService(AppServiceDescriptor, {
      async SetAlwaysOnTop(request: SetAlwaysOnTopRequest) {
        window.setAlwaysOnTop(request.alwaysOnTop);
        return {};
      },
    });
  }
}
