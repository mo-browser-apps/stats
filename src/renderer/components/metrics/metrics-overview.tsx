import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Clock, Thermometer } from "lucide-react";

import { CpuRow } from "@/components/metrics/cpu-row";
import { MemoryRow } from "@/components/metrics/memory-row";
import { DiskRow } from "@/components/metrics/disk-row";
import { NetworkRow } from "@/components/metrics/network-row";
import { metricsGateway } from "@/gateway/metrics-gateway";
import type { MetricsSnapshot } from "@/gen/metrics";
import { baseState, displayText, isLive } from "@/domain/metric-view";
import { formatCelsius, formatUptime } from "@/lib/format";

/**
 * Live overview (the Stats view). Subscribes to the metrics stream only while
 * active and keeps the last rows across tab switches; main owns the cadence.
 */
export function MetricsOverview({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    return metricsGateway.subscribe(setSnapshot, () => setSnapshot(null));
  }, [active]);

  return (
    <div className="flex flex-1 flex-col justify-center px-6 pb-5 pt-2">
      <div className="flex flex-col divide-y divide-border/50">
        <div className="pb-4">
          <CpuRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <MemoryRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <DiskRow snapshot={snapshot} />
        </div>
        <div className="py-4">
          <NetworkRow snapshot={snapshot} />
        </div>
        <div className="pt-4">
          <FooterStats snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact footer: Uptime left, CPU temperature right. Temperature is
 * best-effort on Apple Silicon, so it renders only when a sensor reading is
 * actually available rather than as a dead placeholder.
 */
function FooterStats({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const uptime = snapshot?.uptime;
  const uptimeState = uptime ? baseState(uptime.status) : "pending";
  const uptimeValue = displayText(uptimeState, formatUptime(uptime?.uptimeSeconds ?? 0));

  const temperature = snapshot?.temperature;
  const temperatureLive = temperature ? isLive(baseState(temperature.status)) : false;

  return (
    <div className="flex items-center justify-between text-[11px]">
      <FooterStat icon={Clock} label="Uptime" value={uptimeValue} />
      {temperature && temperatureLive ? (
        <FooterStat icon={Thermometer} label="CPU Temp" value={formatCelsius(temperature.celsius)} />
      ) : null}
    </div>
  );
}

function FooterStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
