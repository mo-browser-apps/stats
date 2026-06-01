import { useEffect, useState } from "react"
import { Cpu, MemoryStick, HardDrive, Network, Clock, Thermometer } from "lucide-react"

import { MetricCard } from "@/components/metric-card"
import { metricsGateway } from "@/gateway/metrics-gateway"
import type { MetricsSnapshot } from "@/gen/metrics"
import { baseState, usageState, isLive } from "@/domain/metric-view"
import {
  formatBytes,
  formatCelsius,
  formatLoadAverage,
  formatPercent,
  formatRate,
  formatTimestamp,
  formatUptime,
} from "@/lib/format"

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
  const [streamError, setStreamError] = useState(false)

  useEffect(() => {
    // One subscription per mount; the returned unsubscribe is the cleanup.
    const unsubscribe = metricsGateway.subscribe(
      (next) => {
        setStreamError(false)
        setSnapshot(next)
      },
      () => setStreamError(true),
    )
    return unsubscribe
  }, [])

  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
      <div className="grid grid-cols-2 gap-3">
        <CpuCard snapshot={snapshot} />
        <MemoryCard snapshot={snapshot} />
        <DiskCard snapshot={snapshot} />
        <NetworkCard snapshot={snapshot} />
        <UptimeCard snapshot={snapshot} />
        <TemperatureCard snapshot={snapshot} />
      </div>

      <StatusLine snapshot={snapshot} streamError={streamError} />
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

function UptimeCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const uptime = snapshot?.uptime
  const state = uptime ? baseState(uptime.status) : "pending"
  const live = isLive(state)
  return (
    <MetricCard
      icon={Clock}
      label="Uptime"
      state={state}
      value={uptime && live ? formatUptime(uptime.uptimeSeconds) : undefined}
      secondary={uptime && live ? `Load ${formatLoadAverage(uptime.loadAverage)}` : undefined}
    />
  )
}

function TemperatureCard({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const temperature = snapshot?.temperature
  const state = temperature ? baseState(temperature.status) : "pending"
  const live = isLive(state)
  return (
    <MetricCard
      icon={Thermometer}
      label="Temperature"
      state={state}
      value={temperature && live ? formatCelsius(temperature.celsius) : undefined}
    />
  )
}

/**
 * Footer caption: shows the last-update time, or an explicit connecting/error
 * state. Honest about stream health rather than silently showing stale cards.
 */
function StatusLine({
  snapshot,
  streamError,
}: {
  snapshot: MetricsSnapshot | null
  streamError: boolean
}) {
  let text: string
  if (streamError) {
    text = "Metrics stream disconnected."
  } else if (!snapshot) {
    text = "Connecting to metrics..."
  } else {
    text = `Updated ${formatTimestamp(snapshot.timestampMs)}`
  }

  return (
    <p className="mt-auto text-center text-[11px] text-muted-foreground tabular-nums">{text}</p>
  )
}
