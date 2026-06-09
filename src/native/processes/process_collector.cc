#include "processes/process_collector.h"

#include <libproc.h>
#include <mach/mach_time.h>
#include <pwd.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "processes/app_metadata.h"

namespace mostats {
namespace {

// Cap on the argument count decoded from a KERN_PROCARGS2 buffer. The buffer is
// untrusted kernel data; a corrupt header must not drive an unbounded loop.
constexpr int kMaxReasonableArgCount = 4096;

// Retry budget for the proc_listallpids capacity race (the table can grow
// between the size query and the read).
constexpr int kMaxPidListAttempts = 5;
constexpr size_t kMinimumPidCapacity = 256;

// Maps an errno from a failed libproc/sysctl call to a per-field availability so
// the renderer can tell "exited" / "denied" / "unavailable" apart. errno 0 means
// the call failed without setting errno, which we treat as a plain unavailable.
NativeFieldStatus StatusFromErrno(int error_number) {
  switch (error_number) {
    case ESRCH:
      return NATIVE_FIELD_STATUS_PROCESS_EXITED;
    case EACCES:
    case EPERM:
      return NATIVE_FIELD_STATUS_PERMISSION_DENIED;
    case ENOSYS:
#ifdef ENOTSUP
    case ENOTSUP:
#endif
      return NATIVE_FIELD_STATUS_UNSUPPORTED;
    default:
      return NATIVE_FIELD_STATUS_UNAVAILABLE;
  }
}

// Fills a NativeString as available with the given value.
void SetAvailableString(NativeString* out, const char* value) {
  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_value(value == nullptr ? "" : value);
}

// Fills a NativeInt64 as available with the given value.
void SetAvailableInt64(NativeInt64* out, int64_t value) {
  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_value(value);
}

// Saturating uint64 -> int64 for the proto's signed counters; the raw macOS
// values (footprint bytes, CPU nanoseconds) never realistically reach this.
int64_t SaturatingInt64(uint64_t value) {
  const uint64_t max_int64 =
      static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
  return value > max_int64 ? std::numeric_limits<int64_t>::max()
                           : static_cast<int64_t>(value);
}

// Content key for an icon's base64 bytes: 64-bit FNV-1a as hex. Non-cryptographic
// is fine - the key only has to collapse identical icons to one table entry and
// tell different ones apart within a pass. A collision would at worst show one
// wrong icon for a tick; nothing crashes.
std::string IconContentKey(const std::string& base64) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (const unsigned char byte : base64) {
    hash ^= byte;
    hash *= 0x100000001b3ULL;
  }
  char out[17];
  std::snprintf(out, sizeof(out), "%016llx",
                static_cast<unsigned long long>(hash));
  return std::string(out, 16);
}

// Interns a resolved icon into the response's dedup table and returns its key
// (empty when the icon is unavailable). Identical bytes collapse to one entry,
// so a shared icon is carried once per pass instead of once per record.
std::string InternIcon(CollectProcessesResponse* response,
                       const NativeImage& icon) {
  if (icon.status() != NATIVE_FIELD_STATUS_AVAILABLE ||
      icon.png_base64().empty()) {
    return std::string();
  }
  std::string key = IconContentKey(icon.png_base64());
  auto& table = *response->mutable_icons();
  if (table.find(key) == table.end()) {
    table[key] = icon;
  }
  return key;
}

// Enumerates all PIDs. proc_listallpids reports a PID count, not a byte count,
// and the table can grow between the size probe and the read, so the buffer is
// grown and retried. Returns false (status set) if the list cannot be read.
bool ListAllPids(std::vector<pid_t>* out, NativeFieldStatus* status) {
  errno = 0;
  const int required = proc_listallpids(nullptr, 0);
  if (required <= 0) {
    *status = StatusFromErrno(errno);
    return false;
  }

  size_t capacity =
      std::max(static_cast<size_t>(required) * 2, kMinimumPidCapacity);
  for (int attempt = 0; attempt < kMaxPidListAttempts; ++attempt) {
    if (capacity >
        static_cast<size_t>(std::numeric_limits<int>::max()) / sizeof(pid_t)) {
      *status = NATIVE_FIELD_STATUS_UNAVAILABLE;
      return false;
    }

    std::vector<pid_t> pids(capacity);
    errno = 0;
    const int count = proc_listallpids(
        pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
    if (count <= 0) {
      *status = StatusFromErrno(errno);
      return false;
    }

    if (static_cast<size_t>(count) < pids.size()) {
      pids.resize(static_cast<size_t>(count));
      // proc_listallpids can pad the tail with 0 entries; drop them.
      pids.erase(std::remove(pids.begin(), pids.end(), 0), pids.end());
      *out = std::move(pids);
      *status = NATIVE_FIELD_STATUS_AVAILABLE;
      return true;
    }

    // Buffer was exactly filled, so the list may have been truncated; grow it.
    capacity *= 2;
  }

  *status = NATIVE_FIELD_STATUS_UNAVAILABLE;
  return false;
}

// Reads the older BSD `kern.proc.pid` record for coarse identity fields. Some
// protected macOS processes (notably WindowServer) deny PROC_PIDTASKALLINFO but
// still expose their name, parent PID, start time, and uid through this public
// sysctl. It does not expose reliable CPU or memory on current macOS, so it is
// an identity fallback only.
bool ReadKinfoProc(pid_t pid, kinfo_proc* info, NativeFieldStatus* status) {
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, static_cast<int>(pid)};
  size_t info_size = sizeof(*info);
  errno = 0;
  if (sysctl(mib, 4, info, &info_size, nullptr, 0) != 0) {
    *status = StatusFromErrno(errno);
    return false;
  }

  if (info_size >= sizeof(*info) && info->kp_proc.p_pid == pid) {
    *status = NATIVE_FIELD_STATUS_AVAILABLE;
    return true;
  }

  *status = NATIVE_FIELD_STATUS_PROCESS_EXITED;
  return false;
}

// Reads PROC_PIDTASKALLINFO (BSD + task info) for one PID. This single call
// provides the parent PID, command name, start time, resident size, and the
// cumulative CPU-time counter, so it is the backbone of each record.
bool ReadTaskAllInfo(pid_t pid, proc_taskallinfo* info, NativeFieldStatus* status) {
  errno = 0;
  const int written =
      proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, info, sizeof(*info));
  if (written == static_cast<int>(sizeof(*info))) {
    *status = NATIVE_FIELD_STATUS_AVAILABLE;
    return true;
  }
  *status = StatusFromErrno(errno);
  return false;
}

