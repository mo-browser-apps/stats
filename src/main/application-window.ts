import process from "node:process";
import { app, BrowserWindow } from "@mobrowser/api";
import type { CloseBrowserWindowAction, CloseBrowserWindowParams } from "@mobrowser/api";
import { DISPLAY_NAME } from "./branding";

/**
 * The two top-level views; the window picks its height per view.
 */
type WindowView = "stats" | "processes";

/**
 * Compact window dimensions. Width is constant; the height follows the active
 * view so neither view wastes vertical space: the Stats overview is a tight stack
 * of metric rows, while the Processes explorer needs room for the sort control,
 * search field, and a ranked list. Kept closer to a menu-bar popover than a
 * dashboard.
 */
const WINDOW_WIDTH = 360;
const VIEW_HEIGHT: Record<WindowView, number> = {
  stats: 484,
  processes: 560,
};

/**
 * The view the window opens at (and re-shows at after a hide).
 */
const INITIAL_VIEW: WindowView = "stats";

/**
 * Per-view resize animation. macOS has no documented animate flag on setBounds,
 * so a short eased loop in main gives a smooth grow/shrink without any content
 * reflow (both views stay mounted, so only the window frame moves).
 */
const RESIZE_DURATION_MS = 160;
const RESIZE_STEP_MS = 16; // ~60fps

/**
 * Position of the macOS traffic-light buttons so they clear the custom
 * draggable title row instead of overlapping content.
 */
const MAC_WINDOW_BUTTON_POSITION = { x: 16, y: 18 } as const;

/**
 * Owns the single compact MoStats window and its show/hide lifecycle.
 *
 * Closing the window hides it so the app keeps running in the background; the
 * window only truly closes when the application is quitting. The window is
 * created lazily and recreated if it was destroyed, so the tray can always
 * bring the UI back.
 */
export class ApplicationWindow {
  private window: BrowserWindow | null = null;

  /**
   * Target height for the active view; used when creating or re-showing.
   */
  private targetHeight = VIEW_HEIGHT[INITIAL_VIEW];

  /**
   * Active resize animation timer, if a grow/shrink is in flight.
   */
  private resizeTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param onVisibilityChange Notified after the window is shown, hidden, or
   *   destroyed so observers (for example the tray menu) can stay in sync.
   */
  constructor(private readonly onVisibilityChange?: () => void) {}

  /**
   * Shows the window, creating it if needed, and brings it to the front.
   */
  show(): void {
    const window = this.getOrCreateWindow();
    if (window.isVisible) {
      window.focus();
      return;
    }
    window.show();
    window.focus();
  }

  /**
   * Hides the window if it currently exists and is visible.
   */
  hide(): void {
    if (this.window && !this.window.isClosed && this.window.isVisible) {
      this.settleResize(this.window);
      this.window.hide();
    }
  }

  /**
   * Toggles window visibility for tray/menu-bar interactions.
   */
  toggle(): void {
    if (this.window && !this.window.isClosed && this.window.isVisible) {
      this.hide();
      return;
    }
    this.show();
  }

  /**
   * Whether the window currently exists and is visible to the user.
   */
  get isVisible(): boolean {
    return this.window !== null && !this.window.isClosed && this.window.isVisible;
  }

  /**
   * The live window instance, or null when none exists (it is created lazily and
   * dropped on close). Exposed so main can parent a native dialog to the window;
   * callers must tolerate null (the dialog is then app-modal).
   */
  get instance(): BrowserWindow | null {
    return this.window !== null && !this.window.isClosed ? this.window : null;
  }

