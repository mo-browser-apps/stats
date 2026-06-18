import { Clock, Cpu, User } from "lucide-react";
import { type ReactNode } from "react";

import { CopyButton } from "@/components/processes/disclosure";
import { ScrollFade } from "@/components/processes/scroll-fade";
import type { DetailField, DetailState, ProcessDetail } from "@/domain/process-detail";
import { UNAVAILABLE_TEXT } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The secondary-stat strip under the header: user, threads, CPU time. */
export function HeaderStats({ detail, grouped }: { detail: ProcessDetail; grouped: boolean }) {
  const threadsText =
    detail.threadCount.state === "ok"
      ? `${detail.threadCount.text} ${detail.threadCount.text === "1" ? "thread" : "threads"}`
      : undefined;

  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      <HeaderStat
        icon={<User className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
        state={detail.user.state}
        text={detail.user.text}
        label="User"
        className="min-w-0 flex-1"
        valueClassName="truncate"
      />
      <div className="flex shrink-0 items-center gap-2">
        <HeaderStat
          icon={<Cpu className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          state={detail.threadCount.state}
          text={threadsText}
          label={grouped ? "Total threads" : "Threads"}
        />
        <HeaderStat
          icon={<Clock className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
          state={detail.cpuTime.state}
          text={detail.cpuTime.text}
          label={grouped ? "Total CPU time" : "CPU time"}
        />
      </div>
    </div>
  );
}

/** One stat in the header strip: a small icon plus its value. */
function HeaderStat({
  icon,
  state,
  text,
  label,
  className,
  valueClassName,
}: {
  icon: ReactNode
  state: DetailState
  text?: string
  label: string
  className?: string
  valueClassName?: string
}) {
  const value = state === "ok" && text !== undefined ? text : "n/a";
  return (
    <span className={cn("flex items-center gap-1", className)} title={`${label}: ${value}`}>
      {icon}
      <span
        className={cn(
          "tabular-nums",
          state === "ok" ? "text-foreground" : "text-muted-foreground",
          valueClassName,
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** A labeled detail field: a quiet uppercase label, the value below. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Renders a value's pending/unavailable state, or the provided OK text. */
export function StateText({ state, text }: { state: DetailState; text?: string }) {
  if (state === "ok" && text !== undefined) {
    return <span className="text-[12px] text-foreground">{text}</span>;
  }
  return (
    <span className="text-[12px] text-muted-foreground">
      {state === "pending" ? "--" : UNAVAILABLE_TEXT}
    </span>
  );
}

/** Long single-line value (path, command line) with a copy button routed through main. */
export function ScrollableValue({
  field,
  copyLabel,
  emptyText = UNAVAILABLE_TEXT,
  pendingText = "--",
}: {
  field: DetailField
  copyLabel: string
  emptyText?: string
  pendingText?: string
}) {
  const text = field.state === "ok" ? field.text ?? "" : undefined;

  if (text === undefined || text.length === 0) {
    const placeholder =
      text !== undefined ? emptyText : field.state === "pending" ? pendingText : UNAVAILABLE_TEXT;
    return <span className="text-[12px] text-muted-foreground">{placeholder}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <ScrollFade className="flex-1" title={text}>
        <span className="block w-max whitespace-nowrap font-mono text-[11px] leading-relaxed text-foreground">
          {text}
        </span>
      </ScrollFade>
      <CopyButton text={text} label={copyLabel} />
    </div>
  );
}
