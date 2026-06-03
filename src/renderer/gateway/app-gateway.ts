import { ipc } from '@/gen/ipc';
import { ActiveView } from '@/gen/app';

/**
 * Renderer-side wrapper over the generated app-level IPC client. Keeps
 * presentation components free of generated-IPC details, mirroring
 * {@link metricsGateway}.
 */
export const appGateway = {
  /**
   * Pins or unpins the window above other windows.
   */
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<unknown> {
    return ipc.app.SetAlwaysOnTop({ alwaysOnTop });
  },

  /**
   * Reports the on-screen view to main so it can gate per-view background work
   * (metrics sampling vs process collection). Fire-and-forget: the caller does
   * not need the acknowledgement.
   */
  setActiveView(view: ActiveView): Promise<unknown> {
    return ipc.app.SetActiveView({ view });
  },
};
