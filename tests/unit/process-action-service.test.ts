import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";

// The service imports `app`/`desktop` from the MoBrowser runtime. Mock them so
// reveal and the Force Quit confirmation are observable and side-effect free.
const h = vi.hoisted(() => ({
  showPath: vi.fn(),
  showMessageDialog: vi.fn(),
}));
vi.mock("@mobrowser/api", () => ({
  app: { showMessageDialog: h.showMessageDialog },
  desktop: { showPath: h.showPath },
}));

import {
  ActionDisabledReason,
  ProcessActionKind,
  RunProcessActionResponse_Outcome as Outcome,
} from "@main/gen/process_explorer";
import {
  disabledReasonFor,
  findTargetRow,
  isCriticalProcess,
  ProcessActionService,
} from "@main/processes/process-action-service";
import { makeRow, makeSnapshot, makeTarget } from "../helpers/process-fixtures";

const REVEAL = ProcessActionKind.PROCESS_ACTION_KIND_REVEAL;
const QUIT = ProcessActionKind.PROCESS_ACTION_KIND_QUIT;
const FORCE_QUIT = ProcessActionKind.PROCESS_ACTION_KIND_FORCE_QUIT;

/** A stable, non-self, non-critical target identity for an existing row. */
const SOME_PID = 4242;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findTargetRow", () => {
  it("returns undefined for an undefined target", () => {
    expect(findTargetRow(makeSnapshot([]), undefined)).toBeUndefined();
  });

  it("matches by PID plus exact start time", () => {
    const snapshot = makeSnapshot([makeRow({ pid: SOME_PID, startedAtUnixMs: 1000, commandName: "app" })]);
    const row = findTargetRow(snapshot, makeTarget(SOME_PID, 1000));
    expect(row?.identity?.pid).toBe(SOME_PID);
  });

  it("does NOT match a reused PID whose start time differs", () => {
    const snapshot = makeSnapshot([makeRow({ pid: SOME_PID, startedAtUnixMs: 2000, commandName: "new" })]);
    expect(findTargetRow(snapshot, makeTarget(SOME_PID, 1000))).toBeUndefined();
  });

  it("returns undefined when the PID is gone (exited)", () => {
    const snapshot = makeSnapshot([makeRow({ pid: 1, startedAtUnixMs: 1, commandName: "launchd" })]);
    expect(findTargetRow(snapshot, makeTarget(SOME_PID, 1000))).toBeUndefined();
  });

  it("falls back to PID alone when the target has no recorded start time", () => {
    const snapshot = makeSnapshot([makeRow({ pid: SOME_PID, startedAtUnixMs: 1000, commandName: "app" })]);
    const row = findTargetRow(snapshot, makeTarget(SOME_PID));
    expect(row?.identity?.pid).toBe(SOME_PID);
  });
});

describe("isCriticalProcess", () => {
  it("treats PID 0 and PID 1 as critical", () => {
    expect(isCriticalProcess(makeRow({ pid: 0, commandName: "kernel_task" }))).toBe(true);
    expect(isCriticalProcess(makeRow({ pid: 1, commandName: "launchd" }))).toBe(true);
  });

  it("matches a denylisted name by command OR executable name", () => {
    expect(isCriticalProcess(makeRow({ pid: 80, commandName: "WindowServer" }))).toBe(true);
    expect(isCriticalProcess(makeRow({ pid: 81, executableName: "Dock" }))).toBe(true);
    expect(isCriticalProcess(makeRow({ pid: 82, commandName: "Finder" }))).toBe(true);
  });

  it("does NOT protect an ordinary app", () => {
    expect(isCriticalProcess(makeRow({ pid: 500, commandName: "Notes", executableName: "Notes" }))).toBe(false);
  });
});

describe("disabledReasonFor", () => {
  const selfPid = 999_999; // a PID that is not the test runner's own.

  it("reveal needs an OK executable path", () => {
    const withPath = makeRow({ pid: SOME_PID, executablePath: "/Applications/App.app/Contents/MacOS/App" });
    const noPath = makeRow({ pid: SOME_PID });
    expect(disabledReasonFor(REVEAL, withPath, selfPid, makeTarget(SOME_PID, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NONE);
    expect(disabledReasonFor(REVEAL, noPath, selfPid, makeTarget(SOME_PID, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH);
  });

  it("reveal stays allowed even for self/critical (a Finder open is harmless)", () => {
    const critical = makeRow({ pid: 1, commandName: "launchd", executablePath: "/sbin/launchd" });
    expect(disabledReasonFor(REVEAL, critical, selfPid, makeTarget(1, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NONE);
  });

  it("quit requires a stable target identity (UNSTABLE_IDENTITY when no start time)", () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "app" });
    // Target carries no start time -> destructive actions are blocked.
    expect(disabledReasonFor(QUIT, row, selfPid, makeTarget(SOME_PID)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_UNSTABLE_IDENTITY);
  });

  it("quit blocks MoStats itself (SELF)", () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "MoStats" });
    expect(disabledReasonFor(QUIT, row, SOME_PID, makeTarget(SOME_PID, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_SELF);
  });

  it("quit blocks a session-critical process (PROTECTED)", () => {
    const row = makeRow({ pid: 80, startedAtUnixMs: 1, commandName: "WindowServer" });
    expect(disabledReasonFor(QUIT, row, selfPid, makeTarget(80, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_PROTECTED);
  });

  it("quit/force-quit are allowed for an ordinary, stable, non-self target", () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "Notes" });
    expect(disabledReasonFor(QUIT, row, selfPid, makeTarget(SOME_PID, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NONE);
    expect(disabledReasonFor(FORCE_QUIT, row, selfPid, makeTarget(SOME_PID, 1)))
      .toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NONE);
  });
});

describe("ProcessActionService.getActionStates", () => {
  it("disables every action with STALE when the target is gone", () => {
    const service = new ProcessActionService(() => makeSnapshot([]), () => null);
    const response = service.getActionStates({ target: makeTarget(SOME_PID, 1) });
    expect(response.targetValid).toBe(false);
    expect(response.actions).toHaveLength(3);
    expect(response.actions.every((a) => !a.enabled)).toBe(true);
    expect(response.actions.every((a) => a.disabledReason === ActionDisabledReason.ACTION_DISABLED_REASON_STALE)).toBe(true);
  });

  it("reports per-action availability for a valid ordinary target", () => {
    const row = makeRow({
      pid: SOME_PID,
      startedAtUnixMs: 1,
      commandName: "Notes",
      executablePath: "/System/Applications/Notes.app/Contents/MacOS/Notes",
    });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const response = service.getActionStates({ target: makeTarget(SOME_PID, 1) });
    expect(response.targetValid).toBe(true);
    const byKind = new Map(response.actions.map((a) => [a.kind, a]));
    expect(byKind.get(REVEAL)?.enabled).toBe(true);
    expect(byKind.get(QUIT)?.enabled).toBe(true);
    expect(byKind.get(FORCE_QUIT)?.enabled).toBe(true);
  });

  it("disables Reveal (NO_PATH) but allows Quit when the path is missing", () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "daemon" });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const byKind = new Map(service.getActionStates({ target: makeTarget(SOME_PID, 1) }).actions.map((a) => [a.kind, a]));
    expect(byKind.get(REVEAL)?.enabled).toBe(false);
    expect(byKind.get(REVEAL)?.disabledReason).toBe(ActionDisabledReason.ACTION_DISABLED_REASON_NO_PATH);
    expect(byKind.get(QUIT)?.enabled).toBe(true);
  });
});

