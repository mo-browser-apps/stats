import process from 'node:process';
import { app, ipc } from '@mobrowser/api';
import { ApplicationWindow } from './application-window';
import { TrayController } from './tray-controller';
import { MetricsService } from './metrics/metrics-service';
import { ProcessExplorerService } from './processes/process-explorer-service';
import { ActiveView, SetActiveViewRequest, SetAlwaysOnTopRequest } from './gen/app';
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
 * Lifecycle: the window hides instead of closing, so the app keeps running in the
 * background with only the tray present. Per-view background work is gated on two
 * signals this class owns: window visibility (from the window callback) and the
 * active view (reported by the renderer via {@link ActiveView}). Exactly the one
 * service whose view is on screen runs, and neither runs while the window is
 * hidden - so metrics sample only on the visible Stats view, and the process
 * collector (which reads sensitive command-line data) collects only on the
 * visible Processes view. Both gates are combined in {@link updateServiceActivation}.
 * Quit is routed through {@link quit} so the metrics interval/stream, the process
 * explorer cadence/stream, and the tray are torn down before the process exits.
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
    // MoStats is a dark-only compact utility (DESIGN.md): fix the native theme
    // to dark so the window chrome matches the renderer rather than following
    // the OS appearance. There is no in-app theme switch.
    app.setTheme('dark');

    this.registerAppService();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on('activated', () => {
      if (this.quitting) {
        return;
      }
      this.window.show();
    });
    app.on('allWindowsClosed', () => {
      if (process.platform !== 'darwin') {
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
   * Tears down runtime services and quits. Disposing the metrics and process
   * explorer services stops the sampling interval and closes their broadcast
   * streams/handlers, and destroying the tray releases the native status item, so
   * no timer, stream subscriber, or native resource is left dangling when the
   * process exits. This MoBrowser version has no before-quit/will-quit app event,
   * so quit is funneled here (from the tray Quit action) rather than hooked after
   * the fact.
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
   * window is hidden. This is the single place the two gates - window visibility
   * and the active view - are combined, so both services follow the same rule:
   * run iff the window is visible and this service's view is the active one.
   * Both setActive calls are idempotent, so re-evaluating on every signal change
   * is cheap.
   */
  private updateServiceActivation(): void {
    const visible = this.window.isVisible;
    this.metrics.setActive(visible && this.activeView === ActiveView.ACTIVE_VIEW_STATS);
    this.processExplorer.setActive(
      visible && this.activeView === ActiveView.ACTIVE_VIEW_PROCESSES,
    );
  }

  /**
   * Registers the app-level IPC service: the always-on-top pin toggle and the
   * active-view report that drives per-view activation.
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
          request.view === ActiveView.ACTIVE_VIEW_PROCESSES ? 'processes' : 'stats',
        );
        return {};
      },
    });
  }
}
