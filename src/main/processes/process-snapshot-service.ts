import * as os from 'node:os';
import { native } from '../gen/native';
import {
  AvailabilityReason,
  CollectorWarningCode,
  MemoryMetricKind,
  MemoryMetricProvenance,
  SnapshotAvailability,
  type CalculateSelectionMemoryTotalRequest,
  type CalculateSelectionMemoryTotalResponse,
  type CollectorWarning,
  type GetProcessSnapshotResponse,
  type GetSnapshotRevisionResponse,
  type ProcessMemoryMetric,
  type ProcessRow,
  type ProcessSnapshot,
  type SelectionMemoryTotal,
} from '../gen/process_explorer';
import { identityKeyFromRenderer } from './process-identity';
import {
  PROCESS_SNAPSHOT_ID_PREFIX,
  PROCESS_SNAPSHOT_REFRESH_INTERVAL_MS,
  PROCESS_SNAPSHOT_WARNINGS,
} from './process-explorer-config';
import { ProcessSnapshotMapper } from './process-snapshot-mapper';
import { SnapshotRefreshLoop } from './snapshot-refresh-loop';

export interface ProcessSnapshotClock {
  now(): number;
  logicalCoreCount(): number;
}

const SYSTEM_CLOCK: ProcessSnapshotClock = {
  now: () => Date.now(),
  logicalCoreCount: () => os.cpus().length,
};

export interface ProcessSnapshotServiceOptions {
  readonly refreshIntervalMs?: number;
  readonly clock?: ProcessSnapshotClock;
  readonly mapper?: ProcessSnapshotMapper;
}

/**
 * Owns the latest main-side process snapshot, the native refresh loop, and the
 * renderer read APIs (snapshot, revision, selection memory total).
 *
 * Reads the native process collector directly (`native.processCollector`), the
 * same way the metrics sampler reads its native probes; per-refresh failures are
 * caught and degraded to a safe warning rather than wrapped behind an adapter.
 *
 * Collection runs only while the process view is active: the renderer is the
 * sole consumer, so the refresh loop (and the native collection it drives) is
 * paused via {@link setActive} while there is nothing to display, mirroring the
 * metrics service. The loop is non-overlapping, so a slow collection cannot
 * stack work. Until the first collection completes, reads return an explicit
 * `NOT_COLLECTED`/`REFRESH_FAILED` empty state rather than throwing.
 *
 * Privacy: command-line argument values pass through for renderer display and
 * local search only; they are never logged, persisted, or echoed in warnings.
 */
export class ProcessSnapshotService {
  private readonly mapper: ProcessSnapshotMapper;

  private readonly clock: ProcessSnapshotClock;

  private readonly refreshLoop: SnapshotRefreshLoop;

  private latestSnapshot: ProcessSnapshot | undefined;

  private revision = 0;

  private lastFailureWarnings: readonly CollectorWarning[] = [];

  /** Whether the process view is active and snapshots should be collected. */
  private active = false;

  /** Set once disposed; blocks any further activation or collection. */
  private disposed = false;

  constructor(options: ProcessSnapshotServiceOptions = {}) {
    this.mapper = options.mapper ?? new ProcessSnapshotMapper();
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.refreshLoop = new SnapshotRefreshLoop({
      intervalMs: options.refreshIntervalMs ?? PROCESS_SNAPSHOT_REFRESH_INTERVAL_MS,
      refresh: async () => this.collectAndStoreSnapshot(),
    });
  }

