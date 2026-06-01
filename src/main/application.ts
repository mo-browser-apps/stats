import { app, ipc, Theme } from '@mobrowser/api';
import { ApplicationWindow } from './application-window';
import { TrayController } from './tray-controller';
import { MetricsService } from './metrics/metrics-service';
import { SetThemeRequest } from './gen/app';
import { AppServiceDescriptor } from './gen/ipc_service';

/**
 * Composition root for the MoStats main process.
 *
 * Owns the single compact window, the menu-bar tray, app lifecycle wiring, and
 * registration of renderer-facing IPC services, including the metrics stream.
 * This iteration establishes the metrics IPC contract and publishes explicit
 * unavailable snapshots; real sampling lands in a later iteration.
 */
export class Application {
  private readonly window = new ApplicationWindow(() => {
    this.tray.refresh();
  });

  private readonly tray = new TrayController(this.window);

  private readonly metrics = new MetricsService();

  /**
   * Wires lifecycle handlers, registers IPC services, and shows the window.
   */
  initialize(): void {
    // MoStats is a dark-only compact utility (DESIGN.md): fix the native theme
    // to dark so the window chrome matches the renderer rather than following
    // the OS appearance. There is no in-app theme switch.
    app.setTheme('dark');

    this.registerAppService();
    this.metrics.start();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on('activated', () => {
      this.window.show();
    });

    this.window.show();
  }

  /**
   * Registers the app-level IPC service. The renderer no longer calls SetTheme
   * (the app is dark-only and the theme is fixed natively at startup), but the
   * RPC is kept as the app-level IPC seam; cleanup is deferred to the
   * pre-release polish pass.
   */
  private registerAppService(): void {
    ipc.registerService(AppServiceDescriptor, {
      async SetTheme(request: SetThemeRequest) {
        app.setTheme(request.theme as Theme);
        return {};
      },
    });
  }
}
