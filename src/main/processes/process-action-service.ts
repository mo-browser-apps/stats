import process from "node:process";
import { app, desktop } from "@mobrowser/api";
import type { BrowserWindow } from "@mobrowser/api";
import {
  ActionDisabledReason,
  ActionState,
  FieldStatus,
  GetProcessActionStatesRequest,
  GetProcessActionStatesResponse,
  ProcessActionKind,
  ProcessIdentity,
  ProcessRow,
  ProcessSnapshot,
  RunProcessActionRequest,
  RunProcessActionResponse,
  RunProcessActionResponse_Outcome as Outcome,
} from "../gen/process_explorer";

/**
 * The action kinds the detail view exposes, in display order.
 */
const ACTION_KINDS: readonly ProcessActionKind[] = [
  ProcessActionKind.PROCESS_ACTION_KIND_REVEAL,
  ProcessActionKind.PROCESS_ACTION_KIND_QUIT,
  ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
];

/**
 * A deliberately narrow denylist of session-critical processes whose termination
 * would crash, log out, or visibly destabilize the macOS session. These cannot be
 * quit/force-quit regardless of who owns them.
 *
 * This is intentionally NOT a "block all Apple/system software" rule: ordinary
 * apps - including Apple's bundled apps like Notes - are quittable, and only this
 * hardcoded set is protected. Anything else may be signaled, and the OS is the
 * final backstop: a process owned by another user (e.g. a root daemon) rejects an
 * unprivileged signal with EPERM, reported as NOT_PERMITTED rather than greyed out.
 */
const CRITICAL_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "kernel_task", // the kernel
  "launchd", // PID 1, the init/service manager
  "WindowServer", // the display server; killing it logs the user out
  "loginwindow", // owns the login/user session
  "logind", // session lifecycle
  "SystemUIServer", // the menu bar
  "Dock", // the Dock and Mission Control
  "Finder", // the desktop and file UI
  "coreaudiod", // core audio; killing it breaks all sound
  "WindowManager", // Stage Manager / window management
]);

/**
 * Reads a string field only when it is explicitly OK and non-empty.
 */
function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value;
  }
  return undefined;
}

/**
 * Finds the row in a snapshot that still matches a target identity. When the
 * target carries an exact start time it must match too, so a reused PID does not
 * match; a target without start time falls back to PID only (destructive actions
 * apply a separate stable-identity guard before signaling). Pure: inspects
 * identity only, never a sensitive value.
 *
 * This `(pid, started_at)` match against the live cached snapshot is the action
 * path's staleness guard: it rejects an exited PID (not found) and a reused PID
 * (start time differs), without tying actions to the snapshot revision the user
 * happened to see when clicking.
 */
export function findTargetRow(
  snapshot: ProcessSnapshot,
  target: ProcessIdentity | undefined,
): ProcessRow | undefined {
  if (target === undefined) {
    return undefined;
  }
  const matches = snapshot.processes.filter((row) => (row.identity?.pid ?? 0) === target.pid);
  if (matches.length === 0) {
    return undefined;
  }
  // A target with a known start time must match it exactly (reused-PID guard);
  // a target with no recorded start time falls back to PID alone. Quit/Force Quit
  // still reject unstable target identities before sending a signal.
  if (target.startedAtStatus === FieldStatus.FIELD_STATUS_OK) {
    return matches.find(
      (row) =>
        row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK &&
        row.identity.startedAtUnixMs === target.startedAtUnixMs,
    );
  }
  return matches[0];
}

/**
 * True when a renderer target carries a PID-reuse-safe process identity.
 */
function hasStableTargetIdentity(target: ProcessIdentity | undefined): boolean {
  return target?.startedAtStatus === FieldStatus.FIELD_STATUS_OK;
}

/**
 * True when a resolved row is a session-critical process that must never be
 * signaled: PID 0/1 plus the {@link CRITICAL_PROCESS_NAMES} denylist - NOT a broad
 * "is it system/Apple software" check, so ordinary apps are not protected. Matched
 * against both the command name and the executable name so a process is caught
 * regardless of which one macOS reported.
 */
export function isCriticalProcess(row: ProcessRow): boolean {
  const pid = row.identity?.pid ?? 0;
  if (pid <= 1) {
    return true;
  }
  const commandName = okString(row.commandName);
  const executableName = okString(row.executableName);
  return (
    (commandName !== undefined && CRITICAL_PROCESS_NAMES.has(commandName)) ||
    (executableName !== undefined && CRITICAL_PROCESS_NAMES.has(executableName))
  );
}

