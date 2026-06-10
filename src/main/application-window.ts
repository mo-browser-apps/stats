import process from "node:process";
import { app, BrowserWindow } from "@mobrowser/api";
import type { CloseBrowserWindowAction, CloseBrowserWindowParams } from "@mobrowser/api";
import { DISPLAY_NAME } from "./branding";

/** The two top-level views; the window picks its height per view. */
type WindowView = "stats" | "processes";

/**
 * Compact window dimensions, closer to a menu-bar popover than a dashboard.
 * Width is constant; the height follows the active view so neither view
 * wastes vertical space.
 */
const WINDOW_WIDTH = 360;
const VIEW_HEIGHT: Record<WindowView, number> = {
  stats: 465,
  processes: 560,
};

const INITIAL_VIEW: WindowView = "stats";

/**
 * Per-view resize animation. macOS has no documented animate flag on
 * setBounds, so a short eased loop in main gives a smooth grow/shrink (both
 * views stay mounted, so only the window frame moves).
 */
const RESIZE_DURATION_MS = 160;
const RESIZE_STEP_MS = 16; // ~60fps

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

  /** Target height for the active view; used when creating or re-showing. */
  private targetHeight = VIEW_HEIGHT[INITIAL_VIEW];

  private resizeTimer: ReturnType<typeof setInterval> | null = null;

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
      this.settleResize(window);
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

  /**
   * Resizes to the active view's height with a short eased animation, keeping
   * the top-left corner fixed like a menu-bar popover. With no live window it
   * just records the target so the next create() opens at the right size.
   */
  resizeForView(view: WindowView): void {
    const target = VIEW_HEIGHT[view];
    const window = this.instance;
    if (window === null) {
      this.targetHeight = target;
      return;
    }

    if (target === this.targetHeight && this.resizeTimer !== null) {
      return; // Already animating to this target.
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
    const window = new BrowserWindow({
      url: app.url,
      title: DISPLAY_NAME,
      size: { width: WINDOW_WIDTH, height: this.targetHeight },
      minimumSize: { width: WINDOW_WIDTH, height: VIEW_HEIGHT.stats },
      resizable: false,
      // No larger layout to expand into; close and minimize stay native.
      windowButtonVisible: { maximize: false, zoom: false },
      windowTitleVisible: false,
      // Keep the native title bar off on macOS for a compact utility look.
      windowTitlebarVisible: !isMac,
    });

    window.browser.zoom.setEnabled(false);

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
      this.stopResize();
      this.window = null;
      this.onVisibilityChange?.();
    });

    return window;
  }

  /**
   * Steps the height from `from` to `to` with an ease-out curve. A new call
   * cancels any in-flight animation, so rapid view switches settle on the
   * latest target instead of fighting each other.
   */
  private animateHeight(window: BrowserWindow, from: number, to: number): void {
    this.stopResize();

    const steps = Math.max(1, Math.round(RESIZE_DURATION_MS / RESIZE_STEP_MS));
    const origin = { ...window.bounds.origin };
    let step = 0;

    this.resizeTimer = setInterval(() => {
      step += 1;
      const t = Math.min(1, step / steps);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
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

  /** Finishes any in-flight resize at the latest target while the frame is hidden. */
  private settleResize(window: BrowserWindow): void {
    this.stopResize();
    if (!window.isClosed && Math.round(window.size.height) !== this.targetHeight) {
      this.setWindowHeight(window, this.targetHeight);
    }
  }

  private stopResize(): void {
    if (this.resizeTimer !== null) {
      clearInterval(this.resizeTimer);
      this.resizeTimer = null;
    }
  }
}
