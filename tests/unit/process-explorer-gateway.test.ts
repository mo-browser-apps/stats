import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getAssets: vi.fn(),
}));

vi.mock("@/gen/ipc", () => ({
  ipc: {
    processExplorer: {
      GetProcessSnapshot: h.getSnapshot,
      GetProcessAssets: h.getAssets,
      StreamRevisions: vi.fn(),
      GetProcessActionStates: vi.fn(),
      RunProcessAction: vi.fn(),
    },
  },
}));

import { type ProcessRow, type ProcessSnapshot, type ProcessStatics } from "@/gen/process_explorer";
import { makeRow, makeSnapshot, wireRow } from "../helpers/process-fixtures";

/**
 * Wire form of a snapshot as main sends it: rows carry only their static_key
 * (blobs stripped) and the icon table is empty; the gateway assembles both
 * locally from content keys.
 */
function wireSnapshot(rows: ProcessRow[], revision: number): ProcessSnapshot {
  return { ...makeSnapshot(rows, revision), processes: rows.map(wireRow), icons: {} };
}

/** The statics map an asset fetch would return for the given joined rows. */
function staticsOf(rows: ProcessRow[]): { [key: string]: ProcessStatics } {
  const statics: { [key: string]: ProcessStatics } = {};
  for (const row of rows) {
    if (row.statics !== undefined) {
      statics[row.staticKey] = row.statics;
    }
  }
  return statics;
}

/**
 * Imports a fresh gateway module instance so the module-level content stores
 * (statics and icons) start empty for every test, mirroring a renderer reload.
 */
async function freshGateway() {
  const module = await import("@/gateway/process-explorer-gateway");
  return module.processExplorerGateway;
}

beforeEach(() => {
  vi.resetModules();
  h.getSnapshot.mockReset();
  h.getAssets.mockReset();
});

