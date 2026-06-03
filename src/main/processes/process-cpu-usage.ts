import {
  AvailabilityReason,
  type AvailableInt64Value,
  type ProcessCpuUsage,
} from '../gen/process_explorer';

/**
 * Computes per-process CPU usage from the cumulative CPU-time counter (in
 * nanoseconds) reported by the native collector, diffed across snapshots in
 * main. The usage percent is the CPU time consumed in the window divided by the
 * wall-clock window, normalized to the machine's logical-core capacity (100% =
 * every core fully busy on this process).
 *
 * First sample for an identity, a counter that went backwards (a restart that
 * reused the PID, or a lost counter), a non-positive window, or a missing core
 * count all report UNAVAILABLE rather than a fabricated value. Identity keys
 * encode PID plus start time, so a reused PID is a new identity and never
 * inherits the previous process's baseline.
 */

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface CpuSample {
  readonly cumulativeCpuTimeNs: number;
  readonly capturedAtUnixMs: number;
}

export interface ProcessCpuUsageRowInput {
  readonly identityKey: string;
  readonly cumulativeCpuTime: AvailableInt64Value;
}

export interface ProcessCpuUsageSnapshotInput {
  readonly capturedAtUnixMs: number;
  readonly logicalCoreCount: number;
  readonly rows: readonly ProcessCpuUsageRowInput[];
}

const UNAVAILABLE_USAGE: ProcessCpuUsage = {
  availability: AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE,
  percent: 0,
};

export class ProcessCpuUsageCalculator {
  private previousSamples = new Map<string, CpuSample>();

  /**
   * Computes usage for every row and stores the baseline for the next call.
   * Returns a map keyed by identity key.
   */
  compute(input: ProcessCpuUsageSnapshotInput): Map<string, ProcessCpuUsage> {
    const usageByIdentityKey = new Map<string, ProcessCpuUsage>();
    const nextSamples = new Map<string, CpuSample>();

    for (const row of input.rows) {
      usageByIdentityKey.set(row.identityKey, this.computeRow(row, input));

      if (row.cumulativeCpuTime.availability === AvailabilityReason.AVAILABILITY_REASON_AVAILABLE) {
        nextSamples.set(row.identityKey, {
          cumulativeCpuTimeNs: row.cumulativeCpuTime.value,
          capturedAtUnixMs: input.capturedAtUnixMs,
        });
      }
    }

    // Replace (not merge) so baselines for vanished processes are dropped and
    // the map cannot grow unbounded across a long session.
    this.previousSamples = nextSamples;
    return usageByIdentityKey;
  }

  /** Clears baselines so the next compute treats every row as a first sample. */
  reset(): void {
    this.previousSamples = new Map();
  }

  private computeRow(
    row: ProcessCpuUsageRowInput,
    input: ProcessCpuUsageSnapshotInput,
  ): ProcessCpuUsage {
    if (row.cumulativeCpuTime.availability !== AvailabilityReason.AVAILABILITY_REASON_AVAILABLE) {
      return { availability: row.cumulativeCpuTime.availability, percent: 0 };
    }

    if (input.logicalCoreCount <= 0) {
      return UNAVAILABLE_USAGE;
    }

    const previous = this.previousSamples.get(row.identityKey);
    if (previous === undefined) {
      return UNAVAILABLE_USAGE;
    }

    const elapsedMs = input.capturedAtUnixMs - previous.capturedAtUnixMs;
    if (elapsedMs <= 0) {
      return UNAVAILABLE_USAGE;
    }

    const cpuTimeDeltaNs = row.cumulativeCpuTime.value - previous.cumulativeCpuTimeNs;
    if (cpuTimeDeltaNs < 0) {
      // Counter went backwards: a restart/reset. Re-arm on the next sample.
      return UNAVAILABLE_USAGE;
    }

    const elapsedNs = elapsedMs * NANOSECONDS_PER_MILLISECOND;
    const busyCoreFraction = cpuTimeDeltaNs / elapsedNs;
    const percentOfMachine = (busyCoreFraction / input.logicalCoreCount) * 100;

    return {
      availability: AvailabilityReason.AVAILABILITY_REASON_AVAILABLE,
      percent: Math.min(Math.max(percentOfMachine, 0), 100),
    };
  }
}
