import { describe, expect, it } from "vitest";
import { FieldStatus } from "@/gen/process_explorer";
import {
  cellState,
  DISPLAY_LIMIT,
  findGroupByKey,
  isPending,
  okString,
  pinOrder,
  projectProcessList,
  resolveSelection,
  rowCpu,
  rowDisplayName,
  rowMemory,
  rowMetric,
  rowNotResponding,
  rowPid,
  sampleMembers,
  sampleMetrics,
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

  it("rowNotResponding is true only for an OK read with the flag set", () => {
    expect(rowNotResponding(makeRow({ notResponding: true }))).toBe(true);
    expect(rowNotResponding(makeRow({ notResponding: false }))).toBe(false);
    // Daemons/helpers carry no responsiveness field at all.
    expect(rowNotResponding(makeRow({}))).toBe(false);
    // A failed/unsupported read must not surface as a real hang.
    expect(
      rowNotResponding(
        makeRow({ notResponding: true, responsivenessStatus: FieldStatus.FIELD_STATUS_UNSUPPORTED }),
      ),
    ).toBe(false);
  });
});

describe("projectProcessList - grouping", () => {
  it("groups an app's processes by bundle path into one row with a +N badge", () => {
    const rows = [
      makeRow({ pid: 100, localizedName: "Chrome", bundlePath: "/Applications/Chrome.app", bundleName: "Chrome", cpuPercent: 4 }),
      makeRow({ pid: 200, executableName: "Chrome Helper", bundlePath: "/Applications/Chrome.app", cpuPercent: 3 }),
      makeRow({ pid: 300, executableName: "Chrome Helper", bundlePath: "/Applications/Chrome.app", cpuPercent: 2 }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
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
    const groups = projectProcessList(makeSnapshot(rows), "memory", "");
    expect(groups.map((group) => group.name)).toEqual(["AutoFill (Chrome)", "AutoFill (MoStats)"]);
    expect(groups.every((group) => group.memberCount === 1)).toBe(true);
  });

  it("keeps non-app processes (no bundle) as separate singleton rows", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "node", startedAtUnixMs: 1 }),
      makeRow({ pid: 2, commandName: "node", startedAtUnixMs: 2 }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    // Two unrelated "node" CLIs are NOT merged into one misleading row.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.memberCount === 1)).toBe(true);
  });

  it("marks a group Not Responding when any member is", () => {
    const rows = [
      // The hung app's flag sits on its main process; helpers carry none.
      makeRow({ pid: 100, localizedName: "Hung", bundlePath: "/Applications/Hung.app", bundleName: "Hung", notResponding: true }),
      makeRow({ pid: 200, executableName: "Hung Helper", bundlePath: "/Applications/Hung.app" }),
      makeRow({ pid: 300, localizedName: "Fine", bundlePath: "/Applications/Fine.app", bundleName: "Fine", notResponding: false }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups.find((group) => group.name === "Hung")?.notResponding).toBe(true);
    expect(groups.find((group) => group.name === "Fine")?.notResponding).toBe(false);
  });
});

describe("projectProcessList - sorting", () => {
  it("ranks groups by summed metric descending", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "low", startedAtUnixMs: 1, cpuPercent: 1 }),
      makeRow({ pid: 2, commandName: "high", startedAtUnixMs: 2, cpuPercent: 90 }),
      makeRow({ pid: 3, commandName: "mid", startedAtUnixMs: 3, cpuPercent: 40 }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups.map((g) => g.name)).toEqual(["high", "mid", "low"]);
  });

  it("re-ranks when the sort switches from cpu to memory", () => {
    const rows = [
      makeRow({ pid: 1, commandName: "cpuHog", startedAtUnixMs: 1, cpuPercent: 80, footprintBytes: 10 * MB }),
      makeRow({ pid: 2, commandName: "ramHog", startedAtUnixMs: 2, cpuPercent: 5, footprintBytes: 900 * MB }),
    ];
    expect(projectProcessList(makeSnapshot(rows), "cpu", "")[0].name).toBe("cpuHog");
    expect(projectProcessList(makeSnapshot(rows), "memory", "")[0].name).toBe("ramHog");
  });

  it("preserves snapshot order on a cold start (all pending, no value)", () => {
    // Every row's CPU is UNKNOWN (first sample): sortValue 0 for all, so the
    // list must keep insertion order rather than snapping to alphabetical.
    const rows = [
      makeRow({ pid: 1, commandName: "zeta", startedAtUnixMs: 1, cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
      makeRow({ pid: 2, commandName: "alpha", startedAtUnixMs: 2, cpuStatus: FieldStatus.FIELD_STATUS_UNKNOWN }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups.map((g) => g.name)).toEqual(["zeta", "alpha"]);
    expect(groups.every((g) => g.metricState === "pending")).toBe(true);
  });
});

describe("pinOrder", () => {
  // Simple keyed items stand in for the ranked rows/groups the list pins: each
  // tick rebuilds them with fresh `value`s, while the pinned key order holds.
  interface Item {
    key: string;
    value: number;
  }
  const item = (key: string, value: number): Item => ({ key, value });
  const keyOf = (it: Item) => it.key;

  it("replays the pinned identity order over a re-ranked list, keeping fresh values", () => {
    const pinned = ["a", "b", "c"];
    // Fresh tick ranked c-first, but the pinned order must win.
    const ranked = [item("c", 90), item("a", 10), item("b", 20)];

    const result = pinOrder(ranked, keyOf, pinned);

    expect(result.map(keyOf)).toEqual(["a", "b", "c"]);
    // The items are the fresh ones - only the order is held, not the values.
    expect(result.map((it) => it.value)).toEqual([10, 20, 90]);
  });

  it("appends new keys after the pinned ones, in their ranked order", () => {
    const pinned = ["a", "b"];
    // d and c are new arrivals; d outranks c but both go below the pinned rows.
    const ranked = [item("d", 95), item("b", 20), item("c", 50), item("a", 10)];

    const result = pinOrder(ranked, keyOf, pinned);

    expect(result.map(keyOf)).toEqual(["a", "b", "d", "c"]);
  });

  it("drops vanished pinned keys without leaving a gap", () => {
    const pinned = ["a", "b", "c"];
    // b vanished this tick; a and c keep their relative pinned order.
    const ranked = [item("c", 30), item("a", 10)];

    expect(pinOrder(ranked, keyOf, pinned).map(keyOf)).toEqual(["a", "c"]);
  });

  it("returns the input unchanged when nothing is pinned", () => {
    const ranked = [item("a", 50), item("b", 40)];
    expect(pinOrder(ranked, keyOf, [])).toBe(ranked);
  });

  it("appends and drops together: vanished key gone, new key after the pinned ones", () => {
    const pinned = ["a", "b", "c"];
    // b exited; d arrived at the top of the ranking.
    const ranked = [item("d", 95), item("a", 10), item("c", 30)];

    expect(pinOrder(ranked, keyOf, pinned).map(keyOf)).toEqual(["a", "c", "d"]);
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
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "chrome");
    expect(groups).toHaveLength(1);
    expect(groups[0].memberCount).toBe(2);
  });

  it("matches by bundle identifier", () => {
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "com.google.chrome");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Chrome");
  });

  it("matches by PID", () => {
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "900");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("postgres");
  });

  it("matches by executable path", () => {
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "/usr/local/bin/postgres");
    expect(groups.map((g) => g.name)).toContain("postgres");
  });

  it("matches a helper by command-line args and returns it as its own row", () => {
    // The app group does not match "--type=renderer" by name, so only the
    // matching helper is returned (as a singleton), not the whole Chrome group.
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "--type=renderer");
    expect(groups).toHaveLength(1);
    expect(groups[0].memberCount).toBe(1);
    expect(groups[0].pid).toBe(200);
  });

  it("returns no groups when nothing matches", () => {
    expect(projectProcessList(makeSnapshot(rows), "cpu", "nonexistent")).toHaveLength(0);
  });
});

