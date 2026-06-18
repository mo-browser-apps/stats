import { useCallback, useEffect, useRef, useState } from "react";

import type { ProcessSnapshot } from "@/gen/process_explorer";
import {
  sampleMembers,
  sampleMetrics,
  type MemberMetricSample,
  type SortMode,
} from "@/domain/process-list";
import { HISTORY_CAPACITY, pushSample, type HistorySample } from "@/domain/sample-history";

/** Maximum number of process-detail histories retained for quick revisits. */
const RETAINED_HISTORY_LIMIT = 12;

/** How long an inactive retained history may sit in memory before pruning. */
const INACTIVE_HISTORY_TTL_MS = 10 * 60 * 1000;

/**
 * A process's retained trails (oldest first): the CPU and memory totals that
 * drive the graph, plus the per-tick member breakdown behind the detail's
 * "members at this tick" list. The three rings are appended in one pass per
 * snapshot revision, so a graph scrub index maps 1:1 onto a breakdown entry.
 * `members` is empty for a plain singleton process (no breakdown is captured).
 */
interface Trails {
  cpu: HistorySample[];
  memory: HistorySample[];
  members: MemberMetricSample[][];
}

/** One snapshot tick's readings for a key, the unit appended to the trails. */
interface TrailSample {
  cpu: HistorySample;
  memory: HistorySample;
  members: MemberMetricSample[];
}

/** A read-only view of one target's trail under the active metric. */
export interface ProcessHistory {
  history: HistorySample[];
  /**
   * The per-tick member breakdown, index-aligned with {@link history}, so
   * `memberHistory[i]` is the members at the same tick `history[i]` plots.
   * Empty for a single-process detail.
   */
  memberHistory: MemberMetricSample[][];
}

/** Collects each tracked key's reading for one snapshot revision. */
function sampleTrails(snapshot: ProcessSnapshot, trackedKeys: Set<string>): Map<string, TrailSample> {
  const samples = sampleMetrics(snapshot, trackedKeys);
  const memberSamples = sampleMembers(snapshot, trackedKeys);
  const result = new Map<string, TrailSample>();
  for (const key of trackedKeys) {
    const sample = samples.get(key);
    if (sample === undefined) {
      continue;
    }
    result.set(key, { cpu: sample.cpu, memory: sample.memory, members: memberSamples.get(key) ?? [] });
  }
  return result;
}

/** Appends one tick onto a key's prior trails, trimming each ring to capacity. */
function appendTick(prior: Trails | undefined, tick: TrailSample): Trails {
  return {
    cpu: pushSample(prior?.cpu ?? [], tick.cpu),
    memory: pushSample(prior?.memory ?? [], tick.memory),
    members: pushSample(prior?.members ?? [], tick.members),
  };
}

/** Applies the bounded live-history policy to the key set sampled each tick. */
function pruneTrackedKeys(
  previous: ReadonlySet<string>,
  activeKey: string | undefined,
  accessedAt: ReadonlyMap<string, number>,
  now: number,
): Set<string> {
  const keep = new Set<string>();
  if (activeKey !== undefined) {
    keep.add(activeKey);
  }

  const inactiveKeys = [...previous]
    .filter((key) => key !== activeKey)
    .filter((key) => now - (accessedAt.get(key) ?? 0) <= INACTIVE_HISTORY_TTL_MS)
    .sort((left, right) => (accessedAt.get(right) ?? 0) - (accessedAt.get(left) ?? 0));

  for (const key of inactiveKeys) {
    if (keep.size >= RETAINED_HISTORY_LIMIT) {
      break;
    }
    keep.add(key);
  }

  return keep;
}

/** Removes trails for histories that are no longer part of the live cache. */
function pruneTrailCache(
  previous: Map<string, Trails>,
  retainedKeys: ReadonlySet<string>,
): Map<string, Trails> {
  if (previous.size === retainedKeys.size && [...previous.keys()].every((key) => retainedKeys.has(key))) {
    return previous;
  }

  const next = new Map<string, Trails>();
  for (const [key, trails] of previous) {
    if (retainedKeys.has(key)) {
      next.set(key, trails);
    }
  }
  return next;
}

/** Drops side-channel cache records for histories that were evicted. */
function pruneCacheRecords(
  accessRecords: Map<string, number>,
  sampledRevisions: Map<string, number>,
  bufferedTicks: Map<string, TrailSample[]>,
  retainedKeys: ReadonlySet<string>,
): void {
  for (const key of accessRecords.keys()) {
    if (!retainedKeys.has(key)) {
      accessRecords.delete(key);
    }
  }
  for (const key of sampledRevisions.keys()) {
    if (!retainedKeys.has(key)) {
      sampledRevisions.delete(key);
    }
  }
  for (const key of bufferedTicks.keys()) {
    if (!retainedKeys.has(key)) {
      bufferedTicks.delete(key);
    }
  }
}

