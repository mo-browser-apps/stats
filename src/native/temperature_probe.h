#ifndef MOSTATS_TEMPERATURE_PROBE_H_
#define MOSTATS_TEMPERATURE_PROBE_H_

// Narrow CPU-temperature probe over the private IOKit HID temperature sensors.
//
// macOS exposes no documented public CPU temperature source on Apple Silicon
// (and the Intel-era SMC T* keys are not readable there), so this is the only
// honest path other than reporting unavailable. The probe reads a CPU
// temperature only when it can validate a trustworthy CPU-cluster sensor by
// Apple's performance/efficiency core naming convention; otherwise it reports
// unavailable. See temperature_probe.cc for the validation rules and the
// IOKit-HID symbol declarations.

namespace mostats {

// One CPU-temperature reading. `available` is false when no trustworthy CPU
// sensor could be read; `celsius` is then 0 and the caller degrades only the
// temperature card to unavailable.
struct CpuTemperatureReading {
  bool available = false;
  double celsius = 0.0;
};

// Reads the average CPU-cluster temperature, or reports it unavailable. Never
// throws and is safe to call on any macOS machine: an unsupported machine, a
// missing sensor, or implausible readings all yield an unavailable result.
CpuTemperatureReading ReadCpuTemperature();

}  // namespace mostats

#endif  // MOSTATS_TEMPERATURE_PROBE_H_
