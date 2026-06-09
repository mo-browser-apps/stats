import { describe, expect, it } from "vitest";
import { FieldStatus } from "@/gen/process_explorer";
import {
  findGroupByKey,
  singleProcessGroup,
  type IconTable,
  type ProcessGroup,
} from "@/domain/process-list";
import { buildProcessDetail } from "@/domain/process-detail";
import { makeRow, makeSnapshot } from "../helpers/process-fixtures";
import type { ProcessRow } from "@/gen/process_explorer";

const MB = 1024 * 1024;
const SEC = 1_000_000_000;

// These detail tests never set or assert an icon, so an empty table is correct;
// rowIcon resolves to undefined and the model's icon fields stay undefined.
const NO_ICONS: IconTable = {};

/** Resolves a group by key from synthetic rows, asserting it exists. */
function groupOf(rows: ProcessRow[], key: string): ProcessGroup {
  const group = findGroupByKey(makeSnapshot(rows), "cpu", key);
  if (group === undefined) {
    throw new Error(`fixture group did not resolve: ${key}`);
  }
  return group;
}

/** Builds a Chrome-like multi-process group through the real projection. */
function chromeGroup(): ProcessGroup {
  const rows = [
    makeRow({
      pid: 100,
      localizedName: "Chrome",
      bundlePath: "/Applications/Chrome.app",
      bundleName: "Chrome",
      bundleIdentifier: "com.google.Chrome",
      executablePath: "/Applications/Chrome.app/Contents/MacOS/Chrome",
      commandLine: ["/Applications/Chrome.app/Contents/MacOS/Chrome"],
      parentPid: 1,
      startedAtUnixMs: 1000,
      cpuPercent: 4,
      footprintBytes: 300 * MB,
      threadCount: 30,
      cpuTimeNanos: 10 * SEC,
      uid: 501,
      userName: "tester",
    }),
    makeRow({
      pid: 200,
      executableName: "Chrome Helper",
      bundlePath: "/Applications/Chrome.app",
      cpuPercent: 8,
      footprintBytes: 150 * MB,
      threadCount: 12,
      cpuTimeNanos: 5 * SEC,
      uid: 501,
    }),
  ];
  return groupOf(rows, "app:/Applications/Chrome.app");
}

describe("buildProcessDetail - identity from representative", () => {
  it("takes name/PID/bundle id from the lowest-PID representative", () => {
    const detail = buildProcessDetail(chromeGroup(), "cpu", NO_ICONS);
    expect(detail.name).toBe("Chrome");
    expect(detail.pid).toBe(100);
    expect(detail.bundleIdentifier).toBe("com.google.Chrome");
    expect(detail.parent).toEqual({ available: true, pid: 1 });
    expect(detail.startedAt).toBe("ok");
    expect(detail.startedAtUnixMs).toBe(1000);
    expect(detail.path).toBe("ok");
    expect(detail.pathText).toBe("/Applications/Chrome.app/Contents/MacOS/Chrome");
    expect(detail.commandLine.state).toBe("ok");
  });
});

describe("buildProcessDetail - member ranking", () => {
  it("ranks the displayed members by the active metric (desc)", () => {
    const detail = buildProcessDetail(chromeGroup(), "cpu", NO_ICONS);
    expect(detail.memberCount).toBe(2);
    // Helper (8%) outranks the main process (4%) in the displayed member list,
    // even though the main process stays the representative for the header.
    expect(detail.members.map((m) => m.pid)).toEqual([200, 100]);
  });

  it("re-ranks members when the sort switches to memory", () => {
    const detail = buildProcessDetail(chromeGroup(), "memory", NO_ICONS);
    // Main process has more memory (300 MB) than the helper (150 MB).
    expect(detail.members.map((m) => m.pid)).toEqual([100, 200]);
  });

  it("ties break by PID for equal-value members", () => {
    const rows = [
      makeRow({ pid: 30, bundlePath: "/Applications/App.app", bundleName: "App", cpuPercent: 0 }),
      makeRow({ pid: 10, bundlePath: "/Applications/App.app", cpuPercent: 0 }),
      makeRow({ pid: 20, bundlePath: "/Applications/App.app", cpuPercent: 0 }),
    ];
    const group = groupOf(rows, "app:/Applications/App.app");
    const detail = buildProcessDetail(group, "cpu", NO_ICONS);
    expect(detail.members.map((m) => m.pid)).toEqual([10, 20, 30]);
  });
});

describe("buildProcessDetail - totals", () => {
  it("sums the selected metric across members (CPU)", () => {
    const detail = buildProcessDetail(chromeGroup(), "cpu", NO_ICONS);
    expect(detail.totalSort).toBe("cpu");
    expect(detail.total.state).toBe("ok");
    // 4% + 8% = 12%, detail precision (two decimals).
    expect(detail.total.text).toBe("12.00%");
  });

  it("sums the selected metric across members (memory)", () => {
    const detail = buildProcessDetail(chromeGroup(), "memory", NO_ICONS);
    expect(detail.totalSort).toBe("memory");
    // 300 MB + 150 MB = 450 MB, detail precision (one extra decimal).
    expect(detail.total.text).toBe("450.0 MB");
  });

  it("sums thread count and CPU time across members", () => {
    const detail = buildProcessDetail(chromeGroup(), "cpu", NO_ICONS);
    expect(detail.threadCount).toEqual({ state: "ok", text: "42" }); // 30 + 12
    expect(detail.cpuTime).toEqual({ state: "ok", text: "15.00s" }); // 10s + 5s
  });

  it("takes the owning user from the representative", () => {
    const detail = buildProcessDetail(chromeGroup(), "cpu", NO_ICONS);
    expect(detail.user).toEqual({ state: "ok", text: "tester" });
  });
});

