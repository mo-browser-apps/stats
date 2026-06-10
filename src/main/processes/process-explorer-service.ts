import { ipc } from "@mobrowser/api";
import type { BrowserWindow } from "@mobrowser/api";
import {
  ProcessExplorerService as ProcessExplorerServiceImpl,
  ProcessExplorerServiceDescriptor,
} from "../gen/ipc_service";
import { ProcessActionService } from "./process-action-service";
import { ProcessSnapshotService } from "./process-snapshot-service";

/**
 * Owns the renderer-facing process explorer service.
 *
 * Composes the process explorer pieces: the {@link ProcessSnapshotService} owns
 * native collection, the cached snapshot, and the streaming `StreamRevisions`
 * broadcast; the {@link ProcessActionService} owns the main-authoritative
 * reveal/quit/force-quit actions (validated against that cached snapshot); and
 * this class registers the unary methods and routes each to the right piece.
 *
 * {@link setActive} gates the collection cadence (driven by main when the Processes
 * view is the visible one), and {@link dispose} (called from the app quit path)
 * tears down the cadence, the broadcast stream, and the unary handlers so nothing
 * is left dangling.
 *
 * Privacy: command-line arguments are sensitive. This service never logs request
 * targets or any process data, and action results stay count-only with no OS
 * diagnostics, paths, names, or arguments.
 */
export class ProcessExplorerService {
  private readonly snapshots = new ProcessSnapshotService();

  private readonly actions: ProcessActionService;

  /**
   * The unary handlers, each a thin route to the owning piece. Held as one object
   * so {@link dispose} unregisters the exact implementation that was registered.
   * The streaming `StreamRevisions` method is owned by the snapshot service's
   * broadcast handle, so it is omitted here. Requests carry privacy-sensitive
   * identity and are never logged; action results stay count-only.
   */
  private readonly unaryHandlers: Pick<
    ProcessExplorerServiceImpl,
    "GetProcessSnapshot" | "GetProcessIcons" | "GetProcessActionStates" | "RunProcessAction"
  > = {
    GetProcessSnapshot: async (request) =>
      this.snapshots.getSnapshot(request.haveRevision),
    GetProcessIcons: (request) => this.snapshots.getIcons(request.keys),
    GetProcessActionStates: async (request) => this.actions.getActionStates(request),
    RunProcessAction: (request) => this.actions.runAction(request),
  };

  private disposed = false;

  /**
   * @param getWindow Returns the live window (or null) so destructive-action
   *   confirmation dialogs can be parented to it. Passed lazily because the
   *   window is recreated across hide/show cycles.
   */
  constructor(getWindow: () => BrowserWindow | null) {
    this.actions = new ProcessActionService(() => this.snapshots.getSnapshot(), getWindow);
    ipc.registerService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }

  /**
   * Activates or pauses process collection. Main calls this with `true` only while
   * the Processes view is the visible one (window shown and Processes tab selected),
   * so the sensitive command-line reads run only while the user is looking at the
   * process list.
   */
  setActive(active: boolean): void {
    this.snapshots.setActive(active);
  }

  /**
   * Stops the service. Disposes the snapshot service (cadence + broadcast stream)
   * and unregisters the unary handlers. Idempotent; called from the app quit path
   * so no IPC handler or stream subscriber is left dangling.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.snapshots.dispose();
    ipc.unregisterService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }
}
