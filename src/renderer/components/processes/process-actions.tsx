import { FolderOpen, Power, Zap } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  ActionDisabledReason,
  ProcessActionKind,
  type ActionState,
} from "@/gen/process_explorer"

/**
 * The fixed bottom action row of the detail view: Open (reveal in Finder), Quit,
 * and Force Quit for the selected process.
 *
 * Presentation-only. Every button's enabled state and disabled reason come from
 * main (the authoritative {@link ActionState} list), and running an action just
 * forwards the kind through {@link onRun} to main, which re-validates, confirms
 * destructive actions with a native dialog, and applies self/system/stale
 * protections. The renderer never executes an action itself. Disabled buttons
 * carry an honest tooltip so the user knows why an action is unavailable (e.g.
 * the target is MoStats itself or a system process).
 */
export function ProcessActions({
  actions,
  busy,
  onRun,
}: {
  actions: ActionState[]
  busy: boolean
  onRun: (kind: ProcessActionKind) => void
}) {
  const reveal = actions.find((a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_REVEAL)
  const quit = actions.find((a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_QUIT)
  const forceQuit = actions.find(
    (a) => a.kind === ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT,
  )

  return (
    <div className="flex items-center gap-2 border-t border-border/60 pt-3">
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
          icon={<Zap className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          disabled={busy || !forceQuit?.enabled}
          onClick={() => onRun(ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT)}
          destructive
        />
      </div>
    </div>
  )
}

/** One compact action button, styled to match the detail view's quiet controls. */
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
  icon: React.ReactNode
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
        "no-drag flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "border-destructive/40 text-destructive hover:bg-destructive/10"
          : "border-border text-foreground hover:bg-muted/60",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** Tooltip for the reveal button, honest about why it is unavailable. */
function revealTitle(reveal: ActionState | undefined): string {
  if (reveal?.enabled) {
    return "Show the executable in Finder"
  }
  if (reveal?.disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH) {
    return "Executable path is unavailable"
  }
  return "Reveal is unavailable for this process"
}

/** Tooltip for a destructive button, honest about why it is unavailable. */
function destructiveTitle(verb: string, action: ActionState | undefined): string {
  if (action?.enabled) {
    return `${verb} this process`
  }
  switch (action?.disabledReason) {
    case ActionDisabledReason.ACTION_DISABLED_REASON_SELF:
      return `Cannot ${verb.toLowerCase()} MoStats itself`
    case ActionDisabledReason.ACTION_DISABLED_REASON_PROTECTED:
      return `Cannot ${verb.toLowerCase()} a system process`
    case ActionDisabledReason.ACTION_DISABLED_REASON_STALE:
      return "This process is no longer available"
    default:
      return `${verb} is unavailable for this process`
  }
}
