import {useEffect, useState} from "react"
import type {LucideIcon} from "lucide-react"
import {Clock, Cpu, HardDrive, MemoryStick, Network, Thermometer} from "lucide-react"

import {MetricCard} from "@/components/metric-card"
import {metricsGateway} from "@/gateway/metrics-gateway"
import type {MetricsSnapshot} from "@/gen/metrics"
import {baseState, isLive, usageState} from "@/domain/metric-view"
import {formatBytes, formatCelsius, formatPercent, formatRate, formatUptime,} from "@/lib/format"

/**
 * Live overview grid. Subscribes once to the main-process metrics stream and
 * re-renders each card as snapshots arrive; the subscription is torn down on
 * unmount. Main owns the sampling cadence, so this component holds no timer.
 *
 * Presentation only: it reads the latest snapshot and renders derived views.
 * Until real sampling lands (I05+), groups arrive UNAVAILABLE/UNKNOWN, which the
 * cards render explicitly rather than as fake values.
 */
export function MetricsOverview() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null)

  useEffect(() => {
    // One subscription per mount; the returned unsubscribe is the cleanup.
    // The cards themselves render pending/unavailable when no snapshot arrives,
    // so stream health needs no separate status line.
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null))
  }, [])

  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
      {/* The four primary metrics are the cards; they sit centered in the space
          between the title row and the footer so the vertical margins match. */}
      <div className="flex flex-1 items-center">
        <div className="grid w-full grid-cols-2 gap-2.5">
          <CpuCard snapshot={snapshot} />
          <MemoryCard snapshot={snapshot} />
          <DiskCard snapshot={snapshot} />
          <NetworkCard snapshot={snapshot} />
        </div>
      </div>

      {/* Uptime and Temperature are secondary stats, kept quiet in the footer. */}
      <div className="flex flex-col gap-2">
        <div className="h-px bg-border" />
        <FooterStats snapshot={snapshot} />
      </div>
    </div>
  )
}

function CpuCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const cpu = snapshot?.cpu
  const state = cpu ? usageState(cpu.status, cpu.usagePercent) : "pending"
  const live = isLive(state)
  const identity = cpu && cpu.model ? `${cpu.model}${cpu.coreCount ? ` - ${cpu.coreCount} cores` : ""}` : undefined
  return (
    <MetricCard
      icon={Cpu}
      label="CPU"
      state={state}
      value={cpu ? formatPercent(cpu.usagePercent) : undefined}
      secondary={live ? identity : undefined}
      percent={live ? cpu?.usagePercent : undefined}
    />
  )
}

function MemoryCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const memory = snapshot?.memory
  const state = memory ? usageState(memory.status, memory.usedPercent) : "pending"
  const live = isLive(state)
  return (
    <MetricCard
      icon={MemoryStick}
      label="Memory"
      state={state}
      value={memory ? formatPercent(memory.usedPercent) : undefined}
      secondary={live ? `${formatBytes(memory!.usedBytes)} / ${formatBytes(memory!.totalBytes)}` : undefined}
      percent={live ? memory?.usedPercent : undefined}
    />
  )
}

function DiskCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const disk = snapshot?.disk
  const state = disk ? usageState(disk.status, disk.usedPercent) : "pending"
  const live = isLive(state)
  return (
    <MetricCard
      icon={HardDrive}
      label="Disk"
      state={state}
      value={disk ? formatPercent(disk.usedPercent) : undefined}
      secondary={live ? `${formatBytes(disk!.usedBytes)} / ${formatBytes(disk!.totalBytes)}` : undefined}
      percent={live ? disk?.usedPercent : undefined}
    />
  )
}

function NetworkCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const network = snapshot?.network
  const state = network ? baseState(network.status) : "pending"
  const live = isLive(state)
  return (
    <MetricCard
      icon={Network}
      label="Network"
      state={state}
      value={network && live ? `↓ ${formatRate(network.rxBytesPerSec)}` : undefined}
      secondary={network && live ? `↑ ${formatRate(network.txBytesPerSec)}` : undefined}
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
  const uptimeLive = uptime ? isLive(baseState(uptime.status)) : false

  const temperature = snapshot?.temperature
  const temperatureLive = temperature ? isLive(baseState(temperature.status)) : false

  return (
    <div className="flex items-center justify-between text-[11px]">
      <div>
        {uptime && uptimeLive ? (
          <FooterStat icon={Clock} label="Uptime" value={formatUptime(uptime.uptimeSeconds)} />
        ) : null}
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