// Chooses a status when a primary task-info read and its BSD sysctl fallback
// both failed. A definite exit beats a denial; otherwise the original task-info
// failure is the most useful explanation for task-backed fields.
NativeFieldStatus CombinedFallbackStatus(NativeFieldStatus task_status,
                                         NativeFieldStatus kinfo_status) {
  if (kinfo_status == NATIVE_FIELD_STATUS_PROCESS_EXITED) {
    return kinfo_status;
  }
  return task_status == NATIVE_FIELD_STATUS_UNSPECIFIED ? kinfo_status
                                                        : task_status;
}

// Resolves the short command name, preferring proc_name and falling back to the
// BSD info's registered name/comm when task info is available. For protected
// processes that deny task info, falls back to kern.proc.pid's p_comm.
void FillCommandName(pid_t pid, const proc_taskallinfo& task, bool task_ok,
                     const kinfo_proc& kinfo, bool kinfo_ok,
                     NativeFieldStatus kinfo_status,
                     NativeString* out) {
  char name[2 * MAXCOMLEN] = {};
  errno = 0;
  if (proc_name(pid, name, static_cast<uint32_t>(sizeof(name))) > 0) {
    SetAvailableString(out, name);
    return;
  }

  if (task_ok) {
    if (task.pbsd.pbi_name[0] != '\0') {
      SetAvailableString(out, task.pbsd.pbi_name);
      return;
    }
    if (task.pbsd.pbi_comm[0] != '\0') {
      SetAvailableString(out, task.pbsd.pbi_comm);
      return;
    }
  }

  if (kinfo_ok && kinfo.kp_proc.p_comm[0] != '\0') {
    SetAvailableString(out, kinfo.kp_proc.p_comm);
    return;
  }

  const NativeFieldStatus name_status = StatusFromErrno(errno);
  out->set_status(
      name_status == NATIVE_FIELD_STATUS_UNAVAILABLE ? kinfo_status
                                                     : name_status);
}

