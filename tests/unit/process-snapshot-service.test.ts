import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const revisionHandle = {
    StreamRevisions: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    collect: vi.fn(),
    registerService: vi.fn(() => revisionHandle),
    revisionHandle,
    cpus: vi.fn(() => [
      { model: "Fake", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: "Fake", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: "Fake", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: "Fake", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]),
  };
});

vi.mock("@mobrowser/api", () => ({
  ipc: { registerService: h.registerService },
}));
vi.mock("@main/gen/native", () => ({
  native: {
    processCollector: { CollectProcesses: h.collect },
  },
}));
vi.mock("node:os", () => ({ cpus: h.cpus }));

import {
  FieldStatus,
  SnapshotStatus,
  SnapshotWarning_Code,
} from "@main/gen/process_explorer";
import {
  NativeFieldStatus,
  type CollectProcessesResponse,
  type NativeAppMetadata,
  type NativeCommandLine,
  type NativeImage,
  type NativeInt64,
  type NativeProcessCpu,
  type NativeProcessMemory,
  type NativeProcessRecord,
  type NativeProcessUser,
  type NativeString,
} from "@main/gen/native/process_collector";
import { ProcessSnapshotService } from "@main/processes/process-snapshot-service";

const OK = NativeFieldStatus.NATIVE_FIELD_STATUS_AVAILABLE;
const DENIED = NativeFieldStatus.NATIVE_FIELD_STATUS_PERMISSION_DENIED;
const UNAVAILABLE = NativeFieldStatus.NATIVE_FIELD_STATUS_UNAVAILABLE;

let clockMs = 0;
let nowSpy: ReturnType<typeof vi.spyOn>;
let services: ProcessSnapshotService[] = [];

beforeEach(() => {
  clockMs = 0;
  h.collect.mockReset();
  h.registerService.mockClear();
  h.revisionHandle.StreamRevisions.mockClear();
  h.revisionHandle.dispose.mockClear();
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  for (const service of services) {
    service.dispose();
  }
  services = [];
  nowSpy.mockRestore();
});

function makeService(): ProcessSnapshotService {
  const service = new ProcessSnapshotService();
  services.push(service);
  return service;
}

function nativeString(value: string, status = OK): NativeString {
  return { status, value: status === OK ? value : "" };
}

function nativeInt(value: number, status = OK): NativeInt64 {
  return { status, value: status === OK ? value : 0 };
}

function nativeImage(value: string, status = OK): NativeImage {
  return { status, pngBase64: status === OK ? value : "" };
}

interface RecordOptions {
  pid?: number;
  startedAtUnixMs?: number;
  startedAtStatus?: NativeFieldStatus;
  parentStatus?: NativeFieldStatus;
  parentPid?: number;
  commandName?: string;
  executableName?: string;
  executablePath?: string;
  executablePathStatus?: NativeFieldStatus;
  bundleIdentifier?: string;
  localizedName?: string;
  iconPngBase64?: string;
  bundlePath?: string;
  bundleName?: string;
  commandLine?: string[];
  commandLineStatus?: NativeFieldStatus;
  /** Marks the argv as served from the native cache (arguments omitted). */
  commandLineFromCache?: boolean;
  footprintBytes?: number;
  footprintStatus?: NativeFieldStatus;
  residentBytes?: number;
  residentStatus?: NativeFieldStatus;
  cpuTimeNs?: number;
  cpuStatus?: NativeFieldStatus;
  threadCount?: number;
  threadStatus?: NativeFieldStatus;
  uid?: number;
  userName?: string;
  userStatus?: NativeFieldStatus;
}

function appMetadata(options: RecordOptions): NativeAppMetadata {
  return {
    bundleIdentifier: nativeString(options.bundleIdentifier ?? "com.example.FakeApp"),
    localizedName: nativeString(options.localizedName ?? "Fake App"),
    // The native record carries an icon key; the bytes live in the response's
    // icons table (see response()). In fixtures the key doubles as the bytes.
    iconKey: options.iconPngBase64 ?? "fake-icon-png",
    bundle: {
      path: nativeString(options.bundlePath ?? "/Applications/FakeApp.app"),
      name: nativeString(options.bundleName ?? "Fake App"),
    },
  };
}

