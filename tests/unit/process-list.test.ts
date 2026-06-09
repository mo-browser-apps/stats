import { describe, expect, it } from "vitest";
import { FieldStatus } from "@/gen/process_explorer";
import {
  cellState,
  DISPLAY_LIMIT,
  findGroupByKey,
  isPending,
  okString,
  pinGroupOrder,
  projectProcessList,
  resolveSelection,
  rowCpu,
  rowDisplayName,
  rowMemory,
  rowMetric,
  rowPid,
  singleProcessGroup,
} from "@/domain/process-list";
import { makeRow, makeSnapshot } from "../helpers/process-fixtures";

const MB = 1024 * 1024;

describe("row readers", () => {
  it("okString reads a value only when OK and non-empty", () => {
    expect(okString({ status: FieldStatus.FIELD_STATUS_OK, value: "x" })).toBe("x");
    expect(okString({ status: FieldStatus.FIELD_STATUS_OK, value: "" })).toBeUndefined();
    expect(okString({ status: FieldStatus.FIELD_STATUS_UNAVAILABLE, value: "x" })).toBeUndefined();
    expect(okString(undefined)).toBeUndefined();
  });

  it("rowDisplayName prefers app name, then exec, then command, then PID", () => {
    expect(rowDisplayName(makeRow({ pid: 5, localizedName: "Safari", executableName: "Safari" }))).toBe("Safari");
    expect(rowDisplayName(makeRow({ pid: 5, executableName: "node" }))).toBe("node");
    expect(rowDisplayName(makeRow({ pid: 5, commandName: "zsh" }))).toBe("zsh");
    expect(rowDisplayName(makeRow({ pid: 42 }))).toBe("PID 42");
  });

  it("isPending is true only for the proto-default UNKNOWN", () => {
    expect(isPending(FieldStatus.FIELD_STATUS_UNKNOWN)).toBe(true);
    expect(isPending(FieldStatus.FIELD_STATUS_OK)).toBe(false);
    expect(isPending(FieldStatus.FIELD_STATUS_UNAVAILABLE)).toBe(false);
  });

  it("rowCpu distinguishes ok / pending (first sample) / unavailable", () => {
    expect(rowCpu(makeRow({ cpuPercent: 12.5 }))).toEqual({ value: 12.5, pending: false });
    // UNKNOWN CPU (first-sample delta) is pending, not unavailable.
    expect(rowCpu(makeRow({ cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }))).toEqual({ pending: true });
    // A row with no cpu field at all is pending.
    expect(rowCpu(makeRow({}))).toEqual({ pending: true });
    // Tried-and-unavailable is not pending.
    expect(rowCpu(makeRow({ cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE }))).toEqual({ pending: false });
  });

  it("rowMemory prefers footprint, falls back to resident", () => {
    expect(rowMemory(makeRow({ footprintBytes: 100 * MB })).value).toBe(100 * MB);
    expect(rowMemory(makeRow({ residentBytes: 80 * MB })).value).toBe(80 * MB);
    // Footprint present but not OK -> resident fallback wins.
    const row = makeRow({ residentBytes: 80 * MB });
    expect(rowMemory(row).value).toBe(80 * MB);
  });

  it("rowMetric follows the active sort", () => {
    const row = makeRow({ cpuPercent: 5, footprintBytes: 200 * MB });
    expect(rowMetric(row, "cpu").value).toBe(5);
    expect(rowMetric(row, "memory").value).toBe(200 * MB);
  });

  it("cellState maps a cell to ok / pending / unavailable", () => {
    expect(cellState({ value: 1, pending: false })).toBe("ok");
    expect(cellState({ pending: true })).toBe("pending");
    expect(cellState({ pending: false })).toBe("unavailable");
  });
});

