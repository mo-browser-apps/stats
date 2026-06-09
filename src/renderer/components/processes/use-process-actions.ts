import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { processExplorerGateway } from "@/gateway/process-explorer-gateway";
import {
  FieldStatus,
  ProcessActionKind,
  RunProcessActionResponse_Outcome as Outcome,
  type ActionState,
  type ProcessIdentity,
} from "@/gen/process_explorer";
import type { ProcessDetail } from "@/domain/process-detail";

/**
 * What {@link useProcessActions} exposes to the detail view's action row.
 */
interface ProcessActionsState {
  /**
   * Main's authoritative per-action availability for the current target.
   */
  actions: ActionState[];
  /**
   * True while an action is in flight; the whole row disables.
   */
  actionsBusy: boolean;
  /**
   * Transient, non-sensitive message for an OS refusal / failure, else undefined.
   */
  actionMessage?: string;
  /**
   * Forwards a chosen action kind to main, then re-pulls; action states are
   * refreshed unless the action terminated the target (the detail navigates
   * away from it then).
   */
  runAction: (kind: ProcessActionKind) => Promise<void>;
}

/**
 * Owns the detail's process-action concerns: the action target, its
 * main-authoritative {@link ActionState} list, the in-flight flag, a transient
 * non-success message, and the action runner.
 */
export function useProcessActions(
  detail: ProcessDetail | undefined,
  onActed: () => Promise<void>,
  onTerminated: (terminatedPid: number) => void,
): ProcessActionsState {
  const targetPid = detail?.pid;
  const targetStartedAt = detail?.startedAt === "ok" ? detail.startedAtUnixMs : undefined;
  const target = useMemo<ProcessIdentity | undefined>(() => {
    if (targetPid === undefined) {
      return undefined;
    }
    return {
      pid: targetPid,
      startedAtStatus:
        targetStartedAt === undefined
          ? FieldStatus.FIELD_STATUS_UNKNOWN
          : FieldStatus.FIELD_STATUS_OK,
      startedAtUnixMs: targetStartedAt ?? 0,
    };
  }, [targetPid, targetStartedAt]);
  const targetKey = target ? `${target.pid}:${target.startedAtStatus}:${target.startedAtUnixMs}` : "";
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const [actions, setActions] = useState<ActionState[]>([]);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

  const refreshActionStates = useCallback(async () => {
    if (!target) {
      setActions([]);
      return;
    }
    const requestedKey = targetKey;
    setActions([]);
    try {
      const response = await processExplorerGateway.getActionStates(target);
      // Ignore a response that arrived after the selection moved on.
      if (targetKeyRef.current === requestedKey) {
        setActions(response.actions);
      }
    } catch {
      // Keep the row disabled for this target until the next successful fetch.
      if (targetKeyRef.current === requestedKey) {
        setActions([]);
      }
    }
  }, [target, targetKey]);

  // Refresh states and clear any prior message whenever the target changes.
  useEffect(() => {
    setActionMessage(undefined);
    void refreshActionStates();
  }, [refreshActionStates]);

  const runAction = useCallback(
    async (kind: ProcessActionKind) => {
      if (!target || actionsBusy) {
        return;
      }
      setActionsBusy(true);
      setActionMessage(undefined);
      let terminated = false;
      try {
        const response = await processExplorerGateway.runAction(kind, target);
        terminated =
          response.outcome === Outcome.OUTCOME_SUCCEEDED &&
          (kind === ProcessActionKind.PROCESS_ACTION_KIND_QUIT ||
            kind === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT);
        setActionMessage(actionOutcomeMessage(response.outcome));
      } catch {
        // No diagnostic is logged - the target/result can carry process identity.
        setActionMessage("Action could not be completed.");
      } finally {
        setActionsBusy(false);
      }
      await onActed();
      if (terminated) {
        onTerminated(target.pid);
      } else {
        await refreshActionStates();
      }
    },
    [target, actionsBusy, onActed, onTerminated, refreshActionStates],
  );

  return { actions, actionsBusy, actionMessage, runAction };
}

/**
 * Maps a coarse action outcome to a short, non-sensitive message for the
 * detail's action row, or undefined when nothing needs to be said. Only an OS
 * refusal or an unspecified failure shows a message. The message is derived from
 * the outcome enum alone - it never includes a process name, path, or argv.
 */
function actionOutcomeMessage(outcome: Outcome): string | undefined {
  switch (outcome) {
    case Outcome.OUTCOME_NOT_PERMITTED:
      return "Couldn't quit - this process is owned by the system.";
    case Outcome.OUTCOME_NOT_ALLOWED:
      return "This action isn't allowed for this process.";
    case Outcome.OUTCOME_FAILED:
      return "Action could not be completed.";
    default:
      return undefined;
  }
}
