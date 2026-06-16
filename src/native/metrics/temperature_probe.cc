#include "metrics/temperature_probe.h"

#include <IOKit/hidsystem/IOHIDEventSystemClient.h>
#include <IOKit/IOKitLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach.h>
#include <sys/sysctl.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>

// Private IOKit HID symbols. These are not declared in any public SDK header,
// so they are forward-declared here with local opaque pointer tags. They are
// read-only sensor queries; the app never controls hardware. If a future macOS
// removes or changes them the probe degrades to unavailable (handled below by
// null/empty checks), never crashing the app.
struct IOHIDEvent;
struct IOHIDServiceClient;
using IOHIDEventRef = IOHIDEvent*;
using IOHIDServiceClientRef = IOHIDServiceClient*;

extern "C" {
IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
void IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client,
                                       CFDictionaryRef match);
CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service,
                                          int64_t type, int32_t options,
                                          int64_t timestamp);
CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service,
                                         CFStringRef property);
double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);
}

namespace mostats {

namespace {

// Plausible CPU temperature window in Celsius. Readings outside this range are
// rejected. On Apple Silicon a parked CPU core's SMC sensor reads a meaningless
// floor (~4-7 C) until the core wakes, so the low bound is also what
// distinguishes a real core reading from that idle floor. Mirrors the
// exelban/stats CPU guard (Modules/Sensors/readers.swift "fix for m2 broken
// sensors", which rejects < 10 / > 120).
constexpr double kMinPlausibleCelsius = 10.0;
constexpr double kMaxPlausibleCelsius = 120.0;

bool IsPlausibleTemperature(double celsius) {
  return std::isfinite(celsius) && celsius >= kMinPlausibleCelsius &&
         celsius <= kMaxPlausibleCelsius;
}

CpuTemperatureReading ReadingFromAverage(double sum, int count) {
  CpuTemperatureReading reading;
  if (count > 0) {
    reading.available = true;
    reading.celsius = sum / count;
  }
  return reading;
}

// A partial average: the running sum and count of in-range core readings from a
// single source, so multiple core sources can be combined before dividing.
struct TemperatureAccumulator {
  double sum = 0.0;
  int count = 0;

