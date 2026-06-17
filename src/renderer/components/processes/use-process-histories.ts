import { useCallback, useEffect, useRef, useState } from "react";

import type { ProcessSnapshot } from "@/gen/process_explorer";
import { sampleMetricsByKey, type SortMode } from "@/domain/process-list";
import { pushSample, type HistorySample } from "@/domain/sample-history";

/** A process's retained CPU and memory trails (oldest first). */
interface Trails {
  cpu: HistorySample[];
  memory: HistorySample[];
}

/** A read-only view of one target's trail under the active metric. */
export interface ProcessHistory {
  history: HistorySample[];
}

/** Keeps short CPU/memory trails for process details the user has opened. */
export function useProcessHistories(snapshot: ProcessSnapshot): (key: string, sort: SortMode) => ProcessHistory {
  const [trailsByKey, setTrailsByKey] = useState<Map<string, Trails>>(() => new Map());
  const trackedKeys = useRef(new Set<string>());
  const lastRevision = useRef<number | null>(null);

  useEffect(() => {
    if (lastRevision.current === snapshot.revision) {
      return;
    }
    lastRevision.current = snapshot.revision;
    if (trackedKeys.current.size === 0) {
      return;
    }
    const samples = sampleMetricsByKey(snapshot);
    for (const key of trackedKeys.current) {
      if (!samples.has(key)) {
        trackedKeys.current.delete(key);
      }
    }
    setTrailsByKey((previous) => {
      const next = new Map<string, Trails>();
      for (const key of trackedKeys.current) {
        const sample = samples.get(key);
        if (sample === undefined) {
          continue;
        }
        const prior = previous.get(key);
        next.set(key, {
          cpu: pushSample(prior?.cpu ?? [], sample.cpu),
          memory: pushSample(prior?.memory ?? [], sample.memory),
        });
      }
      return next;
    });
  }, [snapshot]);

  return useCallback(
    (key: string, sort: SortMode): ProcessHistory => {
      trackedKeys.current.add(key);
      const trails = trailsByKey.get(key);
      return { history: (sort === "cpu" ? trails?.cpu : trails?.memory) ?? [] };
    },
    [trailsByKey],
  );
}
