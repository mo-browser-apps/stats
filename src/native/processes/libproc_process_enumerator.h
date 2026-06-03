#ifndef MOSTATS_LIBPROC_PROCESS_ENUMERATOR_H_
#define MOSTATS_LIBPROC_PROCESS_ENUMERATOR_H_

#include <vector>

#include "processes/native_process_types.h"

namespace mostats::processes {

// Enumerates the live process table via libproc (proc_listallpids) and reads
// per-PID identity (PROC_PIDTASKALLINFO), name (proc_name), and executable path
// (proc_pidpath). Read-only: it never sends signals or modifies any process.
class LibprocProcessEnumerator {
 public:
  // Lists every readable process. `list_availability` reports whether the PID
  // list itself could be read; individual records still carry their own
  // per-field availability for churn/permission failures.
  std::vector<NativeProcessMetadata> EnumerateProcesses(
      NativeAvailabilityReason* list_availability) const;
};

}  // namespace mostats::processes

#endif  // MOSTATS_LIBPROC_PROCESS_ENUMERATOR_H_