function commandLine(options: RecordOptions): NativeCommandLine {
  const status = options.commandLineStatus ?? OK;
  const fromCache = options.commandLineFromCache ?? false;
  return {
    status,
    // A cache-served argv carries no argument bytes; main rehydrates them.
    arguments:
      status === OK && !fromCache
        ? options.commandLine ?? ["fake-app", "--fake-flag"]
        : [],
    fromCache,
  };
}

function memory(options: RecordOptions): NativeProcessMemory {
  return {
    physicalFootprintBytes: nativeInt(
      options.footprintBytes ?? 512,
      options.footprintStatus ?? OK,
    ),
    residentBytes: nativeInt(
      options.residentBytes ?? 256,
      options.residentStatus ?? OK,
    ),
  };
}

function cpu(options: RecordOptions): NativeProcessCpu {
  return {
    cumulativeCpuTimeNs: nativeInt(
      options.cpuTimeNs ?? 1_000_000_000,
      options.cpuStatus ?? OK,
    ),
  };
}

function user(options: RecordOptions): NativeProcessUser {
  const status = options.userStatus ?? OK;
  return {
    status,
    uid: status === OK ? options.uid ?? 501 : 0,
    name: status === OK ? options.userName ?? "tester" : "",
  };
}

function record(options: RecordOptions = {}): NativeProcessRecord {
  return {
    identity: {
      pid: options.pid ?? 100,
      startedAtStatus: options.startedAtStatus ?? OK,
      startedAtUnixMs: options.startedAtUnixMs ?? 1_000,
    },
    parentStatus: options.parentStatus ?? OK,
    parentPid: options.parentPid ?? 1,
    commandName: nativeString(options.commandName ?? "fake-app"),
    executableName: nativeString(options.executableName ?? "Fake App"),
    executablePath: nativeString(
      options.executablePath ?? "/Applications/FakeApp.app/Contents/MacOS/Fake App",
      options.executablePathStatus ?? OK,
    ),
    app: appMetadata(options),
    commandLine: commandLine(options),
    memory: memory(options),
    cpu: cpu(options),
    threadCount: nativeInt(options.threadCount ?? 8, options.threadStatus ?? OK),
    user: user(options),
  };
}

function response(
  records: NativeProcessRecord[],
  available = true,
  iconsOverride?: { [key: string]: NativeImage },
): CollectProcessesResponse {
  // Build the dedup icon table from the records' keys, mirroring native: each
  // record's icon key maps to a NativeImage whose bytes are the key itself (the
  // fixture convention), so the snapshot table matches. Pass `iconsOverride`
  // (e.g. {}) to mimic native's delta behavior of omitting already-sent icons.
  let icons = iconsOverride;
  if (icons === undefined) {
    icons = {};
    for (const record of records) {
      const key = record.app?.iconKey;
      if (key !== undefined && key.length > 0) {
        icons[key] = nativeImage(key);
      }
    }
  }
  return {
    available,
    collectedAtUnixMs: 0,
    records,
    warnings: [],
    icons,
  };
}

async function collectByActivation(
  service: ProcessSnapshotService,
  next: CollectProcessesResponse,
): Promise<void> {
  const callIndex = h.collect.mock.calls.length;
  const revisionCallIndex = h.revisionHandle.StreamRevisions.mock.calls.length;
  h.collect.mockResolvedValueOnce(next);

  service.setActive(true);
  expect(h.collect).toHaveBeenCalledTimes(callIndex + 1);

  const result = h.collect.mock.results[callIndex];
  if (result.type !== "return") {
    throw new Error("collector fixture did not return a promise");
  }
  await result.value;
  await vi.waitFor(() => {
    expect(h.revisionHandle.StreamRevisions).toHaveBeenCalledTimes(revisionCallIndex + 1);
  });
  service.setActive(false);
}

async function collectRejectedByActivation(
  service: ProcessSnapshotService,
  error: Error,
): Promise<void> {
  const callIndex = h.collect.mock.calls.length;
  const revisionCallIndex = h.revisionHandle.StreamRevisions.mock.calls.length;
  h.collect.mockRejectedValueOnce(error);

  service.setActive(true);
  expect(h.collect).toHaveBeenCalledTimes(callIndex + 1);

  const result = h.collect.mock.results[callIndex];
  if (result.type !== "return") {
    throw new Error("collector fixture did not return a promise");
  }
  await result.value.catch(() => undefined);
  await vi.waitFor(() => {
    expect(h.revisionHandle.StreamRevisions).toHaveBeenCalledTimes(revisionCallIndex + 1);
  });
  service.setActive(false);
}

