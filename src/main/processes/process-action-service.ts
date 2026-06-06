import process from 'node:process';
import { app, desktop } from '@mobrowser/api';
import type { BrowserWindow } from '@mobrowser/api';
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
} from '../gen/process_explorer';

/** The action kinds the detail view exposes, in display order. */
const ACTION_KINDS: readonly ProcessActionKind[] = [
  ProcessActionKind.PROCESS_ACTION_KIND_REVEAL,
  ProcessActionKind.PROCESS_ACTION_KIND_QUIT,
  ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
];

/**
 * POSIX path prefixes that mark a system-owned executable. A process running
 * from one of these is treated as system-critical and cannot be quit/force-quit,
 * mirroring Activity Monitor's refusal to kill core OS processes.
 */
const SYSTEM_PATH_PREFIXES: readonly string[] = [
  '/System/',
  '/sbin/',
  '/usr/libexec/',
  '/usr/sbin/',
];

/**
 * Well-known system process names that must never be signaled even though they
 * may not live under a system path.
 */
const SYSTEM_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'kernel_task',
  'launchd',
  'loginwindow',
  'notifyd',
  'powerd',
  'WindowServer',
]);

/** Reads a string field only when it is explicitly OK and non-empty. */
function okString(value: { status: FieldStatus; value: string } | undefined): string | undefined {
  if (value && value.status === FieldStatus.FIELD_STATUS_OK && value.value.length > 0) {
    return value.value;
  }
  return undefined;
}

/**
 * Finds the row in a snapshot that still matches a target identity. When the
 * target carries an exact start time, it must match too so a reused PID does not
 * match. A target without start time falls back to PID only; destructive actions
 * apply a separate stable-identity guard before signaling. Pure: inspects
 * identity only, never a sensitive value.
 *
 * This `(pid, started_at)` identity match against the live cached snapshot is the
 * action path's staleness guard, and it supersedes the request's `revision`
 * field for targets with known start time: matching identity rejects an exited
 * PID (not found) and a reused PID (start time differs), which a coarser revision
 * compare would not, so the action service does not read `request.revision`.
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

/** True when a renderer target carries a PID-reuse-safe process identity. */
function hasStableTargetIdentity(target: ProcessIdentity | undefined): boolean {
  return target?.startedAtStatus === FieldStatus.FIELD_STATUS_OK;
}

/** True when a resolved row is a protected/system-critical process. */
export function isSystemProcess(row: ProcessRow): boolean {
  const pid = row.identity?.pid ?? 0;
  if (pid <= 1) {
    return true;
  }
  const commandName = okString(row.commandName);
  const executableName = okString(row.executableName);
  if (
    (commandName !== undefined && SYSTEM_PROCESS_NAMES.has(commandName)) ||
    (executableName !== undefined && SYSTEM_PROCESS_NAMES.has(executableName))
  ) {
    return true;
  }
  const path = okString(row.executablePath);
  return path !== undefined && SYSTEM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Computes the disabled reason for one action against an already-resolved,
 * non-stale row. Returns NONE when the action is allowed. Pure and side-effect
 * free so it can be unit tested in isolation (I15).
 *
 * - Reveal needs an OK executable path (NO_PATH otherwise); it is always allowed
 *   for self/system processes because opening a file in Finder is harmless.
 * - Quit / Force Quit require a known target start time (UNSTABLE_IDENTITY), then
 *   block MoStats itself (SELF) and system-critical processes (PROTECTED).
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
  if (isSystemProcess(row)) {
    return ActionDisabledReason.ACTION_DISABLED_REASON_PROTECTED;
  }
  return ActionDisabledReason.ACTION_DISABLED_REASON_NONE;
}

/**
 * Owns the privileged, main-authoritative process actions for the detail view:
 * reveal-in-Finder, Quit (SIGTERM), and Force Quit (SIGKILL).
 *
 * Every action is validated here against the latest cached snapshot - never from
 * renderer-supplied state - so the renderer cannot drive a stale, system, or
 * self target. Targets are matched by (pid, start time) identity; an exited or
 * reused-PID target resolves to STALE. Force Quit (SIGKILL) requires an explicit
 * native confirmation dialog (main-authoritative, so the confirm step cannot be
 * skipped by a direct IPC call) because it kills immediately and loses unsaved
 * work; Quit (SIGTERM) is graceful and proceeds without a prompt.
 *
 * Privacy: results are count-only. This service never logs or returns OS
 * diagnostics, executable paths, process names, bundle identifiers, or
 * command-line arguments. Technique reference (signals, self/system protections):
 * mo-activity ProcessActionService, re-implemented compact for MoStats' single
 * ProcessIdentity target rather than its multi-identity/group/classifier shape.
 */
export class ProcessActionService {
  /** MoStats' own PID; destructive actions against it are always blocked. */
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
   * snapshot. When the target no longer matches (exited / reused PID), every
   * action is disabled with STALE and target_valid is false. The target identity
   * is used only for matching and is never logged.
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
   * Confirmation policy: only Force Quit (SIGKILL) confirms, because it kills the
   * process immediately and loses unsaved work. Quit (SIGTERM) is a graceful
   * request the process can handle and save on, so it proceeds without a prompt to
   * keep the common case fast for a developer tool.
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

  /** Builds one {@link ActionState} for an already-resolved, non-stale row. */
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

  /** Reveals a resolved row's executable in Finder via the desktop shell. */
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

  /** Sends SIGTERM (Quit) or SIGKILL (Force Quit) to a resolved row's PID. */
  private signal(action: ProcessActionKind, row: ProcessRow): RunProcessActionResponse {
    const pid = row.identity?.pid ?? 0;
    const signal = action === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(pid, signal);
      return { outcome: Outcome.OUTCOME_SUCCEEDED, affectedCount: 1 };
    } catch (error) {
      // ESRCH means the process already exited between validation and the signal;
      // report it as stale rather than a hard failure. No process detail leaks.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === 'ESRCH'
        ? { outcome: Outcome.OUTCOME_STALE_TARGET, affectedCount: 0 }
        : { outcome: Outcome.OUTCOME_FAILED, affectedCount: 0 };
    }
  }

  /**
   * Shows the native Force Quit confirmation dialog and resolves to whether the
   * user confirmed. The dialog is main-authoritative, so the confirm step cannot
   * be bypassed by a direct IPC call. Only Force Quit confirms (SIGKILL kills
   * immediately and loses unsaved work); Quit does not. It names the single
   * process by display name only (no path/argv); a NSWorkspace-known app uses its
   * localized name, else the executable/command name, else just the PID.
   */
  private async confirmForceQuit(row: ProcessRow): Promise<boolean> {
    const name = this.confirmationName(row);
    const result = await app.showMessageDialog({
      parentWindow: this.getParentWindow() ?? undefined,
      message: `Force Quit ${name}?`,
      informativeText: 'The process will be killed immediately (SIGKILL).',
      type: 'warning',
      buttons: [
        { label: 'Cancel', type: 'secondary' },
        { label: 'Force Quit', type: 'primary' },
      ],
    });
    return result.button.type === 'primary';
  }

  /**
   * A non-sensitive display name for the confirmation dialog: localized app name,
   * else executable name, else command name, else the PID. Never a path or argv.
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
