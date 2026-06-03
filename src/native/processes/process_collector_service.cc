#include "processes/process_collector_service.h"

#include <utility>

namespace mostats::processes {

void ProcessCollectorServiceImpl::CollectProcesses(
    const CollectProcessesRequest* /*request*/,
    mo::rpc::Callback<CollectProcessesResponse> done) {
  std::move(done).Complete(collector_.Collect());
}

}  // namespace mostats::processes