describe("projectProcessList - grouping", () => {
  it("groups an app's processes by bundle path into one row with a +N badge", () => {
    const rows = [
      makeRow({ pid: 100, localizedName: "Chrome", bundlePath: "/Applications/Chrome.app", bundleName: "Chrome", cpuPercent: 4 }),
      makeRow({ pid: 200, executableName: "Chrome Helper", bundlePath: "/Applications/Chrome.app", cpuPercent: 3 }),
      makeRow({ pid: 300, executableName: "Chrome Helper", bundlePath: "/Applications/Chrome.app", cpuPercent: 2 }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups).toHaveLength(1);
    const chrome = groups[0];
    expect(chrome.name).toBe("Chrome");
    expect(chrome.memberCount).toBe(3);
    expect(chrome.childCount).toBe(2);
    // Representative is the lowest-PID member (the main process), not the busiest.
    expect(chrome.pid).toBe(100);
    // Summed CPU across members.
    expect(chrome.metricState).toBe("ok");
    expect(chrome.metricText).toBe("9.0%");
    expect(chrome.sortValue).toBeCloseTo(9);
  });

  it("keeps bundle-identifier-only XPC app services as separate singleton rows", () => {
    const rows = [
      makeRow({
        pid: 10,
        startedAtUnixMs: 10,
        localizedName: "AutoFill (Chrome)",
        bundleIdentifier: "com.example.SharedXpcHelper",
        footprintBytes: 50 * MB,
      }),
      makeRow({
        pid: 11,
        startedAtUnixMs: 11,
        localizedName: "AutoFill (MoStats)",
        bundleIdentifier: "com.example.SharedXpcHelper",
        footprintBytes: 30 * MB,
      }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "memory", "");
    expect(groups.map((group) => group.name)).toEqual(["AutoFill (Chrome)", "AutoFill (MoStats)"]);
    expect(groups.every((group) => group.memberCount === 1)).toBe(true);
  });

  it("keeps non-app processes (no bundle) as separate singleton rows", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "node", startedAtUnixMs: 1 }),
      makeRow({ pid: 2, commandName: "node", startedAtUnixMs: 2 }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    // Two unrelated "node" CLIs are NOT merged into one misleading row.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.memberCount === 1)).toBe(true);
  });
});

