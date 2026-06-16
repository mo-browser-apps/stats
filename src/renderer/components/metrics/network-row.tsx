import { useEffect, useState } from "react";
import { Network } from "lucide-react";

import { MeterTooltip, MetricRowHeader, ValueUnit } from "@/components/metrics/metric-row-header";
import { NetworkGraph, type NetSample } from "@/components/metrics/network-graph";
import type { MetricsSnapshot } from "@/gen/metrics";
import { MetricStatus } from "@/gen/metrics";
import { baseState, isLive } from "@/domain/metric-view";
import { HISTORY_CAPACITY, pushSample } from "@/domain/sample-history";
import { formatRateParts } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Network row: a mirrored down/up area chart with each direction's live rate
 * beside its own lane (scrubbing swaps them to the hovered second, like CPU).
 */
export function NetworkRow({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  const [history, setHistory] = useState<NetSample[]>([]);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const network = snapshot?.network;

  useEffect(() => {
    if (!network) return;
    // A non-finite value must enter history as a gap, not a sample: it would
    // turn the axis max NaN and blank every path until it ages out.
    const sample =
      network.status === MetricStatus.METRIC_STATUS_OK &&
      Number.isFinite(network.rxBytesPerSec) &&
      Number.isFinite(network.txBytesPerSec)
        ? { rxBytesPerSec: network.rxBytesPerSec, txBytesPerSec: network.txBytesPerSec }
        : null;
    setHistory((prev) => pushSample(prev, sample));
  }, [snapshot, network]);

  const live = network ? isLive(baseState(network.status)) : false;

  const scrubbed = scrubIndex !== null ? (history[scrubIndex] ?? null) : null;
  const shown = scrubIndex !== null ? scrubbed : live && network ? network : null;
  // History index -> viewBox slot center, as a percent for the tooltip x.
  const scrubPercent =
    scrubIndex !== null ? ((HISTORY_CAPACITY - history.length + scrubIndex + 0.5) / HISTORY_CAPACITY) * 100 : null;

  return (
    <div className="flex flex-col gap-2">
      <MetricRowHeader icon={Network} label="Network" />
      <div className="flex items-stretch gap-2">
        <div className="relative h-20 flex-1">
          <NetworkGraph history={history} scrubIndex={scrubIndex} onScrub={setScrubIndex} />
          {scrubbed && scrubPercent !== null ? (
            <MeterTooltip leftPercent={scrubPercent} clampPercent={25} className="-top-1">
              <RatePair sample={scrubbed} />
            </MeterTooltip>
          ) : null}
        </div>
        <div className="flex w-20 shrink-0 flex-col">
          <Rate prefix="↓" prefixClassName="text-net-down" bytesPerSec={shown?.rxBytesPerSec} />
          <Rate prefix="↑" prefixClassName="text-net-up" bytesPerSec={shown?.txBytesPerSec} />
        </div>
      </div>
    </div>
  );
}

/** One direction's rate, right-aligned and vertically centered on its lane. */
function Rate({
  prefix,
  prefixClassName,
  bytesPerSec,
}: {
  prefix: string;
  prefixClassName: string;
  bytesPerSec: number | undefined;
}) {
  const parts = bytesPerSec !== undefined ? formatRateParts(bytesPerSec) : null;
  return (
    <span className="flex flex-1 items-center justify-end gap-1.5">
      <span className={cn("text-sm font-light", prefixClassName)}>{prefix}</span>
      <ValueUnit
        value={parts?.value ?? "--"}
        unit={parts?.unit}
        // Mute the placeholder like the other rows' pending "--" values.
        valueClassName={parts === null ? "text-muted-foreground" : undefined}
      />
    </span>
  );
}

/** Both directions of a scrubbed sample, for the tooltip pill. */
function RatePair({ sample }: { sample: NonNullable<NetSample> }) {
  const rx = formatRateParts(sample.rxBytesPerSec);
  const tx = formatRateParts(sample.txBytesPerSec);
  return (
    <span className="flex items-center gap-2">
      <span>
        <span className="text-net-down">↓</span> {rx.value} {rx.unit}
      </span>
      <span>
        <span className="text-net-up">↑</span> {tx.value} {tx.unit}
      </span>
    </span>
  );
}
