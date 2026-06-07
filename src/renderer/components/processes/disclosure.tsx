import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { appGateway } from "@/gateway/app-gateway";
import { cn } from "@/lib/utils";

/**
 * Reusable disclosure and copy primitives for the detail view.
 *
 * Two generic building blocks: the smooth open/close wrapper used by the Members
 * section, and the clipboard copy button used by the inline Path / Command line
 * fields. Sensitive process text (paths, argv) is copied only on explicit user
 * action and is never logged, persisted, or auto-copied; copy routes through main
 * because the renderer is sandboxed.
 */

/**
 * Smooth height/opacity wrapper for compact disclosure bodies. It keeps content
 * mounted so close animations can run, while `inert` prevents hidden controls
 * from being reachable by keyboard.
 */
export function DisclosureContent({
  open,
  children,
}: {
  open: boolean
  children: ReactNode
}) {
  return (
    <div
      aria-hidden={!open}
      inert={open ? undefined : true}
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin-top] duration-150 ease-out motion-reduce:transition-none",
        open ? "mt-1.5 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * A small icon button that copies the given text to the system clipboard via
 * main and briefly confirms with a check. Failures are swallowed silently (no
 * diagnostic is logged - the text can be sensitive).
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void appGateway
      .copyText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
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
  );
}
