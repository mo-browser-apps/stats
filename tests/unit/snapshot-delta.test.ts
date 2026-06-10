import { describe, expect, it } from "vitest";

import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { mergeSnapshotDelta } from "@/gateway/snapshot-delta";
import { makeRow, makeSnapshot } from "../helpers/process-fixtures";

/**
 * Marks a row's argv as carried by the base snapshot (the wire form main sends
 * inside a delta).
 */
function withFromPrevArgv(row: ProcessRow): ProcessRow {
  return {
    ...row,
    commandLine: { status: FieldStatus.FIELD_STATUS_OK, arguments: [], fromPrev: true },
  };
}

/**
 * Builds the wire form of a delta snapshot: rows as given, an empty icon table
 * (icons never ride the snapshot wire), and the delta marker set.
 */
function makeDelta(rows: ProcessRow[], revision: number): ProcessSnapshot {
  return { ...makeSnapshot(rows, revision), icons: {}, delta: true };
}

describe("mergeSnapshotDelta", () => {
  it("rehydrates from_prev argv from the base row with the same identity", () => {
    const base = makeSnapshot(
      [makeRow({ pid: 10, startedAtUnixMs: 1_000, commandLine: ["fake-app", "--flag"] })],
      1,
    );
    const delta = makeDelta(
      [withFromPrevArgv(makeRow({ pid: 10, startedAtUnixMs: 1_000 }))],
      2,
    );

    const merged = mergeSnapshotDelta(base, delta);

    expect(merged.delta).toBe(false);
    expect(merged.revision).toBe(2);
    expect(merged.processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-app", "--flag"],
      fromPrev: false,
    });
  });

  it("keeps fresh argv and rows without from_prev untouched", () => {
    const base = makeSnapshot([makeRow({ pid: 11, startedAtUnixMs: 1_000 })], 1);
    const freshRow = makeRow({
      pid: 12,
      startedAtUnixMs: 2_000,
      commandLine: ["fake-new", "--exec"],
    });
    const delta = makeDelta([freshRow], 2);

    const merged = mergeSnapshotDelta(base, delta);

    expect(merged.processes[0]).toBe(freshRow);
  });

  it("degrades a from_prev row with no base counterpart to UNAVAILABLE argv", () => {
    const base = makeSnapshot([makeRow({ pid: 30, startedAtUnixMs: 1_000 })], 1);
    // Identity mismatch: same PID but a different start time (reused PID).
    const delta = makeDelta(
      [withFromPrevArgv(makeRow({ pid: 30, startedAtUnixMs: 9_000 }))],
      2,
    );

    const merged = mergeSnapshotDelta(base, delta);

    expect(merged.processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
      arguments: [],
      fromPrev: false,
    });
  });

  it("degrades gracefully when no base snapshot exists", () => {
    const delta = makeDelta(
      [withFromPrevArgv(makeRow({ pid: 40, startedAtUnixMs: 1_000 }))],
      2,
    );

    const merged = mergeSnapshotDelta(null, delta);

    expect(merged.delta).toBe(false);
    expect(merged.processes[0].commandLine?.status).toBe(
      FieldStatus.FIELD_STATUS_UNAVAILABLE,
    );
  });
});