  void Add(double celsius) {
    sum += celsius;
    ++count;
  }
  void Merge(const TemperatureAccumulator& other) {
    sum += other.sum;
    count += other.count;
  }
};

// ---------------------------------------------------------------------------
// SMC CPU-core temperature path (primary)
//
// Apple Silicon exposes per-core temperatures as AppleSMC keys whose names
// differ by chip generation. A parked core's key reads an idle floor (~5 C)
// rather than its real value, so we hold the last in-range reading per key and
// reuse it while the core is parked, keeping the average steady.
// ---------------------------------------------------------------------------

// AppleSMC user-client RPC selectors and per-call sub-commands.
constexpr uint8_t kSmcKernelIndex = 2;
constexpr uint8_t kSmcCmdReadBytes = 5;
constexpr uint8_t kSmcCmdReadKeyInfo = 9;

enum class AppleSiliconGeneration { kUnknown, kM1, kM2, kM3, kM4, kM5 };

// SMC RPC structs. The kernel expects this exact 80-byte layout (enforced by
// the static_assert below); the fields we do not use are present only to
// reproduce that layout.
struct SmcKeyDataVers {
  uint8_t major = 0;
  uint8_t minor = 0;
  uint8_t build = 0;
  uint8_t reserved = 0;
  uint16_t release = 0;
};

struct SmcKeyDataLimit {
  uint16_t version = 0;
  uint16_t length = 0;
  uint32_t cpu_plimit = 0;
  uint32_t gpu_plimit = 0;
  uint32_t mem_plimit = 0;
};

struct SmcKeyInfo {
  uint32_t data_size = 0;
  uint32_t data_type = 0;
  uint8_t data_attributes = 0;
};

struct SmcKeyData {
  uint32_t key = 0;
  SmcKeyDataVers vers;
  SmcKeyDataLimit limit;
  SmcKeyInfo key_info;
  uint8_t result = 0;
  uint8_t status = 0;
  uint8_t data8 = 0;
  uint32_t data32 = 0;
  uint8_t bytes[32] = {};
};

static_assert(sizeof(SmcKeyData) == 80,
              "the AppleSMC user-client RPC requires this exact 80-byte layout");

struct SmcValue {
  uint32_t data_size = 0;
  uint32_t data_type = 0;
  std::array<uint8_t, 32> bytes = {};
};

// Per-generation CPU-core temperature keys, copied from the exelban/stats
// research reference (Modules/Sensors/values.swift, the average:true .CPU
// sensors per platform). Performance and efficiency cores both included.
constexpr std::array<std::string_view, 10> kM1CpuKeys = {
    "Tp09", "Tp0T", "Tp01", "Tp05", "Tp0D",
    "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b",
};
constexpr std::array<std::string_view, 12> kM2CpuKeys = {
    "Tp1h", "Tp1t", "Tp1p", "Tp1l", "Tp01", "Tp05",
    "Tp09", "Tp0D", "Tp0X", "Tp0b", "Tp0f", "Tp0j",
};
constexpr std::array<std::string_view, 16> kM3CpuKeys = {
    "Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09",
    "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49",
    "Tf4A", "Tf4B", "Tf4D", "Tf4E",
};
constexpr std::array<std::string_view, 12> kM4CpuKeys = {
    "Te05", "Te09", "Te0H", "Te0S", "Tp01", "Tp05",
    "Tp09", "Tp0D", "Tp0V", "Tp0Y", "Tp0b", "Tp0e",
};
constexpr std::array<std::string_view, 18> kM5CpuKeys = {
    "Tp00", "Tp04", "Tp08", "Tp0C", "Tp0G", "Tp0K",
    "Tp0O", "Tp0R", "Tp0U", "Tp0X", "Tp0a", "Tp0d",
    "Tp0g", "Tp0j", "Tp0m", "Tp0p", "Tp0u", "Tp0y",
};

uint32_t FourCharToKey(std::string_view value) {
  if (value.size() != 4) {
    return 0;
  }
  uint32_t code = 0;
  for (const char character : value) {
    code = (code << 8) | static_cast<uint8_t>(character);
  }
  return code;
}

// Builds a FourCharCode from a literal at compile time, for the data-type
// check below. Distinct from FourCharToKey to keep that runtime path simple.
constexpr uint32_t TypeCode(const char (&value)[5]) {
  uint32_t code = 0;
  for (int i = 0; i < 4; ++i) {
    code = (code << 8) | static_cast<uint8_t>(value[i]);
  }
  return code;
}

std::optional<std::string> ReadSysctlString(const char* name) {
  size_t size = 0;
  if (sysctlbyname(name, nullptr, &size, nullptr, 0) != 0 || size == 0) {
    return std::nullopt;
  }
  std::string value(size, '\0');
  if (sysctlbyname(name, value.data(), &size, nullptr, 0) != 0) {
    return std::nullopt;
  }
  while (!value.empty() && value.back() == '\0') {
    value.pop_back();
  }
  return value;
}

// True when `brand` contains exactly "Apple M<generation>" (so "Apple M1" does
// not match generation '1' inside "Apple M12" if Apple ever ships one).
bool ContainsAppleMGeneration(std::string_view brand, char generation) {
  std::string token = "Apple M";
  token.push_back(generation);
  const size_t position = brand.find(token);
  if (position == std::string_view::npos) {
    return false;
  }
  const size_t after = position + token.size();
  return after == brand.size() ||
         !std::isdigit(static_cast<unsigned char>(brand[after]));
}

AppleSiliconGeneration DetectAppleSiliconGeneration() {
  const std::optional<std::string> brand =
      ReadSysctlString("machdep.cpu.brand_string");
  if (!brand.has_value()) {
    return AppleSiliconGeneration::kUnknown;
  }
  if (ContainsAppleMGeneration(*brand, '1')) return AppleSiliconGeneration::kM1;
  if (ContainsAppleMGeneration(*brand, '2')) return AppleSiliconGeneration::kM2;
  if (ContainsAppleMGeneration(*brand, '3')) return AppleSiliconGeneration::kM3;
  if (ContainsAppleMGeneration(*brand, '4')) return AppleSiliconGeneration::kM4;
  if (ContainsAppleMGeneration(*brand, '5')) return AppleSiliconGeneration::kM5;
  return AppleSiliconGeneration::kUnknown;
}

bool HasNonZeroBytes(const SmcValue& value) {
  const uint32_t byte_count =
      std::min<uint32_t>(value.data_size, value.bytes.size());
  for (uint32_t i = 0; i < byte_count; ++i) {
    if (value.bytes[i] != 0) {
      return true;
    }
  }
  return false;
}

// Decodes the SMC value bytes per its data type. Apple Silicon - this app's
// support matrix, and the only platform the per-generation key lists cover -
// reports temperatures exclusively as "flt " (IEEE float); the Intel-era
// fixed-point types (sp*, fpe2) are deliberately not decoded. Returns nullopt
// for an all-zero or unrecognized value.
std::optional<double> DecodeSmcTemperature(const SmcValue& value) {
  if (value.data_size == 0 || !HasNonZeroBytes(value)) {
    return std::nullopt;
  }
  if (value.data_type != TypeCode("flt ") || value.data_size < sizeof(float)) {
    return std::nullopt;
  }
  float raw = 0.0F;
  std::memcpy(&raw, value.bytes.data(), sizeof(raw));
  return static_cast<double>(raw);
}

// Owns an open AppleSMC user-client connection and reads one key at a time via
// the two-call (key-info, then bytes) protocol. Not copyable; the connection is
// closed on destruction.
class SmcConnection {
 public:
  SmcConnection() {
    io_service_t device = IOServiceGetMatchingService(
        kIOMainPortDefault, IOServiceMatching("AppleSMC"));
    if (device == IO_OBJECT_NULL) {
      return;
    }
    if (IOServiceOpen(device, mach_task_self(), 0, &connection_) !=
        kIOReturnSuccess) {
      connection_ = IO_OBJECT_NULL;
    }
    IOObjectRelease(device);
  }

