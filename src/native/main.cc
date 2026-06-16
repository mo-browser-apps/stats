#include "rpc.h"
#include "gen/memory.rpc.h"
#include "gen/network.rpc.h"
#include "gen/process_collector.rpc.h"
#include "gen/temperature.rpc.h"
#include "metrics/memory_probe.h"
#include "metrics/network_probe.h"
#include "metrics/temperature_probe.h"
#include "processes/process_collector.h"

// The native entry point: each RPC service is a thin wrapper that forwards to a
// probe in metrics/ or processes/ and completes the callback. All collection
// logic, OS sources, and availability rules live in those modules.

using google::protobuf::Empty;
using mo::rpc::Callback;

namespace {

class MemoryServiceImpl : public MemoryService {
 public:
  void ReadUsage(const Empty* /*request*/, Callback<MemoryUsage> done) override {
    MemoryUsage response;
    mostats::ReadMemoryUsage(&response);
    std::move(done).Complete(response);
  }
};

class NetworkServiceImpl : public NetworkService {
 public:
  void ReadCounters(const Empty* /*request*/,
                    Callback<NetworkCounters> done) override {
    NetworkCounters response;
    mostats::ReadNetworkCounters(&response);
    std::move(done).Complete(response);
  }
};

class TemperatureServiceImpl : public TemperatureService {
 public:
  void ReadCpuTemperature(const Empty* /*request*/,
                          Callback<CpuTemperature> done) override {
    const mostats::CpuTemperatureReading reading = mostats::ReadCpuTemperature();
    CpuTemperature response;
    response.set_available(reading.available);
    response.set_celsius(reading.celsius);
    std::move(done).Complete(response);
  }
};

class ProcessCollectorServiceImpl : public ProcessCollectorService {
 public:
  void CollectProcesses(const CollectProcessesRequest* /*request*/,
                        Callback<CollectProcessesResponse> done) override {
    CollectProcessesResponse response;
    mostats::CollectProcesses(&response);
    std::move(done).Complete(response);
  }

  void GetIcons(const GetIconsRequest* request,
                Callback<GetIconsResponse> done) override {
    GetIconsResponse response;
    mostats::GetProcessIcons(*request, &response);
    std::move(done).Complete(response);
  }
};

}  // namespace

void launch() {
  mo::rpc::RegisterService(new MemoryServiceImpl());
  mo::rpc::RegisterService(new NetworkServiceImpl());
  mo::rpc::RegisterService(new TemperatureServiceImpl());
  mo::rpc::RegisterService(new ProcessCollectorServiceImpl());
}
