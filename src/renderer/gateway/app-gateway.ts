import { ipc } from '@/gen/ipc';

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
};
