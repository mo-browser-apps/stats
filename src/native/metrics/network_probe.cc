#include "metrics/network_probe.h"

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

// Technique reference: exelban/stats Modules/Net/readers.swift reads the same
// getifaddrs / if_data ifi_ibytes / ifi_obytes counters. This sums the active
// physical interfaces rather than tracking a single stored primary. No upstream
// code is copied.

namespace mostats {
namespace {

// True when an Ethernet-media interface has a live physical link, so an
// administratively-up but unplugged adapter is not counted.
bool HasActiveMedia(int media_socket, const char* name) {
  ifmediareq request = {};
  strncpy(request.ifm_name, name, sizeof(request.ifm_name) - 1);
  if (ioctl(media_socket, SIOCGIFMEDIA, &request) != 0) {
    return false;
  }
  return (request.ifm_status & IFM_AVALID) != 0 &&
         (request.ifm_status & IFM_ACTIVE) != 0;
}

// True for the active, user-facing physical interfaces a person means by "my
// network". macOS names every genuine NIC en* (Ethernet/Wi-Fi/Thunderbolt) or
// pdp_ip* (cellular); virtual IFT_ETHER interfaces (AirDrop awdl*, the sharing
// bridge, Apple management NICs) use other prefixes, so the name check separates
// them. This drops loopback and VPN tunnels too, avoiding double-counting (VPN
// traffic would otherwise sum on both en0 and the utun tunnel).
//
// en* additionally requires a live media link (above). Cellular is admitted on
// IFF_UP + IFT_CELLULAR alone: SIOCGIFMEDIA is an Ethernet concept and a
// cellular interface commonly reports no media status, so gating it would
// wrongly drop a live cellular-only uplink.
bool IsCountedInterface(const ifaddrs* ptr, int media_socket) {
  if ((ptr->ifa_flags & IFF_UP) == 0 || (ptr->ifa_flags & IFF_LOOPBACK) != 0) {
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
    return true;
  }
  if (strncmp(name, "en", 2) == 0) {
    return HasActiveMedia(media_socket, name);
  }
  return false;
}

}  // namespace

void ReadNetworkCounters(NetworkCounters* response) {
  ifaddrs* addresses = nullptr;
  if (getifaddrs(&addresses) != 0) {
    // Report unavailable rather than zeros that would read as "no traffic".
    response->set_available(false);
    return;
  }

  const int media_socket = socket(AF_INET, SOCK_DGRAM, 0);
  if (media_socket < 0) {
    freeifaddrs(addresses);
    response->set_available(false);
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

  response->set_available(found);
  response->set_rx_bytes(rx_bytes);
  response->set_tx_bytes(tx_bytes);
}

}  // namespace mostats
