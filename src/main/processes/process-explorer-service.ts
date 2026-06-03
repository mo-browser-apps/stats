import { ipc } from '@mobrowser/api';
import {
  ActionDisabledReason,
  GetProcessActionStatesRequest,
  GetProcessActionStatesResponse,
  ProcessActionKind,
  ProcessSnapshot,
  RunProcessActionRequest,
  RunProcessActionResponse,
  RunProcessActionResponse_Outcome,
} from '../gen/process_explorer';
import {
  ProcessExplorerService as ProcessExplorerServiceImpl,
  ProcessExplorerServiceDescriptor,
} from '../gen/ipc_service';
import { ProcessSnapshotService } from './process-snapshot-service';

/** Action kinds the detail view exposes; all disabled until the action iteration. */
const ACTION_KINDS: readonly ProcessActionKind[] = [
  ProcessActionKind.PROCESS_ACTION_KIND_REVEAL,
  ProcessActionKind.PROCESS_ACTION_KIND_QUIT,
  ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
];

/**
 * Owns the renderer-facing process explorer service.
 *
 * Composes the small process explorer pieces, consistent with
 * {@link import('../metrics/metrics-service').MetricsService}: the
 * {@link ProcessSnapshotService} owns native collection, the cached snapshot, and
 * the streaming `StreamRevisions` broadcast, while this class registers the unary
 * methods. `GetProcessSnapshot` is delegated to the snapshot service;
 * `GetProcessActionStates`/`RunProcessAction` stay not-yet-implemented because
 * main-authoritative reveal/quit/force-quit land in the action iteration (I14).
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

  constructor() {
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
   * Returns per-action availability for a target. Until actions are implemented
   * the target is reported invalid and every action is disabled with the
   * not-implemented reason. The request target is intentionally not inspected or
   * logged (it carries privacy-sensitive identity).
   */
  private async getProcessActionStates(
    _request: GetProcessActionStatesRequest,
  ): Promise<GetProcessActionStatesResponse> {
    return {
      targetValid: false,
      actions: ACTION_KINDS.map((kind) => ({
        kind,
        enabled: false,
        disabledReason: ActionDisabledReason.ACTION_DISABLED_REASON_NOT_IMPLEMENTED,
      })),
    };
  }

  /**
   * Runs an action against a target. Until actions are implemented this performs
   * nothing and reports NOT_IMPLEMENTED with a zero affected count. The request
   * is intentionally not inspected or logged.
   */
  private async runProcessAction(
    _request: RunProcessActionRequest,
  ): Promise<RunProcessActionResponse> {
    return {
      outcome: RunProcessActionResponse_Outcome.OUTCOME_NOT_IMPLEMENTED,
      affectedCount: 0,
    };
  }
}
