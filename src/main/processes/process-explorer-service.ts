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
  SnapshotStatus,
} from '../gen/process_explorer';
import {
  ProcessExplorerService as ProcessExplorerServiceImpl,
  ProcessExplorerServiceDescriptor,
} from '../gen/ipc_service';

/** Action kinds the detail view exposes; all disabled until the action iteration. */
const ACTION_KINDS: readonly ProcessActionKind[] = [
  ProcessActionKind.PROCESS_ACTION_KIND_REVEAL,
  ProcessActionKind.PROCESS_ACTION_KIND_QUIT,
  ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
];

/**
 * Owns the renderer-facing process explorer service.
 *
 * This is the I10 contract skeleton: it registers `ProcessExplorerService` and
 * answers every call with an explicit not-yet-implemented state so the renderer
 * can subscribe and call without throwing. Native process collection, the
 * snapshot cadence/cache, per-process CPU deltas, and real reveal/quit/force-quit
 * actions are added in later iterations.
 *
 * Shape mirrors {@link import('../metrics/metrics-service').MetricsService}: the
 * server-streaming `StreamRevisions` method is owned by the no-implementation
 * broadcast handle (so a later cadence can publish revision pings), while the
 * three unary methods are registered with a small implementation object. Both
 * registrations are torn down in {@link dispose}, which the app quit path calls.
 *
 * Privacy: command-line arguments are sensitive. This service never logs request
 * targets or any process data, and action results stay count-only with no OS
 * diagnostics, paths, names, or arguments.
 */
export class ProcessExplorerService {
  /**
   * Broadcast handle for the streaming `StreamRevisions` method. It is held so a
   * later collection cadence can publish revision pings; in I10 nothing is
   * published yet because there is no snapshot to announce.
   */
  private readonly handle = ipc.registerService(ProcessExplorerServiceDescriptor);

  /**
   * The unary handlers. Held as one object so {@link dispose} unregisters the
   * exact implementation that was registered (the streaming method is omitted
   * because the broadcast handle owns it).
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
    // Register only the unary handlers here; the streaming method is owned by
    // the broadcast handle above (mixed-service pattern from the IPC docs).
    ipc.registerService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }

  /**
   * Stops the service. Disposes the broadcast stream (closing any subscribers)
   * and unregisters the unary handlers. Idempotent; called from the app quit
   * path so no IPC handler or stream subscriber is left dangling.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.handle.dispose();
    ipc.unregisterService(ProcessExplorerServiceDescriptor, this.unaryHandlers);
  }

  /**
   * Returns the current snapshot. Until native collection lands this is an
   * explicit LOADING snapshot with revision 0 and no rows, so the list view
   * renders a loading/empty state rather than a fabricated process list.
   */
  private async getProcessSnapshot(): Promise<ProcessSnapshot> {
    return {
      status: SnapshotStatus.SNAPSHOT_STATUS_LOADING,
      revision: 0,
      timestampMs: Date.now(),
      processes: [],
      warnings: [],
    };
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