// Returns the basename of an absolute path, or the whole string if it has no
// slash. Used to derive the executable name from the resolved path.
std::string BaseName(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

// Resolves the absolute executable path (proc_pidpath) and, when available, the
// executable file name (its basename). Path failures degrade both fields.
void FillExecutablePathAndName(pid_t pid, NativeString* path_out,
                               NativeString* name_out) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {};
  errno = 0;
  if (proc_pidpath(pid, path, sizeof(path)) > 0) {
    SetAvailableString(path_out, path);
    SetAvailableString(name_out, BaseName(path).c_str());
    return;
  }

  const NativeFieldStatus status = StatusFromErrno(errno);
  path_out->set_status(status);
  name_out->set_status(status);
}

// Reads the start time from BSD info and writes it onto the identity as Unix
// milliseconds. Uses kern.proc.pid as a fallback when task info is denied.
void SetStartTime(const timeval& start_time, NativeProcessIdentity* identity) {
  if (start_time.tv_sec == 0) {
    identity->set_started_at_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }
  const int64_t millis =
      static_cast<int64_t>(start_time.tv_sec) * 1000 +
      static_cast<int64_t>(start_time.tv_usec) / 1000;
  identity->set_started_at_status(NATIVE_FIELD_STATUS_AVAILABLE);
  identity->set_started_at_unix_ms(millis);
}

void FillStartTime(const proc_taskallinfo& task, bool task_ok,
                   NativeFieldStatus task_status,
                   const kinfo_proc& kinfo, bool kinfo_ok,
                   NativeFieldStatus kinfo_status,
                   NativeProcessIdentity* identity) {
  if (task_ok) {
    timeval start_time = {};
    start_time.tv_sec = static_cast<time_t>(task.pbsd.pbi_start_tvsec);
    start_time.tv_usec =
        static_cast<suseconds_t>(task.pbsd.pbi_start_tvusec);
    SetStartTime(start_time, identity);
    return;
  }

  if (kinfo_ok) {
    SetStartTime(kinfo.kp_proc.p_starttime, identity);
    return;
  }

  identity->set_started_at_status(
      CombinedFallbackStatus(task_status, kinfo_status));
}

// Parses a KERN_PROCARGS2 buffer into the argument vector. Layout: a leading
// int argc, the executable path (NUL-terminated), padding NULs, then argc
// NUL-terminated argv strings. The buffer is untrusted, so every read is
// bounds-checked and a malformed buffer degrades to PARSE_FAILED.
bool ParseProcArgs2(const char* data, size_t size,
                    std::vector<std::string>* arguments) {
  if (data == nullptr || size < sizeof(int)) {
    return false;
  }

  int argc = 0;
  std::memcpy(&argc, data, sizeof(argc));
  if (argc < 0 || argc > kMaxReasonableArgCount) {
    return false;
  }

  size_t offset = sizeof(argc);

  // Skip the executable path string that precedes argv.
  const void* exec_end = std::memchr(data + offset, '\0', size - offset);
  if (exec_end == nullptr) {
    return false;
  }
  offset = static_cast<const char*>(exec_end) - data + 1;

  // Skip the alignment NULs between the exec path and the first argument.
  while (offset < size && data[offset] == '\0') {
    ++offset;
  }

  arguments->reserve(static_cast<size_t>(argc));
  for (int index = 0; index < argc; ++index) {
    if (offset >= size) {
      return false;
    }
    const void* arg_end = std::memchr(data + offset, '\0', size - offset);
    if (arg_end == nullptr) {
      return false;
    }
    const size_t terminator = static_cast<const char*>(arg_end) - data;
    arguments->emplace_back(data + offset, terminator - offset);
    offset = terminator + 1;
  }
  return true;
}

// Reads the system-wide KERN_ARGMAX argument-buffer size. It is constant for the
// running kernel, so the collector reads it once per pass and reuses it for
// every PID rather than issuing this sysctl per process. Returns 0 on failure.
int ReadArgMax() {
  int arg_max = 0;
  size_t arg_max_size = sizeof(arg_max);
  int max_mib[] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(max_mib, 2, &arg_max, &arg_max_size, nullptr, 0) != 0 ||
      arg_max <= 0) {
    return 0;
  }
  return arg_max;
}

