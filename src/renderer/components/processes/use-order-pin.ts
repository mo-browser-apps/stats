import { useEffect, useMemo, useRef } from "react";

import { pinOrder } from "@/domain/process-list";

/**
 * Holds a ranked list's row order steady while `active` (pointer or keyboard
 * focus inside it), so a snapshot re-rank can't move a row between aiming and
 * clicking. Values keep updating; only the order is held. Used by every pinned
 * list: the group list, the detail Members section, and the inline expanded
 * children.
 *
 * `resetKey` drops the held order when it changes (e.g. the drilled target or
 * sort switched), so the next pinned tick re-baselines from the live ranking.
 */
export function useOrderPin<Item, Key>(
  ranked: Item[],
  getKey: (item: Item) => Key,
  active: boolean,
  resetKey?: unknown,
): Item[] {
  // The identity order last shown; the baseline a pinned tick replays.
  const pinnedKeys = useRef<Key[]>([]);
  // Held in a ref so the reorder never re-runs merely because the reader's
  // identity changed - only `ranked`/`active` should drive it.
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;

  useEffect(() => {
    pinnedKeys.current = [];
  }, [resetKey]);

  const ordered = useMemo(
    () => (active ? pinOrder(ranked, getKeyRef.current, pinnedKeys.current) : ranked),
    [active, ranked],
  );

  useEffect(() => {
    pinnedKeys.current = ordered.map(getKeyRef.current);
  }, [ordered]);

  return ordered;
}
