import process from "node:process";
import { app, BrowserWindow } from "@mobrowser/api";
import type { CloseBrowserWindowAction, CloseBrowserWindowParams } from "@mobrowser/api";
import { DISPLAY_NAME } from "./branding";

/**
 * Compact fixed window dimensions, closer to a menu-bar popover than a
 * dashboard. Both views are laid out for the same frame, so the window never
 * resizes.
 */
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 560;

/** Traffic-light position clearing the custom draggable title row. */
const MAC_WINDOW_BUTTON_POSITION = { x: 16, y: 18 } as const;

/**
 * Owns the single compact window and its show/hide lifecycle. Closing hides
 * the window so the app keeps running in the tray; it truly closes only when
 * the app quits. Created lazily and recreated if destroyed, so the tray can
 * always bring the UI back.
 */
export class ApplicationWindow {
  private window: BrowserWindow | null = null;

  /**
   * @param onVisibilityChange Notified after the window is shown, hidden, or
   *   destroyed so observers (e.g. the tray menu) can stay in sync.
   */
  constructor(private readonly onVisibilityChange?: () => void) {}

  /** Shows the window, creating it if needed, and brings it to the front. */
  show(): void {
    const window = this.getOrCreateWindow();
    if (!window.isVisible) {
      window.show();
    }
    window.focus();
  }

  hide(): void {
    const window = this.instance;
    if (window?.isVisible) {
      window.hide();
    }
  }

  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  get isVisible(): boolean {
    return this.instance?.isVisible ?? false;
  }

  /**
   * The live window instance, or null when none exists. Exposed so main can
   * parent native dialogs; callers must tolerate null (then app-modal).
   */
  get instance(): BrowserWindow | null {
    return this.window !== null && !this.window.isClosed ? this.window : null;
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.getOrCreateWindow().setAlwaysOnTop(alwaysOnTop);
  }

  private getOrCreateWindow(): BrowserWindow {
    if (this.window === null || this.window.isClosed) {
      this.window = this.create();
    }
    return this.window;
  }

  private create(): BrowserWindow {
    const isMac = process.platform === "darwin";
    const window = new BrowserWindow({
      url: app.url,
      title: DISPLAY_NAME,
      size: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      resizable: false,
      // No larger layout to expand into; close and minimize stay native.
      windowButtonVisible: { maximize: false, zoom: false },
      windowTitleVisible: false,
      // Keep the native title bar off on macOS for a compact utility look.
      windowTitlebarVisible: !isMac,
    });

    window.browser.zoom.setEnabled(false);

    // The creation-time `size` lands short by the hidden title bar's height,
    // clipping the bottom of both views; setting the size after creation
    // applies the exact frame height.
    window.setSize({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT });

    if (isMac) {
      window.setWindowButtonPosition({ ...MAC_WINDOW_BUTTON_POSITION });
    }

    window.centerWindow();

    // Hide instead of close so the app keeps running; allow a real close only
    // while quitting so the process can exit.
    window.handle("close", async (params: CloseBrowserWindowParams): Promise<CloseBrowserWindowAction> => {
      return params.isQuitting ? "close" : "hide";
    });

    window.on("shown", () => {
      this.onVisibilityChange?.();
    });
    window.on("hidden", () => {
      this.onVisibilityChange?.();
    });
    window.on("closed", () => {
      this.window = null;
      this.onVisibilityChange?.();
    });

    return window;
  }
}
