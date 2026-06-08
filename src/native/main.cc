#include <ifaddrs.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_media.h>
#include <net/if_types.h>
#include <mach/mach.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sockio.h>
#include <sys/sysctl.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <limits>
#include <unistd.h>

#include "rpc.h"
#include "gen/memory.rpc.h"
#include "gen/network.rpc.h"
#include "gen/process_collector.rpc.h"
#include "gen/temperature.rpc.h"
#include "processes/process_collector.h"
#include "temperature/temperature_probe.h"

using google::protobuf::Empty;
using mo::rpc::Callback;

namespace {

uint64_t SaturatingAdd(uint64_t left, uint64_t right) {
  const uint64_t max = std::numeric_limits<uint64_t>::max();
  if (max - left < right) {
    return max;
  }
  return left + right;
}

uint64_t SaturatingSubtract(uint64_t left, uint64_t right) {
  return left > right ? left - right : 0;
}

uint64_t PagesToBytes(uint64_t pages, uint64_t page_size) {
  if (page_size == 0) {
    return 0;
  }
  const uint64_t max = std::numeric_limits<uint64_t>::max();
  if (pages > max / page_size) {
    return max;
  }
  return pages * page_size;
}

bool ReadPhysicalMemorySize(uint64_t* total_bytes) {
  if (total_bytes == nullptr) {
    return false;
  }

  uint64_t value = 0;
  size_t size = sizeof(value);
  if (sysctlbyname("hw.memsize", &value, &size, nullptr, 0) != 0 ||
      size != sizeof(value) || value == 0) {
    return false;
  }

  *total_bytes = value;
  return true;
}

bool HasActiveMedia(int media_socket, const char* name) {
  if (media_socket < 0 || name == nullptr) {
    return false;
  }

  ifmediareq request = {};
  strncpy(request.ifm_name, name, sizeof(request.ifm_name) - 1);
  request.ifm_name[sizeof(request.ifm_name) - 1] = '\0';

  if (ioctl(media_socket, SIOCGIFMEDIA, &request) != 0) {
    return false;
  }

  return (request.ifm_status & IFM_AVALID) != 0 &&
         (request.ifm_status & IFM_ACTIVE) != 0;
}

// True for the active, user-facing physical interfaces a person means by "my
// network": real NICs report IFT_ETHER (Wi-Fi reports as Ethernet on macOS, as
// do Thunderbolt/USB adapters) or IFT_CELLULAR. This already drops VPN tunnels
// (utun*, IFT_OTHER) and gif/stf by link-layer type. But several virtual
// interfaces also report IFT_ETHER - AirDrop (awdl*), low-latency WLAN (llw*),
// the internet-sharing bridge (bridge*/ap*), and Apple internal management NICs
// (anpi*) - so the type alone is not enough. macOS names every genuine
// user-facing NIC en* (Ethernet/Wi-Fi/Thunderbolt) or pdp_ip* (cellular), and
// the virtual IFT_ETHER interfaces all use other prefixes, so an en*/pdp_ip*
// name check cleanly separates them. Counting only these avoids double-counting
// VPN traffic (it would otherwise be summed on both en0 and the utun tunnel)
// and excludes local-only AirDrop/sharing traffic.
//
// For en* (Ethernet-media) interfaces, SIOCGIFMEDIA additionally rejects
// adapters that are administratively up but physically disconnected. The media
// gate is intentionally NOT applied to cellular (pdp_ip*): SIOCGIFMEDIA is an
// Ethernet-media concept and a PPP-style cellular interface commonly reports no
// valid media status, so gating it would wrongly drop a live cellular-only
// uplink. Cellular is admitted on the IFF_UP + IFT_CELLULAR signal alone.
bool IsCountedInterface(const ifaddrs* ptr, int media_socket) {
  // Skip down interfaces and the loopback (local-only traffic).
  if ((ptr->ifa_flags & IFF_UP) == 0 ||
      (ptr->ifa_flags & IFF_LOOPBACK) != 0) {
    return false;
  }

  if (ptr->ifa_addr == nullptr || ptr->ifa_addr->sa_family != AF_LINK) {
    return false;
  }

  const sockaddr_dl* link = reinterpret_cast<const sockaddr_dl*>(ptr->ifa_addr);
  if (link->sdl_type != IFT_ETHER && link->sdl_type != IFT_CELLULAR) {
    return false;
  }

  const char* name = ptr->ifa_name;
  if (strncmp(name, "pdp_ip", 6) == 0) {
    // Cellular: no Ethernet media layer, so trust the IFF_UP + type signal.
    return true;
  }
  if (strncmp(name, "en", 2) == 0) {
    // Ethernet/Wi-Fi/Thunderbolt: require a live physical link.
    return HasActiveMedia(media_socket, name);
  }
  return false;
}

}  // namespace

