import { ipc } from "@mobrowser/api";
import type { BrowserWindow } from "@mobrowser/api";
import {
  ProcessExplorerService as ProcessExplorerServiceImpl,
  ProcessExplorerServiceDescriptor,
} from "../gen/ipc_service";
import { ProcessActionService } from "./process-action-service";
import { ProcessSnapshotService } from "./process-snapshot-service";

/**
 * Composes the renderer-facing process explorer: the
 * {@link ProcessSnapshotService} owns collection, the cached snapshot, and the
 * StreamRevisions broadcast; the {@link ProcessActionService} owns the
 * main-authoritative reveal/quit/force-quit actions (validated against that
 * cache); this class registers the unary methods and routes each to its owner.
 */
export class ProcessExplorerService {
  private readonly snapshots = new ProcessSnapshotService();

  private readonly actions: ProcessActionService;

  /**
   * The unary handlers, held as one object so {@link dispose} unregisters the
   * exact implementation that was registered. The streaming StreamRevisions
   * method is owned by the snapshot service's broadcast handle.
   */
  private readonly unaryHandlers: Pick<
    ProcessExplorerServiceImpl,
    "GetProcessSnapshot" | "GetProcessIcons" | "GetProcessActionStates" | "RunProcessAction"
  > = {
    GetProcessSnapshot: async () => this.snapshots.getSnapshot(),
    GetProcessIcons: (request) => this.snapshots.getIcons(request.keys),
    GetProcessActionStates: async (request) => this.actions.getActionStates(request),
    RunProcessAction: (request) => this.actions.runAction(request),
  };

  private disposed = false;

  /**
   * @param getWindow Returns the live window (or null) to parent
   *   destructive-action confirmation dialogs; lazy because the window is
   *   recreated across hide/show cycles.
   */
  constructor(getWindow: () => BrowserWindow | null) {
    this.actions = new ProcessActionService(() => this.snapshots.getSnapshot(), getWindow);
    ipc.registerService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }

  /**
   * Activates or pauses collection; active only while the Processes view is on
   * screen, so the sensitive command-line reads run only while it is watched.
   */
  setActive(active: boolean): void {
    this.snapshots.setActive(active);
  }

  /** Stops collection and unregisters all handlers. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.snapshots.dispose();
    ipc.unregisterService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }
}
