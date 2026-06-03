import { createProcessIdentityKey } from './process-identity';
import { ProcessCpuUsageCalculator } from './process-cpu-usage';
import {
  AvailabilityReason,
  ChromiumProcessKind,
  CollectorWarningCode,
  MemoryMetricKind,
  MemoryMetricProvenance,
  type AvailablePngImageValue,
  type AvailableStringValue,
  type AvailableInt64Value,
  type CollectorWarning,
  type ProcessAppMetadata,
  type ProcessCommandLine,
  type ProcessMemoryMetric,
  type ProcessMemoryMetrics,
  type ProcessPerformanceMetrics,
  type ProcessRow,
  type ProcessSnapshot,
} from '../gen/process_explorer';
import {
  NativeAvailabilityReason,
  NativeCollectorWarningCode,
  NativeMemoryMetricKind,
  NativeMemoryMetricProvenance,
  type CollectProcessesResponse,
  type NativeCollectorWarning,
  type NativeCommandLine,
  type NativeInt64Value,
  type NativeMemoryMetric,
  type NativeParentProcess,
  type NativePngImageValue,
  type NativeProcessAppMetadata,
  type NativeProcessIdentity,
  type NativeProcessMemoryMetrics,
  type NativeProcessPerformanceMetrics,
  type NativeProcessRecord,
  type NativeStringValue,
} from '../gen/native/process_collector';

/**
 * Safe, argv-free warning text for records that could not be mapped. Like every
 * collector warning, it is count-only and must never include command-line
 * argument values, paths, names, or bundle identifiers.
 */
const RECORD_MAPPING_PARTIAL_MESSAGE =
  'Some process records could not be mapped and were omitted from the snapshot.';

export interface ProcessSnapshotMapperInput {
  readonly nativeResponse: CollectProcessesResponse;
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAtUnixMs: number;
  readonly refreshDurationMs: number;
  readonly logicalCoreCount: number;
}

/**
 * Maps a raw native collection into the renderer process snapshot DTO. It owns
 * the two things the native collector cannot: a stable identity key (PID plus
 * start time) and the per-process CPU-usage delta. There is no separate domain
 * model - the renderer DTO is the only process shape MoStats needs, so the map
 * is native -> DTO directly.
 *
 * CPU usage is computed by {@link ProcessCpuUsageCalculator}, which holds the
 * previous-snapshot baselines, so the mapper is stateful and one instance must
 * be reused across collections.
 *
 * Command-line argument values pass through for renderer display and local
 * search only; they are never logged or echoed in warnings.
 */
export class ProcessSnapshotMapper {
  private readonly cpuUsageCalculator = new ProcessCpuUsageCalculator();

  map(input: ProcessSnapshotMapperInput): ProcessSnapshot {
    const rows: ProcessRow[] = [];
    let skippedRecordCount = 0;

    for (const record of input.nativeResponse.records) {
      const row = mapRecord(record);
      if (row === undefined) {
        skippedRecordCount += 1;
      } else {
        rows.push(row);
      }
    }

    const cpuUsageByIdentityKey = this.cpuUsageCalculator.compute({
      capturedAtUnixMs: input.capturedAtUnixMs,
      logicalCoreCount: input.logicalCoreCount,
      rows: rows.map((row) => ({
        identityKey: row.identity?.identityKey ?? '',
        cumulativeCpuTime:
          row.performance?.cumulativeCpuTimeNanoseconds ?? unavailableInt64(),
      })),
    });

    for (const row of rows) {
      const usage = cpuUsageByIdentityKey.get(row.identity?.identityKey ?? '');
      if (usage !== undefined) {
        row.cpuUsage = usage;
      }
    }

    return {
      snapshotId: input.snapshotId,
      revision: input.revision,
      capturedAtUnixMs: input.capturedAtUnixMs,
      refreshDurationMs: input.refreshDurationMs,
      rows,
      warnings: [
        ...input.nativeResponse.warnings.map(mapNativeWarning),
        ...mapperWarnings(skippedRecordCount),
      ],
    };
  }

  /** Clears CPU baselines so the next map treats every row as a first sample. */
  reset(): void {
    this.cpuUsageCalculator.reset();
  }
}

const NATIVE_AVAILABILITY_TO_DTO: Readonly<Record<NativeAvailabilityReason, AvailabilityReason>> = {
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_UNSPECIFIED]:
    AvailabilityReason.AVAILABILITY_REASON_UNSPECIFIED,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_AVAILABLE]:
    AvailabilityReason.AVAILABILITY_REASON_AVAILABLE,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_UNAVAILABLE]:
    AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_PERMISSION_DENIED]:
    AvailabilityReason.AVAILABILITY_REASON_PERMISSION_DENIED,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_PROCESS_EXITED]:
    AvailabilityReason.AVAILABILITY_REASON_PROCESS_EXITED,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_UNSUPPORTED]:
    AvailabilityReason.AVAILABILITY_REASON_UNSUPPORTED,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_PARSE_FAILED]:
    AvailabilityReason.AVAILABILITY_REASON_PARSE_FAILED,
  [NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE]:
    AvailabilityReason.AVAILABILITY_REASON_NOT_APPLICABLE,
  [NativeAvailabilityReason.UNRECOGNIZED]: AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE,
};