  /**
   * Pins or unpins the window above other windows.
   */
  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.getOrCreateWindow().setAlwaysOnTop(alwaysOnTop);
  }

  /**
   * Resizes the window to the active view's height, animating the change with a
   * short eased setBounds loop so the grow/shrink reads as smooth. The top-left
   * corner stays fixed by preserving the current bounds origin, like a menu-bar
   * popover. If no live window exists, it just records the target height so the
   * next create() opens at the right size.
   */
  resizeForView(view: WindowView): void {
    const target = VIEW_HEIGHT[view];
    const window = this.window;
    if (window === null || window.isClosed) {
      // No window to animate; remember the target for the next create().
      this.targetHeight = target;
      return;
    }

    if (target === this.targetHeight && this.resizeTimer !== null) {
      return;
    }

    this.targetHeight = target;

    if (!window.isVisible) {
      this.settleResize(window);
      return;
    }

    const from = Math.round(window.size.height);
    if (from === target) {
      this.stopResize();
      return;
    }

    this.animateHeight(window, from, target);
  }

  private getOrCreateWindow(): BrowserWindow {
    if (this.window === null || this.window.isClosed) {
      this.window = this.create();
    }
    return this.window;
  }

  private create(): BrowserWindow {
    const isMac = process.platform === "darwin";
    const initialHeight = this.targetHeight;
    const window = new BrowserWindow({
      // The URL of the app frontend entry point.
      url: app.url,
      // Branded name for the user-visible title.
      title: DISPLAY_NAME,
      // The size is just big enough for the initial view.
      size: { width: WINDOW_WIDTH, height: initialHeight },
      minimumSize: { width: WINDOW_WIDTH, height: VIEW_HEIGHT.stats },
      resizable: false,
      // Hide the green maximize/zoom button: there is no larger layout to
      // expand into. Close and minimize stay so the window behaves natively.
      windowButtonVisible: { maximize: false, zoom: false },
      windowTitleVisible: false,
      // Keep the native title bar off on macOS for a compact utility look.
      windowTitlebarVisible: !isMac,
    });

    // Disable content zoom entirely.
    window.browser.zoom.setEnabled(false);

    if (isMac) {
      window.setWindowButtonPosition({ ...MAC_WINDOW_BUTTON_POSITION });
    }

    window.centerWindow();

    // Hide instead of close so the app keeps running in the background. When
    // the app is quitting, allow the window to close so the process can exit.
    window.handle("close", async (params: CloseBrowserWindowParams): Promise<CloseBrowserWindowAction> => {
      if (params.isQuitting) {
        return "close";
      }
      return "hide";
    });

    window.on("shown", () => {
      this.onVisibilityChange?.();
    });
    window.on("hidden", () => {
      this.onVisibilityChange?.();
    });
    window.on("closed", () => {
      this.stopResize();
      this.window = null;
      this.onVisibilityChange?.();
    });

    return window;
  }

  /**
   * Steps the window height from `from` to `to` over RESIZE_DURATION_MS using an
   * ease-out curve. A new call cancels any in-flight animation so rapid view
   * switches always settle on the latest target rather than fighting each other.
   */
  private animateHeight(window: BrowserWindow, from: number, to: number): void {
    this.stopResize();

    const steps = Math.max(1, Math.round(RESIZE_DURATION_MS / RESIZE_STEP_MS));
    const origin = { ...window.bounds.origin };
    let step = 0;

    this.resizeTimer = setInterval(() => {
      step += 1;
      const t = Math.min(1, step / steps);
      // Ease-out cubic for a natural deceleration.
      const eased = 1 - Math.pow(1 - t, 3);
      const height = Math.round(from + (to - from) * eased);

      if (this.window !== window || window.isClosed) {
        this.stopResize();
        return;
      }
      this.setWindowHeight(window, height, origin);

      if (t >= 1) {
        this.stopResize();
      }
    }, RESIZE_STEP_MS);
  }

  /**
   * Applies a bounded per-view height while preserving the chosen frame origin.
   */
  private setWindowHeight(
    window: BrowserWindow,
    height: number,
    origin = window.bounds.origin,
  ): void {
    window.setBounds({
      origin: { x: origin.x, y: origin.y },
      size: { width: WINDOW_WIDTH, height },
    });
  }

  /**
   * Finishes any in-flight resize at the latest target while the frame is hidden.
   */
  private settleResize(window: BrowserWindow): void {
    this.stopResize();
    if (!window.isClosed && Math.round(window.size.height) !== this.targetHeight) {
      this.setWindowHeight(window, this.targetHeight);
    }
  }

  /**
   * Clears the resize animation timer if one is running.
   */
  private stopResize(): void {
    if (this.resizeTimer !== null) {
      clearInterval(this.resizeTimer);
      this.resizeTimer = null;
    }
  }
}
