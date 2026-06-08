import { type ReactNode } from "react";
import { FolderOpen, OctagonX, Power } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ActionDisabledReason,
  ProcessActionKind,
  type ActionState,
} from "@/gen/process_explorer";

/**
 * The fixed bottom action row of the detail view: Open (reveal in Finder), Quit,
 * and Force Quit for the selected process.
 *
 * Presentation-only. Each button's enabled state and disabled reason come from
 * main (the authoritative {@link ActionState} list), and running an action just
 * forwards the kind through {@link onRun}; the renderer never executes an action
 * itself. Disabled buttons carry an honest tooltip explaining why.
 */
export function ProcessActions({
  actions,
  busy,
  message,
  onRun,
}: {
  actions: ActionState[]
  busy: boolean
  message?: string
  onRun: (kind: ProcessActionKind) => void
}) {
  const reveal = actions.find((a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_REVEAL);
  const quit = actions.find((a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_QUIT);
  const forceQuit = actions.find(
    (a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      {message ? (
        <p className="text-[11px] text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <ActionButton
          label="Open"
          title={revealTitle(reveal)}
          icon={<FolderOpen className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          disabled={busy || !reveal?.enabled}
          onClick={() => onRun(ProcessActionKind.PROCESS_ACTION_KIND_REVEAL)}
        />
        <div className="ml-auto flex items-center gap-2">
          <ActionButton
            label="Quit"
            title={destructiveTitle("Quit", quit)}
            icon={<Power className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
            disabled={busy || !quit?.enabled}
            onClick={() => onRun(ProcessActionKind.PROCESS_ACTION_KIND_QUIT)}
          />
          <ActionButton
            label="Force Quit"
            title={destructiveTitle("Force Quit", forceQuit)}
            icon={<OctagonX className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
            disabled={busy || !forceQuit?.enabled}
            onClick={() => onRun(ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT)}
            destructive
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One compact action button, styled to match the detail view's quiet controls.
 */
function ActionButton({
  label,
  title,
  icon,
  disabled,
  onClick,
  destructive = false,
}: {
  label: string
  title: string
  icon: ReactNode
  disabled: boolean
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "no-drag flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "text-destructive/80 enabled:hover:bg-destructive/10 enabled:hover:text-destructive enabled:focus-visible:bg-destructive/10 enabled:focus-visible:text-destructive"
          : "text-foreground enabled:hover:bg-muted/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Tooltip for the reveal button, honest about why it is unavailable.
 */
function revealTitle(reveal: ActionState | undefined): string {
  if (reveal?.enabled) {
    return "Show the executable in Finder";
  }
  if (reveal?.disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH) {
    return "Executable path is unavailable";
  }
  return "Reveal is unavailable for this process";
}

/**
 * Tooltip for a destructive button, honest about why it is unavailable.
 */
function destructiveTitle(verb: string, action: ActionState | undefined): string {
  if (action?.enabled) {
    return `${verb} this process`;
  }
  switch (action?.disabledReason) {
    case ActionDisabledReason.ACTION_DISABLED_REASON_SELF:
      return `Cannot ${verb.toLowerCase()} MōStats itself`;
    case ActionDisabledReason.ACTION_DISABLED_REASON_PROTECTED:
      return `Cannot ${verb.toLowerCase()} a critical system process`;
    case ActionDisabledReason.ACTION_DISABLED_REASON_STALE:
      return "This process is no longer available";
    case ActionDisabledReason.ACTION_DISABLED_REASON_UNSTABLE_IDENTITY:
      return "Process start time is unavailable";
    default:
      return `${verb} is unavailable for this process`;
  }
}
