import { app, Menu, MenuItem, Tray } from "@mobrowser/api";
import type { MouseButton } from "@mobrowser/api";
import type { ApplicationWindow } from "./application-window";

/**
 * Human-facing app name.
 */
const DISPLAY_NAME = "MōStats";

/**
 * Owns the macOS menu-bar tray item and its menu.
 *
 * The tray is the primary way to bring the compact window back after it has
 * been hidden, and to quit the app. A left click toggles the window; a right
 * click opens the menu with Show/Hide and Quit actions. Quit is routed through
 * the injected callback (rather than calling `app.quit()` directly) so the owner
 * can tear down runtime services before the process exits. (About lives in the
 * macOS app menu, the native location, not here.)
 */
export class TrayController {
  private readonly tray: Tray;
  private readonly toggleWindowItem: MenuItem;
  private readonly quitItem: MenuItem;

  /**
   * @param window The compact window the tray shows, hides, and toggles.
   * @param onQuit Invoked when the user selects Quit; the owner disposes
   *   services and then quits the app.
   */
  constructor(
    private readonly window: ApplicationWindow,
    private readonly onQuit: () => void,
  ) {
    this.toggleWindowItem = new MenuItem({
      id: "toggleWindow",
      label: this.getToggleLabel(),
      action: () => {
        this.window.toggle();
      },
    });
    this.quitItem = new MenuItem({
      id: "quit",
      label: `Quit ${DISPLAY_NAME}`,
      shortcut: "CommandOrControl+Q",
      action: () => {
        this.onQuit();
      },
    });

    this.tray = new Tray({
      tooltip: DISPLAY_NAME,
      imagePath: `${app.getPath("appResources")}/imageTemplate.png`,
      menu: this.buildMenu(),
    });

    this.tray.on("mouseUp", (button: MouseButton) => {
      if (button === "secondary") {
        this.tray.openMenu();
        return;
      }
      this.window.toggle();
    });
  }

  /**
   * Refreshes the stateful tray menu label. Called when window visibility
   * changes so the Show/Hide label matches the current state. A no-op once the
   * tray is destroyed, since a window visibility event can still fire during
   * quit (after `destroy()`) when the window is closed.
   */
  refresh(): void {
    if (this.tray.destroyed) {
      return;
    }
    this.toggleWindowItem.setLabel(this.getToggleLabel());
  }

  /**
   * Releases the native tray resource. Idempotent.
   */
  destroy(): void {
    if (this.tray.destroyed) {
      return;
    }
    this.tray.destroy();
  }

  private buildMenu(): Menu {
    return new Menu({
      items: [
        this.toggleWindowItem,
        "separator",
        this.quitItem,
      ],
    });
  }

  private getToggleLabel(): string {
    return this.window.isVisible ? `Hide ${DISPLAY_NAME}` : `Show ${DISPLAY_NAME}`;
  }
}
