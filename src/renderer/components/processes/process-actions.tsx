import { type ReactNode } from "react";
import { FolderOpen, OctagonX, Power } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ActionDisabledReason,
  ProcessActionKind,
  type ActionState,
} from "@/gen/process_explorer";

/**
 * The fixed bottom action row of the detail view: Open (reveal in Finder),
 * Quit, and Force Quit. Presentation-only: enabled states come from main's
 * authoritative {@link ActionState} list and running an action just forwards
 * the kind; disabled buttons carry an honest tooltip explaining why.
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
      <p
        className={cn("min-h-4 text-[11px] text-muted-foreground", message ? undefined : "invisible")}
        role="status"
      >
        {message}
      </p>
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
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "text-destructive enabled:hover:bg-destructive/10 enabled:focus-visible:bg-destructive/10"
          : "text-foreground enabled:hover:bg-muted/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function revealTitle(reveal: ActionState | undefined): string {
  if (reveal === undefined) {
    // States are still being fetched; "unavailable" would be a false claim.
    return "Checking available actions...";
  }
  if (reveal.enabled) {
    return "Show the executable in Finder";
  }
  if (reveal.disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH) {
    return "Executable path is unavailable";
  }
  return "Reveal is unavailable for this process";
}

function destructiveTitle(verb: string, action: ActionState | undefined): string {
  if (action === undefined) {
    // States are still being fetched; "unavailable" would be a false claim.
    return "Checking available actions...";
  }
  if (action.enabled) {
    return `${verb} this process`;
  }
  switch (action.disabledReason) {
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
