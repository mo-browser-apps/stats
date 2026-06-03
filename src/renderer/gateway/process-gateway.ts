import { ipc } from '@/gen/ipc';
import type {
  CalculateSelectionMemoryTotalRequest,
  CalculateSelectionMemoryTotalResponse,
  GetProcessActionStatesRequest,
  GetProcessActionStatesResponse,
  GetProcessSnapshotResponse,
  GetSnapshotRevisionResponse,
  RunProcessActionRequest,
  RunProcessActionResponse,
} from '@/gen/process_explorer';

/**
 * Renderer-side wrapper over the generated process explorer IPC client.
 *
 * Mirrors {@link metricsGateway} and {@link appGateway}: keeps presentation
 * components free of generated-IPC details and gives the process explorer view a
 * small, typed surface. Snapshot reads are unary (a full snapshot can be large,
 * so it is pulled on demand) plus a lightweight revision read for freshness
 * polling; actions are unary so each privileged operation has an explicit target
 * validated in main.
 *
 * No UI consumer wires this yet (the process explorer list lands in I12); for
 * now main answers reads with an explicit empty/unavailable state, so these
 * calls resolve without throwing.
 */
export const processGateway = {
  /** Fetches the latest process snapshot, or an explicit empty/unavailable state. */
  getSnapshot(): Promise<GetProcessSnapshotResponse> {
    return ipc.processExplorer.GetProcessSnapshot({});
  },

  /** Fetches the latest snapshot revision for cheap freshness polling. */
  getRevision(): Promise<GetSnapshotRevisionResponse> {
    return ipc.processExplorer.GetSnapshotRevision({});
  },

  /** Totals memory for a selection of processes against one snapshot. */
  calculateSelectionMemoryTotal(
    request: CalculateSelectionMemoryTotalRequest,
  ): Promise<CalculateSelectionMemoryTotalResponse> {
    return ipc.processExplorer.CalculateSelectionMemoryTotal(request);
  },

  /** Reads main-authoritative action enablement for a process or group target. */
  getActionStates(
    request: GetProcessActionStatesRequest,
  ): Promise<GetProcessActionStatesResponse> {
    return ipc.processExplorer.GetProcessActionStates(request);
  },

  /** Runs a validated process action and returns a count-only safe result. */
  runAction(request: RunProcessActionRequest): Promise<RunProcessActionResponse> {
    return ipc.processExplorer.RunProcessAction(request);
  },
};
