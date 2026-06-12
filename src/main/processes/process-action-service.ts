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

/** The action kinds the detail view exposes, in display order. */
const ACTION_KINDS: readonly ProcessActionKind[] = [
  ProcessActionKind.PROCESS_ACTION_KIND_REVEAL,
  ProcessActionKind.PROCESS_ACTION_KIND_QUIT,
  ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
];

/**
 * A deliberately narrow denylist of session-critical processes whose
 * termination would crash, log out, or visibly destabilize the macOS session.
 * Intentionally NOT a broad "all Apple software" rule: ordinary apps stay
 * quittable, and the OS is the final backstop for the rest (an unprivileged
 * signal to another user's process fails with EPERM -> NOT_PERMITTED).
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

/** Reads a string field only when it is explicitly OK and non-empty. */
function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value;
  }
  return undefined;
}

/**
 * Finds the row in a snapshot that still matches a target identity - the
 * action path's staleness guard. A target with a known start time must match
 * it exactly, so an exited PID (not found) and a reused PID (start time
 * differs) both miss; a target without one falls back to PID alone.
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
  if (target.startedAtStatus === FieldStatus.FIELD_STATUS_OK) {
    return matches.find(
      (row) =>
        row.identity?.startedAtStatus === FieldStatus.FIELD_STATUS_OK &&
        row.identity.startedAtUnixMs === target.startedAtUnixMs,
    );
  }
  return matches[0];
}

/** True when a renderer target carries a PID-reuse-safe process identity. */
function hasStableTargetIdentity(target: ProcessIdentity | undefined): boolean {
  return target?.startedAtStatus === FieldStatus.FIELD_STATUS_OK;
}

/**
 * True for a session-critical process that must never be signaled: PID 0/1
 * plus the {@link CRITICAL_PROCESS_NAMES} denylist, matched against both the
 * command name and the executable name.
 */
export function isCriticalProcess(row: ProcessRow): boolean {
  const pid = row.identity?.pid ?? 0;
  if (pid <= 1) {
    return true;
  }
  const commandName = okString(row.statics?.commandName);
  const executableName = okString(row.statics?.executableName);
  return (
    (commandName !== undefined && CRITICAL_PROCESS_NAMES.has(commandName)) ||
    (executableName !== undefined && CRITICAL_PROCESS_NAMES.has(executableName))
  );
}

/**
 * The disabled reason for one action against an already-resolved row, or NONE
 * when allowed. Reveal only needs an OK executable path (opening Finder is
 * harmless even for self/critical processes). Quit/Force Quit require a known
 * start time (UNSTABLE_IDENTITY), then block MoStats itself (SELF) and
 * session-critical processes (PROTECTED); a root-owned daemon is not
 * pre-emptively blocked - the OS rejects the signal at execution time.
 */
