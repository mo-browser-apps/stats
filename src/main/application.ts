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
 * optional CPU temperature in main and streams them to the renderer.
 *
 * Lifecycle (I09): the window hides instead of closing, so the app keeps running
 * in the background with only the tray present. The metrics cadence and the
 * process-collection cadence (I11) both follow window visibility - they run
 * while the window is shown and pause while it is hidden, since a hidden compact
 * monitor has nothing to display. Quit is routed through {@link quit} so the
 * metrics interval/stream, the process refresh loop, and the tray are torn down
 * before the process exits.
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
    // Process explorer IPC (I11). The snapshot service collects live process
    // data via the native collector while the process view is active; its
    // cadence is gated on window visibility below, alongside the metrics one.
    this.processExplorer.register();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on('activated', () => {
      this.window.show();
    });

    this.window.show();
    // Showing the window normally emits the visibility change that starts the
    // cadences; sync explicitly too so startup never depends on event ordering.
    // setActive is idempotent, so this is a no-op if the event already fired.
    this.metrics.setActive(this.window.isVisible);
    this.processExplorer.setActive(this.window.isVisible);
  }

  /**
   * Tears down runtime services and quits. Disposing the metrics service stops
   * the sampling interval and closes the broadcast stream, disposing the process
   * explorer stops its refresh loop, and destroying the tray releases the native
   * status item, so no timer, stream subscriber, or native resource is left
   * dangling when the process exits. This MoBrowser version has no
   * before-quit/will-quit app event, so quit is funneled here (from the tray
   * Quit action) rather than hooked after the fact.
   */
  quit(): void {
    this.metrics.dispose();
    this.processExplorer.dispose();
    this.tray.destroy();
    app.quit();
  }

  /**
   * Reacts to the window being shown, hidden, or destroyed: keeps the tray menu
   * label in sync and gates the metrics and process-collection cadences on
   * visibility so the native probes only run while there is a visible window to
   * display them.
   */
  private handleWindowVisibilityChange(): void {
    this.tray.refresh();
    this.metrics.setActive(this.window.isVisible);
    this.processExplorer.setActive(this.window.isVisible);
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
