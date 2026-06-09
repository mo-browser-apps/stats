import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { rowIdentityKey } from "@/domain/process-list";

/**
 * Merges a delta {@link ProcessSnapshot} (see the proto's `ProcessSnapshot.delta`)
 * with the full base snapshot it was built against, producing a self-contained
 * snapshot for presentation code.
 *
 * Main sends a delta only when the pull's have_revision named a snapshot the
 * renderer holds, so `base` is that snapshot. Three reductions are reversed:
 * rows marked `commandLine.from_prev` take their argv from the base row with
 * the same identity, rows marked `stable_from_prev` take their stable field
 * group (names, path, app metadata, user) from it, and the icon table is the
 * delta's new entries plus the base entries the merged rows still reference
 * (dead keys are dropped, so the table stays bounded by what is on screen).
 * Pure and side-effect free; the gateway owns the base bookkeeping.
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
    if (!row.commandLine?.fromPrev && !row.stableFromPrev) {
      return row;
    }
    // A marked row without a base counterpart cannot be rehydrated (a protocol
    // mismatch that should not happen); degrade its marked fields honestly.
    const baseRow = baseRows.get(rowIdentityKey(row));
    if (baseRow === undefined) {
      return degradeUnrehydratable(row);
    }

    const merged = { ...row };
    if (row.stableFromPrev) {
      merged.commandName = baseRow.commandName;
      merged.executableName = baseRow.executableName;
      merged.executablePath = baseRow.executablePath;
      merged.app = baseRow.app;
      merged.user = baseRow.user;
      merged.stableFromPrev = false;
    }
    if (row.commandLine?.fromPrev) {
      merged.commandLine = baseRow.commandLine ?? unavailableCommandLine();
    }
    return merged;
  });

  const icons: { [key: string]: string } = { ...delta.icons };
  if (base !== null) {
    for (const row of processes) {
      const key = row.app?.iconKey;
      if (key !== undefined && key.length > 0 && icons[key] === undefined) {
        const bytes = base.icons[key];
        if (bytes !== undefined) {
          icons[key] = bytes;
        }
      }
    }
  }

  // The merged snapshot is self-contained: clear the delta marker so downstream
  // code (and a later merge using it as base) treats it as a full snapshot.
  return { ...delta, processes, icons, delta: false };
}

/**
 * Clears the from_prev/stable_from_prev markers of a row whose base row is
 * missing: argv becomes explicitly unavailable and the stable fields stay
 * absent, so the row renders with honest fallbacks (PID name, generic icon)
 * rather than fabricated values.
 */
function degradeUnrehydratable(row: ProcessRow): ProcessRow {
  const degraded = { ...row, stableFromPrev: false };
  if (row.commandLine?.fromPrev) {
    degraded.commandLine = unavailableCommandLine();
  }
  return degraded;
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
