#include "metrics/network_probe.h"

#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_media.h>
#include <net/if_types.h>
#include <net/if_var.h>
#include <net/route.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sockio.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

// Counter source: sysctl(NET_RT_IFLIST2) RTM_IFINFO2 messages carry struct
// if_data64 with 64-bit ifi_ibytes/ifi_obytes (net/if_var.h) - the same sysctl
// netstat -ib reads. The simpler getifaddrs path exposes these counters as
// 32-bit (struct if_data), which wraps every 4 GiB (about half a minute of
// sustained 1 Gbps), so it cannot feed a rate.

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
bool IsCountedInterface(uint32_t flags, uint8_t link_type, const char* name,
                        int media_socket) {
  if ((flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0) {
    return false;
  }
  if (link_type != IFT_ETHER && link_type != IFT_CELLULAR) {
    return false;
  }
  if (strncmp(name, "pdp_ip", 6) == 0) {
    return true;
  }
  if (strncmp(name, "en", 2) == 0) {
    return HasActiveMedia(media_socket, name);
  }
  return false;
}

// Fetches the NET_RT_IFLIST2 routing dump. A failure (including the rare
// ENOMEM when an interface appears between the size query and the copy) just
// reports unavailable for this tick; the sampler retries on the next one.
bool FetchInterfaceList(std::vector<char>* buffer) {
  int mib[6] = {CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0};
  size_t length = 0;
  if (sysctl(mib, 6, nullptr, &length, nullptr, 0) != 0) {
    return false;
  }
  buffer->resize(length);
  if (sysctl(mib, 6, buffer->data(), &length, nullptr, 0) != 0) {
    return false;
  }
  buffer->resize(length);
  return true;
}

}  // namespace

void ReadNetworkCounters(NetworkCounters* response) {
  std::vector<char> buffer;
  if (!FetchInterfaceList(&buffer)) {
    // Report unavailable rather than zeros that would read as "no traffic".
    response->set_available(false);
    return;
  }

  const int media_socket = socket(AF_INET, SOCK_DGRAM, 0);
  if (media_socket < 0) {
    response->set_available(false);
    return;
  }

  // Every routing message starts with the same msglen/version/type prefix;
  // the rest of the layout varies by type (RTM_IFINFO2 carries if_msghdr2,
  // while the interleaved per-address RTM_NEWADDR messages are much shorter),
  // so only that prefix may be read or length-checked before the type switch.
  constexpr size_t kMessagePrefixSize = offsetof(if_msghdr, ifm_addrs);
  const char* const end = buffer.data() + buffer.size();
  for (const char* next = buffer.data();
       next + kMessagePrefixSize <= end;) {
    const if_msghdr* header = reinterpret_cast<const if_msghdr*>(next);
    if (header->ifm_msglen < kMessagePrefixSize) {
      break;  // Malformed length; bail rather than loop forever.
    }
    const char* const message_end = next + header->ifm_msglen;
    next = message_end;
    if (message_end > end || header->ifm_type != RTM_IFINFO2) {
      continue;
    }
    if (header->ifm_msglen < sizeof(if_msghdr2) + sizeof(sockaddr_dl)) {
      continue;
    }

    const if_msghdr2* info = reinterpret_cast<const if_msghdr2*>(header);
    // The interface-name sockaddr immediately follows the fixed header.
    const sockaddr_dl* link = reinterpret_cast<const sockaddr_dl*>(info + 1);
    if ((info->ifm_addrs & RTA_IFP) == 0 || link->sdl_family != AF_LINK) {
      continue;
    }

    char name[IFNAMSIZ] = {};
    const size_t name_length =
        std::min<size_t>(link->sdl_nlen, sizeof(name) - 1);
    memcpy(name, link->sdl_data, name_length);

    if (!IsCountedInterface(info->ifm_flags, link->sdl_type, name,
                            media_socket)) {
      continue;
    }

    InterfaceCounters* entry = response->add_interfaces();
    entry->set_name(name);
    entry->set_rx_bytes(info->ifm_data.ifi_ibytes);
    entry->set_tx_bytes(info->ifm_data.ifi_obytes);
  }

  close(media_socket);
  response->set_available(response->interfaces_size() > 0);
}

}  // namespace mostats