describe("ProcessActionService.runAction", () => {
  it("reveals a target's executable via desktop.showPath", async () => {
    const path = "/Applications/App.app/Contents/MacOS/App";
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "App", executablePath: path });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: REVEAL, target: makeTarget(SOME_PID, 1) });
    expect(result.outcome).toBe(Outcome.OUTCOME_SUCCEEDED);
    expect(result.affectedCount).toBe(1);
    expect(h.showPath).toHaveBeenCalledWith(path);
  });

  it("returns STALE_TARGET when the target no longer matches", async () => {
    const service = new ProcessActionService(() => makeSnapshot([]), () => null);
    const result = await service.runAction({ action: QUIT, target: makeTarget(SOME_PID, 1) });
    expect(result.outcome).toBe(Outcome.OUTCOME_STALE_TARGET);
    expect(h.showMessageDialog).not.toHaveBeenCalled();
  });

  it("returns NOT_ALLOWED for a protected target and never signals", async () => {
    const row = makeRow({ pid: 80, startedAtUnixMs: 1, commandName: "WindowServer" });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: QUIT, target: makeTarget(80, 1) });
    expect(result.outcome).toBe(Outcome.OUTCOME_NOT_ALLOWED);
  });

  it("blocks a destructive action whose target identity is unstable (no start time)", async () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "App" });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    // Target without a start time -> UNSTABLE_IDENTITY -> NOT_ALLOWED.
    const result = await service.runAction({ action: QUIT, target: makeTarget(SOME_PID) });
    expect(result.outcome).toBe(Outcome.OUTCOME_NOT_ALLOWED);
  });

  it("treats a declined Force Quit confirmation as a no-op (does not kill)", async () => {
    h.showMessageDialog.mockResolvedValue({ button: { type: "secondary" } });
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "App", executablePath: "/x" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: FORCE_QUIT, target: makeTarget(SOME_PID, 1) });
    expect(h.showMessageDialog).toHaveBeenCalledOnce();
    expect(result.outcome).toBe(Outcome.OUTCOME_SUCCEEDED);
    expect(result.affectedCount).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("signals on a confirmed Force Quit, mapping ESRCH to STALE_TARGET", async () => {
    h.showMessageDialog.mockResolvedValue({ button: { type: "primary" } });
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "App" });
    // Simulate the process having exited between confirm and signal.
    const esrch: NodeJS.ErrnoException = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw esrch;
    });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: FORCE_QUIT, target: makeTarget(SOME_PID, 1) });
    expect(killSpy).toHaveBeenCalledWith(SOME_PID, "SIGKILL");
    expect(result.outcome).toBe(Outcome.OUTCOME_STALE_TARGET);
  });

  it("Quit sends SIGTERM with no confirmation and maps EPERM to NOT_PERMITTED", async () => {
    const row = makeRow({ pid: SOME_PID, startedAtUnixMs: 1, commandName: "rootdaemon" });
    const eperm: NodeJS.ErrnoException = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm;
    });
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: QUIT, target: makeTarget(SOME_PID, 1) });
    expect(killSpy).toHaveBeenCalledWith(SOME_PID, "SIGTERM");
    expect(h.showMessageDialog).not.toHaveBeenCalled();
    expect(result.outcome).toBe(Outcome.OUTCOME_NOT_PERMITTED);
  });

  it("blocks self-termination (SELF) without signaling", async () => {
    // Use the real runner PID so the service's selfPid guard fires.
    const row = makeRow({ pid: process.pid, startedAtUnixMs: 1, commandName: "MoStats" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const service = new ProcessActionService(() => makeSnapshot([row]), () => null);
    const result = await service.runAction({ action: QUIT, target: makeTarget(process.pid, 1) });
    expect(result.outcome).toBe(Outcome.OUTCOME_NOT_ALLOWED);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
