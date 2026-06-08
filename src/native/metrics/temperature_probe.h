#ifndef MOSTATS_METRICS_TEMPERATURE_PROBE_H_
#define MOSTATS_METRICS_TEMPERATURE_PROBE_H_

// Narrow CPU-temperature probe over private macOS sensor APIs.
//
// macOS exposes no documented public CPU temperature source on Apple Silicon,
// so this is the only honest path other than reporting unavailable. The probe
// averages the union of every in-range per-core reading from two CPU-core
// sources (the same sources Stats averages for its "Average CPU" value):
//   - generation-specific AppleSMC core keys. A parked core's SMC sensor reads a
//     meaningless idle floor until it wakes, so the probe holds the last
//     in-range value per core and reuses it while the core is parked.
//   - the HID CPU-core sensors ("pACC/eACC MTR Temp"), which come back already
//     resolved (no idle floor) but are absent on some machines.
// Both sources measure CPU cores, so neither misreports the value. There is no
// die / approximate fallback: when neither source yields a plausible CPU-core
// value the probe reports unavailable, so the result is only ever a real
// CPU-core temperature. See temperature_probe.cc for the decode and validation
// rules and the private symbol declarations.

namespace mostats {

// One CPU-temperature reading. `available` is false when no trustworthy CPU
// sensor could be read; `celsius` is then 0 and the caller degrades only the
// temperature card to unavailable.
struct CpuTemperatureReading {
  bool available = false;
  double celsius = 0.0;
};

// Reads the average CPU-core temperature, or reports it unavailable. Never
// throws and is safe to call on any macOS machine: an unsupported machine,
// missing core sensors, or implausible readings all yield an unavailable result
// rather than an approximated value. Stateful across calls (holds the last
// in-range value per SMC core); callers may invoke it on any thread.
CpuTemperatureReading ReadCpuTemperature();

}  // namespace mostats

#endif  // MOSTATS_METRICS_TEMPERATURE_PROBE_H_
