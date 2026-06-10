import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { rowIdentityKey } from "@/domain/process-list";

/**
 * Merges a delta {@link ProcessSnapshot} (see the proto's `ProcessSnapshot.delta`)
 * with the full base snapshot it was built against, producing a self-contained
 * snapshot for presentation code.
 *
 * Main sends a delta only when the pull's have_revision named a snapshot the
 * renderer holds, so `base` is that snapshot. argv is the only reduced field:
 * rows marked `commandLine.from_prev` take their argv from the base row with
 * the same identity. Icons are not handled here - they never ride the snapshot
 * wire; the gateway assembles the icon table separately. Pure and side-effect
 * free; the gateway owns the base bookkeeping.
 */
export function mergeSnapshotDelta(
  base: ProcessSnapshot | null,
  delta: ProcessSnapshot,
): ProcessSnapshot {
  const baseRows = new Map<string, ProcessRow>();
  if (base !== null) {
    for (const row of base.processes) {
      baseRows.set(rowIdentityKey(row), row);
    }
  }

  const processes = delta.processes.map((row) => {
    if (!row.commandLine?.fromPrev) {
      return row;
    }
    // A marked row without a base counterpart cannot be rehydrated (a protocol
    // mismatch that should not happen); degrade its argv honestly.
    const baseRow = baseRows.get(rowIdentityKey(row));
    return {
      ...row,
      commandLine: baseRow?.commandLine ?? unavailableCommandLine(),
    };
  });

  // The merged snapshot is self-contained: clear the delta marker so downstream
  // code (and a later merge using it as base) treats it as a full snapshot.
  return { ...delta, processes, delta: false };
}

/**
 * An explicitly-unavailable argv cell, used when rehydration is impossible.
 */
function unavailableCommandLine() {
  return {
    status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
    arguments: [],
    fromPrev: false,
  };
}