/**
 * Computes the disabled reason for one action against an already-resolved,
 * non-stale row. Returns NONE when the action is allowed. Pure and side-effect
 * free so it can be unit tested in isolation.
 *
 * - Reveal needs an OK executable path (NO_PATH otherwise); always allowed for
 *   self/critical processes because opening a file in Finder is harmless.
 * - Quit / Force Quit require a known target start time (UNSTABLE_IDENTITY), then
 *   block MoStats itself (SELF) and session-critical processes (PROTECTED).
 *   Everything else is allowed; a root-owned daemon is not pre-emptively blocked
 *   here - the OS rejects the signal (EPERM -> NOT_PERMITTED) at execution time.
 */
export function disabledReasonFor(
  action: ProcessActionKind,
  row: ProcessRow,
  selfPid: number,
  target: ProcessIdentity | undefined,
): ActionDisabledReason {
  if (action === ProcessActionKind.PROCESS_ACTION_KIND_REVEAL) {
    return okString(row.executablePath) !== undefined
      ? ActionDisabledReason.ACTION_DISABLED_REASON_NONE
      : ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH;
  }

  if (!hasStableTargetIdentity(target)) {
    return ActionDisabledReason.ACTION_DISABLED_REASON_UNSTABLE_IDENTITY;
  }
  if ((row.identity?.pid ?? 0) === selfPid) {
    return ActionDisabledReason.ACTION_DISABLED_REASON_SELF;
  }
  if (isCriticalProcess(row)) {
    return ActionDisabledReason.ACTION_DISABLED_REASON_PROTECTED;
  }
  return ActionDisabledReason.ACTION_DISABLED_REASON_NONE;
}

/**
 * Owns the privileged, main-authoritative process actions for the detail view:
 * reveal-in-Finder, Quit (SIGTERM), and Force Quit (SIGKILL).
 *
 * Every action is validated here against the latest cached snapshot - never from
 * renderer-supplied state - so the renderer cannot drive a stale, critical, or
 * self target. Targets are matched by (pid, start time) identity; an exited or
 * reused-PID target resolves to STALE. Destructive actions are blocked only for
 * MoStats itself and the small {@link CRITICAL_PROCESS_NAMES} denylist; ordinary
 * apps are quittable, and the OS is the final guard for root-owned daemons (an
 * unprivileged signal returns EPERM -> NOT_PERMITTED). Force Quit (SIGKILL)
 * requires a native confirmation dialog, main-authoritative so the confirm step
 * cannot be skipped by a direct IPC call, because it kills immediately and loses
 * unsaved work; Quit (SIGTERM) is graceful and proceeds without a prompt.
 *
 * Privacy: results are count-only. This service never logs or returns OS
 * diagnostics, executable paths, process names, bundle identifiers, or
 * command-line arguments.
 */
export class ProcessActionService {
  /**
   * MoStats' own PID; destructive actions against it are always blocked.
   */
  private readonly selfPid = process.pid;

  /**
   * @param getSnapshot Returns the latest cached snapshot the actions validate
   *   against (the snapshot service's cache).
   * @param getParentWindow Returns the window to parent the confirmation dialog
   *   to, or null when no window is live (the dialog is then app-modal).
   */
  constructor(
    private readonly getSnapshot: () => ProcessSnapshot,
    private readonly getParentWindow: () => BrowserWindow | null,
  ) {}

  /**
   * Returns per-action availability for a target, validated against the latest
   * snapshot. When the target no longer matches (exited / reused PID), every action
   * is disabled with STALE and target_valid is false. The target identity is used
   * only for matching and is never logged.
   */
  getActionStates(request: GetProcessActionStatesRequest): GetProcessActionStatesResponse {
    const row = findTargetRow(this.getSnapshot(), request.target);
    if (row === undefined) {
      return {
        targetValid: false,
        actions: ACTION_KINDS.map((kind) => ({
          kind,
          enabled: false,
          disabledReason: ActionDisabledReason.ACTION_DISABLED_REASON_STALE,
        })),
      };
    }

    return {
      targetValid: true,
      actions: ACTION_KINDS.map((kind) => this.actionState(kind, row, request.target)),
    };
  }

