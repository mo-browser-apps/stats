#include <ifaddrs.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_media.h>
#include <net/if_types.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sockio.h>
#include <cstdint>
#include <cstring>
#include <unistd.h>

#include "rpc.h"
#include "gen/network.rpc.h"

using google::protobuf::Empty;
using mo::rpc::Callback;

namespace {

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

void launch() {
  mo::rpc::RegisterService(new NetworkServiceImpl());
}