/**
 * Keeps short CPU/memory/member trails for a bounded set of recent details.
 *
 * While `frozen` (the detail view is inspecting a past tick), incoming ticks
 * are buffered aside instead of appended, so the inspected tick cannot scroll
 * off the graph and no data is lost. When inspection ends the buffered ticks
 * are spliced back on in arrival order, capacity-trimmed - a seamless catch-up
 * rather than a gap. Recently viewed details stay live in a bounded recency
 * cache, so quick back-and-forth navigation shows current graphs without
 * letting member breakdowns accumulate for the renderer lifetime.
 */
export function useProcessHistories(
  snapshot: ProcessSnapshot,
  frozen: boolean,
  activeKey: string | undefined,
): (key: string, sort: SortMode) => ProcessHistory {
  const [trailsByKey, setTrailsByKey] = useState<Map<string, Trails>>(() => new Map());
  const trackedKeys = useRef(new Set<string>());
  const accessedAt = useRef(new Map<string, number>());
  const sampledRevisionByKey = useRef(new Map<string, number>());
  const frozenRef = useRef(frozen);
  // Ticks that arrived while frozen, per key, oldest first - replayed on thaw.
  const buffer = useRef(new Map<string, TrailSample[]>());

  const reconcileTrackedKeys = useCallback((now: number) => {
    if (activeKey !== undefined) {
      accessedAt.current.set(activeKey, now);
    }
    trackedKeys.current = pruneTrackedKeys(trackedKeys.current, activeKey, accessedAt.current, now);
    pruneCacheRecords(
      accessedAt.current,
      sampledRevisionByKey.current,
      buffer.current,
      trackedKeys.current,
    );
  }, [activeKey]);

  const commitPrunedTrails = useCallback(() => {
    setTrailsByKey((previous) => pruneTrailCache(previous, trackedKeys.current));
  }, []);

  useEffect(() => {
    const wasFrozen = frozenRef.current;
    frozenRef.current = frozen;
    if (frozen || !wasFrozen || buffer.current.size === 0) {
      return;
    }
    const queued = buffer.current;
    buffer.current = new Map();
    setTrailsByKey((previous) => {
      const next = new Map(previous);
      for (const key of trackedKeys.current) {
        const ticks = queued.get(key);
        if (ticks === undefined || ticks.length === 0) {
          continue;
        }
        let trails: Trails | undefined = next.get(key);
        for (const tick of ticks) {
          trails = appendTick(trails, tick);
        }
        // ticks is non-empty, so the loop ran and trails is now defined.
        next.set(key, trails as Trails);
      }
      return next;
    });
  }, [frozen]);

  useEffect(() => {
    reconcileTrackedKeys(Date.now());

    if (trackedKeys.current.size === 0) {
      commitPrunedTrails();
      return;
    }

    const unsampledKeys = new Set(
      [...trackedKeys.current].filter((key) => sampledRevisionByKey.current.get(key) !== snapshot.revision),
    );
    if (unsampledKeys.size === 0) {
      commitPrunedTrails();
      return;
    }

    const ticks = sampleTrails(snapshot, unsampledKeys);
    const appendTicks = new Map<string, TrailSample>();

    for (const key of unsampledKeys) {
      const tick = ticks.get(key);
      if (tick === undefined) {
        trackedKeys.current.delete(key);
        accessedAt.current.delete(key);
        sampledRevisionByKey.current.delete(key);
        buffer.current.delete(key);
        continue;
      }

      sampledRevisionByKey.current.set(key, snapshot.revision);
      if (frozenRef.current && key === activeKey) {
        const queued = buffer.current.get(key) ?? [];
        queued.push(tick);
        buffer.current.set(key, queued.slice(-HISTORY_CAPACITY));
        continue;
      }

      appendTicks.set(key, tick);
    }

    setTrailsByKey((previous) => {
      const retained = pruneTrailCache(previous, trackedKeys.current);
      const next = new Map(retained);
      for (const [key, tick] of appendTicks) {
        next.set(key, appendTick(retained.get(key), tick));
      }
      return next;
    });
  }, [activeKey, snapshot, reconcileTrackedKeys, commitPrunedTrails]);

  return useCallback(
    (key: string, sort: SortMode): ProcessHistory => {
      const trails = trailsByKey.get(key);
      return {
        history: (sort === "cpu" ? trails?.cpu : trails?.memory) ?? [],
        memberHistory: trails?.members ?? [],
      };
    },
    [trailsByKey],
  );
}