describe("ProcessSnapshotService", () => {
  it("maps native records and derives per-process CPU from a stable second sample", async () => {
    const service = makeService();

    clockMs = 1_000;
    await collectByActivation(service, response([
      record({
        pid: 123,
        startedAtUnixMs: 10_000,
        parentPid: 1,
        commandName: "fake-browser",
        executableName: "Fake Browser",
        executablePath: "/Applications/FakeBrowser.app/Contents/MacOS/Fake Browser",
        bundleIdentifier: "com.example.FakeBrowser",
        localizedName: "Fake Browser",
        bundlePath: "/Applications/FakeBrowser.app",
        bundleName: "Fake Browser",
        commandLine: ["fake-browser", "--renderer-fixture"],
        footprintBytes: 2_048,
        residentBytes: 1_024,
        cpuTimeNs: 1_000_000_000,
        threadCount: 12,
        uid: 502,
        userName: "fixtureuser",
      }),
    ]));

    let snapshot = service.getSnapshot();
    expect(snapshot.status).toBe(SnapshotStatus.SNAPSHOT_STATUS_OK);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.processes).toHaveLength(1);

    let row = snapshot.processes[0];
    expect(row.identity).toEqual({
      pid: 123,
      startedAtStatus: FieldStatus.FIELD_STATUS_OK,
      startedAtUnixMs: 10_000,
    });
    expect(row.parentStatus).toBe(FieldStatus.FIELD_STATUS_OK);
    expect(row.parentPid).toBe(1);
    expect(row.commandName?.value).toBe("fake-browser");
    expect(row.executablePath?.value).toBe("/Applications/FakeBrowser.app/Contents/MacOS/Fake Browser");
    expect(row.app?.bundleIdentifier?.value).toBe("com.example.FakeBrowser");
    expect(row.app?.localizedName?.value).toBe("Fake Browser");
    expect(row.app?.bundle?.path?.value).toBe("/Applications/FakeBrowser.app");
    expect(row.commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-browser", "--renderer-fixture"],
      fromPrev: false,
    });
    expect(row.memory?.physicalFootprintBytes).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      value: 2_048,
    });
    expect(row.cpu).toEqual({
      status: FieldStatus.FIELD_STATUS_UNKNOWN,
      usagePercent: 0,
    });
    expect(row.cpuTime).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      nanos: 1_000_000_000,
    });
    expect(row.threadCount).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      value: 12,
    });
    expect(row.user).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      uid: 502,
      name: "fixtureuser",
    });
    expect(h.revisionHandle.StreamRevisions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 1,
        status: SnapshotStatus.SNAPSHOT_STATUS_OK,
      }),
    );

    clockMs = 3_000;
    await collectByActivation(service, response([
      record({
        pid: 123,
        startedAtUnixMs: 10_000,
        cpuTimeNs: 3_000_000_000,
      }),
    ]));

    snapshot = service.getSnapshot();
    row = snapshot.processes[0];
    expect(snapshot.revision).toBe(2);
    expect(row.cpu?.status).toBe(FieldStatus.FIELD_STATUS_OK);
    expect(row.cpu?.usagePercent).toBeCloseTo(100);
    expect(row.cpuTime).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      nanos: 3_000_000_000,
    });
    expect(h.revisionHandle.StreamRevisions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 2,
        status: SnapshotStatus.SNAPSHOT_STATUS_OK,
      }),
    );
  });

  it("keeps CPU pending for a reused PID with a different start time", async () => {
    const service = makeService();

    clockMs = 1_000;
    await collectByActivation(service, response([
      record({ pid: 55, startedAtUnixMs: 1_000, cpuTimeNs: 1_000_000_000 }),
    ]));

    clockMs = 3_000;
    await collectByActivation(service, response([
      record({ pid: 55, startedAtUnixMs: 9_000, cpuTimeNs: 5_000_000_000 }),
    ]));

    const row = service.getSnapshot().processes[0];
    expect(row.identity?.pid).toBe(55);
    expect(row.identity?.startedAtUnixMs).toBe(9_000);
    expect(row.cpu).toEqual({
      status: FieldStatus.FIELD_STATUS_UNKNOWN,
      usagePercent: 0,
    });
  });

  it("reports UNKNOWN when a same-key cumulative counter goes backwards", async () => {
    const service = makeService();

    clockMs = 1_000;
    await collectByActivation(service, response([
      record({ pid: 70, startedAtUnixMs: 5_000, cpuTimeNs: 5_000_000_000 }),
    ]));

    // Same (pid, started_at) but the cumulative counter decreased (counter reset):
    // the delta is negative, so CPU re-arms to UNKNOWN rather than a bogus value.
    clockMs = 3_000;
    await collectByActivation(service, response([
      record({ pid: 70, startedAtUnixMs: 5_000, cpuTimeNs: 1_000_000_000 }),
    ]));

    expect(service.getSnapshot().processes[0].cpu).toEqual({
      status: FieldStatus.FIELD_STATUS_UNKNOWN,
      usagePercent: 0,
    });
  });

  it("caps per-process CPU at logical-core-count * 100", async () => {
    const service = makeService(); // mocked os.cpus() reports 4 cores -> cap 400%

    clockMs = 1_000;
    await collectByActivation(service, response([
      record({ pid: 71, startedAtUnixMs: 5_000, cpuTimeNs: 0 }),
    ]));

    // 10s of CPU time over a 1s wall window would be 1000%, far past the cap.
    clockMs = 2_000;
    await collectByActivation(service, response([
      record({ pid: 71, startedAtUnixMs: 5_000, cpuTimeNs: 10_000_000_000 }),
    ]));

    const row = service.getSnapshot().processes[0];
    expect(row.cpu?.status).toBe(FieldStatus.FIELD_STATUS_OK);
    expect(row.cpu?.usagePercent).toBe(400);
  });

  it("degrades a successful collect with available:false to an unavailable snapshot", async () => {
    const service = makeService();

    // Distinct from the rejected-promise path: the collector returns normally but
    // reports the list itself unavailable.
    await collectByActivation(service, response([], false));

    const snapshot = service.getSnapshot();
    expect(snapshot.status).toBe(SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.processes).toEqual([]);
  });

  it("maps denied fields to explicit statuses and count-only warnings", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({
        pid: 80,
        executablePathStatus: DENIED,
        commandLineStatus: DENIED,
        footprintStatus: DENIED,
        residentStatus: UNAVAILABLE,
      }),
    ]));

    const snapshot = service.getSnapshot();
    const row = snapshot.processes[0];
    expect(snapshot.status).toBe(SnapshotStatus.SNAPSHOT_STATUS_PERMISSION_LIMITED);
    expect(snapshot.warnings).toEqual([
      {
        code: SnapshotWarning_Code.CODE_PERMISSION_DENIED,
        affectedCount: 1,
      },
      {
        code: SnapshotWarning_Code.CODE_COMMAND_LINE_PARTIAL,
        affectedCount: 1,
      },
    ]);
    expect(row.executablePath).toEqual({
      status: FieldStatus.FIELD_STATUS_PERMISSION_DENIED,
      value: "",
    });
    expect(row.commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_PERMISSION_DENIED,
      arguments: [],
      fromPrev: false,
    });
    expect(row.memory?.physicalFootprintBytes).toEqual({
      status: FieldStatus.FIELD_STATUS_PERMISSION_DENIED,
      value: 0,
    });
    expect(row.memory?.residentBytes).toEqual({
      status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
      value: 0,
    });
  });

  it("degrades a failed native collection to an unavailable snapshot and revision", async () => {
    const service = makeService();

    await collectRejectedByActivation(service, new Error("native fixture failed"));

    const snapshot = service.getSnapshot();
    expect(snapshot.status).toBe(SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    expect(h.revisionHandle.StreamRevisions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 1,
        status: SnapshotStatus.SNAPSHOT_STATUS_UNAVAILABLE,
      }),
    );
  });
});

