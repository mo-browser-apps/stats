#ifndef MOSTATS_PROCESS_ARGUMENTS_READER_H_
#define MOSTATS_PROCESS_ARGUMENTS_READER_H_

#include <cstddef>
#include <sys/types.h>

#include "processes/native_process_types.h"

namespace mostats::processes {

// Reads a process's command-line arguments via sysctl KERN_PROCARGS2.
//
// Privacy: the returned argument values are sensitive display/search data and
// must never be logged, persisted, exported, or echoed in warnings. This reader
// only returns them; main keeps them isolated in the process explorer contract.
class ProcessArgumentsReader {
 public:
  // Reads and parses the argument vector for one PID. Protected, exited, or
  // unparsable processes return an unavailable/permission-denied/parse-failed
  // result rather than throwing.
  NativeProcessArguments Read(pid_t pid) const;

  // Parses a raw KERN_PROCARGS2 buffer. Exposed for narrow unit testing of the
  // parser without sysctl access.
  static NativeProcessArguments ParseKernProcArgs2Buffer(const char* data,
                                                         size_t size);
};

}  // namespace mostats::processes

#endif  // MOSTATS_PROCESS_ARGUMENTS_READER_H_
