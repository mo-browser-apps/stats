import {
  ProcessActionDisabledReason,
  ProcessActionKind,
  ProcessActionStatus,
  ProcessActionTargetKind,
  type GetProcessActionStatesRequest,
  type GetProcessActionStatesResponse,
  type ProcessActionResult,
  type ProcessActionState,
  type ProcessActionTarget,
  type RunProcessActionRequest,
  type RunProcessActionResponse,
} from '../gen/process_explorer';
import type { ProcessSnapshotService } from './process-snapshot-service';

/**
 * Main-authoritative process actions (reveal, quit, force quit).
 *
 * Intentionally inert and safe until I14: it reports every action as disabled
 * and refuses to run anything, so no reveal is performed and no signal is ever
 * sent. The disabled reason reflects state: before the first collection there is
 * no snapshot to validate against, so it is `SNAPSHOT_UNAVAILABLE`; once I11's
 * collector stores a snapshot, target validation is simply not built yet, so it
 * is `NOT_IMPLEMENTED`. Real per-target validation and SIGTERM/SIGKILL land in
 * I14.
 */
export class ProcessActionService {
  constructor(private readonly snapshotService: ProcessSnapshotService) {}

  /**
   * Returns action enablement for a renderer-selected target. Every action is
   * disabled in this iteration; the renderer should render controls as
   * unavailable rather than enabling destructive operations.
   */
  getProcessActionStates(
    request: GetProcessActionStatesRequest,
  ): GetProcessActionStatesResponse {
    const disabledReason = this.getDisabledReason();
    return {
      states: request.actionKinds.map((actionKind) =>
        this.createDisabledState(actionKind, request.target, disabledReason),
      ),
    };
  }

  /**
   * Refuses to execute any action in this iteration and returns a count-only
   * safe blocked result. No command lines, paths, names, or OS diagnostics are
   * included.
   */
  runProcessAction(request: RunProcessActionRequest): RunProcessActionResponse {
    return {
      result: this.createBlockedResult(request.actionKind, this.getDisabledReason()),
    };
  }

  /**
   * The disabled reason for the current state: SNAPSHOT_UNAVAILABLE before the
   * first collection, NOT_IMPLEMENTED once a snapshot exists but action
   * validation has not been built (I14). Either way the action stays disabled.
   */
  private getDisabledReason(): ProcessActionDisabledReason {
    return this.snapshotService.getLatestSnapshot() === undefined
      ? ProcessActionDisabledReason.PROCESS_ACTION_DISABLED_REASON_SNAPSHOT_UNAVAILABLE
      : ProcessActionDisabledReason.PROCESS_ACTION_DISABLED_REASON_NOT_IMPLEMENTED;
  }

  private createDisabledState(
    actionKind: ProcessActionKind,
    target: ProcessActionTarget | undefined,
    disabledReason: ProcessActionDisabledReason,
  ): ProcessActionState {
    return {
      actionKind,
      targetKind:
        target?.targetKind ?? ProcessActionTargetKind.PROCESS_ACTION_TARGET_KIND_UNSPECIFIED,
      enabled: false,
      disabledReason,
      affectedProcessCount: 0,
      requiresConfirmation: isDestructiveAction(actionKind),
    };
  }

  private createBlockedResult(
    actionKind: ProcessActionKind,
    reason: ProcessActionDisabledReason,
  ): ProcessActionResult {
    return {
      actionKind,
      status: ProcessActionStatus.PROCESS_ACTION_STATUS_BLOCKED,
      reason,
      affectedProcessCount: 0,
      succeededProcessCount: 0,
      failedProcessCount: 0,
    };
  }
}

/** Quit and force quit are destructive and require renderer confirmation. */
function isDestructiveAction(actionKind: ProcessActionKind): boolean {
  return (
    actionKind === ProcessActionKind.PROCESS_ACTION_KIND_QUIT ||
    actionKind === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_KILL
  );
}