  /**
   * Activates or pauses collection to match process-view visibility. Active
   * starts the refresh loop (and runs one collection immediately); idle stops
   * future ticks and clears the CPU baselines so the first post-resume sample
   * reports pending rather than a delta across the paused gap. Idempotent for
   * repeated calls with the same state.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) {
      return;
    }

    this.active = active;
    if (active) {
      this.refreshLoop.start();
    } else {
      this.refreshLoop.stop();
      this.mapper.reset();
    }
  }

  /** Stops the refresh loop permanently. Idempotent. For app shutdown. */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.active = false;
    this.refreshLoop.stop();
  }

  getProcessSnapshot(): GetProcessSnapshotResponse {
    if (this.latestSnapshot === undefined) {
      return {
        availability: this.getAbsentSnapshotAvailability(),
        snapshot: undefined,
        warnings: [...this.lastFailureWarnings],
      };
    }

    return {
      availability: SnapshotAvailability.SNAPSHOT_AVAILABILITY_AVAILABLE,
      snapshot: this.latestSnapshot,
      warnings: [...this.latestSnapshot.warnings, ...this.lastFailureWarnings],
    };
  }

  getSnapshotRevision(): GetSnapshotRevisionResponse {
    if (this.latestSnapshot === undefined) {
      return {
        availability: this.getAbsentSnapshotAvailability(),
        revision: undefined,
        warnings: [...this.lastFailureWarnings],
      };
    }

    return {
      availability: SnapshotAvailability.SNAPSHOT_AVAILABILITY_AVAILABLE,
      revision: {
        snapshotId: this.latestSnapshot.snapshotId,
        revision: this.latestSnapshot.revision,
        capturedAtUnixMs: this.latestSnapshot.capturedAtUnixMs,
      },
      warnings: [...this.lastFailureWarnings],
    };
  }

  /**
   * Totals memory for the selected process identities against the latest
   * snapshot, preserving stale (selection no longer present) and unavailable
   * counts so a partial total is honest. With no snapshot yet, every selection
   * is stale and the total is unavailable.
   */
  calculateSelectionMemoryTotal(
    request: CalculateSelectionMemoryTotalRequest,
  ): CalculateSelectionMemoryTotalResponse {
    const metricKind = normalizeMetricKind(request.preferredMetricKind);
    const rowsByIdentityKey = this.indexLatestRows();

    let liveMatchedCount = 0;
    let unavailableCount = 0;
    let totalBytes = 0;

    for (const identity of request.selectedIdentities) {
      const row = rowsByIdentityKey.get(identityKeyFromRenderer(identity));
      if (row === undefined) {
        continue;
      }
      liveMatchedCount += 1;

      const metric = selectMemoryMetric(row, metricKind);
      if (metric?.availability === AvailabilityReason.AVAILABILITY_REASON_AVAILABLE) {
        totalBytes += metric.bytes;
      } else {
        unavailableCount += 1;
      }
    }

    const requestedSelectionCount = request.selectedIdentities.length;
    return {
      total: buildSelectionTotal({
        requestedSelectionCount,
        liveMatchedCount,
        unavailableCount,
        metricKind,
        totalBytes,
      }),
    };
  }

  /** Returns the latest snapshot for privileged action validation (I14). */
  getLatestSnapshot(): ProcessSnapshot | undefined {
    return this.latestSnapshot;
  }

  private async collectAndStoreSnapshot(): Promise<void> {
    const startedAt = this.clock.now();

    try {
      const nativeResponse = await native.processCollector.CollectProcesses({});
      // The view may have been hidden or disposed while collection was in
      // flight; dropping the result keeps a stale baseline from arming the CPU
      // calculator after a pause and avoids storing post-dispose.
      if (!this.active || this.disposed) {
        return;
      }

      const completedAt = this.clock.now();
      const nextRevision = this.revision + 1;
      const capturedAtUnixMs =
        nativeResponse.collectedAtUnixMs > 0 ? nativeResponse.collectedAtUnixMs : completedAt;
      const refreshDurationMs = Math.max(
        0,
        completedAt - startedAt,
        nativeResponse.collectionDurationMs,
      );

      this.latestSnapshot = this.mapper.map({
        nativeResponse,
        snapshotId: `${PROCESS_SNAPSHOT_ID_PREFIX}-${String(nextRevision)}`,
        revision: nextRevision,
        capturedAtUnixMs,
        refreshDurationMs,
        logicalCoreCount: this.clock.logicalCoreCount(),
      });
      this.revision = nextRevision;
      this.lastFailureWarnings = [];
    } catch {
      // Degrade to a safe failure warning. The error is not surfaced because it
      // could carry process-identifying text; the renderer only needs to know a
      // refresh failed.
      this.lastFailureWarnings = [createNativeFailureWarning()];
    }
  }

  private indexLatestRows(): ReadonlyMap<string, ProcessRow> {
    const rowsByIdentityKey = new Map<string, ProcessRow>();
    for (const row of this.latestSnapshot?.rows ?? []) {
      const key = row.identity?.identityKey;
      if (key !== undefined && key.length > 0) {
        rowsByIdentityKey.set(key, row);
      }
    }
    return rowsByIdentityKey;
  }

  private getAbsentSnapshotAvailability(): SnapshotAvailability {
    return this.lastFailureWarnings.length > 0
      ? SnapshotAvailability.SNAPSHOT_AVAILABILITY_REFRESH_FAILED
      : SnapshotAvailability.SNAPSHOT_AVAILABILITY_NOT_COLLECTED;
  }
}

function normalizeMetricKind(metricKind: MemoryMetricKind): MemoryMetricKind {
  return metricKind === MemoryMetricKind.MEMORY_METRIC_KIND_RESIDENT
    ? MemoryMetricKind.MEMORY_METRIC_KIND_RESIDENT
    : MemoryMetricKind.MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT;
}

function selectMemoryMetric(
  row: ProcessRow,
  metricKind: MemoryMetricKind,
): ProcessMemoryMetric | undefined {
  return metricKind === MemoryMetricKind.MEMORY_METRIC_KIND_RESIDENT
    ? row.memory?.resident
    : row.memory?.physicalFootprint;
}

interface SelectionTotalParts {
  readonly requestedSelectionCount: number;
  readonly liveMatchedCount: number;
  readonly unavailableCount: number;
  readonly metricKind: MemoryMetricKind;
  readonly totalBytes: number;
}

function buildSelectionTotal(parts: SelectionTotalParts): SelectionMemoryTotal {
  const availableCount = parts.liveMatchedCount - parts.unavailableCount;
  const availability =
    parts.liveMatchedCount === 0 || availableCount === 0
      ? AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE
      : AvailabilityReason.AVAILABILITY_REASON_AVAILABLE;

  return {
    requestedSelectionCount: parts.requestedSelectionCount,
    liveMatchedCount: parts.liveMatchedCount,
    staleSelectionCount: parts.requestedSelectionCount - parts.liveMatchedCount,
    unavailableCount: parts.unavailableCount,
    metricKind: parts.metricKind,
    availability,
    totalBytes:
      availability === AvailabilityReason.AVAILABILITY_REASON_AVAILABLE ? parts.totalBytes : 0,
    provenance: MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_AGGREGATED,
  };
}

function createNativeFailureWarning(): CollectorWarning {
  return {
    code: CollectorWarningCode.COLLECTOR_WARNING_CODE_COLLECTION_FAILED,
    safeMessage: PROCESS_SNAPSHOT_WARNINGS.nativeCollectionFailed,
    affectedProcessCount: 0,
  };
}
