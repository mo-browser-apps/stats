import { app, CheckboxMenuItem, Menu, MenuItem, Tray } from "@mobrowser/api";
import type { MouseButton } from "@mobrowser/api";
import type { ApplicationWindow } from "./application-window";

/**
 * Human-facing app name.
 */
const DISPLAY_NAME = "MōStats";

/**
 * Owns the macOS menu-bar tray item and its menu.
 */
export class TrayController {
  private readonly tray: Tray;
  private readonly toggleWindowItem: MenuItem;
  private readonly launchAtLoginItem: CheckboxMenuItem;
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
    this.launchAtLoginItem = new CheckboxMenuItem({
      id: "launchAtLogin",
      label: "Launch at Login",
      checked: app.loginItemSettings.openAtLogin,
      action: () => {
        this.toggleLaunchAtLogin();
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
        this.syncLaunchAtLogin();
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
        this.launchAtLoginItem,
        "separator",
        this.quitItem,
      ],
    });
  }

  private getToggleLabel(): string {
    return this.window.isVisible ? `Hide ${DISPLAY_NAME}` : `Show ${DISPLAY_NAME}`;
  }

  /**
   * Flips the login-item registration to the opposite of the current OS state,
   * then re-reads it. The checkbox is set from the read-back, not the request,
   * so a refused change (e.g. the system denying background-item registration)
   * leaves the menu honest instead of showing a checkmark that lies.
   */
  private toggleLaunchAtLogin(): void {
    app.setLoginItemSettings({ openAtLogin: !app.loginItemSettings.openAtLogin });
    this.syncLaunchAtLogin();
  }

  /**
   * Re-reads the authoritative OS login-item state into the checkbox.
   */
  private syncLaunchAtLogin(): void {
    this.launchAtLoginItem.setChecked(app.loginItemSettings.openAtLogin);
  }
}
