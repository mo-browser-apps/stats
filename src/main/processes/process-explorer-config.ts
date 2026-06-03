/**
 * Shared configuration and safe warning text for the process explorer.
 *
 * Warning messages are count-only and must never include command-line argument
 * values, executable paths, process names, or bundle identifiers.
 */

/** How often main re-collects the process snapshot while the view is active. */
export const PROCESS_SNAPSHOT_REFRESH_INTERVAL_MS = 2000;

/** Prefix for the per-collection snapshot id (the revision is appended). */
export const PROCESS_SNAPSHOT_ID_PREFIX = 'process-snapshot';

/** Safe, argv-free warning text surfaced to the renderer. */
export const PROCESS_SNAPSHOT_WARNINGS = {
  nativeCollectionFailed: 'The process snapshot could not be collected from the system.',
  nativeRecordMappingPartial:
    'Some process records could not be mapped and were omitted from the snapshot.',
} as const;
