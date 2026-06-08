#ifndef MOSTATS_METRICS_NETWORK_PROBE_H_
#define MOSTATS_METRICS_NETWORK_PROBE_H_

#include "gen/network.pb.h"

namespace mostats {

// Reads cumulative network byte counters into the generated response.
//
// Sums the kernel's per-interface rx/tx totals across the active physical
// interfaces (Ethernet/Wi-Fi/Thunderbolt and cellular), skipping loopback, VPN
// tunnels, and AirDrop/sharing so traffic is not double-counted. On failure the
// response is marked unavailable. Only raw counters are returned; the
// main-process sampler owns the delta-to-rate math. See network_probe.cc for the
// interface-selection rule.
void ReadNetworkCounters(NetworkCounters* response);

}  // namespace mostats

#endif  // MOSTATS_METRICS_NETWORK_PROBE_H_
