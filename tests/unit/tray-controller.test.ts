import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationWindow } from "@main/application-window";

/**
 * Tests the tray's Launch at Login checkbox: it must initialize from, toggle
 * through, and re-sync against the OS-backed `app.loginItemSettings` so the
 * menu never claims a registration the system refused. The MoBrowser runtime
 * is mocked: `app` exposes a mutable login-item state (with a refusal switch),
 * and the Tray/Menu/MenuItem/CheckboxMenuItem constructors capture enough to
 * drive actions and listeners from the tests.
 */

/** A captured menu item action-bearing options object. */
interface CapturedItemOptions {
  id: string;
  label: string;
  checked?: boolean;
  action: () => void;
}

const h = vi.hoisted(() => ({
  /** The simulated OS login-item registration. */
  openAtLogin: false,
  /** When true, setLoginItemSettings is ignored (the OS refused the change). */
  refuseChanges: false,
  setLoginItemSettings: vi.fn(),
  setChecked: vi.fn(),
  setLabel: vi.fn(),
  openMenu: vi.fn(),
  trayDestroy: vi.fn(),
  menuItems: [] as unknown[],
  checkbox: undefined as CapturedItemOptions | undefined,
  plainItems: [] as CapturedItemOptions[],
  trayListeners: new Map<string, (button: string) => void>(),
}));

vi.mock("@mobrowser/api", () => ({
  app: {
    getPath: () => "/test-resources",
    get loginItemSettings() {
      return { openAtLogin: h.openAtLogin };
    },
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
      h.setLoginItemSettings(settings);
      if (!h.refuseChanges) {
        h.openAtLogin = settings.openAtLogin;
      }
    },
  },
  Menu: vi.fn(function MockMenu(options: { items: unknown[] }) {
    h.menuItems = options.items;
    return {};
  }),
  MenuItem: vi.fn(function MockMenuItem(options: CapturedItemOptions) {
    h.plainItems.push(options);
    return { options, setLabel: h.setLabel };
  }),
  CheckboxMenuItem: vi.fn(function MockCheckboxMenuItem(options: CapturedItemOptions) {
    h.checkbox = options;
    return { options, setChecked: h.setChecked };
  }),
  Tray: vi.fn(function MockTray() {
    return {
      destroyed: false,
      on: (event: string, listener: (button: string) => void) => {
        h.trayListeners.set(event, listener);
      },
      openMenu: h.openMenu,
      destroy: h.trayDestroy,
    };
  }),
}));

import { TrayController } from "@main/tray-controller";

function makeWindow(): { toggle: ReturnType<typeof vi.fn>; window: ApplicationWindow } {
  const toggle = vi.fn();
  const stub = { toggle, isVisible: true };
  return { toggle, window: stub as unknown as ApplicationWindow };
}

function fireMouseUp(button: string): void {
  const listener = h.trayListeners.get("mouseUp");
  if (!listener) throw new Error("tray mouseUp listener was not registered");
  listener(button);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.openAtLogin = false;
  h.refuseChanges = false;
  h.menuItems = [];
  h.checkbox = undefined;
  h.plainItems = [];
  h.trayListeners.clear();
});

describe("TrayController launch at login", () => {
  it("initializes the checkbox from the OS state and places it in the menu", () => {
    h.openAtLogin = true;
    const { window } = makeWindow();
    new TrayController(window, vi.fn());

    expect(h.checkbox?.label).toBe("Launch at Login");
    expect(h.checkbox?.checked).toBe(true);
    // Show/Hide, separator, Launch at Login, separator, Quit.
    expect(h.menuItems).toHaveLength(5);
  });

  it("toggles the registration and re-checks from the OS read-back", () => {
    const { window } = makeWindow();
    new TrayController(window, vi.fn());
    expect(h.checkbox?.checked).toBe(false);

    h.checkbox?.action();
    expect(h.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(h.setChecked).toHaveBeenLastCalledWith(true);

    h.checkbox?.action();
    expect(h.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
    expect(h.setChecked).toHaveBeenLastCalledWith(false);
  });

  it("stays unchecked when the OS refuses the registration", () => {
    h.refuseChanges = true;
    const { window } = makeWindow();
    new TrayController(window, vi.fn());

    h.checkbox?.action();
    // The request was made, but the checkbox reflects the unchanged OS state.
    expect(h.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(h.setChecked).toHaveBeenLastCalledWith(false);
  });

  it("re-syncs the checkbox from the OS before opening the menu on right-click", () => {
    const { window } = makeWindow();
    new TrayController(window, vi.fn());

    // The registration changed outside the app (System Settings).
    h.openAtLogin = true;
    fireMouseUp("secondary");

    expect(h.setChecked).toHaveBeenLastCalledWith(true);
    expect(h.openMenu).toHaveBeenCalledTimes(1);
    // The sync happens before the menu is shown, so the user never sees stale state.
    const syncOrder = h.setChecked.mock.invocationCallOrder.at(-1) ?? 0;
    const openOrder = h.openMenu.mock.invocationCallOrder.at(-1) ?? 0;
    expect(syncOrder).toBeLessThan(openOrder);
  });

  it("keeps the left-click window toggle untouched", () => {
    const { window, toggle } = makeWindow();
    new TrayController(window, vi.fn());

    fireMouseUp("primary");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(h.openMenu).not.toHaveBeenCalled();
  });
});
