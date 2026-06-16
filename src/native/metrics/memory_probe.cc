#include "metrics/memory_probe.h"

#include <mach/mach.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <cstdint>
#include <limits>

// Technique reference: exelban/stats Modules/RAM/readers.swift reads the same
// host_statistics64 VM categories. This is a scoped re-implementation exposing
// only total, used, available, and cache for MoStats' single memory row. No
// upstream code is copied.

namespace mostats {
namespace {

uint64_t SaturatingAdd(uint64_t left, uint64_t right) {
  const uint64_t max = std::numeric_limits<uint64_t>::max();
  return max - left < right ? max : left + right;
}

uint64_t SaturatingSubtract(uint64_t left, uint64_t right) {
  return left > right ? left - right : 0;
}

uint64_t PagesToBytes(uint64_t pages, uint64_t page_size) {
  if (page_size == 0) {
    return 0;
  }
  const uint64_t max = std::numeric_limits<uint64_t>::max();
  return pages > max / page_size ? max : pages * page_size;
}

// Total physical RAM via sysctl, or false when it cannot be read.
bool ReadPhysicalMemorySize(uint64_t* total_bytes) {
  uint64_t value = 0;
  size_t size = sizeof(value);
  if (sysctlbyname("hw.memsize", &value, &size, nullptr, 0) != 0 ||
      size != sizeof(value) || value == 0) {
    return false;
  }
  *total_bytes = value;
  return true;
}

}  // namespace

void ReadMemoryUsage(MemoryUsage* response) {
  uint64_t total_bytes = 0;
  const long raw_page_size = sysconf(_SC_PAGESIZE);

  // mach_host_self() adds a send-right uref that is never deallocated; the
  // port is process-lifetime stable, so acquire it once instead of leaking one
  // reference per tick.
  static const host_t host = mach_host_self();

  vm_statistics64_data_t stats = {};
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  const kern_return_t result = host_statistics64(
      host, HOST_VM_INFO64, reinterpret_cast<host_info64_t>(&stats), &count);

  if (!ReadPhysicalMemorySize(&total_bytes) || raw_page_size <= 0 ||
      result != KERN_SUCCESS) {
    response->set_available(false);
    return;
  }
  const uint64_t page_size = static_cast<uint64_t>(raw_page_size);

  // Pages in use, minus the pages the kernel can reclaim on demand (file cache
  // plus purgeable), which we report separately rather than as pressure.
  uint64_t occupied_pages = 0;
  occupied_pages = SaturatingAdd(occupied_pages, stats.active_count);
  occupied_pages = SaturatingAdd(occupied_pages, stats.inactive_count);
  occupied_pages = SaturatingAdd(occupied_pages, stats.speculative_count);
  occupied_pages = SaturatingAdd(occupied_pages, stats.wire_count);
  occupied_pages = SaturatingAdd(occupied_pages, stats.compressor_page_count);

  uint64_t cached_pages = 0;
  cached_pages = SaturatingAdd(cached_pages, stats.purgeable_count);
  cached_pages = SaturatingAdd(cached_pages, stats.external_page_count);

  const uint64_t used_pages = SaturatingSubtract(occupied_pages, cached_pages);
  uint64_t used_bytes = std::min(PagesToBytes(used_pages, page_size), total_bytes);
  const uint64_t available_bytes = total_bytes - used_bytes;
  const uint64_t cached_bytes =
      std::min(PagesToBytes(cached_pages, page_size), available_bytes);
  const uint64_t wired_bytes =
      std::min(PagesToBytes(stats.wire_count, page_size), used_bytes);
  const uint64_t compressed_bytes = std::min(
      PagesToBytes(stats.compressor_page_count, page_size),
      used_bytes - wired_bytes);
  const uint64_t app_bytes = used_bytes - wired_bytes - compressed_bytes;

  response->set_available(true);
  response->set_total_bytes(total_bytes);
  response->set_used_bytes(used_bytes);
  response->set_available_bytes(available_bytes);
  response->set_cached_bytes(cached_bytes);
  response->set_app_bytes(app_bytes);
  response->set_wired_bytes(wired_bytes);
  response->set_compressed_bytes(compressed_bytes);
}

}  // namespace mostats
