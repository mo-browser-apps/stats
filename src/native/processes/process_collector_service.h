#ifndef MOSTATS_PROCESS_COLLECTOR_SERVICE_H_
#define MOSTATS_PROCESS_COLLECTOR_SERVICE_H_

#include "gen/process_collector.rpc.h"
#include "processes/native_process_collector.h"

namespace mostats::processes {

// RPC entry point for native process collection. Main calls CollectProcesses
// each refresh tick; this returns one raw snapshot for main to map and diff
// (identity keys and per-process CPU deltas). Read-only; never sends signals or
// reveals paths.
class ProcessCollectorServiceImpl final : public ProcessCollectorService {
 public:
  void CollectProcesses(const CollectProcessesRequest* request,
                        mo::rpc::Callback<CollectProcessesResponse> done) override;

 private:
  NativeProcessCollector collector_;
};

}  // namespace mostats::processes

#endif  // MOSTATS_PROCESS_COLLECTOR_SERVICE_H_