const NATIVE_MEMORY_KIND_TO_DTO: Readonly<Record<NativeMemoryMetricKind, MemoryMetricKind>> = {
  [NativeMemoryMetricKind.NATIVE_MEMORY_METRIC_KIND_UNSPECIFIED]:
    MemoryMetricKind.MEMORY_METRIC_KIND_UNSPECIFIED,
  [NativeMemoryMetricKind.NATIVE_MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT]:
    MemoryMetricKind.MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT,
  [NativeMemoryMetricKind.NATIVE_MEMORY_METRIC_KIND_RESIDENT]:
    MemoryMetricKind.MEMORY_METRIC_KIND_RESIDENT,
  [NativeMemoryMetricKind.UNRECOGNIZED]: MemoryMetricKind.MEMORY_METRIC_KIND_UNSPECIFIED,
};

const NATIVE_PROVENANCE_TO_DTO: Readonly<
  Record<NativeMemoryMetricProvenance, MemoryMetricProvenance>
> = {
  [NativeMemoryMetricProvenance.NATIVE_MEMORY_METRIC_PROVENANCE_UNSPECIFIED]:
    MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_UNSPECIFIED,
  [NativeMemoryMetricProvenance.NATIVE_MEMORY_METRIC_PROVENANCE_PROC_PID_RUSAGE]:
    MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_PROC_PID_RUSAGE,
  [NativeMemoryMetricProvenance.NATIVE_MEMORY_METRIC_PROVENANCE_PROC_TASKINFO]:
    MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_PROC_TASKINFO,
  [NativeMemoryMetricProvenance.UNRECOGNIZED]:
    MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_UNSPECIFIED,
};

const NATIVE_WARNING_CODE_TO_DTO: Readonly<
  Record<NativeCollectorWarningCode, CollectorWarningCode>
> = {
  [NativeCollectorWarningCode.NATIVE_COLLECTOR_WARNING_CODE_UNSPECIFIED]:
    CollectorWarningCode.COLLECTOR_WARNING_CODE_UNSPECIFIED,
  [NativeCollectorWarningCode.NATIVE_COLLECTOR_WARNING_CODE_PARTIAL_COLLECTION]:
    CollectorWarningCode.COLLECTOR_WARNING_CODE_PARTIAL_COLLECTION,
  [NativeCollectorWarningCode.NATIVE_COLLECTOR_WARNING_CODE_PERMISSION_DENIED]:
    CollectorWarningCode.COLLECTOR_WARNING_CODE_PERMISSION_DENIED,
  [NativeCollectorWarningCode.NATIVE_COLLECTOR_WARNING_CODE_COMMAND_LINE_PARTIAL]:
    CollectorWarningCode.COLLECTOR_WARNING_CODE_COMMAND_LINE_PARTIAL,
  [NativeCollectorWarningCode.NATIVE_COLLECTOR_WARNING_CODE_COLLECTION_FAILED]:
    CollectorWarningCode.COLLECTOR_WARNING_CODE_COLLECTION_FAILED,
  [NativeCollectorWarningCode.UNRECOGNIZED]: CollectorWarningCode.COLLECTOR_WARNING_CODE_UNSPECIFIED,
};

function mapAvailability(availability: NativeAvailabilityReason | undefined): AvailabilityReason {
  return availability === undefined
    ? AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE
    : NATIVE_AVAILABILITY_TO_DTO[availability];
}

function isAvailable(availability: NativeAvailabilityReason | undefined): boolean {
  return availability === NativeAvailabilityReason.NATIVE_AVAILABILITY_REASON_AVAILABLE;
}

/** Maps one native record, or returns undefined when it has no usable identity. */
function mapRecord(record: NativeProcessRecord): ProcessRow | undefined {
  const identity = record.identity;
  if (identity === undefined) {
    return undefined;
  }

  return {
    identity: mapIdentity(identity),
    parent: mapParent(record.parent),
    commandName: mapString(record.commandName),
    executableName: mapString(record.executableName),
    executablePath: mapString(record.executablePath),
    app: mapApp(record.app),
    commandLine: mapCommandLine(record.commandLine),
    // Chromium classification is an I12+ display concern; left unspecified here.
    chromiumKind: ChromiumProcessKind.CHROMIUM_PROCESS_KIND_UNSPECIFIED,
    memory: mapMemory(record.memory),
    performance: mapPerformance(record.performance),
    // Filled in by the CPU calculator after all rows are mapped.
    cpuUsage: { availability: AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE, percent: 0 },
  };
}

