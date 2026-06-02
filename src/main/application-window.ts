import process from 'node:process';
import { app, BrowserWindow } from '@mobrowser/api';
import type { CloseBrowserWindowAction, CloseBrowserWindowParams } from '@mobrowser/api';

/**
 * Compact window dimensions aligned with DESIGN.md. The minimum size still
 * preserves every primary metric slot without overlap once the overview lands.
 */
const WINDOW_SIZE = { width: 460, height: 340 } as const;
const MIN_WINDOW_SIZE = { width: 420, height: 340 } as const;

/**
 * Position of the macOS traffic-light buttons so they clear the custom
 * draggable title row instead of overlapping content.
 */
const MAC_WINDOW_BUTTON_POSITION = { x: 16, y: 18 } as const;

/**
 * Keep normal dev launches visually faithful to the compact app. DevTools can
 * still be opened explicitly when debugging renderer behavior.
 */
const OPEN_DEVTOOLS = process.env.MOSTATS_OPEN_DEVTOOLS === '1';

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
   * Pins or unpins the window above other windows.
   */
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
    const isMac = process.platform === 'darwin';
    const window = new BrowserWindow({
      url: app.url,
      title: app.name,
      size: { ...WINDOW_SIZE },
      minimumSize: { ...MIN_WINDOW_SIZE },
      // A compact monitor has one fixed layout; resizing only lets it stretch
      // into empty space, so the window is a fixed size like the sibling apps.
      resizable: false,
      // Hide the green maximize/zoom button: there is no larger layout to
      // expand into. Close and minimize stay so the window behaves natively.
      windowButtonVisible: { maximize: false, zoom: false },
      windowTitleVisible: false,
      // Keep the native title bar off on macOS for a compact utility look; the
      // renderer provides its own draggable region. Other platforms keep the
      // standard title bar so the window stays draggable.
      windowTitlebarVisible: !isMac,
    });

    if (isMac) {
      window.setWindowButtonPosition({ ...MAC_WINDOW_BUTTON_POSITION });
    }

    window.centerWindow();

    // Hide instead of close so the app keeps running in the background. When
    // the app is quitting, allow the window to close so the process can exit.
    window.handle('close', async (params: CloseBrowserWindowParams): Promise<CloseBrowserWindowAction> => {
      if (params.isQuitting) {
        return 'close';
      }
      return 'hide';
    });

    window.on('shown', () => {
      this.onVisibilityChange?.();
    });
    window.on('hidden', () => {
      this.onVisibilityChange?.();
    });
    window.on('closed', () => {
      this.window = null;
      this.onVisibilityChange?.();
    });

    if (!app.packaged && OPEN_DEVTOOLS) {
      window.browser.devTools.open();
    }

    return window;
  }
}
