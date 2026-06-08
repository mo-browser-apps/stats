#ifndef MOSTATS_METRICS_MEMORY_PROBE_H_
#define MOSTATS_METRICS_MEMORY_PROBE_H_

#include "gen/memory.pb.h"

namespace mostats {

// Reads an Activity Monitor-style memory breakdown into the generated response.
//
// Reclaimable file cache is subtracted from "used" and reported separately so
// the UI does not present cache as pressure. On any failure the response is
// marked unavailable. The main-process sampler owns percentage derivation. See
// memory_probe.cc for the page-counter sources and math.
void ReadMemoryUsage(MemoryUsage* response);

}  // namespace mostats

#endif  // MOSTATS_METRICS_MEMORY_PROBE_H_
