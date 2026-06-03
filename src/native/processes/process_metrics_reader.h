#ifndef MOSTATS_PROCESS_METRICS_READER_H_
#define MOSTATS_PROCESS_METRICS_READER_H_

#include "processes/native_process_types.h"

namespace mostats::processes {

// Reads per-process resource metrics: physical footprint (proc_pid_rusage),
// resident memory fallback (PROC_PIDTASKALLINFO), and cumulative user+system
// CPU time. Per-process network has no reliable macOS source and is reported
// UNSUPPORTED. Read-only.
class ProcessMetricsReader {
 public:
  NativeProcessResourceSnapshot ReadProcess(
      const NativeProcessTaskSnapshot& task) const;
};

}  // namespace mostats::processes

#endif  // MOSTATS_PROCESS_METRICS_READER_H_
