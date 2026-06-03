#ifndef MOSTATS_NATIVE_PROCESS_COLLECTOR_H_
#define MOSTATS_NATIVE_PROCESS_COLLECTOR_H_

#include "process_collector.pb.h"
#include "processes/libproc_process_enumerator.h"
#include "processes/process_arguments_reader.h"
#include "processes/process_metrics_reader.h"
#include "processes/workspace_app_enricher.h"

namespace mostats::processes {

// Composes the libproc enumerator, KERN_PROCARGS2 argument reader,
// proc_pid_rusage metrics reader, and NSWorkspace enricher into one
// CollectProcessesResponse. Read-only: it never sends signals or reveals paths;
// process actions are owned by main, not native.
class NativeProcessCollector {
 public:
  NativeProcessCollector();

  CollectProcessesResponse Collect() const;

 private:
  LibprocProcessEnumerator enumerator_;
  ProcessArgumentsReader arguments_reader_;
  ProcessMetricsReader metrics_reader_;
  WorkspaceApplicationEnricher application_enricher_;
};

}  // namespace mostats::processes

#endif  // MOSTATS_NATIVE_PROCESS_COLLECTOR_H_
