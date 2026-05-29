import { app, Menu, MenuItem, Tray } from '@mobrowser/api';
import type { MouseButton } from '@mobrowser/api';
import type { ApplicationWindow } from './application-window';

/**
 * Owns the macOS menu-bar tray item and its menu.
 *
 * The tray is the primary way to bring the compact window back after it has
 * been hidden, and to quit the app. A left click toggles the window; a right
 * click opens the menu with explicit Show/Hide and Quit actions.
 */
export class TrayController {
  private readonly tray: Tray;

  constructor(private readonly window: ApplicationWindow) {
    this.tray = new Tray({
      tooltip: app.name,
      imagePath: `${app.getPath('appResources')}/imageTemplate.png`,
      menu: this.buildMenu(),
    });

    this.tray.on('mouseUp', (button: MouseButton) => {
      if (button === 'secondary') {
        this.tray.openMenu();
        return;
      }
      this.window.toggle();
    });
  }

  /**
   * Rebuilds the tray menu. Called when window visibility changes so the
   * Show/Hide label matches the current state.
   */
  refresh(): void {
    this.tray.setMenu(this.buildMenu());
  }

  /**
   * Releases the native tray resource.
   */
  destroy(): void {
    this.tray.destroy();
  }

  private buildMenu(): Menu {
    return new Menu({
      items: [
        new MenuItem({
          id: 'toggleWindow',
          label: this.window.isVisible ? 'Hide MoStats' : 'Show MoStats',
          action: () => {
            this.window.toggle();
          },
        }),
        'separator',
        new MenuItem({
          id: 'quit',
          label: 'Quit MoStats',
          shortcut: 'CommandOrControl+Q',
          action: () => {
            app.quit();
          },
        }),
      ],
    });
  }
}
