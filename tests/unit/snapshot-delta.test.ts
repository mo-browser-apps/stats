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
 * Builds the wire form of a delta snapshot: rows as given, only the listed
 * icons, and the delta marker set.
 */
function makeDelta(
  rows: ProcessRow[],
  icons: { [key: string]: string },
  revision: number,
): ProcessSnapshot {
  return { ...makeSnapshot(rows, revision), icons, delta: true };
}

describe("mergeSnapshotDelta", () => {
  it("rehydrates from_prev argv from the base row with the same identity", () => {
    const base = makeSnapshot(
      [makeRow({ pid: 10, startedAtUnixMs: 1_000, commandLine: ["fake-app", "--flag"] })],
      1,
    );
    const delta = makeDelta(
      [withFromPrevArgv(makeRow({ pid: 10, startedAtUnixMs: 1_000 }))],
      {},
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
    const delta = makeDelta([freshRow], {}, 2);

    const merged = mergeSnapshotDelta(base, delta);

    expect(merged.processes[0]).toBe(freshRow);
  });

  it("merges new icons with base icons still referenced and drops dead ones", () => {
    // Base carries icons A (still referenced) and B (its app exits).
    const base = makeSnapshot(
      [
        makeRow({ pid: 20, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A" }),
        makeRow({ pid: 21, startedAtUnixMs: 1_000, iconPngBase64: "ICON-B" }),
      ],
      1,
    );
    // Delta: pid 20 lives on (icon A referenced, bytes omitted), pid 22 is new
    // with icon C shipped on the delta.
    const delta = makeDelta(
      [
        makeRow({ pid: 20, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A" }),
        makeRow({ pid: 22, startedAtUnixMs: 2_000, iconPngBase64: "ICON-C" }),
      ],
      { "ICON-C": "ICON-C" },
      2,
    );

    const merged = mergeSnapshotDelta(base, delta);

    expect(merged.icons).toEqual({ "ICON-A": "ICON-A", "ICON-C": "ICON-C" });
  });

  it("degrades a from_prev row with no base counterpart to UNAVAILABLE argv", () => {
    const base = makeSnapshot([makeRow({ pid: 30, startedAtUnixMs: 1_000 })], 1);
    // Identity mismatch: same PID but a different start time (reused PID).
    const delta = makeDelta(
      [withFromPrevArgv(makeRow({ pid: 30, startedAtUnixMs: 9_000 }))],
      {},
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
      { "ICON-D": "ICON-D" },
      2,
    );

    const merged = mergeSnapshotDelta(null, delta);

    expect(merged.delta).toBe(false);
    expect(merged.icons).toEqual({ "ICON-D": "ICON-D" });
    expect(merged.processes[0].commandLine?.status).toBe(
      FieldStatus.FIELD_STATUS_UNAVAILABLE,
    );
  });

  it("rehydrates the stable field group from the base row", () => {
    const base = makeSnapshot(
      [
        makeRow({
          pid: 50,
          startedAtUnixMs: 1_000,
          commandName: "fake-app",
          executableName: "Fake App",
          executablePath: "/Applications/FakeApp.app/Contents/MacOS/Fake App",
          bundleIdentifier: "com.example.FakeApp",
          localizedName: "Fake App",
          iconPngBase64: "ICON-E",
          bundlePath: "/Applications/FakeApp.app",
          bundleName: "Fake App",
          uid: 501,
          userName: "fixtureuser",
        }),
      ],
      1,
    );
    // The wire form: stable group stripped, volatile fields present.
    const wireRow: ProcessRow = {
      ...makeRow({ pid: 50, startedAtUnixMs: 1_000, footprintBytes: 4_096 }),
      commandName: undefined,
      executableName: undefined,
      executablePath: undefined,
      app: undefined,
      user: undefined,
      stableFromPrev: true,
    };
    const delta = makeDelta([wireRow], {}, 2);

    const merged = mergeSnapshotDelta(base, delta);
    const row = merged.processes[0];

    expect(row.stableFromPrev).toBe(false);
    expect(row.commandName?.value).toBe("fake-app");
    expect(row.executablePath?.value).toBe(
      "/Applications/FakeApp.app/Contents/MacOS/Fake App",
    );
    expect(row.app?.bundleIdentifier?.value).toBe("com.example.FakeApp");
    expect(row.app?.iconKey).toBe("ICON-E");
    expect(row.user?.uid).toBe(501);
    // Volatile fields come from the delta row, not the base.
    expect(row.memory?.physicalFootprintBytes?.value).toBe(4_096);
    // The base icon is carried over because the merged row references it.
    expect(merged.icons["ICON-E"]).toBe("ICON-E");
  });

  it("degrades a stable_from_prev row with no base counterpart", () => {
    const base = makeSnapshot([makeRow({ pid: 60, startedAtUnixMs: 1_000 })], 1);
    const wireRow: ProcessRow = {
      ...makeRow({ pid: 60, startedAtUnixMs: 9_000 }),
      executablePath: undefined,
      app: undefined,
      stableFromPrev: true,
    };
    const delta = makeDelta([wireRow], {}, 2);

    const merged = mergeSnapshotDelta(base, delta);
    const row = merged.processes[0];

    // Markers cleared, stable fields stay absent: honest fallbacks downstream.
    expect(row.stableFromPrev).toBe(false);
    expect(row.executablePath).toBeUndefined();
    expect(row.app).toBeUndefined();
  });
});
