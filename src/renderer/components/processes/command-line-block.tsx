import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react"
import { useState } from "react"

import { appGateway } from "@/gateway/app-gateway"
import { cn } from "@/lib/utils"
import { UNAVAILABLE_TEXT } from "@/lib/format"
import type { DetailCommandLine, DetailState } from "@/components/processes/process-view"

/**
 * The detail view's command-line block: a compact disclosure row that expands
 * to the process's arguments in a readable wrapping, scrollable region.
 *
 * Command-line text is sensitive local debugging data. It is shown and copied
 * only on explicit user action and is never logged, persisted, or auto-copied.
 * Copy is routed through main (the renderer is sandboxed and cannot reach the
 * clipboard); main writes it to the user's clipboard and never logs it.
 */
export function CommandLineBlock({ commandLine }: { commandLine: DetailCommandLine }) {
  const value = commandLine.state === "ok" ? (commandLine.text ?? "") : undefined

  return (
    <TextDisclosure
      label="Command line"
      value={value}
      state={commandLine.state}
      copyLabel="Copy command line"
      emptyText="No arguments"
      pendingText="..."
    />
  )
}

/**
 * A collapsed-by-default text disclosure for sensitive or very long process
 * fields. The visible header stays compact; expansion reveals the full wrapped
 * monospace value inside a bounded hidden-scrollbar area.
 */
export function TextDisclosure({
  label,
  value,
  state,
  copyLabel,
  emptyText = UNAVAILABLE_TEXT,
  pendingText = "--",
}: {
  label: string
  value?: string
  state: DetailState
  copyLabel: string
  emptyText?: string
  pendingText?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const hasContent = value !== undefined && value.length > 0
  const statusText =
    value !== undefined ? emptyText : state === "pending" ? pendingText : UNAVAILABLE_TEXT

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          disabled={!hasContent}
          aria-expanded={hasContent ? expanded : undefined}
          className={cn(
            "no-drag flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
            hasContent
              ? "hover:bg-muted/50"
              : "cursor-default text-muted-foreground disabled:opacity-100",
          )}
        >
          {hasContent ? (
            expanded ? (
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            ) : (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            )
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {label}
          </span>
          {!hasContent ? (
            <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
              {statusText}
            </span>
          ) : null}
        </button>
        {hasContent ? <CopyButton text={value} label={copyLabel} /> : null}
      </div>

      {hasContent && expanded ? (
        <div className="scrollbar-hidden max-h-24 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2.5">
          <p className="break-all whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
            {value}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * A small icon button that copies the given text to the system clipboard via
 * main and briefly confirms with a check. Failures are swallowed silently (no
 * diagnostic is logged - the text can be sensitive).
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void appGateway
      .copyText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => undefined)
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        "no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  )
}
