import { ipc } from '@mobrowser/api';
import type { BrowserWindow } from '@mobrowser/api';
import {
  GetProcessActionStatesRequest,
  GetProcessActionStatesResponse,
  ProcessSnapshot,
  RunProcessActionRequest,
  RunProcessActionResponse,
} from '../gen/process_explorer';
import {
  ProcessExplorerService as ProcessExplorerServiceImpl,
  ProcessExplorerServiceDescriptor,
} from '../gen/ipc_service';
import { ProcessActionService } from './process-action-service';
import { ProcessSnapshotService } from './process-snapshot-service';

/**
 * Owns the renderer-facing process explorer service.
 *
 * Composes the small process explorer pieces, consistent with
 * {@link import('../metrics/metrics-service').MetricsService}: the
 * {@link ProcessSnapshotService} owns native collection, the cached snapshot, and
 * the streaming `StreamRevisions` broadcast; the {@link ProcessActionService} owns
 * the main-authoritative reveal/quit/force-quit actions (validated against that
 * cached snapshot); and this class registers the unary methods and routes them to
 * the right piece. `GetProcessSnapshot` is delegated to the snapshot service;
 * `GetProcessActionStates`/`RunProcessAction` are delegated to the action service.
 *
 * Lifecycle mirrors the metrics service: {@link setActive} gates the collection
 * cadence (driven by {@link import('../application').Application} when the
 * Processes view is the visible one), and {@link dispose} (called from the app
 * quit path) tears down the cadence, the broadcast stream, and the unary handlers
 * so nothing is left dangling.
 *
 * Privacy: command-line arguments are sensitive. This service never logs request
 * targets or any process data, and action results stay count-only with no OS
 * diagnostics, paths, names, or arguments.
 */
export class ProcessExplorerService {
  private readonly snapshots = new ProcessSnapshotService();

  private readonly actions: ProcessActionService;

  /**
   * The unary handlers. Held as one object so {@link dispose} unregisters the
   * exact implementation that was registered. The streaming `StreamRevisions`
   * method is owned by the snapshot service's broadcast handle, so it is omitted
   * here.
   */
  private readonly unaryHandlers: Pick<
    ProcessExplorerServiceImpl,
    'GetProcessSnapshot' | 'GetProcessActionStates' | 'RunProcessAction'
  > = {
    GetProcessSnapshot: () => this.getProcessSnapshot(),
    GetProcessActionStates: (request) => this.getProcessActionStates(request),
    RunProcessAction: (request) => this.runProcessAction(request),
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
   * Activates or pauses process collection. Main calls this with `true` only when
   * the Processes view is the visible one (the window is shown and Processes is
   * the selected tab) and `false` otherwise, so the sensitive command-line reads
   * run only while the user is looking at the process list.
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

  /**
   * Returns the latest cached process snapshot from the snapshot service. Before
   * the first collection (or while the view is idle) this is an explicit
   * loading/unavailable snapshot, so the list view never renders fabricated rows.
   */
  private async getProcessSnapshot(): Promise<ProcessSnapshot> {
    return this.snapshots.getSnapshot();
  }

  /**
   * Returns per-action availability for a target, validated in the action service
   * against the latest snapshot. The request target carries privacy-sensitive
   * identity and is never logged.
   */
  private async getProcessActionStates(
    request: GetProcessActionStatesRequest,
  ): Promise<GetProcessActionStatesResponse> {
    return this.actions.getActionStates(request);
  }

  /**
   * Runs a validated action against a target through the action service (reveal /
   * confirmed quit / confirmed force quit). The request is never logged and the
   * result is count-only.
   */
  private async runProcessAction(
    request: RunProcessActionRequest,
  ): Promise<RunProcessActionResponse> {
    return this.actions.runAction(request);
  }
}
