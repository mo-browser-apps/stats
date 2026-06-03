#ifndef MOSTATS_NATIVE_AVAILABILITY_H_
#define MOSTATS_NATIVE_AVAILABILITY_H_

#include "process_collector.pb.h"

namespace mostats::processes {

// Maps a POSIX errno into the collector's per-field availability reason so a
// process that exits or denies access mid-collection degrades that field rather
// than failing the whole snapshot.
NativeAvailabilityReason AvailabilityFromErrno(int error_number);

// True when the availability reason is a macOS access denial.
bool IsPermissionDenied(NativeAvailabilityReason availability);

}  // namespace mostats::processes

#endif  // MOSTATS_NATIVE_AVAILABILITY_H_
