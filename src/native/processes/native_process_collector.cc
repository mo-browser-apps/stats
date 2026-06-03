#include "processes/native_process_collector.h"

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "processes/native_availability.h"

namespace mostats::processes {
namespace {

using Clock = std::chrono::steady_clock;

int64_t UnixTimeMilliseconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

int64_t ElapsedMilliseconds(const Clock::time_point started_at) {
  const auto elapsed = Clock::now() - started_at;
  return std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
}

int64_t StartTimeUnixMilliseconds(const proc_bsdinfo& bsd_info) {
  return static_cast<int64_t>(bsd_info.pbi_start_tvsec) * 1000 +
         static_cast<int64_t>(bsd_info.pbi_start_tvusec) / 1000;
}

std::string ExecutableNameFromPath(const std::string& executable_path) {
  const size_t separator = executable_path.find_last_of('/');
  if (separator == std::string::npos ||
      separator + 1 >= executable_path.size()) {
    return executable_path;
  }
  return executable_path.substr(separator + 1);
}

void SetStringValue(NativeStringValue* target,
                    const NativeStringSnapshot& source) {
  target->set_availability(source.availability);
  if (source.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    target->set_value(source.value);
  }
}

void SetPngImageValue(NativePngImageValue* target,
                      const NativePngImageSnapshot& source) {
  target->set_availability(source.availability);
  if (source.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    target->set_png_base64(source.png_base64);
    target->set_width_px(source.width_px);
    target->set_height_px(source.height_px);
  }
}

void SetIntegerValue(NativeInt64Value* target,
                     const NativeIntegerSnapshot& source) {
  target->set_availability(source.availability);
  if (source.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    target->set_value(source.value);
  }
}

void SetMemoryMetric(NativeMemoryMetric* target,
                     const NativeMemoryMetricSnapshot& source) {
  target->set_kind(source.kind);
  target->set_availability(source.availability);
  target->set_provenance(source.provenance);
  if (source.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    target->set_bytes(source.bytes);
  }
}

// Command-line argument values are sensitive; they are written to the wire
// message for display/search only and are never logged or echoed in warnings.
void SetCommandLine(NativeCommandLine* target,
                    const NativeProcessArguments& source) {
  target->set_availability(source.availability);
  if (source.availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    return;
  }

  for (const std::string& argument : source.arguments) {
    target->add_arguments(argument);
  }
  target->set_display_text(source.display_text);
}

void SetIdentity(NativeProcessIdentity* identity,
                 const NativeProcessTaskSnapshot& task,
                 const pid_t pid) {
  identity->set_pid(static_cast<int32_t>(pid));
  if (task.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE &&
      task.task_info.pbsd.pbi_start_tvsec > 0) {
    identity->set_started_at_availability(NATIVE_AVAILABILITY_REASON_AVAILABLE);
    identity->set_started_at_unix_ms(
        StartTimeUnixMilliseconds(task.task_info.pbsd));
    return;
  }
  identity->set_started_at_availability(task.availability);
}

void SetParent(NativeParentProcess* parent,
               const NativeProcessTaskSnapshot& task) {
  if (task.availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    parent->set_availability(task.availability);
    return;
  }

  const int32_t parent_pid = static_cast<int32_t>(task.task_info.pbsd.pbi_ppid);
  if (parent_pid <= 0) {
    // The kernel/launchd root has no real parent process.
    parent->set_availability(NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE);
    return;
  }

  parent->set_availability(NATIVE_AVAILABILITY_REASON_AVAILABLE);
  parent->set_parent_pid(parent_pid);
}

// Executable file name from the path when available, otherwise the command name.
NativeStringSnapshot ExecutableNameSnapshot(
    const NativeStringSnapshot& executable_path,
    const NativeStringSnapshot& command_name) {
  if (executable_path.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    NativeStringSnapshot snapshot;
    snapshot.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
    snapshot.value = ExecutableNameFromPath(executable_path.value);
    return snapshot;
  }
  return command_name;
}

void AddWarning(CollectProcessesResponse* response,
                const NativeCollectorWarningCode code,
                const std::string& safe_message,
                const int affected_count) {
  if (affected_count <= 0) {
    return;
  }

  NativeCollectorWarning* warning = response->add_warnings();
  warning->set_code(code);
  warning->set_safe_message(safe_message);
  warning->set_affected_process_count(affected_count);
}

// Per-collection counters for the safe (no-argv) warning summary.
struct WarningCounters {
  int partial_collection_count = 0;
  int permission_denied_count = 0;
  int command_line_partial_count = 0;
};

void UpdateWarningCounters(const NativeProcessMetadata& metadata,
                           const NativeProcessArguments& arguments,
                           const NativeMemoryMetricsSnapshot& memory,
                           WarningCounters* counters) {
  bool partial = false;
  bool permission_denied = false;

  const NativeAvailabilityReason states[] = {
      metadata.task.availability,
      metadata.command_name.availability,
      metadata.executable_path.availability,
      arguments.availability,
      memory.physical_footprint.availability,
      memory.resident.availability,
  };

  for (const NativeAvailabilityReason state : states) {
    if (state != NATIVE_AVAILABILITY_REASON_AVAILABLE &&
        state != NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE) {
      partial = true;
    }
    if (IsPermissionDenied(state)) {
      permission_denied = true;
    }
  }

  if (arguments.availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    counters->command_line_partial_count += 1;
  }
  if (partial) {
    counters->partial_collection_count += 1;
  }
  if (permission_denied) {
    counters->permission_denied_count += 1;
  }
}

}  // namespace

NativeProcessCollector::NativeProcessCollector() = default;

CollectProcessesResponse NativeProcessCollector::Collect() const {
  const Clock::time_point started_at = Clock::now();
  CollectProcessesResponse response;

  NativeAvailabilityReason list_availability =
      NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  const std::vector<NativeProcessMetadata> processes =
      enumerator_.EnumerateProcesses(&list_availability);
  const NativeAppMetadataByPid app_metadata_by_pid =
      application_enricher_.SnapshotRunningApplications();

  WarningCounters warning_counters;
  if (list_availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    AddWarning(&response, NATIVE_COLLECTOR_WARNING_CODE_COLLECTION_FAILED,
               "The native collector could not enumerate process identifiers.",
               1);
  }

  for (const NativeProcessMetadata& process : processes) {
    const NativeProcessArguments arguments = arguments_reader_.Read(process.pid);
    const NativeProcessResourceSnapshot metrics =
        metrics_reader_.ReadProcess(process.task);
    UpdateWarningCounters(process, arguments, metrics.memory, &warning_counters);

    NativeProcessRecord* record = response.add_records();
    SetIdentity(record->mutable_identity(), process.task, process.pid);
    SetParent(record->mutable_parent(), process.task);
    SetStringValue(record->mutable_command_name(), process.command_name);
    SetStringValue(record->mutable_executable_path(), process.executable_path);
    SetStringValue(
        record->mutable_executable_name(),
        ExecutableNameSnapshot(process.executable_path, process.command_name));

    const auto app_metadata =
        app_metadata_by_pid.find(static_cast<int>(process.pid));
    if (app_metadata != app_metadata_by_pid.end()) {
      SetStringValue(record->mutable_app()->mutable_bundle_identifier(),
                     app_metadata->second.bundle_identifier);
      SetStringValue(record->mutable_app()->mutable_localized_name(),
                     app_metadata->second.localized_name);
      SetPngImageValue(record->mutable_app()->mutable_icon_png(),
                       app_metadata->second.icon_png);
    } else {
      // Non-GUI process: app metadata simply does not apply.
      record->mutable_app()->mutable_bundle_identifier()->set_availability(
          NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE);
      record->mutable_app()->mutable_localized_name()->set_availability(
          NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE);
      record->mutable_app()->mutable_icon_png()->set_availability(
          NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE);
    }

    SetCommandLine(record->mutable_command_line(), arguments);
    SetMemoryMetric(record->mutable_memory()->mutable_physical_footprint(),
                    metrics.memory.physical_footprint);
    SetMemoryMetric(record->mutable_memory()->mutable_resident(),
                    metrics.memory.resident);
    SetIntegerValue(
        record->mutable_performance()->mutable_cumulative_cpu_time_ns(),
        metrics.performance.cumulative_cpu_time_ns);
    SetIntegerValue(record->mutable_performance()
                        ->mutable_cumulative_network_received_bytes(),
                    metrics.performance.cumulative_network_received_bytes);
    SetIntegerValue(
        record->mutable_performance()->mutable_cumulative_network_sent_bytes(),
        metrics.performance.cumulative_network_sent_bytes);
  }

  AddWarning(
      &response, NATIVE_COLLECTOR_WARNING_CODE_PARTIAL_COLLECTION,
      "Some process records have fields unavailable because of process churn "
      "or macOS access policy.",
      warning_counters.partial_collection_count);
  AddWarning(&response, NATIVE_COLLECTOR_WARNING_CODE_PERMISSION_DENIED,
             "macOS denied access to one or more protected process fields.",
             warning_counters.permission_denied_count);
  AddWarning(
      &response, NATIVE_COLLECTOR_WARNING_CODE_COMMAND_LINE_PARTIAL,
      "Command-line arguments were unavailable for one or more processes.",
      warning_counters.command_line_partial_count);

  response.set_collected_at_unix_ms(UnixTimeMilliseconds());
  response.set_collection_duration_ms(ElapsedMilliseconds(started_at));
  return response;
}

}  // namespace mostats::processes