  ~SmcConnection() {
    if (connection_ != IO_OBJECT_NULL) {
      IOServiceClose(connection_);
    }
  }

  SmcConnection(const SmcConnection&) = delete;
  SmcConnection& operator=(const SmcConnection&) = delete;

  bool is_open() const { return connection_ != IO_OBJECT_NULL; }

  // Reads a key's metadata (data size and type). This is stable for the life of
  // the machine, so callers cache it and then read values via ReadValue without
  // repeating this call. Returns nullopt on RPC failure or a zero-size key.
  std::optional<SmcKeyInfo> ReadKeyInfo(std::string_view key) const {
    if (!is_open()) {
      return std::nullopt;
    }
    SmcKeyData input;
    SmcKeyData output;
    input.key = FourCharToKey(key);
    input.data8 = kSmcCmdReadKeyInfo;
    // `result` is the SMC status byte (e.g. 0x84 = key not found); a non-zero
    // status can come back with kIOReturnSuccess, so both must be checked.
    if (Call(input, &output) != kIOReturnSuccess || output.result != 0 ||
        output.key_info.data_size == 0) {
      return std::nullopt;
    }
    return output.key_info;
  }

  // Reads a key's value bytes given its already-known metadata, performing only
  // the single bytes-read RPC (the key-info RPC is skipped). This halves the
  // per-read SMC traffic on the hot path, where the probe re-reads the same
  // core keys every tick.
  std::optional<SmcValue> ReadValue(std::string_view key,
                                    const SmcKeyInfo& info) const {
    if (!is_open()) {
      return std::nullopt;
    }
    SmcKeyData input;
    SmcKeyData output;
    input.key = FourCharToKey(key);
    input.key_info.data_size = info.data_size;
    input.data8 = kSmcCmdReadBytes;
    // A non-zero SMC status byte means the read failed even when the RPC
    // itself succeeded; without this check garbage bytes could decode into a
    // plausible value and contaminate the held per-core readings.
    if (Call(input, &output) != kIOReturnSuccess || output.result != 0) {
      return std::nullopt;
    }

    SmcValue value;
    value.data_size = info.data_size;
    value.data_type = info.data_type;
    const size_t byte_count =
        std::min<size_t>(value.bytes.size(), value.data_size);
    std::memcpy(value.bytes.data(), output.bytes, byte_count);
    return value;
  }