// Reads and parses the command-line arguments for one PID via KERN_PROCARGS2.
// The caller owns `buffer` (sized to KERN_ARGMAX, ~1 MiB) and reuses it across
// every PID in the pass, so this hot path performs no per-process allocation -
// only the sysctl copy and the parse. KERN_ARGMAX is constant for the kernel and
// is read once by the caller. Sensitive data: returned for display/search only;
// never logged here.
void FillCommandLine(pid_t pid, int arg_max, std::vector<char>* buffer,
                     NativeCommandLine* out) {
  if (arg_max <= 0 || buffer->empty()) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  size_t buffer_size = buffer->size();
  int args_mib[] = {CTL_KERN, KERN_PROCARGS2, static_cast<int>(pid)};
  errno = 0;
  if (sysctl(args_mib, 3, buffer->data(), &buffer_size, nullptr, 0) != 0) {
    out->set_status(StatusFromErrno(errno));
    return;
  }

  std::vector<std::string> arguments;
  if (!ParseProcArgs2(buffer->data(), buffer_size, &arguments)) {
    out->set_status(NATIVE_FIELD_STATUS_PARSE_FAILED);
    return;
  }

  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  for (std::string& argument : arguments) {
    out->add_arguments(std::move(argument));
  }
}

// Fills per-process memory: physical footprint from proc_pid_rusage (primary)
// and resident size from task info (fallback display value).
void FillMemory(pid_t pid, const proc_taskallinfo& task, bool task_ok,
                NativeFieldStatus task_status, NativeProcessMemory* out) {
  rusage_info_current usage = {};
  errno = 0;
  if (proc_pid_rusage(pid, RUSAGE_INFO_CURRENT,
                      reinterpret_cast<rusage_info_t*>(&usage)) == 0) {
    SetAvailableInt64(out->mutable_physical_footprint_bytes(),
                      SaturatingInt64(usage.ri_phys_footprint));
  } else {
    out->mutable_physical_footprint_bytes()->set_status(
        StatusFromErrno(errno));
  }

  if (task_ok) {
    SetAvailableInt64(out->mutable_resident_bytes(),
                      SaturatingInt64(task.ptinfo.pti_resident_size));
  } else {
    out->mutable_resident_bytes()->set_status(task_status);
  }
}

// Converts a mach absolute-time tick count to nanoseconds. proc_pidinfo reports
// pti_total_user/system in mach time units, NOT nanoseconds (e.g. ~41.67 ns per
// tick on Apple Silicon; 1:1 only on older Intel). The 128-bit intermediate
// avoids overflow in tick * numer; the host timebase is queried once.
uint64_t MachTicksToNanos(uint64_t ticks) {
  static const mach_timebase_info_data_t timebase = [] {
    mach_timebase_info_data_t info = {1, 1};
    mach_timebase_info(&info);
    return info;
  }();
  if (timebase.denom == 0) {
    return ticks;  // Defensive: never divide by zero.
  }
  const __uint128_t nanos =
      (static_cast<__uint128_t>(ticks) * timebase.numer) / timebase.denom;
  const __uint128_t max_u64 = std::numeric_limits<uint64_t>::max();
  return static_cast<uint64_t>(nanos > max_u64 ? max_u64 : nanos);
}

// Fills the cumulative CPU-time counter (user + system) in nanoseconds from task
// info. Main diffs this across snapshots; the collector never computes a rate.
void FillCpu(const proc_taskallinfo& task, bool task_ok,
             NativeFieldStatus task_status, NativeProcessCpu* out) {
  if (!task_ok) {
    out->mutable_cumulative_cpu_time_ns()->set_status(task_status);
    return;
  }
  // pti_total_user/system are mach absolute-time ticks; sum them (saturating)
  // and convert to real nanoseconds so the contract's _ns field is honest.
  uint64_t ticks = task.ptinfo.pti_total_user;
  const uint64_t remaining = std::numeric_limits<uint64_t>::max() - ticks;
  ticks += std::min(remaining, task.ptinfo.pti_total_system);
  SetAvailableInt64(out->mutable_cumulative_cpu_time_ns(),
                    SaturatingInt64(MachTicksToNanos(ticks)));
}

