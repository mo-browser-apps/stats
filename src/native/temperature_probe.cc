#include "temperature_probe.h"

#include <IOKit/hidsystem/IOHIDEventSystemClient.h>
#include <CoreFoundation/CoreFoundation.h>

#include <cmath>

// Private IOKit HID symbols. These are not declared in any public SDK header,
// so they are forward-declared here exactly as the upstream research reference
// (exelban/stats Modules/Sensors/bridge.h, in turn based on MenuMeters) does.
// They are read-only sensor queries; the app never controls hardware. If a
// future macOS removes or changes them the probe degrades to unavailable
// (handled below by null/empty checks), never crashing the app.
extern "C" {
typedef struct __IOHIDEvent* IOHIDEventRef;
typedef struct __IOHIDServiceClient* IOHIDServiceClientRef;

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

// IOHID event constants (from IOHIDEventTypes; not in the public SDK headers).
constexpr int32_t kHIDEventTypeTemperature = 15;
constexpr int32_t IOHIDEventFieldTemperature = kHIDEventTypeTemperature << 16;

// Matching keys for the Apple Silicon temperature sensor HID page/usage.
constexpr int32_t kAppleVendorTemperaturePage = 0xff00;
constexpr int32_t kAppleVendorTemperatureUsage = 0x0005;

// Plausible CPU temperature window in Celsius. Mirrors the exelban/stats CPU
// guard (it rejects implausible readings outside roughly this range to drop
// the "broken M2 sensor" values); anything outside is discarded so a single
// bad sensor can never skew the average.
constexpr double kMinPlausibleCelsius = 10.0;
constexpr double kMaxPlausibleCelsius = 120.0;

// Builds the { PrimaryUsagePage, PrimaryUsage } matching dictionary that
// selects the temperature sensor HID services. Caller releases the result.
CFDictionaryRef CreateTemperatureMatch() {
  int32_t page = kAppleVendorTemperaturePage;
  int32_t usage = kAppleVendorTemperatureUsage;
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

// True only for the CPU-cluster temperature sensors. Apple names its CPU core
// clusters pACC (performance cores) and eACC (efficiency cores); GPU, SOC,
// battery, NAND, PMU die, and calibration sensors all use other names. Trusting
// only this documented-by-convention CPU naming - rather than guessing at the
// undocumented PMU die sensors many machines expose - is what keeps the reading
// honest: a machine that does not expose pACC/eACC simply reports unavailable.
bool IsCpuSensorName(CFStringRef name) {
  return CFStringHasPrefix(name, CFSTR("pACC")) ||
         CFStringHasPrefix(name, CFSTR("eACC"));
}

}  // namespace

CpuTemperatureReading ReadCpuTemperature() {
  CpuTemperatureReading reading;

  CFDictionaryRef match = CreateTemperatureMatch();
  if (match == nullptr) {
    return reading;  // unavailable
  }

  IOHIDEventSystemClientRef client =
      IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (client == nullptr) {
    CFRelease(match);
    return reading;  // unavailable
  }

  IOHIDEventSystemClientSetMatching(client, match);
  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  CFRelease(match);
  if (services == nullptr) {
    CFRelease(client);
    return reading;  // unavailable
  }

  double sum = 0.0;
  int count = 0;
  const CFIndex service_count = CFArrayGetCount(services);
  for (CFIndex i = 0; i < service_count; ++i) {
    IOHIDServiceClientRef service =
        static_cast<IOHIDServiceClientRef>(
            const_cast<void*>(CFArrayGetValueAtIndex(services, i)));
    if (service == nullptr) {
      continue;
    }

    CFTypeRef name_ref = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    if (name_ref == nullptr) {
      continue;
    }
    const bool is_cpu = CFGetTypeID(name_ref) == CFStringGetTypeID() &&
                        IsCpuSensorName(static_cast<CFStringRef>(name_ref));
    CFRelease(name_ref);
    if (!is_cpu) {
      continue;
    }

    IOHIDEventRef event =
        IOHIDServiceClientCopyEvent(service, kHIDEventTypeTemperature, 0, 0);
    if (event == nullptr) {
      continue;
    }
    const double celsius =
        IOHIDEventGetFloatValue(event, IOHIDEventFieldTemperature);
    CFRelease(event);

    // Drop implausible readings so one bad sensor cannot skew the average.
    if (std::isfinite(celsius) && celsius >= kMinPlausibleCelsius &&
        celsius <= kMaxPlausibleCelsius) {
      sum += celsius;
      ++count;
    }
  }

  CFRelease(services);
  CFRelease(client);

  if (count > 0) {
    reading.available = true;
    reading.celsius = sum / count;
  }
  return reading;
}

}  // namespace mostats
