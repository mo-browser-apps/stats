import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const revisionHandle = {
    StreamRevisions: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    collect: vi.fn(),
    icons: vi.fn(),
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
    processCollector: { CollectProcesses: h.collect, GetIcons: h.icons },
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
  type NativeInt64,
  type NativeProcessCpu,
  type NativeProcessMemory,
  type NativeProcessRecord,
  type NativeProcessUser,
  type NativeResponsiveness,
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
  h.icons.mockReset();
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
  iconKey?: string;
  bundlePath?: string;
  bundleName?: string;
  commandLine?: string[];
  commandLineStatus?: NativeFieldStatus;
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
  notResponding?: boolean;
  responsivenessStatus?: NativeFieldStatus;
}

function appMetadata(options: RecordOptions): NativeAppMetadata {
  return {
    bundleIdentifier: nativeString(options.bundleIdentifier ?? "com.example.FakeApp"),
    localizedName: nativeString(options.localizedName ?? "Fake App"),
    // The native record carries only a content key; the bytes are served by the
    // separate GetIcons RPC, never on the collection response.
    iconKey: options.iconKey ?? "fake-icon-png",
    bundle: {
      path: nativeString(options.bundlePath ?? "/Applications/FakeApp.app"),
      name: nativeString(options.bundleName ?? "Fake App"),
    },
  };
}