// Fills the thread count from task info (pti_threadnum). Available only when the
// PROC_PIDTASKALLINFO read succeeded; otherwise it carries that read's status.
void FillThreadCount(const proc_taskallinfo& task, bool task_ok,
                     NativeFieldStatus task_status, NativeInt64* out) {
  if (!task_ok) {
    out->set_status(task_status);
    return;
  }
  SetAvailableInt64(out, std::max(0, task.ptinfo.pti_threadnum));
}

// Fills the owning user from task info or the kern.proc.pid fallback, then
// resolves the login name with getpwuid_r. An unmapped uid (no passwd entry)
// stays AVAILABLE with the numeric uid and an empty name, because the uid itself
// is still a real value. getpwuid_r is used (not getpwuid) so the per-pass loop
// stays thread-safe and does not return a pointer into shared static storage.
void SetAvailableUser(uid_t uid, NativeProcessUser* out) {
  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_uid(static_cast<int32_t>(uid));

  // Resolve the login name. A miss (no entry / error) is not a failure: the uid
  // is still valid, so the name is simply left empty.
  struct passwd pwd = {};
  struct passwd* result = nullptr;
  char buffer[1024] = {};
  if (getpwuid_r(uid, &pwd, buffer, sizeof(buffer), &result) == 0 &&
      result != nullptr && result->pw_name != nullptr) {
    out->set_name(result->pw_name);
  }
}

void FillUser(const proc_taskallinfo& task, bool task_ok,
              NativeFieldStatus task_status,
              const kinfo_proc& kinfo, bool kinfo_ok,
              NativeFieldStatus kinfo_status, NativeProcessUser* out) {
  if (task_ok) {
    SetAvailableUser(task.pbsd.pbi_uid, out);
    return;
  }

  if (kinfo_ok) {
    SetAvailableUser(kinfo.kp_eproc.e_ucred.cr_uid, out);
    return;
  }

  out->set_status(CombinedFallbackStatus(task_status, kinfo_status));
}