describe("projectProcessList - display cap", () => {
  it("caps the list at DISPLAY_LIMIT", () => {
    const rows = Array.from({ length: DISPLAY_LIMIT + 25 }, (_, i) =>
      makeRow({ pid: i + 1, commandName: `proc${i}`, startedAtUnixMs: i + 1, cpuPercent: i + 1 }),
    );
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
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
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups[0].iconPngBase64).toBe("ICON-BYTES");
  });

  it("shares one icon across a multi-process group's members", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/App.app", bundleName: "App", iconPngBase64: "APP-ICON", cpuPercent: 1 }),
      makeRow({ pid: 200, bundlePath: "/Applications/App.app", iconPngBase64: "APP-ICON", cpuPercent: 1 }),
    ];
    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    expect(groups).toHaveLength(1);
    expect(groups[0].iconPngBase64).toBe("APP-ICON");
  });

  it("leaves the icon undefined when the row has no icon key", () => {
    const groups = projectProcessList(makeSnapshot([makeRow({ pid: 1, commandName: "tool" })]), "cpu", "");
    expect(groups[0].iconPngBase64).toBeUndefined();
  });
});

describe("projectProcessList - system daemons", () => {
  // The list shows every running process; macOS daemons are not bucketed or
  // hidden. A non-app process (no .app bundle) is its own singleton row.
  const daemons = [
    makeRow({ pid: 1, commandName: "launchd", startedAtUnixMs: 1, executablePath: "/sbin/launchd", cpuPercent: 0.5 }),
    makeRow({ pid: 400, commandName: "fake-sharingd", startedAtUnixMs: 2, executablePath: "/usr/libexec/fake-sharingd", cpuPercent: 1 }),
    makeRow({ pid: 401, commandName: "fake-mds", startedAtUnixMs: 3, executablePath: "/System/Library/fake-mds", cpuPercent: 2 }),
  ];

  it("shows Apple-path non-app daemons as individual singleton rows", () => {
    const groups = projectProcessList(makeSnapshot(daemons), "cpu", "");
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.memberCount === 1)).toBe(true);
    // Ranked by CPU descending, like any other rows.
    expect(groups.map((g) => g.name)).toEqual(["fake-mds", "fake-sharingd", "launchd"]);
  });

  it("lists daemons alongside user and app-bundled processes, nothing hidden", () => {
    const rows = [
      ...daemons,
      makeRow({ pid: 500, commandName: "fake-postgres", startedAtUnixMs: 4, executablePath: "/usr/local/bin/fake-postgres", cpuPercent: 1 }),
      makeRow({ pid: 501, commandName: "fake-node", startedAtUnixMs: 5, executablePath: "/Users/fixture/work/fake-node", cpuPercent: 1 }),
      // An app keeps its own app group (it has a bundle); its helper folds in.
      makeRow({ pid: 502, localizedName: "Fake Dock", startedAtUnixMs: 6, executablePath: "/System/Library/CoreServices/FakeDock.app/Contents/MacOS/FakeDock", bundlePath: "/System/Library/CoreServices/FakeDock.app", bundleName: "Fake Dock", cpuPercent: 1 }),
      makeRow({ pid: 503, commandName: "fake-pathless", startedAtUnixMs: 7, cpuPercent: 1 }),
    ];

    const groups = projectProcessList(makeSnapshot(rows), "cpu", "");
    const names = groups.map((group) => group.name).sort();

    expect(names).toEqual([
      "Fake Dock",
      "fake-mds",
      "fake-node",
      "fake-pathless",
      "fake-postgres",
      "fake-sharingd",
      "launchd",
    ]);
  });

  it("surfaces a daemon by name search like any other process", () => {
    const groups = projectProcessList(makeSnapshot(daemons), "cpu", "fake-sharingd");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("fake-sharingd");
    // A singleton daemon matches as its own group; the key is its identity key.
    expect(groups[0].memberCount).toBe(1);
    expect(groups[0].pid).toBe(400);
    expect(groups[0].openSelection).toEqual({ kind: "group", key: "pid:400:2" });
  });
});

