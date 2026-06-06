import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { processExplorerGateway } from "@/gateway/process-explorer-gateway";
import {
  FieldStatus,
  RunProcessActionResponse_Outcome as Outcome,
  type ActionState,
  type ProcessActionKind,
  type ProcessIdentity,
} from "@/gen/process_explorer";
import type { ProcessDetail } from "@/domain/process-detail";

/** What {@link useProcessActions} exposes to the detail view's action row. */
export interface ProcessActionsState {
  /** Main's authoritative per-action availability for the current target. */
  actions: ActionState[];
  /** True while an action is in flight; the whole row disables. */
  actionsBusy: boolean;
  /** Transient, non-sensitive message for an OS refusal / failure, else undefined. */
  actionMessage?: string;
  /** Forwards a chosen action kind to main, then re-pulls and refreshes states. */
  runAction: (kind: ProcessActionKind) => Promise<void>;
}

/**
 * Owns the detail's process-action concerns: the action target, its
 * main-authoritative {@link ActionState} list, the in-flight flag, a transient
 * non-success message, and the action runner. Kept out of the view component so
 * the latter stays focused on the snapshot lifecycle and list/detail rendering.
 *
 * The target is derived from the open `detail` but keyed on its primitive
 * identity (pid + start time) so it is stable across the 2s snapshot ticks (the
 * detail object is a fresh reference each tick) and does not refetch needlessly.
 * A `targetKey` guard drops out-of-order `getActionStates` responses. Action
 * requests do not carry a snapshot revision: main validates the target by
 * identity against its latest cached snapshot. `onActed` re-pulls the snapshot
 * after an action so a killed process drops promptly and the detail falls back.
 */
export function useProcessActions(
  detail: ProcessDetail | undefined,
  onActed: () => Promise<void>,
): ProcessActionsState {
  const targetPid = detail?.pid;
  const targetStartedAt = detail?.startedAt === "ok" ? detail.startedAtUnixMs : undefined;
  const target = useMemo<ProcessIdentity | undefined>(
    () =>
      targetPid === undefined
        ? undefined
        : {
            pid: targetPid,
            startedAtStatus:
              targetStartedAt === undefined
                ? FieldStatus.FIELD_STATUS_UNKNOWN
                : FieldStatus.FIELD_STATUS_OK,
            startedAtUnixMs: targetStartedAt ?? 0,
          },
    [targetPid, targetStartedAt],
  );
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
      try {
        const response = await processExplorerGateway.runAction(kind, target);
        // A succeeded quit/force-quit drops the row and the detail falls back, so
        // only a non-success outcome needs surfacing. Messages are derived from the
        // coarse outcome only - they carry no process identity.
        setActionMessage(actionOutcomeMessage(response.outcome));
      } catch {
        // No diagnostic is logged - the target/result can carry process identity.
        setActionMessage("Action could not be completed.");
      } finally {
        setActionsBusy(false);
      }
      // Re-pull so a quit/force-quit drops the row promptly (the detail then falls
      // back down the stack), and refresh the action availability for what remains.
      await onActed();
      await refreshActionStates();
    },
    [target, actionsBusy, onActed, refreshActionStates],
  );

  return { actions, actionsBusy, actionMessage, runAction };
}

/**
 * Maps a coarse action outcome to a short, non-sensitive message for the detail's
 * action row, or undefined when nothing needs to be said. A succeeded action
 * drops the row (the detail falls back), and a stale target likewise resolves to
 * a different view, so neither shows a message; only an OS refusal or an
 * unspecified failure does. The message is derived from the outcome enum alone -
 * it never includes a process name, path, or argv.
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
