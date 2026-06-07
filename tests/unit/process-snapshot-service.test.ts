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
    iconPng: nativeImage(options.iconPngBase64 ?? "fake-icon-png"),
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

function response(records: NativeProcessRecord[], available = true): CollectProcessesResponse {
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
  h.collect.mockResolvedValueOnce(next);

  service.setActive(true);
  expect(h.collect).toHaveBeenCalledTimes(callIndex + 1);

  const result = h.collect.mock.results[callIndex];
  if (result.type !== "return") {
    throw new Error("collector fixture did not return a promise");
  }
  await result.value;
  await Promise.resolve();
  service.setActive(false);
}

async function collectRejectedByActivation(
  service: ProcessSnapshotService,
  error: Error,
): Promise<void> {
  const callIndex = h.collect.mock.calls.length;
  h.collect.mockRejectedValueOnce(error);

  service.setActive(true);
  expect(h.collect).toHaveBeenCalledTimes(callIndex + 1);

  const result = h.collect.mock.results[callIndex];
  if (result.type !== "return") {
    throw new Error("collector fixture did not return a promise");
  }
  await result.value.catch(() => undefined);
  await Promise.resolve();
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
