#ifndef MOSTATS_NATIVE_PROCESS_TYPES_H_
#define MOSTATS_NATIVE_PROCESS_TYPES_H_

#include <libproc.h>
#include <sys/types.h>

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "process_collector.pb.h"

namespace mostats::processes {

// A string field plus the reason it is (un)available. The value is meaningful
// only when availability is AVAILABLE.
struct NativeStringSnapshot {
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  std::string value;
};

// A 32x32 PNG app icon plus availability. The base64 payload is volatile
// display-only data and must not be logged or persisted.
struct NativePngImageSnapshot {
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  std::string png_base64;
  int width_px = 0;
  int height_px = 0;
};

// A signed integer field plus availability. The value is meaningful only when
// availability is AVAILABLE.
struct NativeIntegerSnapshot {
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  int64_t value = 0;
};

// proc_pidinfo(PROC_PIDTASKALLINFO) result for one PID. Used for identity start
// time, parent PID, resident-memory fallback, and cumulative CPU time.
struct NativeProcessTaskSnapshot {
  pid_t pid = 0;
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  proc_taskallinfo task_info = {};
};

// Identity/path metadata read from libproc for one PID.
struct NativeProcessMetadata {
  pid_t pid = 0;
  NativeProcessTaskSnapshot task;
  NativeStringSnapshot command_name;
  NativeStringSnapshot executable_path;
};

// Parsed KERN_PROCARGS2 result. Argument values are sensitive display/search
// data and must never be logged, persisted, exported, or echoed in warnings.
struct NativeProcessArguments {
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  std::vector<std::string> arguments;
  std::string display_text;
};

// One per-process memory metric in bytes plus availability and source.
struct NativeMemoryMetricSnapshot {
  NativeMemoryMetricKind kind = NATIVE_MEMORY_METRIC_KIND_UNSPECIFIED;
  NativeAvailabilityReason availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  int64_t bytes = 0;
  NativeMemoryMetricProvenance provenance =
      NATIVE_MEMORY_METRIC_PROVENANCE_UNSPECIFIED;
};

// Physical footprint (preferred) plus resident (fallback) for one process.
struct NativeMemoryMetricsSnapshot {
  NativeMemoryMetricSnapshot physical_footprint;
  NativeMemoryMetricSnapshot resident;
};

// Cumulative per-process counters. CPU time drives per-process CPU usage after
// main diffs it across snapshots; per-process network has no reliable macOS
// source and is reported UNSUPPORTED rather than faked.
struct NativeProcessPerformanceSnapshot {
  NativeIntegerSnapshot cumulative_cpu_time_ns;
  NativeIntegerSnapshot cumulative_network_received_bytes;
  NativeIntegerSnapshot cumulative_network_sent_bytes;
};

// Memory plus performance counters for one process.
struct NativeProcessResourceSnapshot {
  NativeMemoryMetricsSnapshot memory;
  NativeProcessPerformanceSnapshot performance;
};

// Optional NSWorkspace app metadata for a GUI process.
struct NativeAppMetadataSnapshot {
  NativeStringSnapshot bundle_identifier;
  NativeStringSnapshot localized_name;
  NativePngImageSnapshot icon_png;
};

// App metadata indexed by PID, produced by the NSWorkspace enricher.
using NativeAppMetadataByPid = std::unordered_map<int, NativeAppMetadataSnapshot>;

}  // namespace mostats::processes

#endif  // MOSTATS_NATIVE_PROCESS_TYPES_H_
