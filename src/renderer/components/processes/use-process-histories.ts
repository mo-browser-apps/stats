import { useCallback, useEffect, useRef, useState } from "react";

import type { ProcessSnapshot } from "@/gen/process_explorer";
import {
  sampleMembersForKeys,
  sampleMetricsForKeys,
  type MemberMetricSample,
  type SortMode,
} from "@/domain/process-list";
import { HISTORY_CAPACITY, pushSample, type HistorySample } from "@/domain/sample-history";

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
  const samples = sampleMetricsForKeys(snapshot, trackedKeys);
  const memberSamples = sampleMembersForKeys(snapshot, trackedKeys);
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

/**
 * Keeps short CPU/memory trails for process details the user has opened.
 *
 * While `frozen` (the detail view is inspecting a past tick), incoming ticks
 * are buffered aside instead of appended, so the inspected tick cannot scroll
 * off the graph and no data is lost. When inspection ends the buffered ticks
 * are spliced back on in arrival order, capacity-trimmed - a seamless catch-up
 * rather than a gap. Main keeps collecting throughout; only this renderer-side
 * ring is held.
 */
export function useProcessHistories(
  snapshot: ProcessSnapshot,
  frozen: boolean,
): (key: string, sort: SortMode) => ProcessHistory {
  const [trailsByKey, setTrailsByKey] = useState<Map<string, Trails>>(() => new Map());
  const trackedKeys = useRef(new Set<string>());
  const lastRevision = useRef<number | null>(null);
  const frozenRef = useRef(frozen);
  // Ticks that arrived while frozen, per key, oldest first - replayed on thaw.
  const buffer = useRef(new Map<string, TrailSample[]>());

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
    if (lastRevision.current === snapshot.revision) {
      return;
    }
    lastRevision.current = snapshot.revision;
    if (trackedKeys.current.size === 0) {
      return;
    }
    const ticks = sampleTrails(snapshot, trackedKeys.current);

    if (frozenRef.current) {
      // Leave trails untouched so the inspected tick stays stable; stash this
      // tick instead, capped per key so a long freeze still bounds memory.
      for (const [key, tick] of ticks) {
        const queued = buffer.current.get(key) ?? [];
        queued.push(tick);
        buffer.current.set(key, queued.slice(-HISTORY_CAPACITY));
      }
      return;
    }

    // Live: drop tracked keys whose target has vanished, then append.
    for (const key of trackedKeys.current) {
      if (!ticks.has(key)) {
        trackedKeys.current.delete(key);
      }
    }
    setTrailsByKey((previous) => {
      const next = new Map<string, Trails>();
      for (const key of trackedKeys.current) {
        const tick = ticks.get(key);
        if (tick === undefined) {
          continue;
        }
        next.set(key, appendTick(previous.get(key), tick));
      }
      return next;
    });
  }, [snapshot]);

  return useCallback(
    (key: string, sort: SortMode): ProcessHistory => {
      trackedKeys.current.add(key);
      const trails = trailsByKey.get(key);
      return {
        history: (sort === "cpu" ? trails?.cpu : trails?.memory) ?? [],
        memberHistory: trails?.members ?? [],
      };
    },
    [trailsByKey],
  );
}