/**
 * Narrow macOS memory probe.
 *
 * Reads the host VM page counters via host_statistics64() and returns a compact
 * Activity Monitor-style breakdown. Reclaimable file cache (external +
 * purgeable pages) is subtracted from the primary "used" figure and surfaced
 * separately so the UI does not present cache as pressure. The main-process
 * sampler owns percentage derivation and unavailable-state mapping.
 *
 * Technique reference: exelban/stats Modules/RAM/readers.swift uses the same
 * host_statistics64 VM categories; this is a scoped C++ re-implementation that
 * exposes only total, used, available, and cache for MoStats' single row.
 */
class MemoryServiceImpl : public MemoryService {
 public:
  void ReadUsage(const Empty* /*request*/, Callback<MemoryUsage> done) override {
    MemoryUsage response;

    uint64_t total_bytes = 0;
    if (!ReadPhysicalMemorySize(&total_bytes)) {
      response.set_available(false);
      std::move(done).Complete(response);
      return;
    }

    const long raw_page_size = sysconf(_SC_PAGESIZE);
    if (raw_page_size <= 0) {
      response.set_available(false);
      std::move(done).Complete(response);
      return;
    }
    const uint64_t page_size = static_cast<uint64_t>(raw_page_size);

    vm_statistics64_data_t stats = {};
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    const kern_return_t result = host_statistics64(
        mach_host_self(), HOST_VM_INFO64, reinterpret_cast<host_info64_t>(&stats),
        &count);
    if (result != KERN_SUCCESS) {
      response.set_available(false);
      std::move(done).Complete(response);
      return;
    }

    uint64_t occupied_pages = 0;
    occupied_pages = SaturatingAdd(occupied_pages, stats.active_count);
    occupied_pages = SaturatingAdd(occupied_pages, stats.inactive_count);
    occupied_pages = SaturatingAdd(occupied_pages, stats.speculative_count);
    occupied_pages = SaturatingAdd(occupied_pages, stats.wire_count);
    occupied_pages = SaturatingAdd(occupied_pages, stats.compressor_page_count);

    uint64_t cached_pages = 0;
    cached_pages = SaturatingAdd(cached_pages, stats.purgeable_count);
    cached_pages = SaturatingAdd(cached_pages, stats.external_page_count);

    const uint64_t used_pages =
        SaturatingSubtract(occupied_pages, cached_pages);
    uint64_t used_bytes = PagesToBytes(used_pages, page_size);
    uint64_t cached_bytes = PagesToBytes(cached_pages, page_size);

    used_bytes = std::min(used_bytes, total_bytes);
    const uint64_t available_bytes = total_bytes - used_bytes;
    cached_bytes = std::min(cached_bytes, available_bytes);

    response.set_available(true);
    response.set_total_bytes(total_bytes);
    response.set_used_bytes(used_bytes);
    response.set_available_bytes(available_bytes);
    response.set_cached_bytes(cached_bytes);
    std::move(done).Complete(response);
  }
};

