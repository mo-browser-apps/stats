export interface SnapshotRefreshLoopOptions {
  readonly intervalMs: number;
  readonly refresh: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs periodic process-snapshot refreshes without overlapping native
 * collection. A tick that fires while a prior refresh is still in flight reuses
 * that in-flight promise instead of starting a second collection, so a slow
 * collection can never stack work or spin. The loop swallows refresh errors (via
 * onError) so the timer keeps running and the next tick retries.
 */
export class SnapshotRefreshLoop {
  private timer: ReturnType<typeof setInterval> | undefined;

  private refreshInFlight: Promise<void> | undefined;

  constructor(private readonly options: SnapshotRefreshLoopOptions) {}

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Starts periodic refreshes and immediately runs one. Idempotent. */
  start(): void {
    if (this.isRunning()) {
      return;
    }

    this.timer = setInterval(() => {
      void this.refreshNow();
    }, this.options.intervalMs);
    void this.refreshNow();
  }

  /** Stops future ticks without cancelling an in-flight refresh. Idempotent. */
  stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one refresh, or returns the in-flight refresh if one is running. */
  refreshNow(): Promise<void> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }

    const refresh = this.runRefresh();
    this.refreshInFlight = refresh;
    void refresh.finally(() => {
      this.refreshInFlight = undefined;
    });
    return refresh;
  }

  private async runRefresh(): Promise<void> {
    try {
      await this.options.refresh();
    } catch (error: unknown) {
      this.options.onError?.(error);
    }
  }
}
