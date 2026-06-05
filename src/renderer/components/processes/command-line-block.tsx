import { Check, Copy } from "lucide-react"
import { useState } from "react"

import { appGateway } from "@/gateway/app-gateway"
import { cn } from "@/lib/utils"
import { UNAVAILABLE_TEXT } from "@/lib/format"
import type { DetailCommandLine } from "@/components/processes/process-view"

/**
 * The detail view's command-line block: the process's arguments in a readable
 * wrapping, scrollable region with a manual copy affordance.
 *
 * Command-line text is sensitive local debugging data. It is shown and copied
 * only on explicit user action and is never logged, persisted, or auto-copied.
 * Copy is routed through main (the renderer is sandboxed and cannot reach the
 * clipboard); main writes it to the user's clipboard and never logs it.
 */
export function CommandLineBlock({ commandLine }: { commandLine: DetailCommandLine }) {
  const value = commandLine.state === "ok" ? (commandLine.text ?? "") : undefined

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Command line
        </h3>
        {value !== undefined && value.length > 0 ? <CopyButton text={value} label="Copy command line" /> : null}
      </div>

      {value !== undefined ? (
        value.length > 0 ? (
          <div className="scrollbar-hidden max-h-24 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2.5">
            <p className="break-all whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
              {value}
            </p>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">No arguments</p>
        )
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {commandLine.state === "pending" ? "..." : UNAVAILABLE_TEXT}
        </p>
      )}
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
