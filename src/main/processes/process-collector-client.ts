import type {
  CollectProcessesRequest,
  CollectProcessesResponse,
} from '../gen/native/process_collector';
import type { ProcessCollectorClient as GeneratedProcessCollectorClient } from '../gen/native/process_collector_client';

/** The subset of the generated native client the snapshot service depends on. */
export type ProcessCollectorRpc = Pick<GeneratedProcessCollectorClient, 'CollectProcesses'>;

/**
 * Main-process boundary over the native process collector.
 *
 * Decouples {@link ProcessSnapshotService} from the generated client so the
 * native collection can be swapped or faked in tests. The snapshot service
 * drives this once per refresh tick to pull a raw native process snapshot.
 */
export interface ProcessCollector {
  collectProcesses(): Promise<CollectProcessesResponse>;
}

/**
 * Thin adapter from the {@link ProcessCollector} interface to the generated
 * native client.
 */
export class ProcessCollectorClient implements ProcessCollector {
  private static readonly EMPTY_REQUEST: CollectProcessesRequest = {};

  constructor(private readonly rpc: ProcessCollectorRpc) {}

  collectProcesses(): Promise<CollectProcessesResponse> {
    return this.rpc.CollectProcesses(ProcessCollectorClient.EMPTY_REQUEST);
  }
}