describe("projectProcessList - sorting", () => {
  it("ranks groups by summed metric descending", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "low", startedAtUnixMs: 1, cpuPercent: 1 }),
      makeRow({ pid: 2, commandName: "high", startedAtUnixMs: 2, cpuPercent: 90 }),
      makeRow({ pid: 3, commandName: "mid", startedAtUnixMs: 3, cpuPercent: 40 }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups.map((g) => g.name)).toEqual(["high", "mid", "low"]);
  });

  it("re-ranks when the sort switches from cpu to memory", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "cpuHog", startedAtUnixMs: 1, cpuPercent: 80, footprintBytes: 10 * MB }),
      makeRow({ pid: 2, commandName: "ramHog", startedAtUnixMs: 2, cpuPercent: 5, footprintBytes: 900 * MB }),
    ];
    expect(projectProcessList(makeSnapshot(rows), "cpu", "").groups[0].name).toBe("cpuHog");
    expect(projectProcessList(makeSnapshot(rows), "memory", "").groups[0].name).toBe("ramHog");
  });

  it("preserves snapshot order on a cold start (all pending, no value)", () => {
    // Every row's CPU is UNKNOWN (first sample): sortValue 0 for all, so the
    // list must keep insertion order rather than snapping to alphabetical.
    const rows = [
      makeRow({ pid: 1, commandName: "zeta", startedAtUnixMs: 1, cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
      makeRow({ pid: 2, commandName: "alpha", startedAtUnixMs: 2, cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups.map((g) => g.name)).toEqual(["zeta", "alpha"]);
    expect(groups.every((g) => g.metricState === "pending")).toBe(true);
  });
});

describe("pinGroupOrder", () => {
  function tick(cpuByName: Record<string, number>) {
    const rows = Object.entries(cpuByName).map(([name, cpu], index) =>
      makeRow({ pid: index + 1, commandName: name, startedAtUnixMs: index + 1, cpuPercent: cpu }),
    );
    return projectProcessList(makeSnapshot(rows), "cpu", "").groups;
  }

  it("replays the pinned order over a re-ranked projection, keeping fresh values", () => {
    const before = tick({ alpha: 50, beta: 40, gamma: 30 });
    const pinned = before.map((group) => group.key);

    // Next tick: gamma spikes to the top; the pinned order must not move.
    const next = tick({ alpha: 10, beta: 20, gamma: 90 });
    const replayed = pinGroupOrder(next, pinned);

    expect(replayed.map((group) => group.name)).toEqual(["alpha", "beta", "gamma"]);
    // The group objects are the fresh ones - values keep ticking while pinned.
    expect(replayed.map((group) => group.sortValue)).toEqual([10, 20, 90]);
  });

  it("appends new groups after the pinned rows and drops vanished ones", () => {
    const pinned = tick({ alpha: 50, beta: 40, gamma: 30 }).map((group) => group.key);

    // beta exited; delta arrived at the top of the ranking.
    const nextRows = [
      makeRow({ pid: 1, commandName: "alpha", startedAtUnixMs: 1, cpuPercent: 10 }),
      makeRow({ pid: 3, commandName: "gamma", startedAtUnixMs: 3, cpuPercent: 30 }),
      makeRow({ pid: 4, commandName: "delta", startedAtUnixMs: 4, cpuPercent: 95 }),
    ];
    const next = projectProcessList(makeSnapshot(nextRows), "cpu", "").groups;

    expect(pinGroupOrder(next, pinned).map((group) => group.name)).toEqual(["alpha", "gamma", "delta"]);
  });

  it("passes groups through unchanged when nothing is pinned", () => {
    const groups = tick({ alpha: 50, beta: 40 });
    expect(pinGroupOrder(groups, [])).toBe(groups);
  });
});

describe("projectProcessList - search", () => {
  const rows = [
    makeRow({
      pid: 100,
      localizedName: "Chrome",
      bundlePath: "/Applications/Chrome.app",
      bundleName: "Chrome",
      bundleIdentifier: "com.google.Chrome",
      cpuPercent: 4,
    }),
    makeRow({
      pid: 200,
      executableName: "Chrome Helper",
      bundlePath: "/Applications/Chrome.app",
      executablePath: "/Applications/Chrome.app/Contents/Helper",
      commandLine: ["/helper", "--type=renderer"],
      cpuPercent: 3,
    }),
    makeRow({ pid: 900, commandName: "postgres", startedAtUnixMs: 9, executablePath: "/usr/local/bin/postgres" }),
  ];

  it("matches an app group by name and keeps it grouped", () => {
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "chrome");
    expect(groups).toHaveLength(1);
    expect(groups[0].memberCount).toBe(2);
  });

  it("matches by bundle identifier", () => {
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "com.google.chrome");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Chrome");
  });

  it("matches by PID", () => {
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "900");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("postgres");
  });

  it("matches by executable path", () => {
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "/usr/local/bin/postgres");
    expect(groups.map((g) => g.name)).toContain("postgres");
  });

  it("matches a helper by command-line args and returns it as its own row", () => {
    // The app group does not match "--type=renderer" by name, so only the
    // matching helper is returned (as a singleton), not the whole Chrome group.
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "--type=renderer");
    expect(groups).toHaveLength(1);
    expect(groups[0].memberCount).toBe(1);
    expect(groups[0].pid).toBe(200);
  });

  it("returns no groups when nothing matches", () => {
    expect(projectProcessList(makeSnapshot(rows), "cpu", "nonexistent").groups).toHaveLength(0);
  });
});

describe("projectProcessList - display cap", () => {
  it("caps the list at DISPLAY_LIMIT", () => {
    const rows = Array.from({ length: DISPLAY_LIMIT + 25 }, (_, i) =>
      makeRow({ pid: i + 1, commandName: `proc${i}`, startedAtUnixMs: i + 1, cpuPercent: i + 1 }),
    );
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups).toHaveLength(DISPLAY_LIMIT);
    // The cap keeps the highest-ranked rows (largest cpu first).
    expect(groups[0].sortValue).toBe(rows.length);
  });
});

describe("findGroupByKey", () => {
  it("re-resolves a group by its key, uncapped", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/Chrome.app", bundleName: "Chrome", cpuPercent: 4 }),
      makeRow({ pid: 200, bundlePath: "/Applications/Chrome.app", cpuPercent: 3 }),
    ];
    const group = findGroupByKey(makeSnapshot(rows), "cpu", "app:/Applications/Chrome.app");
    expect(group).toBeDefined();
    expect(group?.memberCount).toBe(2);
    expect(group?.pid).toBe(100);
  });

  it("returns undefined when the group is gone", () => {
    const rows = [makeRow({ pid: 1, commandName: "node", startedAtUnixMs: 1 })];
    expect(findGroupByKey(makeSnapshot(rows), "cpu", "app:/nope.app")).toBeUndefined();
  });
});