 private:
  kern_return_t Call(const SmcKeyData& input, SmcKeyData* output) const {
    size_t output_size = sizeof(SmcKeyData);
    return IOConnectCallStructMethod(connection_, kSmcKernelIndex, &input,
                                     sizeof(SmcKeyData), output, &output_size);
  }

  io_connect_t connection_ = IO_OBJECT_NULL;
};

// Returns the CPU-core key list for this machine's generation, or an empty
// span for non-Apple-Silicon / unknown chips.
std::span<const std::string_view> CpuKeysForGeneration(
    AppleSiliconGeneration generation) {
  switch (generation) {
    case AppleSiliconGeneration::kM1: return kM1CpuKeys;
    case AppleSiliconGeneration::kM2: return kM2CpuKeys;
    case AppleSiliconGeneration::kM3: return kM3CpuKeys;
    case AppleSiliconGeneration::kM4: return kM4CpuKeys;
    case AppleSiliconGeneration::kM5: return kM5CpuKeys;
    case AppleSiliconGeneration::kUnknown: return {};
  }
  return {};
}

// Process-lifetime CPU-core temperature reader. Holds one SMC connection and
// the last in-range temperature seen per core key, so a core that is parked
// this tick (reading the idle floor) still contributes its last real value to
// the average - matching how Stats keeps the reading steady. Guarded by a mutex
// because the native RPC handler may invoke ReadCpuTemperature from a non-main
// thread.
class CpuCoreTemperatureReader {
 public:
  // Returns the sum and count of the held per-core readings (not a finished
  // average), so the caller can merge these SMC cores with the HID cores before
  // averaging the union.
  TemperatureAccumulator Read() {
    std::lock_guard<std::mutex> lock(mutex_);

    TemperatureAccumulator accumulator;
    if (!initialized_) {
      generation_ = DetectAppleSiliconGeneration();
      initialized_ = true;
    }
    if (!smc_.is_open()) {
      return accumulator;
    }

    for (const std::string_view key : CpuKeysForGeneration(generation_)) {
      // Cache each key's metadata once: size/type are fixed for the machine's
      // life, so later ticks skip the key-info RPC and do only the bytes-read.
      // The cached value is optional: a key absent from this chip caches as
      // nullopt ("known absent") so it is probed at most once, never re-queried
      // every tick - the generation key lists are supersets and many keys do not
      // exist on a given chip.
      const uint32_t key_code = FourCharToKey(key);
      auto info_it = key_info_.find(key_code);
      if (info_it == key_info_.end()) {
        info_it = key_info_.emplace(key_code, smc_.ReadKeyInfo(key)).first;
      }
      if (!info_it->second.has_value()) {
        continue;  // Known-absent key on this chip.
      }

      const std::optional<SmcValue> value =
          smc_.ReadValue(key, *info_it->second);
      if (!value.has_value()) {
        continue;
      }
      // Keep only in-range readings; a parked core reads the idle floor and is
      // ignored this tick (its held value, if any, still counts below).
      const std::optional<double> celsius = DecodeSmcTemperature(*value);
      if (celsius.has_value() && IsPlausibleTemperature(*celsius)) {
        last_good_[key_code] = *celsius;
      }
    }

    // Accumulate every core that has ever produced a real reading. Cores never
    // yet seen in range (e.g. parked since launch) are simply absent until they
    // wake once, which avoids averaging in the idle floor.
    for (const auto& entry : last_good_) {
      accumulator.Add(entry.second);
    }
    return accumulator;
  }