// Builds one process record from all sources. Each field carries its own
// availability so a single denied/exited read degrades that field, not the row.
// app_metadata holds GUI-app metadata keyed by PID (from NSWorkspace); a record
// with no entry keeps its app fields unset and falls back to a generic icon.
// The resolved icon is interned into `response`'s dedup table and referenced by
// key, so a shared icon is stored once for the whole pass.
void FillRecord(
    pid_t pid, int arg_max, std::vector<char>* args_buffer,
    CollectProcessesResponse* response, NativeProcessRecord* record,
    const std::unordered_map<int32_t, NativeAppMetadata>& app_metadata) {
  NativeProcessIdentity* identity = record->mutable_identity();
  identity->set_pid(pid);

  proc_taskallinfo task = {};
  NativeFieldStatus task_status = NATIVE_FIELD_STATUS_UNAVAILABLE;
  const bool task_ok = ReadTaskAllInfo(pid, &task, &task_status);

  kinfo_proc kinfo = {};
  NativeFieldStatus kinfo_status = NATIVE_FIELD_STATUS_UNAVAILABLE;
  const bool kinfo_ok =
      task_ok ? false : ReadKinfoProc(pid, &kinfo, &kinfo_status);

  FillStartTime(task, task_ok, task_status, kinfo, kinfo_ok, kinfo_status,
                identity);

  if (task_ok) {
    record->set_parent_status(NATIVE_FIELD_STATUS_AVAILABLE);
    record->set_parent_pid(static_cast<int32_t>(task.pbsd.pbi_ppid));
  } else if (kinfo_ok) {
    record->set_parent_status(NATIVE_FIELD_STATUS_AVAILABLE);
    record->set_parent_pid(static_cast<int32_t>(kinfo.kp_eproc.e_ppid));
  } else {
    record->set_parent_status(
        CombinedFallbackStatus(task_status, kinfo_status));
  }

  FillCommandName(pid, task, task_ok, kinfo, kinfo_ok, kinfo_status,
                  record->mutable_command_name());
  FillExecutablePathAndName(pid, record->mutable_executable_path(),
                            record->mutable_executable_name());
  FillCommandLine(pid, arg_max, args_buffer, record->mutable_command_line());
  FillMemory(pid, task, task_ok, task_status, record->mutable_memory());
  FillCpu(task, task_ok, task_status, record->mutable_cpu());
  FillThreadCount(task, task_ok, task_status, record->mutable_thread_count());
  FillUser(task, task_ok, task_status, kinfo, kinfo_ok, kinfo_status,
           record->mutable_user());

  // GUI app metadata enrichment (NSWorkspace): copy the entry for this PID when
  // one exists. NSWorkspace remains the source of exact bundle id, localized app
  // name, and the running GUI app's own icon. The grouping bundle below is still
  // normalized from the executable path so nested helper apps inside a larger
  // `.app` group under the user-facing owner instead of appearing as arbitrary
  // top-level apps.
  const auto match = app_metadata.find(static_cast<int32_t>(pid));
  if (match != app_metadata.end()) {
    *record->mutable_app() = match->second;
  }

  // Resolve the icon into a local image, then intern it and store only the key on
  // the record. Every process resolves the same way: from the executable path
  // (the owning `.app` icon for a bundled app/helper, the generic icon for a
  // daemon), with the NSWorkspace bundle path as a fallback when the executable
  // path is unavailable. The per-resolution-path cache in IconForFilePath means a
  // steady pass does no AppKit work; InternIcon then de-dupes identical bytes.
  NativeImage icon;
  icon.set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);

  if (record->executable_path().status() == NATIVE_FIELD_STATUS_AVAILABLE) {
    FillAppBundle(record->executable_path().value(),
                  record->mutable_app()->mutable_bundle());
    IconForExecutablePath(record->executable_path().value(), &icon);
  } else if (
      record->has_app() &&
      record->app().bundle().path().status() == NATIVE_FIELD_STATUS_AVAILABLE) {
    IconForFilePath(record->app().bundle().path().value(), &icon);
  }

  std::string icon_key = InternIcon(response, icon);
  if (!icon_key.empty()) {
    record->mutable_app()->set_icon_key(std::move(icon_key));
  }
}

}  // namespace

void CollectProcesses(CollectProcessesResponse* response) {
  std::vector<pid_t> pids;
  NativeFieldStatus list_status = NATIVE_FIELD_STATUS_UNAVAILABLE;
  if (!ListAllPids(&pids, &list_status)) {
    // Could not enumerate at all: report unavailable with no rows. A
    // permission-limited enumeration is summarized as a count-only warning.
    response->set_available(false);
    if (list_status == NATIVE_FIELD_STATUS_PERMISSION_DENIED) {
      NativeCollectorWarning* warning = response->add_warnings();
      warning->set_code(NativeCollectorWarning::CODE_PERMISSION_DENIED);
      warning->set_affected_count(0);
    }
    return;
  }

  response->set_available(true);
  const int64_t now_ms =
      static_cast<int64_t>(std::time(nullptr)) * 1000;
  response->set_collected_at_unix_ms(now_ms);

  // Snapshot GUI app metadata once for the whole pass (one NSWorkspace query),
  // then merge the matching entry onto each record by PID.
  const std::unordered_map<int32_t, NativeAppMetadata> app_metadata =
      SnapshotRunningAppMetadata();

  // Allocate the KERN_PROCARGS2 argument buffer once and reuse it for every PID.
  // KERN_ARGMAX (~1 MiB) is constant for the kernel, so reading it once and
  // sharing a single buffer turns a per-PID 1 MiB allocate-and-zero into one
  // allocation per pass - the dominant collection cost on a machine with many
  // processes. A 0 arg_max leaves the buffer empty and FillCommandLine reports
  // command lines unavailable for the pass.
  const int arg_max = ReadArgMax();
  std::vector<char> args_buffer(arg_max > 0 ? static_cast<size_t>(arg_max) : 0);

  for (const pid_t pid : pids) {
    FillRecord(pid, arg_max, &args_buffer, response, response->add_records(),
               app_metadata);
  }
}

}  // namespace mostats
