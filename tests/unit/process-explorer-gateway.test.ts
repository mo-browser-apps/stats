import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getIcons: vi.fn(),
}));

vi.mock("@/gen/ipc", () => ({
  ipc: {
    processExplorer: {
      GetProcessSnapshot: h.getSnapshot,
      GetProcessIcons: h.getIcons,
      StreamRevisions: vi.fn(),
      GetProcessActionStates: vi.fn(),
      RunProcessAction: vi.fn(),
    },
  },
}));

import { FieldStatus, type ProcessRow, type ProcessSnapshot } from "@/gen/process_explorer";
import { makeRow, makeSnapshot } from "../helpers/process-fixtures";

/**
 * Wire form of a full snapshot as main sends it: the icon table is always empty
 * on the wire (the gateway assembles it locally from content keys).
 */
function wireSnapshot(rows: ProcessRow[], revision: number): ProcessSnapshot {
  return { ...makeSnapshot(rows, revision), icons: {} };
}

/**
 * Wire form of a delta snapshot whose rows carry from_prev argv markers.
 */
function wireDelta(rows: ProcessRow[], revision: number): ProcessSnapshot {
  return { ...wireSnapshot(rows, revision), delta: true };
}

/**
 * Marks a row's argv as carried by the renderer's previous snapshot.
 */
function withFromPrevArgv(row: ProcessRow): ProcessRow {
  return {
    ...row,
    commandLine: { status: FieldStatus.FIELD_STATUS_OK, arguments: [], fromPrev: true },
  };
}

/**
 * Imports a fresh gateway module instance so the module-level lastSnapshot (the
 * have_revision base and icon store) starts empty for every test, mirroring a
 * renderer reload.
 */
async function freshGateway() {
  const module = await import("@/gateway/process-explorer-gateway");
  return module.processExplorerGateway;
}

beforeEach(() => {
  vi.resetModules();
  h.getSnapshot.mockReset();
  h.getIcons.mockReset();
});

describe("processExplorerGateway icon assembly", () => {
  it("fetches referenced icon keys once on first pull and assembles the table", async () => {
    const gateway = await freshGateway();
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 10, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A" }),
      makeRow({ pid: 11, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A" }),
      makeRow({ pid: 12, startedAtUnixMs: 1_000 }),
    ], 1));
    h.getIcons.mockResolvedValueOnce({ icons: { "ICON-A": "BYTES-A" } });

    const snapshot = await gateway.getSnapshot();

    expect(h.getSnapshot).toHaveBeenCalledWith({ haveRevision: 0 });
    // One fetch for the one distinct referenced key; the keyless row adds none.
    expect(h.getIcons).toHaveBeenCalledTimes(1);
    expect(h.getIcons).toHaveBeenCalledWith({ keys: ["ICON-A"] });
    expect(snapshot.icons).toEqual({ "ICON-A": "BYTES-A" });
  });

  it("reuses held keys without refetching and merges a delta against the held base", async () => {
    const gateway = await freshGateway();
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({
        pid: 20,
        startedAtUnixMs: 1_000,
        iconPngBase64: "ICON-B",
        commandLine: ["fake-app", "--flag"],
      }),
    ], 1));
    h.getIcons.mockResolvedValueOnce({ icons: { "ICON-B": "BYTES-B" } });
    await gateway.getSnapshot();

    h.getSnapshot.mockResolvedValueOnce(wireDelta([
      withFromPrevArgv(makeRow({ pid: 20, startedAtUnixMs: 1_000, iconPngBase64: "ICON-B" })),
    ], 2));

    const snapshot = await gateway.getSnapshot();

    expect(h.getSnapshot).toHaveBeenLastCalledWith({ haveRevision: 1 });
    // The key is already held; no second icon fetch.
    expect(h.getIcons).toHaveBeenCalledTimes(1);
    expect(snapshot.icons).toEqual({ "ICON-B": "BYTES-B" });
    // The from_prev argv was rehydrated from the held base snapshot.
    expect(snapshot.processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-app", "--flag"],
      fromPrev: false,
    });
    expect(snapshot.delta).toBe(false);
  });

  it("degrades a failed icon fetch to fallback and retries the keys on the next pull", async () => {
    const gateway = await freshGateway();
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 30, startedAtUnixMs: 1_000, iconPngBase64: "ICON-C" }),
    ], 1));
    h.getIcons.mockRejectedValueOnce(new Error("ipc fixture failed"));

    const first = await gateway.getSnapshot();
    // The pull itself succeeds; the row just has no icon bytes this tick.
    expect(first.icons).toEqual({});

    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 30, startedAtUnixMs: 1_000, iconPngBase64: "ICON-C" }),
    ], 2));
    h.getIcons.mockResolvedValueOnce({ icons: { "ICON-C": "BYTES-C" } });

    const second = await gateway.getSnapshot();
    // The key was still missing, so the next pull refetched and healed it.
    expect(h.getIcons).toHaveBeenLastCalledWith({ keys: ["ICON-C"] });
    expect(second.icons).toEqual({ "ICON-C": "BYTES-C" });
  });

  it("leaves a key main cannot resolve absent and retries it on the next pull", async () => {
    const gateway = await freshGateway();
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 40, startedAtUnixMs: 1_000, iconPngBase64: "ICON-D" }),
    ], 1));
    h.getIcons.mockResolvedValueOnce({ icons: {} });

    const first = await gateway.getSnapshot();
    expect(first.icons).toEqual({});

    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 40, startedAtUnixMs: 1_000, iconPngBase64: "ICON-D" }),
    ], 2));
    h.getIcons.mockResolvedValueOnce({ icons: { "ICON-D": "BYTES-D" } });

    const second = await gateway.getSnapshot();
    expect(h.getIcons).toHaveBeenCalledTimes(2);
    expect(second.icons).toEqual({ "ICON-D": "BYTES-D" });
  });

  it("drops icons no longer referenced by the new snapshot", async () => {
    const gateway = await freshGateway();
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 50, startedAtUnixMs: 1_000, iconPngBase64: "ICON-E" }),
      makeRow({ pid: 51, startedAtUnixMs: 1_000, iconPngBase64: "ICON-F" }),
    ], 1));
    h.getIcons.mockResolvedValueOnce({ icons: { "ICON-E": "BYTES-E", "ICON-F": "BYTES-F" } });
    await gateway.getSnapshot();

    // ICON-F's app exited; only ICON-E is still referenced.
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([
      makeRow({ pid: 50, startedAtUnixMs: 1_000, iconPngBase64: "ICON-E" }),
    ], 2));

    const snapshot = await gateway.getSnapshot();
    expect(h.getIcons).toHaveBeenCalledTimes(1);
    expect(snapshot.icons).toEqual({ "ICON-E": "BYTES-E" });
  });
});
