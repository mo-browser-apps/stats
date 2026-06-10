/**
 * Runs an async tick immediately and then on a fixed interval while active.
 * A tick that overlaps an in-flight one is skipped, so a slow tick cannot
 * stack work. Once disposed the loop is permanently inert.
 */
export class PollLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
  ) {}

  /** Starts or pauses the cadence. Idempotent. */
  setActive(active: boolean): void {
    if (this.disposed) {
      return;
    }
    if (active && this.timer === null) {
      void this.run();
      this.timer = setInterval(() => void this.run(), this.intervalMs);
    } else if (!active && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch {
      // The tick owns its errors; never break the cadence or reject unhandled.
    } finally {
      this.running = false;
    }
  }
}
