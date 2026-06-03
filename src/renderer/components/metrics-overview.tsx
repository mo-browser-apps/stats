import {useEffect, useState} from "react"
import type {LucideIcon} from "lucide-react"
import {Clock, Cpu, HardDrive, MemoryStick, Network, Thermometer} from "lucide-react"

import {MetricRow} from "@/components/metric-row"
import {metricsGateway} from "@/gateway/metrics-gateway"
import type {MetricsSnapshot} from "@/gen/metrics"
import {baseState, isLive, usageState} from "@/domain/metric-view"
import {UNAVAILABLE_TEXT, formatBytes, formatCelsius, formatPercent, formatRate, formatUptime,} from "@/lib/format"

/**
 * Live overview (the Stats view).
 *
 * Owns the metrics-stream subscription for its own lifetime: it subscribes on
 * mount and unsubscribes on unmount, holding the latest snapshot in local state.
 * Because the view switch mounts this only while Stats is on screen - and main
 * pauses the metrics cadence off the Stats view - the subscription exists exactly
 * when there is a live stream to consume. After returning to Stats the first
 * paint shows the last value until the next tick (~1s). Renders the snapshot as a
 * stack of metric rows; the renderer holds no sampling timer.
 */
export function MetricsOverview() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null)

  useEffect(() => {
    // One subscription per mount; the returned unsubscribe is the cleanup.
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null))
  }, [])

  return (
    <div className="flex flex-1 flex-col px-6 pb-5">
      <div className="flex flex-1 flex-col justify-center divide-y divide-border/50">
        <div className="pb-4">
          <CpuRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <MemoryRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <DiskRow snapshot={snapshot} />
        </div>
        <div className="pt-4">
          <NetworkRow snapshot={snapshot} />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="h-px bg-border/50" />
        <FooterStats snapshot={snapshot} />
      </div>
    </div>
  )
}

function CpuRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const cpu = snapshot?.cpu
  const state = cpu ? usageState(cpu.status, cpu.usagePercent) : "pending"
  const live = isLive(state)
  const detail = cpu && cpu.model ? `${cpu.model}${cpu.coreCount ? ` - ${cpu.coreCount} cores` : ""}` : undefined
  return (
    <MetricRow
      icon={Cpu}
      label="CPU"
      state={state}
      value={cpu ? formatPercent(cpu.usagePercent) : undefined}
      detail={live ? detail : undefined}
      percent={live ? cpu?.usagePercent : undefined}
    />
  )
}

function MemoryRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory
  const state = memory ? usageState(memory.status, memory.usedPercent) : "pending"
  const live = isLive(state)
  return (
    <MetricRow
      icon={MemoryStick}
      label="Memory"
      state={state}
      value={memory ? formatPercent(memory.usedPercent) : undefined}
      detail={live ? `${formatBytes(memory!.usedBytes)} / ${formatBytes(memory!.totalBytes)}` : undefined}
      percent={live ? memory?.usedPercent : undefined}
    />
  )
}

function DiskRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const disk = snapshot?.disk
  const state = disk ? usageState(disk.status, disk.usedPercent) : "pending"
  const live = isLive(state)
  return (
    <MetricRow
      icon={HardDrive}
      label="Disk"
      state={state}
      value={disk ? formatPercent(disk.usedPercent) : undefined}
      detail={live ? `${formatBytes(disk!.usedBytes)} / ${formatBytes(disk!.totalBytes)}` : undefined}
      percent={live ? disk?.usedPercent : undefined}
    />
  )
}

function NetworkRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const network = snapshot?.network
  const state = network ? baseState(network.status) : "pending"
  const live = isLive(state)
  return (
    <MetricRow
      icon={Network}
      label="Network"
      state={state}
      value={network && live ? `↓ ${formatRate(network.rxBytesPerSec)}` : undefined}
      detail={network && live ? `↑ ${formatRate(network.txBytesPerSec)}` : undefined}
    />
  )
}

/**
 * Compact footer: Uptime in the left corner and CPU temperature in the right
 * corner.
 *
 * CPU temperature is best-effort on Apple Silicon, so it is shown only when a
 * sensor reading is actually available rather than as a dead placeholder.
 */
function FooterStats({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const uptime = snapshot?.uptime
  const uptimeState = uptime ? baseState(uptime.status) : "pending"
  const uptimeLive = isLive(uptimeState)
  const uptimeValue = uptime && uptimeLive
    ? formatUptime(uptime.uptimeSeconds)
    : uptimeState === "pending"
      ? "--"
      : UNAVAILABLE_TEXT

  const temperature = snapshot?.temperature
  const temperatureLive = temperature ? isLive(baseState(temperature.status)) : false

  return (
    <div className="flex items-center justify-between text-[11px]">
      <div>
        <FooterStat icon={Clock} label="Uptime" value={uptimeValue} />
      </div>

      <div>
        {temperature && temperatureLive ? (
          <FooterStat icon={Thermometer} label="CPU Temp" value={formatCelsius(temperature.celsius)} />
        ) : null}
      </div>
    </div>
  )
}

/** A single footer stat: quiet icon + label, then the value. */
function FooterStat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}