describe("sampleMetrics", () => {
  it("sums a group's members under the group key, with per-member identity keys", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/Chrome.app", startedAtUnixMs: 1, cpuPercent: 4, footprintBytes: 300 * MB }),
      makeRow({ pid: 200, bundlePath: "/Applications/Chrome.app", startedAtUnixMs: 2, cpuPercent: 8, footprintBytes: 150 * MB }),
    ];
    const samples = sampleMetrics(makeSnapshot(rows));

    expect(samples.get("app:/Applications/Chrome.app")).toEqual({ cpu: 12, memory: 450 * MB });
    expect(samples.get("pid:100:1")).toEqual({ cpu: 4, memory: 300 * MB });
    expect(samples.get("pid:200:2")).toEqual({ cpu: 8, memory: 150 * MB });
  });

  it("keys an ungrouped process once (group key == identity)", () => {
    const rows = [makeRow({ pid: 321, commandName: "tool", startedAtUnixMs: 5, cpuPercent: 7, footprintBytes: 20 * MB })];
    const samples = sampleMetrics(makeSnapshot(rows));

    expect(samples.get("pid:321:5")).toEqual({ cpu: 7, memory: 20 * MB });
    expect(samples.size).toBe(1);
  });

  it("records an unreadable metric as null, not a fabricated 0", () => {
    const rows = [
      makeRow({ pid: 10, commandName: "x", startedAtUnixMs: 1, cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE, footprintBytes: 5 * MB }),
    ];
    const sample = sampleMetrics(makeSnapshot(rows)).get("pid:10:1");

    expect(sample?.cpu).toBeNull();
    expect(sample?.memory).toBe(5 * MB);
  });

  it("can selectively sample only tracked history keys", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/Chrome.app", startedAtUnixMs: 1, cpuPercent: 4, footprintBytes: 300 * MB }),
      makeRow({ pid: 200, bundlePath: "/Applications/Chrome.app", startedAtUnixMs: 2, cpuPercent: 8, footprintBytes: 150 * MB }),
      makeRow({ pid: 300, bundlePath: "/Applications/Slack.app", startedAtUnixMs: 3, cpuPercent: 2, footprintBytes: 50 * MB }),
    ];
    const snapshot = makeSnapshot(rows);
    const full = sampleMetrics(snapshot);
    const selective = sampleMetrics(snapshot, new Set(["app:/Applications/Chrome.app", "pid:200:2"]));

    expect(selective.get("app:/Applications/Chrome.app")).toEqual(full.get("app:/Applications/Chrome.app"));
    expect(selective.get("pid:200:2")).toEqual(full.get("pid:200:2"));
    expect(selective.has("pid:100:1")).toBe(false);
    expect(selective.has("app:/Applications/Slack.app")).toBe(false);
  });
});

