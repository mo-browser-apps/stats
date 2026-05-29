import { app, ipc, Theme } from '@mobrowser/api';
import { ApplicationWindow } from './application-window';
import { TrayController } from './tray-controller';
import { SetThemeRequest } from './gen/app';
import { AppServiceDescriptor } from './gen/ipc_service';

/**
 * Composition root for the MoStats main process.
 *
 * Owns the single compact window, the menu-bar tray, app lifecycle wiring, and
 * registration of renderer-facing IPC services. Metric sampling and the metrics
 * IPC contract are added in later iterations; this iteration only establishes
 * the application shell.
 */
export class Application {
  private readonly window = new ApplicationWindow(() => {
    this.tray.refresh();
  });

  private readonly tray = new TrayController(this.window);

  /**
   * Wires lifecycle handlers, registers IPC services, and shows the window.
   */
  initialize(): void {
    this.registerThemeService();

    // On macOS, reopen the window when the app is activated (Dock click or
    // Cmd+Tab) after all windows were hidden or closed.
    app.on('activated', () => {
      this.window.show();
    });

    this.window.show();
  }

  /**
   * Registers the app-level theme service so the renderer can switch the
   * native theme. This is the only renderer IPC service in this iteration.
   */
  private registerThemeService(): void {
    ipc.registerService(AppServiceDescriptor, {
      async SetTheme(request: SetThemeRequest) {
        app.setTheme(request.theme as Theme);
        return {};
      },
    });
  }
}
