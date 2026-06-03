#include "processes/native_availability.h"

#include <cerrno>

namespace mostats::processes {

NativeAvailabilityReason AvailabilityFromErrno(const int error_number) {
  switch (error_number) {
    case 0:
      return NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
    case ESRCH:
      // The process exited between enumeration and reading this field.
      return NATIVE_AVAILABILITY_REASON_PROCESS_EXITED;
    case EACCES:
    case EPERM:
      return NATIVE_AVAILABILITY_REASON_PERMISSION_DENIED;
    case ENOSYS:
#ifdef ENOTSUP
    case ENOTSUP:
#endif
      return NATIVE_AVAILABILITY_REASON_UNSUPPORTED;
    default:
      return NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  }
}

bool IsPermissionDenied(const NativeAvailabilityReason availability) {
  return availability == NATIVE_AVAILABILITY_REASON_PERMISSION_DENIED;
}

}  // namespace mostats::processes
