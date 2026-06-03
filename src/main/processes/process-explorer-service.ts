import { ipc, type RequestContext } from '@mobrowser/api';
import {
  ProcessExplorerServiceDescriptor,
  type ProcessExplorerService as GeneratedProcessExplorerService,
} from '../gen/ipc_service';
import type {
  CalculateSelectionMemoryTotalRequest,
  CalculateSelectionMemoryTotalResponse,
  GetProcessActionStatesRequest,
  GetProcessActionStatesResponse,
  GetProcessSnapshotRequest,
  GetProcessSnapshotResponse,
  GetSnapshotRevisionRequest,
  GetSnapshotRevisionResponse,
  RunProcessActionRequest,
  RunProcessActionResponse,
} from '../gen/process_explorer';
import { ProcessActionService } from './process-action-service';
import { ProcessSnapshotService } from './process-snapshot-service';

/**
 * Renderer-facing process explorer IPC boundary.
 *
 * Registers the typed `ProcessExplorerService` (unary snapshot/revision reads,
 * memory totals, and action state/run) and delegates to the main-owned snapshot
 * and action services. Kept separate from the metrics stream so sensitive
 * command-line data lives in its own contract that can be gated and reviewed
 * independently.
 *
 * Lifecycle: the snapshot service collects only while the process view is
 * active. The single window is the sole consumer, so {@link setActive} drives
 * collection from window visibility (mirroring the metrics service), and
 * {@link dispose} stops the refresh loop on quit. Reads return an explicit
 * empty/unavailable state until the first collection completes. Actions stay
 * inert until I14.
 */
export class ProcessExplorerService implements GeneratedProcessExplorerService {
  private readonly snapshotService = new ProcessSnapshotService();

  private readonly actionService = new ProcessActionService(this.snapshotService);

  /** Registers the service with the IPC runtime so the renderer can call it. */
  register(): void {
    ipc.registerService(ProcessExplorerServiceDescriptor, this);
  }

  /**
   * Activates or pauses process collection to match process-view visibility.
   * The window is the only consumer, so collection runs only while it is shown.
   */
  setActive(active: boolean): void {
    this.snapshotService.setActive(active);
  }

  /** Stops the refresh loop. Called from the app quit path. */
  dispose(): void {
    this.snapshotService.dispose();
  }

  GetProcessSnapshot(
    _request: GetProcessSnapshotRequest,
    _ctx: RequestContext,
  ): Promise<GetProcessSnapshotResponse> {
    return Promise.resolve(this.snapshotService.getProcessSnapshot());
  }

  GetSnapshotRevision(
    _request: GetSnapshotRevisionRequest,
    _ctx: RequestContext,
  ): Promise<GetSnapshotRevisionResponse> {
    return Promise.resolve(this.snapshotService.getSnapshotRevision());
  }

  CalculateSelectionMemoryTotal(
    request: CalculateSelectionMemoryTotalRequest,
    _ctx: RequestContext,
  ): Promise<CalculateSelectionMemoryTotalResponse> {
    return Promise.resolve(this.snapshotService.calculateSelectionMemoryTotal(request));
  }

  GetProcessActionStates(
    request: GetProcessActionStatesRequest,
    _ctx: RequestContext,
  ): Promise<GetProcessActionStatesResponse> {
    return Promise.resolve(this.actionService.getProcessActionStates(request));
  }

  RunProcessAction(
    request: RunProcessActionRequest,
    _ctx: RequestContext,
  ): Promise<RunProcessActionResponse> {
    return Promise.resolve(this.actionService.runProcessAction(request));
  }
}
