import { ipc } from "@/gen/ipc";
import { ActiveView } from "@/gen/app";

/**
 * Renderer-side wrapper over the app-level IPC client, keeping presentation
 * components free of generated-IPC details.
 */
export const appGateway = {
  /** Pins or unpins the window above other windows. */
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<unknown> {
    return ipc.app.SetAlwaysOnTop({ alwaysOnTop });
  },

  /** Reports the on-screen view so main can gate per-view background work. */
  setActiveView(view: ActiveView): Promise<unknown> {
    return ipc.app.SetActiveView({ view });
  },

  /**
   * Copies user-selected text (a path or command line) via main, which holds
   * the privileged clipboard access. The text is sensitive: passed only on an
   * explicit user action and never logged.
   */
  copyText(text: string): Promise<unknown> {
    return ipc.app.CopyText({ text });
  },
};