function mapIdentity(identity: NativeProcessIdentity) {
  const startedAtAvailable = isAvailable(identity.startedAtAvailability);
  return {
    pid: identity.pid,
    startedAtAvailability: mapAvailability(identity.startedAtAvailability),
    startedAtUnixMs: startedAtAvailable ? identity.startedAtUnixMs : 0,
    identityKey: createProcessIdentityKey(
      identity.pid,
      startedAtAvailable ? identity.startedAtUnixMs : undefined,
    ),
  };
}

function mapParent(parent: NativeParentProcess | undefined) {
  const available = isAvailable(parent?.availability) && (parent?.parentPid ?? 0) > 0;
  return {
    availability: mapAvailability(parent?.availability),
    parentPid: available ? (parent?.parentPid ?? 0) : 0,
    parentStartedAtUnixMs: 0,
  };
}

function mapString(value: NativeStringValue | undefined): AvailableStringValue {
  return {
    availability: mapAvailability(value?.availability),
    value: isAvailable(value?.availability) ? (value?.value ?? '') : '',
  };
}

function mapApp(app: NativeProcessAppMetadata | undefined): ProcessAppMetadata {
  return {
    bundleIdentifier: mapString(app?.bundleIdentifier),
    localizedName: mapString(app?.localizedName),
    iconPng: mapPngImage(app?.iconPng),
  };
}

function mapPngImage(value: NativePngImageValue | undefined): AvailablePngImageValue {
  const available =
    isAvailable(value?.availability) &&
    value !== undefined &&
    value.pngBase64.length > 0 &&
    value.widthPx > 0 &&
    value.heightPx > 0;

  return {
    availability: available
      ? AvailabilityReason.AVAILABILITY_REASON_AVAILABLE
      : mapAvailability(value?.availability),
    pngBase64: available ? value.pngBase64 : '',
    widthPx: available ? value.widthPx : 0,
    heightPx: available ? value.heightPx : 0,
  };
}

function mapCommandLine(commandLine: NativeCommandLine | undefined): ProcessCommandLine {
  const available = isAvailable(commandLine?.availability);
  return {
    availability: mapAvailability(commandLine?.availability),
    arguments: available ? (commandLine?.arguments ?? []) : [],
    displayText: available ? (commandLine?.displayText ?? '') : '',
  };
}

function mapMemory(memory: NativeProcessMemoryMetrics | undefined): ProcessMemoryMetrics {
  return {
    physicalFootprint: mapMemoryMetric(
      memory?.physicalFootprint,
      MemoryMetricKind.MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT,
    ),
    resident: mapMemoryMetric(memory?.resident, MemoryMetricKind.MEMORY_METRIC_KIND_RESIDENT),
  };
}

function mapMemoryMetric(
  metric: NativeMemoryMetric | undefined,
  fallbackKind: MemoryMetricKind,
): ProcessMemoryMetric {
  const available = isAvailable(metric?.availability);
  return {
    kind:
      metric?.kind === undefined ||
      metric.kind === NativeMemoryMetricKind.NATIVE_MEMORY_METRIC_KIND_UNSPECIFIED
        ? fallbackKind
        : NATIVE_MEMORY_KIND_TO_DTO[metric.kind],
    availability: mapAvailability(metric?.availability),
    bytes: available ? (metric?.bytes ?? 0) : 0,
    provenance:
      metric?.provenance === undefined
        ? MemoryMetricProvenance.MEMORY_METRIC_PROVENANCE_UNSPECIFIED
        : NATIVE_PROVENANCE_TO_DTO[metric.provenance],
  };
}

function mapPerformance(
  performance: NativeProcessPerformanceMetrics | undefined,
): ProcessPerformanceMetrics {
  return {
    cumulativeCpuTimeNanoseconds: mapInt64(performance?.cumulativeCpuTimeNs),
    cumulativeNetworkReceivedBytes: mapInt64(performance?.cumulativeNetworkReceivedBytes),
    cumulativeNetworkSentBytes: mapInt64(performance?.cumulativeNetworkSentBytes),
  };
}

function mapInt64(value: NativeInt64Value | undefined): AvailableInt64Value {
  return {
    availability: mapAvailability(value?.availability),
    value: isAvailable(value?.availability) ? (value?.value ?? 0) : 0,
  };
}

function unavailableInt64(): AvailableInt64Value {
  return { availability: AvailabilityReason.AVAILABILITY_REASON_UNAVAILABLE, value: 0 };
}

function mapNativeWarning(warning: NativeCollectorWarning): CollectorWarning {
  return {
    code: NATIVE_WARNING_CODE_TO_DTO[warning.code],
    safeMessage: warning.safeMessage,
    affectedProcessCount: warning.affectedProcessCount,
  };
}

function mapperWarnings(skippedRecordCount: number): readonly CollectorWarning[] {
  if (skippedRecordCount === 0) {
    return [];
  }

  return [
    {
      code: CollectorWarningCode.COLLECTOR_WARNING_CODE_PARTIAL_COLLECTION,
      safeMessage: RECORD_MAPPING_PARTIAL_MESSAGE,
      affectedProcessCount: skippedRecordCount,
    },
  ];
}