describe("buildProcessDetail - single process", () => {
  it("has no member list and reads its own fields", () => {
    const row = makeRow({
      pid: 777,
      commandName: "redis-server",
      executablePath: "/usr/local/bin/redis-server",
      startedAtUnixMs: 50,
      cpuPercent: 2.5,
      footprintBytes: 20 * MB,
      uid: 0,
      userName: "root",
    });
    const detail = buildProcessDetail(singleProcessGroup(row, "cpu", NO_ICONS), "cpu", NO_ICONS);
    expect(detail.memberCount).toBe(1);
    expect(detail.members).toHaveLength(0);
    expect(detail.name).toBe("redis-server");
    expect(detail.total.text).toBe("2.50%");
    expect(detail.user.text).toBe("root");
  });
});

describe("buildProcessDetail - availability", () => {
  it("marks missing started-at / path / command line honestly", () => {
    const row = makeRow({ pid: 5, commandName: "daemon" });
    const detail = buildProcessDetail(singleProcessGroup(row, "cpu", NO_ICONS), "cpu", NO_ICONS);
    // No start time given -> identity startedAtStatus defaults to UNKNOWN -> pending.
    expect(detail.startedAt).toBe("pending");
    // No path / command line -> pending (proto-default UNKNOWN distinguished from unavailable).
    expect(detail.path).toBe("pending");
    expect(detail.commandLine.state).toBe("pending");
    expect(detail.parent.available).toBe(false);
  });

  it("distinguishes permission-denied command line as unavailable, not pending", () => {
    const row = makeRow({ pid: 5, commandName: "secure", commandLineStatus: FieldStatus.FIELD_STATUS_PERMISSION_DENIED });
    const detail = buildProcessDetail(singleProcessGroup(row, "cpu", NO_ICONS), "cpu", NO_ICONS);
    expect(detail.commandLine.state).toBe("unavailable");
  });

  it("reports an unreadable user/thread/cpu-time stat as unavailable", () => {
    const row = makeRow({ pid: 5, commandName: "protected" });
    const detail = buildProcessDetail(singleProcessGroup(row, "cpu", NO_ICONS), "cpu", NO_ICONS);
    // No uid/threads/cpuTime fields at all -> pending (still being determined).
    expect(detail.user.state).toBe("pending");
    expect(detail.threadCount.state).toBe("pending");
    expect(detail.cpuTime.state).toBe("pending");
  });

  it("falls back to uid N when the user name is empty", () => {
    const row = makeRow({ pid: 5, commandName: "x", uid: 501, userName: "" });
    const detail = buildProcessDetail(singleProcessGroup(row, "cpu", NO_ICONS), "cpu", NO_ICONS);
    expect(detail.user).toEqual({ state: "ok", text: "uid 501" });
  });
});

describe("buildProcessDetail - group total mixed states", () => {
  it("sums OK members and ignores a pending member (no NaN)", () => {
    const rows = [
      makeRow({ pid: 10, bundlePath: "/Applications/App.app", bundleName: "App", cpuPercent: 6 }),
      // A member still being computed contributes 0, not NaN, and does not block
      // the OK total from the member that does have a value.
      makeRow({ pid: 20, bundlePath: "/Applications/App.app", cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
    ];
    const detail = buildProcessDetail(groupOf(rows, "app:/Applications/App.app"), "cpu", NO_ICONS);
    expect(detail.total.state).toBe("ok");
    expect(detail.total.text).toBe("6.00%");
  });

  it("reports the total pending when no member is OK but one is still pending", () => {
    const rows = [
      makeRow({ pid: 10, bundlePath: "/Applications/App.app", bundleName: "App", cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
      makeRow({ pid: 20, bundlePath: "/Applications/App.app", cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE }),
    ];
    // pending beats unavailable: at least one member may still resolve.
    const detail = buildProcessDetail(groupOf(rows, "app:/Applications/App.app"), "cpu", NO_ICONS);
    expect(detail.total.state).toBe("pending");
  });

  it("reports the total unavailable when every member was tried and failed", () => {
    const rows = [
      makeRow({ pid: 10, bundlePath: "/Applications/App.app", bundleName: "App", cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE }),
      makeRow({ pid: 20, bundlePath: "/Applications/App.app", cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE }),
    ];
    const detail = buildProcessDetail(groupOf(rows, "app:/Applications/App.app"), "cpu", NO_ICONS);
    expect(detail.total.state).toBe("unavailable");
  });
});