describe("ProcessSnapshotService field mapping", () => {
  it("maps a record with no app metadata to all-UNKNOWN app fields and no bundle", async () => {
    const service = makeService();

    // A non-GUI process carries no NSWorkspace metadata; the collector leaves the
    // whole app group unset, which must map to UNKNOWN (renderer uses a fallback
    // icon and the command/executable name) rather than OK-empty.
    const bare: NativeProcessRecord = { ...record({ pid: 200 }), app: undefined };
    await collectByActivation(service, response([bare]));

    const app = service.getSnapshot().processes[0].app;
    expect(app?.bundleIdentifier?.status).toBe(FieldStatus.FIELD_STATUS_UNKNOWN);
    expect(app?.localizedName?.status).toBe(FieldStatus.FIELD_STATUS_UNKNOWN);
    // No app -> empty icon key (the gateway then leaves the icon as a fallback).
    expect(app?.iconKey).toBe("");
    expect(app?.bundle).toBeUndefined();
  });

  it("maps the deduplicated icon table and keys each row into it", async () => {
    const service = makeService();

    // Two records share one icon: main passes the table through (one entry) and
    // each row references it by the same key. The bytes stay in the table; the
    // row's iconPngBase64 is filled later by the renderer gateway.
    const a = record({ pid: 301, iconPngBase64: "SHARED-ICON" });
    const b = record({ pid: 302, iconPngBase64: "SHARED-ICON" });
    await collectByActivation(service, response([a, b]));

    const snapshot = service.getSnapshot();
    expect(snapshot.icons["SHARED-ICON"]).toBe("SHARED-ICON");
    expect(Object.keys(snapshot.icons)).toHaveLength(1);
    expect(snapshot.processes[0].app?.iconKey).toBe("SHARED-ICON");
    expect(snapshot.processes[1].app?.iconKey).toBe("SHARED-ICON");
  });

  it("drops the app bundle to undefined when its path is not AVAILABLE", async () => {
    const service = makeService();

    // App metadata exists, but the owning .app path could not be read: the bundle
    // must be dropped so the renderer keeps the row singleton, not grouped by a
    // phantom path.
    const base = record({ pid: 201 });
    const withUnreadableBundlePath: NativeProcessRecord = {
      ...base,
      app: {
        ...base.app!,
        bundle: {
          path: nativeString("", UNAVAILABLE),
          name: nativeString("", UNAVAILABLE),
        },
      },
    };
    await collectByActivation(service, response([withUnreadableBundlePath]));

    expect(service.getSnapshot().processes[0].app?.bundle).toBeUndefined();
  });

  it("clamps negative native byte/count values to zero", async () => {
    const service = makeService();

    // Negative values should not happen, but a garbage native value must not
    // surface as a negative size/count downstream.
    await collectByActivation(service, response([
      record({ pid: 202, footprintBytes: -1, residentBytes: -5, threadCount: -3 }),
    ]));

    const row = service.getSnapshot().processes[0];
    expect(row.memory?.physicalFootprintBytes?.value).toBe(0);
    expect(row.memory?.residentBytes?.value).toBe(0);
    expect(row.threadCount?.value).toBe(0);
  });
});

