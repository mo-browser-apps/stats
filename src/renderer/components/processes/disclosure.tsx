import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { appGateway } from "@/gateway/app-gateway";
import { cn } from "@/lib/utils";

/**
 * Smooth height/opacity wrapper for disclosure bodies.
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
        "grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
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
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    };
  }, []);

  function copy() {
    void appGateway
      .copyText(text)
      .then(() => {
        setCopied(true);
        // Restart the confirmation window on every copy, so a quick second
        // click is not cut short by the first click's timer.
        if (resetTimer.current !== null) {
          window.clearTimeout(resetTimer.current);
        }
        resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
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
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
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