function commandLine(options: RecordOptions): NativeCommandLine {
  const status = options.commandLineStatus ?? OK;
  return {
    status,
    arguments: status === OK ? options.commandLine ?? ["fake-app", "--fake-flag"] : [],
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

// Absent unless the test sets it, like the collector: only NSWorkspace apps
// carry the field.
function responsiveness(options: RecordOptions): NativeResponsiveness | undefined {
  if (options.responsivenessStatus !== undefined) {
    return { status: options.responsivenessStatus, unresponsive: options.notResponding ?? false };
  }
  if (options.notResponding !== undefined) {
    return { status: OK, unresponsive: options.notResponding };
  }
  return undefined;
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
    responsiveness: responsiveness(options),
  };
}

function response(
  records: NativeProcessRecord[],
  available = true,
): CollectProcessesResponse {
  return {
    available,
    collectedAtUnixMs: 0,
    records,
    warnings: [],
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
    expect(row.staticKey).not.toBe("");
    expect(row.statics?.parentStatus).toBe(FieldStatus.FIELD_STATUS_OK);
    expect(row.statics?.parentPid).toBe(1);
    expect(row.statics?.commandName?.value).toBe("fake-browser");
    expect(row.statics?.executablePath?.value).toBe("/Applications/FakeBrowser.app/Contents/MacOS/Fake Browser");
    expect(row.statics?.app?.bundleIdentifier?.value).toBe("com.example.FakeBrowser");
    expect(row.statics?.app?.localizedName?.value).toBe("Fake Browser");
    expect(row.statics?.app?.bundle?.path?.value).toBe("/Applications/FakeBrowser.app");
    expect(row.statics?.commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      arguments: ["fake-browser", "--renderer-fixture"],
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
    expect(row.statics?.user).toEqual({
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
    expect(row.statics?.executablePath).toEqual({
      status: FieldStatus.FIELD_STATUS_PERMISSION_DENIED,
      value: "",
    });
    expect(row.statics?.commandLine).toEqual({
      status: FieldStatus.FIELD_STATUS_PERMISSION_DENIED,
      arguments: [],
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

    const app = service.getSnapshot().processes[0].statics?.app;
    expect(app?.bundleIdentifier?.status).toBe(FieldStatus.FIELD_STATUS_UNKNOWN);
    expect(app?.localizedName?.status).toBe(FieldStatus.FIELD_STATUS_UNKNOWN);
    // No app -> empty icon key (the gateway then leaves the icon as a fallback).
    expect(app?.iconKey).toBe("");
    expect(app?.bundle).toBeUndefined();
  });

  it("keys rows by icon content key and keeps the wire icon table empty", async () => {
    const service = makeService();

    // Two records share one icon key. The snapshot never carries icon bytes -
    // the renderer gateway fetches unknown keys through GetProcessIcons and
    // assembles the table locally.
    const a = record({ pid: 301, iconKey: "SHARED-ICON" });
    const b = record({ pid: 302, iconKey: "SHARED-ICON" });
    await collectByActivation(service, response([a, b]));

    const snapshot = service.getSnapshot();
    expect(snapshot.icons).toEqual({});
    expect(snapshot.processes[0].statics?.app?.iconKey).toBe("SHARED-ICON");
    expect(snapshot.processes[1].statics?.app?.iconKey).toBe("SHARED-ICON");
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

    expect(service.getSnapshot().processes[0].statics?.app?.bundle).toBeUndefined();
  });

  it("maps responsiveness absent-in/absent-out and trusts the flag only when OK", async () => {
    const service = makeService();

    // A hung GUI app, a healthy one, a daemon with no field at all, and a GUI
    // app whose read failed: only the OK read may surface a true flag, and the
    // failed read must not leak its native value as a real hang.
    await collectByActivation(service, response([
      record({ pid: 401, notResponding: true }),
      record({ pid: 402, notResponding: false }),
      record({ pid: 403 }),
      record({ pid: 404, notResponding: true, responsivenessStatus: UNAVAILABLE }),
    ]));

    const rows = service.getSnapshot().processes;
    expect(rows[0].responsiveness).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      unresponsive: true,
    });
    expect(rows[1].responsiveness).toEqual({
      status: FieldStatus.FIELD_STATUS_OK,
      unresponsive: false,
    });
    expect(rows[2].responsiveness).toBeUndefined();
    expect(rows[3].responsiveness).toEqual({
      status: FieldStatus.FIELD_STATUS_UNAVAILABLE,
      unresponsive: false,
    });
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

describe("ProcessSnapshotService assets", () => {
  it("serves statics by content key from the latest two generations", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 501, startedAtUnixMs: 1_000, commandLine: ["fake-app", "--one"] }),
    ]));

    // The wire row carries only the key; the blob is fetched on demand. An
    // unknown key is omitted, not errored.
    const wireRow = service.getWireSnapshot().processes[0];
    expect(wireRow.staticKey).not.toBe("");
    expect(wireRow.statics).toBeUndefined();
    const assets = await service.getAssets([wireRow.staticKey, "unknown-key"], []);
    expect(assets.statics[wireRow.staticKey]?.commandLine?.arguments).toEqual(["fake-app", "--one"]);
    expect(assets.statics["unknown-key"]).toBeUndefined();
    expect(h.icons).not.toHaveBeenCalled();

    // After the process exits, its blob stays resolvable for exactly one more
    // generation (an asset fetch racing the next tick), then drops out.
    await collectByActivation(service, response([]));
    expect((await service.getAssets([wireRow.staticKey], [])).statics[wireRow.staticKey]).toBeDefined();
    await collectByActivation(service, response([]));
    expect((await service.getAssets([wireRow.staticKey], [])).statics[wireRow.staticKey]).toBeUndefined();
  });

  it("dedupes identical statics under one key and keeps main's own rows joined", async () => {
    const service = makeService();

    // Twin processes (same image, same argv) share one statics blob.
    await collectByActivation(service, response([
      record({ pid: 601, startedAtUnixMs: 1_000, commandLine: ["fake-twin"] }),
      record({ pid: 602, startedAtUnixMs: 1_000, commandLine: ["fake-twin"] }),
    ]));

    const [first, second] = service.getWireSnapshot().processes;
    expect(first.staticKey).toBe(second.staticKey);

    // Main's internal snapshot keeps the blob joined for the action service.
    expect(service.getSnapshot().processes[0].statics?.commandLine?.arguments).toEqual(["fake-twin"]);
  });

  it("gives changed statics a new key for the same identity (exec)", async () => {
    const service = makeService();

    await collectByActivation(service, response([
      record({ pid: 603, startedAtUnixMs: 1_000, commandLine: ["fake-wrapper"] }),
    ]));
    const before = service.getWireSnapshot().processes[0].staticKey;

    // Same (pid, started_at), new argv: the process exec'd into another image.
    await collectByActivation(service, response([
      record({ pid: 603, startedAtUnixMs: 1_000, commandLine: ["fake-real-binary", "--exec"] }),
    ]));
    const after = service.getWireSnapshot().processes[0].staticKey;

    expect(after).not.toBe(before);
  });

  it("passes icon-byte lookups through to the native cache", async () => {
    const service = makeService();
    h.icons.mockResolvedValueOnce({ icons: { "ICON-A": "BYTES-A" } });

    const result = await service.getAssets([], ["ICON-A", "ICON-GONE"]);

    expect(h.icons).toHaveBeenCalledWith({ keys: ["ICON-A", "ICON-GONE"] });
    expect(result.icons).toEqual({ "ICON-A": "BYTES-A" });
  });

  it("short-circuits empty key lists without a native call", async () => {
    const service = makeService();

    expect(await service.getAssets([], [])).toEqual({ statics: {}, icons: {} });
    expect(h.icons).not.toHaveBeenCalled();
  });

  it("degrades a failed native icon lookup to an empty table", async () => {
    const service = makeService();
    h.icons.mockRejectedValueOnce(new Error("native fixture failed"));

    expect((await service.getAssets([], ["ICON-A"])).icons).toEqual({});
  });
});