  /**
   * Runs one validated action against one target. Re-resolves and re-checks the
   * target against the latest snapshot (the action states the renderer saw may be
   * stale), confirms Force Quit through a native dialog, then reveals or signals.
   * Returns a coarse, count-only outcome with no sensitive detail.
   *
   * Confirmation policy: only Force Quit (SIGKILL) confirms, because it kills
   * immediately and loses unsaved work. Quit (SIGTERM) is a graceful request the
   * process can save on, so it proceeds without a prompt.
   */
  async runAction(request: RunProcessActionRequest): Promise<RunProcessActionResponse> {
    const row = findTargetRow(this.getSnapshot(), request.target);
    if (row === undefined) {
      return { outcome: Outcome.OUTCOME_STALE_TARGET, affectedCount: 0 };
    }

    const disabledReason = disabledReasonFor(request.action, row, this.selfPid, request.target);
    if (disabledReason !== ActionDisabledReason.ACTION_DISABLED_REASON_NONE) {
      // NO_PATH/SELF/PROTECTED/UNSTABLE_IDENTITY collapse to count-only not allowed.
      return { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 };
    }

    if (request.action === ProcessActionKind.PROCESS_ACTION_KIND_REVEAL) {
      return this.reveal(row);
    }

    if (request.action === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT) {
      const confirmed = await this.confirmForceQuit(row);
      if (!confirmed) {
        // Treat a declined confirmation as a no-op, not a failure.
        return { outcome: Outcome.OUTCOME_SUCCEEDED, affectedCount: 0 };
      }

      const freshRow = findTargetRow(this.getSnapshot(), request.target);
      if (freshRow === undefined) {
        return { outcome: Outcome.OUTCOME_STALE_TARGET, affectedCount: 0 };
      }

      const freshDisabledReason = disabledReasonFor(
        request.action,
        freshRow,
        this.selfPid,
        request.target,
      );
      if (freshDisabledReason !== ActionDisabledReason.ACTION_DISABLED_REASON_NONE) {
        return { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 };
      }

      return this.signal(request.action, freshRow);
    }

    if (request.action === ProcessActionKind.PROCESS_ACTION_KIND_QUIT) {
      // SIGTERM is graceful and recoverable, so it proceeds without confirmation.
      return this.signal(request.action, row);
    }

    return { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 };
  }

  /**
   * Builds one {@link ActionState} for an already-resolved, non-stale row.
   */
  private actionState(
    kind: ProcessActionKind,
    row: ProcessRow,
    target: ProcessIdentity | undefined,
  ): ActionState {
    const disabledReason = disabledReasonFor(kind, row, this.selfPid, target);
    const enabled = disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_NONE;
    return {
      kind,
      enabled,
      disabledReason: enabled ? ActionDisabledReason.ACTION_DISABLED_REASON_NONE : disabledReason,
    };
  }

  /**
   * Reveals a resolved row's executable in Finder via the desktop shell.
   */
  private reveal(row: ProcessRow): RunProcessActionResponse {
    const path = okString(row.executablePath);
    if (path === undefined) {
      return { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 };
    }
    try {
      desktop.showPath(path);
      return { outcome: Outcome.OUTCOME_SUCCEEDED, affectedCount: 1 };
    } catch {
      // No diagnostic is logged - the path is sensitive.
      return { outcome: Outcome.OUTCOME_FAILED, affectedCount: 0 };
    }
  }

  /**
   * Sends SIGTERM (Quit) or SIGKILL (Force Quit) to a resolved row's PID.
   */
  private signal(action: ProcessActionKind, row: ProcessRow): RunProcessActionResponse {
    const pid = row.identity?.pid ?? 0;
    const signal = action === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(pid, signal);
      return { outcome: Outcome.OUTCOME_SUCCEEDED, affectedCount: 1 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      switch (code) {
        case "ESRCH":
          return { outcome: Outcome.OUTCOME_STALE_TARGET, affectedCount: 0 };
        case "EPERM":
          return { outcome: Outcome.OUTCOME_NOT_PERMITTED, affectedCount: 0 };
        default:
          return { outcome: Outcome.OUTCOME_FAILED, affectedCount: 0 };
      }
    }
  }

  /**
   * Shows the native Force Quit confirmation dialog and resolves to whether the
   * user confirmed. Main-authoritative, so the confirm step cannot be bypassed by
   * a direct IPC call. Names the process by display name only (no path/argv).
   */
  private async confirmForceQuit(row: ProcessRow): Promise<boolean> {
    const name = this.confirmationName(row);
    const result = await app.showMessageDialog({
      parentWindow: this.getParentWindow() ?? undefined,
      message: `Force Quit ${name}?`,
      informativeText: "The process will be killed immediately (SIGKILL).",
      type: "warning",
      buttons: [
        { label: "Cancel", type: "secondary" },
        { label: "Force Quit", type: "primary" },
      ],
    });
    return result.button.type === "primary";
  }

  /**
   * A display name for the confirmation dialog: localized app name, else executable
   * name, else command name, else the PID. Never a path or argv.
   */
  private confirmationName(row: ProcessRow): string {
    return (
      okString(row.app?.localizedName) ??
      okString(row.executableName) ??
      okString(row.commandName) ??
      `PID ${row.identity?.pid ?? 0}`
    );
  }
}
