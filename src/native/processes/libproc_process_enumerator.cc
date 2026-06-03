#include "processes/libproc_process_enumerator.h"

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <limits>
#include <vector>

#include "processes/native_availability.h"

namespace mostats::processes {
namespace {

// proc_listallpids over-reports then we trim; start generous to avoid retries.
constexpr size_t kMinimumPidCapacity = 256;
constexpr int kMaxPidListAttempts = 5;

NativeStringSnapshot AvailableString(const char* value) {
  NativeStringSnapshot result;
  result.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  result.value = value == nullptr ? "" : value;
  return result;
}

NativeStringSnapshot UnavailableString(
    const NativeAvailabilityReason availability) {
  NativeStringSnapshot result;
  result.availability = availability;
  return result;
}

// Reads the full PID list, growing the buffer if the kernel fills it exactly
// (which means there may be more PIDs than fit).
std::vector<pid_t> ListAllPids(NativeAvailabilityReason* availability) {
  errno = 0;
  // proc_listallpids(nullptr, 0) returns a PID count, not a byte count.
  const int required_pid_count = proc_listallpids(nullptr, 0);
  if (required_pid_count <= 0) {
    *availability = AvailabilityFromErrno(errno);
    return {};
  }

  size_t pid_capacity =
      std::max(static_cast<size_t>(required_pid_count) * 2, kMinimumPidCapacity);
  for (int attempt = 0; attempt < kMaxPidListAttempts; ++attempt) {
    if (pid_capacity >
        static_cast<size_t>(std::numeric_limits<int>::max()) / sizeof(pid_t)) {
      *availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
      return {};
    }

    std::vector<pid_t> pids(pid_capacity);
    errno = 0;
    const int pid_count = proc_listallpids(
        pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
    if (pid_count <= 0) {
      *availability = AvailabilityFromErrno(errno);
      return {};
    }

    if (static_cast<size_t>(pid_count) < pids.size()) {
      pids.resize(static_cast<size_t>(pid_count));
      pids.erase(std::remove(pids.begin(), pids.end(), 0), pids.end());
      *availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
      return pids;
    }

    if (pid_capacity >
        static_cast<size_t>(std::numeric_limits<int>::max()) /
            (sizeof(pid_t) * 2)) {
      *availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
      return {};
    }
    pid_capacity *= 2;
  }

  *availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  return {};
}

NativeProcessTaskSnapshot ReadTaskInfo(const pid_t pid) {
  NativeProcessTaskSnapshot snapshot;
  snapshot.pid = pid;

  errno = 0;
  const int bytes_written = proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0,
                                         &snapshot.task_info,
                                         sizeof(snapshot.task_info));
  if (bytes_written == static_cast<int>(sizeof(snapshot.task_info))) {
    snapshot.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
    return snapshot;
  }

  snapshot.availability = AvailabilityFromErrno(errno);
  return snapshot;
}

// Prefers proc_name; falls back to the task info's process name/comm fields.
NativeStringSnapshot ReadProcessName(const pid_t pid,
                                     const NativeProcessTaskSnapshot& task) {
  char name_buffer[PROC_PIDPATHINFO_MAXSIZE] = {};
  errno = 0;
  const int bytes_written =
      proc_name(pid, name_buffer, static_cast<uint32_t>(sizeof(name_buffer)));
  if (bytes_written > 0) {
    return AvailableString(name_buffer);
  }

  if (task.availability == NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    if (task.task_info.pbsd.pbi_name[0] != '\0') {
      return AvailableString(task.task_info.pbsd.pbi_name);
    }
    if (task.task_info.pbsd.pbi_comm[0] != '\0') {
      return AvailableString(task.task_info.pbsd.pbi_comm);
    }
  }

  return UnavailableString(AvailabilityFromErrno(errno));
}

NativeStringSnapshot ReadProcessPath(const pid_t pid) {
  char path_buffer[PROC_PIDPATHINFO_MAXSIZE] = {};
  errno = 0;
  const int bytes_written = proc_pidpath(pid, path_buffer, sizeof(path_buffer));
  if (bytes_written > 0) {
    return AvailableString(path_buffer);
  }
  return UnavailableString(AvailabilityFromErrno(errno));
}

NativeProcessMetadata ReadProcessMetadata(const pid_t pid) {
  NativeProcessMetadata metadata;
  metadata.pid = pid;
  metadata.task = ReadTaskInfo(pid);
  metadata.command_name = ReadProcessName(pid, metadata.task);
  metadata.executable_path = ReadProcessPath(pid);
  return metadata;
}

}  // namespace

std::vector<NativeProcessMetadata> LibprocProcessEnumerator::EnumerateProcesses(
    NativeAvailabilityReason* list_availability) const {
  std::vector<pid_t> pids = ListAllPids(list_availability);
  std::vector<NativeProcessMetadata> processes;
  processes.reserve(pids.size());
  for (const pid_t pid : pids) {
    processes.push_back(ReadProcessMetadata(pid));
  }
  return processes;
}

}  // namespace mostats::processes