 private:
  std::mutex mutex_;
  bool initialized_ = false;
  AppleSiliconGeneration generation_ = AppleSiliconGeneration::kUnknown;
  SmcConnection smc_;
  // Both maps are keyed by the key's FourCharCode, so the per-tick lookups
  // allocate nothing. nullopt = key probed and absent on this chip (do not
  // re-probe).
  std::unordered_map<uint32_t, std::optional<SmcKeyInfo>> key_info_;
  std::unordered_map<uint32_t, double> last_good_;
};

// ---------------------------------------------------------------------------
// HID CPU-core temperature path
//
// Apple also exposes per-core CPU temperatures on a HID page (0xff05) as
// services named "pACC MTR Temp" (performance) and "eACC MTR Temp" (efficiency
// cores). These come back already resolved (no idle floor), so they need only a
// range filter. The page is empty on some machines; where present its readings
// are averaged with the SMC ones. SOC die sensors on this page are deliberately
// skipped - they are not CPU-core temperatures.
// ---------------------------------------------------------------------------

constexpr int32_t kHIDEventTypeTemperature = 15;
constexpr int32_t kIOHIDEventFieldTemperature = kHIDEventTypeTemperature << 16;
constexpr int32_t kAppleVendorTemperatureSensorPage = 0xff05;
constexpr int32_t kAppleVendorTemperatureSensorUsage = 0x0005;

CFDictionaryRef CreateCpuCoreSensorMatch() {
  int32_t page = kAppleVendorTemperatureSensorPage;
  int32_t usage = kAppleVendorTemperatureSensorUsage;
  CFNumberRef page_number = CFNumberCreate(nullptr, kCFNumberSInt32Type, &page);
  CFNumberRef usage_number = CFNumberCreate(nullptr, kCFNumberSInt32Type, &usage);
  if (page_number == nullptr || usage_number == nullptr) {
    if (page_number != nullptr) CFRelease(page_number);
    if (usage_number != nullptr) CFRelease(usage_number);
    return nullptr;
  }
  const void* keys[] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
  const void* values[] = {page_number, usage_number};
  CFDictionaryRef match =
      CFDictionaryCreate(nullptr, keys, values, 2, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  CFRelease(page_number);
  CFRelease(usage_number);
  return match;
}

// True only for the CPU performance/efficiency core sensors ("pACC MTR Temp" /
// "eACC MTR Temp"); the GPU ("GPU MTR Temp"), SOC, ANE, and ISP sensors share
// the page but are not CPU-core temperatures.
bool IsCpuCoreSensorName(CFStringRef name) {
  return CFStringHasPrefix(name, CFSTR("pACC MTR Temp")) ||
         CFStringHasPrefix(name, CFSTR("eACC MTR Temp"));
}

// One read pass over an already-copied service list. Sets `has_cpu_sensor`
// true when at least one CPU-core sensor *service* is present, independent of
// whether its reading is plausible this tick - the caller latches off only on
// a successful enumeration that proved this machine has no such sensors (a
// fixed hardware fact), so a present-but-momentarily-unreadable sensor never
// causes a false latch.
TemperatureAccumulator ReadCpuCoreTemperaturesFrom(CFArrayRef services,
                                                   bool* has_cpu_sensor) {
  TemperatureAccumulator accumulator;
  *has_cpu_sensor = false;

  const CFIndex service_count = CFArrayGetCount(services);
  for (CFIndex i = 0; i < service_count; ++i) {
    IOHIDServiceClientRef service = static_cast<IOHIDServiceClientRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(services, i)));
    if (service == nullptr) {
      continue;
    }
    CFTypeRef name_ref = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    if (name_ref == nullptr) {
      continue;
    }
    const bool is_cpu_core = CFGetTypeID(name_ref) == CFStringGetTypeID() &&
                             IsCpuCoreSensorName(static_cast<CFStringRef>(name_ref));
    CFRelease(name_ref);
    if (!is_cpu_core) {
      continue;
    }
    // A CPU-core sensor service exists on this machine, independent of whether
    // its reading is plausible this tick.
    *has_cpu_sensor = true;
    IOHIDEventRef event =
        IOHIDServiceClientCopyEvent(service, kHIDEventTypeTemperature, 0, 0);
    if (event == nullptr) {
      continue;
    }
    const double celsius =
        IOHIDEventGetFloatValue(event, kIOHIDEventFieldTemperature);
    CFRelease(event);
    if (IsPlausibleTemperature(celsius)) {
      accumulator.Add(celsius);
    }
  }