describe("processExplorerGateway asset assembly", () => {
  it("fetches statics then icons on the first pull and joins them onto rows", async () => {
    const gateway = await freshGateway();
    const rows = [
      makeRow({ pid: 10, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A", commandLine: ["fake-app"] }),
      makeRow({ pid: 11, startedAtUnixMs: 1_000, iconPngBase64: "ICON-A" }),
      makeRow({ pid: 12, startedAtUnixMs: 1_000 }),
    ];
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 1));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf(rows), icons: {} });
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: { "ICON-A": "BYTES-A" } });

    const snapshot = await gateway.getSnapshot();

    expect(h.getSnapshot).toHaveBeenCalledWith({});
    expect(h.getAssets).toHaveBeenNthCalledWith(1, {
      staticKeys: rows.map((row) => row.staticKey),
      iconKeys: [],
    });
    // One icon fetch for the one distinct referenced key; the keyless row adds none.
    expect(h.getAssets).toHaveBeenNthCalledWith(2, { staticKeys: [], iconKeys: ["ICON-A"] });
    expect(snapshot.processes[0].statics?.commandLine?.arguments).toEqual(["fake-app"]);
    expect(snapshot.icons).toEqual({ "ICON-A": "BYTES-A" });
  });

  it("reuses held statics and icons without any fetch on the next pull", async () => {
    const gateway = await freshGateway();
    const rows = [makeRow({ pid: 20, startedAtUnixMs: 1_000, iconPngBase64: "ICON-B" })];
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 1));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf(rows), icons: {} });
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: { "ICON-B": "BYTES-B" } });
    await gateway.getSnapshot();

    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 2));

    const snapshot = await gateway.getSnapshot();

    // Everything is held; no further asset round-trips.
    expect(h.getAssets).toHaveBeenCalledTimes(2);
    expect(snapshot.processes[0].statics).toBeDefined();
    expect(snapshot.icons).toEqual({ "ICON-B": "BYTES-B" });
  });

  it("fetches only the new statics when a new process shares a held icon", async () => {
    const gateway = await freshGateway();
    const existing = makeRow({ pid: 30, startedAtUnixMs: 1_000, iconPngBase64: "ICON-C" });
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([existing], 1));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf([existing]), icons: {} });
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: { "ICON-C": "BYTES-C" } });
    await gateway.getSnapshot();

    // A second instance of the same app appears: new statics, same icon.
    const arrived = makeRow({ pid: 31, startedAtUnixMs: 2_000, iconPngBase64: "ICON-C" });
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([existing, arrived], 2));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf([arrived]), icons: {} });

    const snapshot = await gateway.getSnapshot();

    expect(h.getAssets).toHaveBeenCalledTimes(3);
    expect(h.getAssets).toHaveBeenLastCalledWith({ staticKeys: [arrived.staticKey], iconKeys: [] });
    expect(snapshot.processes[1].statics).toBeDefined();
    expect(snapshot.icons).toEqual({ "ICON-C": "BYTES-C" });
  });

  it("degrades a failed asset fetch to bare rows and heals on the next pull", async () => {
    const gateway = await freshGateway();
    const rows = [makeRow({ pid: 40, startedAtUnixMs: 1_000, commandLine: ["fake-app"] })];
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 1));
    h.getAssets.mockRejectedValueOnce(new Error("ipc fixture failed"));

    const first = await gateway.getSnapshot();
    // The pull itself succeeds; the rows just have no statics this tick.
    expect(first.processes[0].statics).toBeUndefined();
    expect(first.icons).toEqual({});

    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 2));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf(rows), icons: {} });

    const second = await gateway.getSnapshot();
    // The keys were still missing, so the next pull refetched and healed.
    expect(second.processes[0].statics?.commandLine?.arguments).toEqual(["fake-app"]);
  });

  it("retries an icon key main could not resolve on the next pull", async () => {
    const gateway = await freshGateway();
    const rows = [makeRow({ pid: 50, startedAtUnixMs: 1_000, iconPngBase64: "ICON-D" })];
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 1));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf(rows), icons: {} });
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: {} });

    const first = await gateway.getSnapshot();
    expect(first.icons).toEqual({});

    h.getSnapshot.mockResolvedValueOnce(wireSnapshot(rows, 2));
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: { "ICON-D": "BYTES-D" } });

    const second = await gateway.getSnapshot();
    expect(h.getAssets).toHaveBeenLastCalledWith({ staticKeys: [], iconKeys: ["ICON-D"] });
    expect(second.icons).toEqual({ "ICON-D": "BYTES-D" });
  });

  it("drops statics and icons no longer referenced by the new snapshot", async () => {
    const gateway = await freshGateway();
    const staying = makeRow({ pid: 60, startedAtUnixMs: 1_000, iconPngBase64: "ICON-E" });
    const exiting = makeRow({ pid: 61, startedAtUnixMs: 1_000, iconPngBase64: "ICON-F" });
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([staying, exiting], 1));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf([staying, exiting]), icons: {} });
    h.getAssets.mockResolvedValueOnce({
      statics: {},
      icons: { "ICON-E": "BYTES-E", "ICON-F": "BYTES-F" },
    });
    await gateway.getSnapshot();

    // The second process exits; its content drops out of the stores.
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([staying], 2));
    const snapshot = await gateway.getSnapshot();
    expect(h.getAssets).toHaveBeenCalledTimes(2);
    expect(snapshot.icons).toEqual({ "ICON-E": "BYTES-E" });

    // It comes back: both its statics and icon must be refetched (proves the drop).
    h.getSnapshot.mockResolvedValueOnce(wireSnapshot([staying, exiting], 3));
    h.getAssets.mockResolvedValueOnce({ statics: staticsOf([exiting]), icons: {} });
    h.getAssets.mockResolvedValueOnce({ statics: {}, icons: { "ICON-F": "BYTES-F" } });

    await gateway.getSnapshot();
    expect(h.getAssets).toHaveBeenNthCalledWith(3, { staticKeys: [exiting.staticKey], iconKeys: [] });
    expect(h.getAssets).toHaveBeenNthCalledWith(4, { staticKeys: [], iconKeys: ["ICON-F"] });
  });
});