describe("resolveSelection", () => {
  it("resolves a group selection by key", () => {
    // A real multi-process group shows its owning .app name (a single process
    // would show its own name instead - covered by the grouping suite).
    const rows = [
      makeRow({ pid: 10, bundlePath: "/Applications/A.app", bundleName: "A" }),
      makeRow({ pid: 11, bundlePath: "/Applications/A.app", bundleName: "A" }),
    ];
    const group = resolveSelection(makeSnapshot(rows), "cpu", { kind: "group", key: "app:/Applications/A.app" });
    expect(group?.name).toBe("A");
    expect(group?.memberCount).toBe(2);
  });

  it("resolves a process selection by exact (pid, started_at)", () => {
    const rows = [makeRow({ pid: 50, commandName: "worker", startedAtUnixMs: 1234 })];
    const group = resolveSelection(makeSnapshot(rows), "cpu", { kind: "process", pid: 50, startedAtUnixMs: 1234 });
    expect(group?.memberCount).toBe(1);
    expect(group?.pid).toBe(50);
  });

  it("returns undefined for a reused PID (start time differs)", () => {
    // Same PID, different start time: the originally-selected process exited and
    // its PID was reused, so it must NOT resolve to the new process.
    const rows = [makeRow({ pid: 50, commandName: "other", startedAtUnixMs: 9999 })];
    const group = resolveSelection(makeSnapshot(rows), "cpu", { kind: "process", pid: 50, startedAtUnixMs: 1234 });
    expect(group).toBeUndefined();
  });

  it("returns undefined when the selected PID is gone entirely", () => {
    const rows = [makeRow({ pid: 7, commandName: "alive", startedAtUnixMs: 1 })];
    expect(resolveSelection(makeSnapshot(rows), "cpu", { kind: "process", pid: 50, startedAtUnixMs: 1234 })).toBeUndefined();
  });

  it("falls back to PID alone when the selection carried no start time", () => {
    const rows = [makeRow({ pid: 50, commandName: "worker", startedAtUnixMs: 1234 })];
    const group = resolveSelection(makeSnapshot(rows), "cpu", { kind: "process", pid: 50 });
    expect(group?.pid).toBe(50);
  });
});

describe("singleProcessGroup", () => {
  it("wraps one row as a one-member group targeting that process", () => {
    const row = makeRow({ pid: 321, commandName: "tool", startedAtUnixMs: 5, cpuPercent: 7 });
    const group = singleProcessGroup(row, "cpu", {});
    expect(group.memberCount).toBe(1);
    expect(group.childCount).toBe(0);
    expect(group.openSelection).toEqual({ kind: "process", pid: 321, startedAtUnixMs: 5 });
    expect(rowPid(row)).toBe(321);
  });
});

describe("projectProcessList - icon resolution", () => {
  it("resolves a group's icon from the snapshot's icon table by key", () => {
    // makeSnapshot tables the row's icon key (the base64 itself, in fixtures), so
    // the projection resolves the row's icon back through the table by its key.
    const rows = [makeRow({ pid: 1, commandName: "tool", iconPngBase64: "ICON-BYTES" })];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups[0].iconPngBase64).toBe("ICON-BYTES");
  });

  it("shares one icon across a multi-process group's members", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/App.app", bundleName: "App", iconPngBase64: "APP-ICON", cpuPercent: 1 }),
      makeRow({ pid: 200, bundlePath: "/Applications/App.app", iconPngBase64: "APP-ICON", cpuPercent: 1 }),
    ];
    const { groups } = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups).toHaveLength(1);
    expect(groups[0].iconPngBase64).toBe("APP-ICON");
  });

  it("leaves the icon undefined when the row has no icon key", () => {
    const { groups } = projectProcessList(makeSnapshot([makeRow({ pid: 1, commandName: "tool" })]), "cpu", "");
    expect(groups[0].iconPngBase64).toBeUndefined();
  });
});