export function disabledReasonFor(
  action: ProcessActionKind,
  row: ProcessRow,
  selfPid: number,
  target: ProcessIdentity | undefined,
): ActionDisabledReason {
  if (action === ProcessActionKind.PROCESS_ACTION_KIND_REVEAL) {
    return okString(row.statics?.executablePath) !== undefined
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
 * Owns the privileged process actions for the detail view: reveal-in-Finder,
 * Quit (SIGTERM), and Force Quit (SIGKILL).
 *
 * Every action is validated here against the latest cached snapshot - never
 * renderer-supplied state - so the renderer cannot drive a stale, critical, or
 * self target. Force Quit confirms through a native dialog in main, so the
 * confirm step cannot be skipped by a direct IPC call; Quit is graceful and
 * proceeds without a prompt.
 *
 * Privacy: results are count-only; no OS diagnostics, paths, names, or
 * arguments are logged or returned.
 */
export class ProcessActionService {
  /** MoStats' own PID; destructive actions against it are always blocked. */
  private readonly selfPid = process.pid;

  /**
   * @param getSnapshot Returns the latest cached snapshot to validate against -
   *   the main-side form with statics joined onto rows (names and paths are
   *   read from row.statics).
   * @param getParentWindow Returns the window to parent the confirmation
   *   dialog to, or null when none is live (the dialog is then app-modal).
   */
  constructor(
    private readonly getSnapshot: () => ProcessSnapshot,
    private readonly getParentWindow: () => BrowserWindow | null,
  ) {}

  /**
   * Per-action availability for a target. When the target no longer matches
   * (exited / reused PID), every action is disabled with STALE.
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
   * Runs one action against one target, re-validating against the latest
   * snapshot (the states the renderer saw may be stale). Returns a coarse,
   * count-only outcome.
   */
  async runAction(request: RunProcessActionRequest): Promise<RunProcessActionResponse> {
    const resolved = this.resolveAllowedRow(request);
    if (resolved.row === undefined) {
      return resolved.blocked;
    }

    switch (request.action) {
      case ProcessActionKind.PROCESS_ACTION_KIND_REVEAL:
        return this.reveal(resolved.row);
      case ProcessActionKind.PROCESS_ACTION_KIND_QUIT:
        // SIGTERM is graceful and recoverable, so no confirmation.
        return this.signal(request.action, resolved.row);
      case ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT:
        return this.confirmAndForceQuit(request, resolved.row);
      default:
        return { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 };
    }
  }

  /**
   * Resolves the request target against the latest snapshot and checks the
   * action is allowed, returning the row or the blocking response.
   */
  private resolveAllowedRow(
    request: RunProcessActionRequest,
  ): { row: ProcessRow; blocked?: undefined } | { row?: undefined; blocked: RunProcessActionResponse } {
    const row = findTargetRow(this.getSnapshot(), request.target);
    if (row === undefined) {
      return { blocked: { outcome: Outcome.OUTCOME_STALE_TARGET, affectedCount: 0 } };
    }
    const disabledReason = disabledReasonFor(request.action, row, this.selfPid, request.target);
    if (disabledReason !== ActionDisabledReason.ACTION_DISABLED_REASON_NONE) {
      // NO_PATH/SELF/PROTECTED/UNSTABLE_IDENTITY collapse to count-only not allowed.
      return { blocked: { outcome: Outcome.OUTCOME_NOT_ALLOWED, affectedCount: 0 } };
    }
    return { row };
  }

  /**
   * Confirms Force Quit through the native dialog, then re-resolves the target
   * (it may have exited while the dialog was up) before signaling. A declined
   * confirmation is a no-op, not a failure.
   */
  private async confirmAndForceQuit(
    request: RunProcessActionRequest,
    row: ProcessRow,
  ): Promise<RunProcessActionResponse> {
    const confirmed = await this.confirmForceQuit(row);
    if (!confirmed) {
      return { outcome: Outcome.OUTCOME_SUCCEEDED, affectedCount: 0 };
    }

    const fresh = this.resolveAllowedRow(request);
    if (fresh.row === undefined) {
      return fresh.blocked;
    }
    return this.signal(request.action, fresh.row);
  }

  private actionState(
    kind: ProcessActionKind,
    row: ProcessRow,
    target: ProcessIdentity | undefined,
  ): ActionState {
    const disabledReason = disabledReasonFor(kind, row, this.selfPid, target);
    return {
      kind,
      enabled: disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_NONE,
      disabledReason,
    };
  }

  /** Reveals a resolved row's executable in Finder via the desktop shell. */
  private reveal(row: ProcessRow): RunProcessActionResponse {
    const path = okString(row.statics?.executablePath);
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

  /** Sends SIGTERM (Quit) or SIGKILL (Force Quit) to a resolved row's PID. */
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

  /** Shows the native Force Quit confirmation; names the process by display name only. */
  private async confirmForceQuit(row: ProcessRow): Promise<boolean> {
    const name =
      okString(row.statics?.app?.localizedName) ??
      okString(row.statics?.executableName) ??
      okString(row.statics?.commandName) ??
      `PID ${row.identity?.pid ?? 0}`;
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
}
