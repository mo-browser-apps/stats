#include "processes/process_metrics_reader.h"

#include <libproc.h>

#include <cerrno>
#include <cstdint>
#include <limits>

#include "processes/native_availability.h"

namespace mostats::processes {
namespace {

int64_t SaturatingInt64FromUInt64(const uint64_t value) {
  const uint64_t max_int64 =
      static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
  if (value > max_int64) {
    return std::numeric_limits<int64_t>::max();
  }
  return static_cast<int64_t>(value);
}

uint64_t SaturatingAdd(const uint64_t first, const uint64_t second) {
  if (first > std::numeric_limits<uint64_t>::max() - second) {
    return std::numeric_limits<uint64_t>::max();
  }
  return first + second;
}

NativeIntegerSnapshot AvailableInteger(const uint64_t value) {
  NativeIntegerSnapshot snapshot;
  snapshot.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  snapshot.value = SaturatingInt64FromUInt64(value);
  return snapshot;
}

NativeIntegerSnapshot UnavailableInteger(
    const NativeAvailabilityReason availability) {
  NativeIntegerSnapshot snapshot;
  snapshot.availability = availability;
  return snapshot;
}

NativeMemoryMetricSnapshot UnavailableMetric(
    const NativeMemoryMetricKind kind,
    const NativeAvailabilityReason availability) {
  NativeMemoryMetricSnapshot metric;
  metric.kind = kind;
  metric.availability = availability;
  return metric;
}

NativeMemoryMetricSnapshot AvailableMetric(
    const NativeMemoryMetricKind kind,
    const uint64_t bytes,
    const NativeMemoryMetricProvenance provenance) {
  NativeMemoryMetricSnapshot metric;
  metric.kind = kind;
  metric.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  metric.bytes = SaturatingInt64FromUInt64(bytes);
  metric.provenance = provenance;
  return metric;
}

// proc_pid_rusage gives the macOS physical footprint, the preferred memory
// figure (matches Activity Monitor's "Memory" column more closely than RSS).
NativeMemoryMetricSnapshot ReadPhysicalFootprint(const pid_t pid) {
  rusage_info_current usage = {};
  errno = 0;
  if (proc_pid_rusage(pid, RUSAGE_INFO_CURRENT,
                      reinterpret_cast<rusage_info_t*>(&usage)) == 0) {
    return AvailableMetric(NATIVE_MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT,
                           usage.ri_phys_footprint,
                           NATIVE_MEMORY_METRIC_PROVENANCE_PROC_PID_RUSAGE);
  }

  return UnavailableMetric(NATIVE_MEMORY_METRIC_KIND_PHYSICAL_FOOTPRINT,
                           AvailabilityFromErrno(errno));
}

// Resident set size from the already-read task info, used as a display fallback
// when the physical footprint is unavailable.
NativeMemoryMetricSnapshot ReadResidentFromTaskInfo(
    const NativeProcessTaskSnapshot& task) {
  if (task.availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    return UnavailableMetric(NATIVE_MEMORY_METRIC_KIND_RESIDENT,
                             task.availability);
  }

  return AvailableMetric(NATIVE_MEMORY_METRIC_KIND_RESIDENT,
                         task.task_info.ptinfo.pti_resident_size,
                         NATIVE_MEMORY_METRIC_PROVENANCE_PROC_TASKINFO);
}

// Cumulative user+system CPU time in nanoseconds; main diffs it across
// snapshots to derive a per-process CPU percentage.
NativeIntegerSnapshot ReadCpuTimeFromTaskInfo(
    const NativeProcessTaskSnapshot& task) {
  if (task.availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    return UnavailableInteger(task.availability);
  }

  return AvailableInteger(SaturatingAdd(task.task_info.ptinfo.pti_total_user,
                                        task.task_info.ptinfo.pti_total_system));
}

}  // namespace

NativeProcessResourceSnapshot ProcessMetricsReader::ReadProcess(
    const NativeProcessTaskSnapshot& task) const {
  NativeProcessResourceSnapshot snapshot;
  snapshot.memory.physical_footprint = ReadPhysicalFootprint(task.pid);
  snapshot.memory.resident = ReadResidentFromTaskInfo(task);
  snapshot.performance.cumulative_cpu_time_ns = ReadCpuTimeFromTaskInfo(task);
  // No reliable non-brittle per-process network source exists on macOS, so
  // these stay UNSUPPORTED rather than faked.
  snapshot.performance.cumulative_network_received_bytes =
      UnavailableInteger(NATIVE_AVAILABILITY_REASON_UNSUPPORTED);
  snapshot.performance.cumulative_network_sent_bytes =
      UnavailableInteger(NATIVE_AVAILABILITY_REASON_UNSUPPORTED);
  return snapshot;
}

}  // namespace mostats::processes