/**
 * Narrow macOS network probe.
 *
 * Reads the kernel's cumulative per-interface byte counters via getifaddrs()
 * and sums the link-layer (AF_LINK) if_data totals across the active physical
 * interfaces (see IsCountedInterface for the selection rule). Only the raw
 * cumulative counters are returned; the main-process sampler owns the
 * delta-to-rate math, first-sample handling, and counter-reset rejection.
 *
 * Technique reference: exelban/stats Modules/Net/readers.swift reads the same
 * getifaddrs / if_data ifi_ibytes / ifi_obytes counters; this is a scoped C++
 * re-implementation that sums the active physical interfaces rather than
 * tracking a single stored primary interface. No upstream code is copied.
 */
class NetworkServiceImpl : public NetworkService {
 public:
  void ReadCounters(const Empty* /*request*/,
                    Callback<NetworkCounters> done) override {
    NetworkCounters response;

    ifaddrs* addresses = nullptr;
    if (getifaddrs(&addresses) != 0) {
      // Could not enumerate interfaces; report unavailable rather than zeros
      // that would read as a real "no traffic" sample.
      response.set_available(false);
      std::move(done).Complete(response);
      return;
    }

    const int media_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (media_socket < 0) {
      freeifaddrs(addresses);
      response.set_available(false);
      std::move(done).Complete(response);
      return;
    }

    uint64_t rx_bytes = 0;
    uint64_t tx_bytes = 0;
    bool found = false;

    for (ifaddrs* ptr = addresses; ptr != nullptr; ptr = ptr->ifa_next) {
      // Byte counters live on the link-layer (AF_LINK) entry of each interface.
      if (!IsCountedInterface(ptr, media_socket)) {
        continue;
      }

      const if_data* data = static_cast<const if_data*>(ptr->ifa_data);
      if (data == nullptr) {
        continue;
      }

      rx_bytes += data->ifi_ibytes;
      tx_bytes += data->ifi_obytes;
      found = true;
    }

    close(media_socket);
    freeifaddrs(addresses);

    response.set_available(found);
    response.set_rx_bytes(rx_bytes);
    response.set_tx_bytes(tx_bytes);
    std::move(done).Complete(response);
  }
};

/**
 * Narrow macOS CPU-temperature probe.
 *
 * Delegates to ReadCpuTemperature(), which averages the union of every in-range
 * per-core reading from two CPU-core sources (the same sources Stats averages):
 * generation-specific AppleSMC core keys (holding the last in-range value per
 * core so a parked core's idle floor does not skew the result) and the HID
 * CPU-core sensors ("pACC/eACC MTR Temp"). Both measure CPU cores; there is no
 * die or approximate fallback, so it reports available=false rather than a
 * guessed value when neither source yields a plausible CPU-core reading. No Node
 * API exposes thermal sensors and macOS has no documented public CPU temperature
 * source on Apple Silicon, so unavailable is an honest, accepted outcome. See
 * temperature_probe.cc for the decode and validation rules.
 */
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

/**
 * Narrow macOS process collector.
 *
 * Delegates to mostats::CollectProcesses(), which enumerates the current
 * process list with libproc and reports per-process identity, command line,
 * memory, and cumulative CPU time with explicit per-field availability. It is
 * inspection-only and read-only - it never signals processes (actions are
 * main-owned) and computes no rates (main diffs the CPU counter across
 * snapshots). Command-line arguments are sensitive: they are returned for local
 * display/search only and are never logged here. See process_collector.cc for
 * the collection and availability rules.
 */
class ProcessCollectorServiceImpl : public ProcessCollectorService {
 public:
  void CollectProcesses(const CollectProcessesRequest* /*request*/,
                        Callback<CollectProcessesResponse> done) override {
    CollectProcessesResponse response;
    mostats::CollectProcesses(&response);
    std::move(done).Complete(response);
  }
};

void launch() {
  mo::rpc::RegisterService(new MemoryServiceImpl());
  mo::rpc::RegisterService(new NetworkServiceImpl());
  mo::rpc::RegisterService(new TemperatureServiceImpl());
  mo::rpc::RegisterService(new ProcessCollectorServiceImpl());
}