  return accumulator;
}

// Process-lifetime HID CPU-core reader. The HID temperature page exists on some
// Macs and is entirely absent on others (e.g. the M2 Max this was developed on
// returns no CPU-core sensors). Whether the page has sensors cannot change while
// the machine runs, so once an enumeration succeeds and finds none, this latches
// "unavailable" and skips all HID work on every later tick. A transient setup
// failure does not latch - it is retried. Mutex-guarded because the RPC handler
// may call it off the main thread.
class HidCpuCoreTemperatureReader {
 public:
  ~HidCpuCoreTemperatureReader() {
    if (client_ != nullptr) {
      CFRelease(client_);
    }
  }

  TemperatureAccumulator Read() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (latched_unavailable_) {
      return {};
    }

    // The matched client is created once and reused: client creation is the
    // expensive part of a pass. The service list is still copied fresh each
    // tick, so no stale service reference is ever read. A transient creation
    // failure leaves `client_` null and retries on the next tick.
    if (client_ == nullptr) {
      CFDictionaryRef match = CreateCpuCoreSensorMatch();
      if (match == nullptr) {
        return {};
      }
      client_ = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
      if (client_ == nullptr) {
        CFRelease(match);
        return {};
      }
      IOHIDEventSystemClientSetMatching(client_, match);
      CFRelease(match);
    }

    CFArrayRef services = IOHIDEventSystemClientCopyServices(client_);
    if (services == nullptr) {
      return {};
    }

    bool has_cpu_sensor = false;
    TemperatureAccumulator accumulator =
        ReadCpuCoreTemperaturesFrom(services, &has_cpu_sensor);
    CFRelease(services);

    // The service list was obtained: a genuine enumeration, authoritative for
    // this machine even when it matched zero CPU-core sensors - a fixed
    // hardware fact, so latch off rather than re-enumerating forever.
    if (!has_cpu_sensor) {
      latched_unavailable_ = true;
    }
    return accumulator;
  }

 private:
  std::mutex mutex_;
  bool latched_unavailable_ = false;
  IOHIDEventSystemClientRef client_ = nullptr;
};

}  // namespace

CpuTemperatureReading ReadCpuTemperature() {
  // Average the union of every in-range CPU-core reading from both core sources:
  // the AppleSMC per-core keys (idle-floor held) and the HID CPU-core sensors.
  // There is no die / approximate fallback: when neither source yields a
  // plausible CPU-core value the result is unavailable, so the card only ever
  // shows a real CPU-core temperature.
  static CpuCoreTemperatureReader smc_reader;
  static HidCpuCoreTemperatureReader hid_reader;

  TemperatureAccumulator cores = smc_reader.Read();
  cores.Merge(hid_reader.Read());
  return ReadingFromAverage(cores.sum, cores.count);
}

}  // namespace mostats