describe("sampleMembers", () => {
  it("captures a per-member breakdown (both metrics, with identity) under the group key", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/Chrome.app", localizedName: "Chrome", startedAtUnixMs: 1, cpuPercent: 4, footprintBytes: 300 * MB, iconPngBase64: "ICON" }),
      makeRow({ pid: 200, bundlePath: "/Applications/Chrome.app", executableName: "Chrome Helper", startedAtUnixMs: 2, cpuPercent: 8, footprintBytes: 150 * MB }),
    ];
    const breakdown = sampleMembers(makeSnapshot(rows)).get("app:/Applications/Chrome.app");

    expect(breakdown).toEqual([
      { key: "pid:100:1", pid: 100, startedAtUnixMs: 1, name: "Chrome", iconKey: "ICON", cpu: 4, memory: 300 * MB },
      { key: "pid:200:2", pid: 200, startedAtUnixMs: 2, name: "Chrome Helper", iconKey: undefined, cpu: 8, memory: 150 * MB },
    ]);
  });

  it("omits single-member keys (an ordinary process has no breakdown)", () => {
    const rows = [makeRow({ pid: 321, commandName: "tool", startedAtUnixMs: 5, cpuPercent: 7 })];
    const breakdowns = sampleMembers(makeSnapshot(rows));

    expect(breakdowns.size).toBe(0);
  });

  it("captures a one-member app group so historical ticks do not fall back to live members", () => {
    const rows = [
      makeRow({
        pid: 100,
        bundlePath: "/Applications/App.app",
        localizedName: "App",
        startedAtUnixMs: 1,
        cpuPercent: 4,
        footprintBytes: 300 * MB,
      }),
    ];
    const breakdown = sampleMembers(makeSnapshot(rows)).get("app:/Applications/App.app");

    expect(breakdown).toEqual([
      { key: "pid:100:1", pid: 100, startedAtUnixMs: 1, name: "App", iconKey: undefined, cpu: 4, memory: 300 * MB },
    ]);
  });

  it("records an unreadable member metric as null at the tick", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/App.app", startedAtUnixMs: 1, cpuStatus: FieldStatus.FIELD_STATUS_UNAVAILABLE, footprintBytes: 10 * MB }),
      makeRow({ pid: 200, bundlePath: "/Applications/App.app", startedAtUnixMs: 2, cpuPercent: 3, footprintBytes: 20 * MB }),
    ];
    const breakdown = sampleMembers(makeSnapshot(rows)).get("app:/Applications/App.app");

    expect(breakdown?.[0].cpu).toBeNull();
    expect(breakdown?.[0].memory).toBe(10 * MB);
  });

  it("captures only multi-member keys; a singleton daemon gets no breakdown", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/App.app", startedAtUnixMs: 1, cpuPercent: 4 }),
      makeRow({ pid: 200, bundlePath: "/Applications/App.app", startedAtUnixMs: 2, cpuPercent: 3 }),
      // A lone daemon is a singleton row, so it has no member breakdown (the
      // detail just shows the row itself) - it is listed, not hidden.
      makeRow({ pid: 1, commandName: "launchd", startedAtUnixMs: 9, executablePath: "/sbin/launchd", cpuPercent: 1 }),
    ];
    const breakdowns = sampleMembers(makeSnapshot(rows));

    expect([...breakdowns.keys()]).toEqual(["app:/Applications/App.app"]);
    expect(breakdowns.get("pid:1:9")).toBeUndefined();
  });

  it("can selectively sample only tracked app-group breakdowns", () => {
    const rows = [
      makeRow({ pid: 100, bundlePath: "/Applications/Chrome.app", localizedName: "Chrome", startedAtUnixMs: 1, cpuPercent: 4, footprintBytes: 300 * MB }),
      makeRow({ pid: 200, bundlePath: "/Applications/Chrome.app", executableName: "Chrome Helper", startedAtUnixMs: 2, cpuPercent: 8, footprintBytes: 150 * MB }),
      makeRow({ pid: 300, bundlePath: "/Applications/Slack.app", localizedName: "Slack", startedAtUnixMs: 3, cpuPercent: 2, footprintBytes: 50 * MB }),
      makeRow({ pid: 400, bundlePath: "/Applications/Slack.app", executableName: "Slack Helper", startedAtUnixMs: 4, cpuPercent: 1, footprintBytes: 40 * MB }),
    ];
    const snapshot = makeSnapshot(rows);
    const full = sampleMembers(snapshot);
    const selective = sampleMembers(snapshot, new Set(["app:/Applications/Chrome.app"]));

    expect(selective.get("app:/Applications/Chrome.app")).toEqual(full.get("app:/Applications/Chrome.app"));
    expect([...selective.keys()]).toEqual(["app:/Applications/Chrome.app"]);
  });
});
