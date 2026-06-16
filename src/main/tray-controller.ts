import { app, CheckboxMenuItem, Menu, MenuItem, Tray } from "@mobrowser/api";
import type { MouseButton } from "@mobrowser/api";
import type { ApplicationWindow } from "./application-window";
import { DISPLAY_NAME } from "./branding";

/**
 * Owns the macOS menu-bar tray item and its menu. Primary click toggles the
 * window; secondary click opens the menu.
 */
export class TrayController {
  private readonly tray: Tray;
  private readonly toggleWindowItem: MenuItem;
  private readonly launchAtLoginItem: CheckboxMenuItem;
  private readonly quitItem: MenuItem;

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
   * Syncs the Show/Hide label with the window state. A no-op once destroyed:
   * a visibility event can still fire during quit when the window closes.
   */
  refresh(): void {
    if (this.tray.destroyed) {
      return;
    }
    this.toggleWindowItem.setLabel(this.getToggleLabel());
  }

  /** Releases the native tray resource. Idempotent. */
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

  private toggleLaunchAtLogin(): void {
    app.setLoginItemSettings({ openAtLogin: !app.loginItemSettings.openAtLogin });
    this.syncLaunchAtLogin();
  }

  /**
   * Re-reads the authoritative OS login-item state into the checkbox, so a
   * refused change (e.g. denied background-item registration) never shows a
   * checkmark that lies.
   */
  private syncLaunchAtLogin(): void {
    this.launchAtLoginItem.setChecked(app.loginItemSettings.openAtLogin);
  }
}
