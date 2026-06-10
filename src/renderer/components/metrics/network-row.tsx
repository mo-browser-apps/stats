import { Network } from "lucide-react";

import { MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import type { MetricsSnapshot } from "@/gen/metrics";
import { baseState, isLive } from "@/domain/metric-view";
import { formatRateParts } from "@/lib/format";

/** Down (rx) and up (tx) rates grouped on one line; network has no meter. */
export function NetworkRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const network = snapshot?.network;
  const live = network ? isLive(baseState(network.status)) : false;

  return (
    <MetricRowHeader icon={Network} label="Network">
      {live && network ? (
        <span className="flex items-baseline gap-3">
          <Rate prefix="↓" bytesPerSec={network.rxBytesPerSec} />
          <Rate prefix="↑" bytesPerSec={network.txBytesPerSec} />
        </span>
      ) : null}
    </MetricRowHeader>
  );
}

function Rate({ prefix, bytesPerSec }: { prefix: string; bytesPerSec: number }) {
  const { value, unit } = formatRateParts(bytesPerSec);
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-sm font-light text-muted-foreground">{prefix}</span>
      <ValueUnit value={value} unit={unit} />
    </span>
  );
}
