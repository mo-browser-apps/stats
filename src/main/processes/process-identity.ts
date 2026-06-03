import { AvailabilityReason } from '../gen/process_explorer';

/**
 * Stable per-process identity key (PID plus start time). PIDs are reused, so a
 * key that also encodes the start time keeps a stale selection or action target
 * from silently retargeting a different process that reused the PID, and lets the
 * CPU calculator avoid inheriting a previous process's baseline.
 */

const UNKNOWN_START_SEGMENT = 'unavailable';

/** Derives the identity key from a PID and optional start time. */
export function createProcessIdentityKey(pid: number, startedAtUnixMs?: number): string {
  if (startedAtUnixMs === undefined) {
    return `pid:${String(pid)}:started-at:${UNKNOWN_START_SEGMENT}`;
  }
  return `pid:${String(pid)}:started-at:${String(startedAtUnixMs)}`;
}

/**
 * Derives the identity key for a renderer-supplied identity, using the start
 * time only when it is marked available.
 */
export function identityKeyFromRenderer(identity: {
  readonly pid: number;
  readonly startedAtAvailability: AvailabilityReason;
  readonly startedAtUnixMs: number;
  readonly identityKey: string;
}): string {
  // Prefer the key main already produced when the renderer round-trips it.
  if (identity.identityKey.length > 0) {
    return identity.identityKey;
  }

  const startedAtUnixMs =
    identity.startedAtAvailability === AvailabilityReason.AVAILABILITY_REASON_AVAILABLE
      ? identity.startedAtUnixMs
      : undefined;
  return createProcessIdentityKey(identity.pid, startedAtUnixMs);
}