describe("ProcessSnapshotService incremental payloads", () => {
  it("rehydrates cache-served argv from the pass that first read it", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 400, startedAtUnixMs: 1_000, commandLine: ["fake-app", "--flag"] }),
    ]));
    // Native serves the same identity from its cache: status only, no bytes.
    await collectByActivation(service, response([
      record({ pid: 400, startedAtUnixMs: 1_000, commandLineFromCache: true }),
    ]));

    const row = service.getSnapshot().processes[0];
    expect(row.commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-app", "--flag"],
      fromPrev: false,
    });
  });

  it("degrades a cache-served argv with no stored value to UNAVAILABLE", async () => {
    const service = makeService();

    // from_cache on the very first pass: the fresh read that should have seeded
    // the store never reached this service, so the row must not fake an argv.
    await collectByActivation(service, response([
      record({ pid: 401, startedAtUnixMs: 1_000, commandLineFromCache: true }),
    ]));

    expect(service.getSnapshot().processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
      arguments: [],
      fromPrev: false,
    });
  });

  it("rehydrates icon bytes for keys native omitted as already sent", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 402, iconPngBase64: "ICON-A" }),
    ]));
    // Next pass references the same key but ships no bytes (native's delta).
    await collectByActivation(service, response(
      [record({ pid: 402, iconPngBase64: "ICON-A" })],
      true,
      {},
    ));

    const snapshot = service.getSnapshot();
    expect(snapshot.icons["ICON-A"]).toBe("ICON-A");
    expect(snapshot.processes[0].app?.iconKey).toBe("ICON-A");
  });

  it("drops an unreferenced icon from the table and store", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 403, iconPngBase64: "ICON-B" }),
    ]));
    // The app exited; nothing references ICON-B anymore.
    await collectByActivation(service, response(
      [{ ...record({ pid: 404 }), app: undefined }],
      true,
      {},
    ));

    expect(service.getSnapshot().icons).toEqual({});
  });

  it("serves a delta against the revision the renderer holds", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 405, startedAtUnixMs: 1_000, commandLine: ["fake-app", "--one"], iconPngBase64: "ICON-C" }),
    ]));
    // Second pass: same process (argv cache-served), plus a new one with a new
    // icon and a fresh argv.
    await collectByActivation(service, response([
      record({ pid: 405, startedAtUnixMs: 1_000, commandLineFromCache: true, iconPngBase64: "ICON-C" }),
      record({ pid: 406, startedAtUnixMs: 2_000, commandLine: ["fake-new", "--two"], iconPngBase64: "ICON-D" }),
    ], true, { "ICON-D": nativeImage("ICON-D") }));

    // Renderer holds revision 1: unchanged argv, stable fields, and known icons
    // are omitted; the volatile fields still ship.
    const delta = service.getSnapshot(1);
    expect(delta.delta).toBe(true);
    expect(delta.revision).toBe(2);
    expect(Object.keys(delta.icons)).toEqual(["ICON-D"]);
    expect(delta.processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: [],
      fromPrev: true,
    });
    expect(delta.processes[0].stableFromPrev).toBe(true);
    expect(delta.processes[0].executablePath).toBeUndefined();
    expect(delta.processes[0].app).toBeUndefined();
    expect(delta.processes[0].user).toBeUndefined();
    expect(delta.processes[0].memory?.physicalFootprintBytes?.value).toBe(512);
    // The new process ships everything in full.
    expect(delta.processes[1].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-new", "--two"],
      fromPrev: false,
    });
    expect(delta.processes[1].stableFromPrev).toBe(false);
    expect(delta.processes[1].executablePath?.value).not.toBeUndefined();

    // Renderer holds the current revision (re-entering the view): everything
    // known dedupes against the snapshot itself.
    const reentry = service.getSnapshot(2);
    expect(reentry.delta).toBe(true);
    expect(reentry.icons).toEqual({});
    expect(reentry.processes[0].commandLine?.fromPrev).toBe(true);

    // An unknown revision (renderer reloaded) gets the full snapshot.
    const full = service.getSnapshot(7);
    expect(full.delta).toBe(false);
    expect(full.icons["ICON-C"]).toBe("ICON-C");
    expect(full.icons["ICON-D"]).toBe("ICON-D");
    expect(full.processes[0].commandLine?.arguments).toEqual(["fake-app", "--one"]);

    // Callers inside main (the action service) always see the full snapshot.
    expect(service.getSnapshot().delta).toBe(false);
  });

  it("ships a changed argv in full even when the identity matches", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 407, startedAtUnixMs: 1_000, commandLine: ["fake-wrapper"] }),
    ]));
    // Same identity, new argv (the process exec'd; native re-read it fresh).
    await collectByActivation(service, response([
      record({ pid: 407, startedAtUnixMs: 1_000, commandLine: ["fake-real-binary", "--exec"] }),
    ]));

    const delta = service.getSnapshot(1);
    expect(delta.delta).toBe(true);
    expect(delta.processes[0].commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-real-binary", "--exec"],
      fromPrev: false,
    });
  });

  it("ships changed stable fields in full even when the identity matches", async () => {
    const service = makeService();

    // A just-launched app first reports a staging path, then settles.
    await collectByActivation(service, response([
      record({ pid: 408, startedAtUnixMs: 1_000, executablePath: "/private/var/staging/FakeApp.app/Contents/MacOS/Fake" }),
    ]));
    await collectByActivation(service, response([
      record({ pid: 408, startedAtUnixMs: 1_000, executablePath: "/Applications/FakeApp.app/Contents/MacOS/Fake" }),
    ]));

    const delta = service.getSnapshot(1);
    expect(delta.delta).toBe(true);
    expect(delta.processes[0].stableFromPrev).toBe(false);
    expect(delta.processes[0].executablePath?.value).toBe(
      "/Applications/FakeApp.app/Contents/MacOS/Fake",
    );
  });
});
