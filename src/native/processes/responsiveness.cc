#include "processes/responsiveness.h"

#include <MacTypes.h>
#include <dlfcn.h>
#include <sys/types.h>

namespace mostats {
namespace {

// The window-server connection handle type used by the private CGS calls.
typedef int CGSConnectionID;

// Private SkyLight/CGS and deprecated Process Manager entry points. There is
// no public macOS API for "is this app marked Not Responding", so these are
// resolved by name at runtime instead of being declared and linked: a future
// macOS that drops a symbol degrades this feature to UNSUPPORTED instead of
// failing the whole native module load. The images are guaranteed present by
// the AppKit and ApplicationServices framework links in CMakeLists.
using CGSMainConnectionIDFn = CGSConnectionID (*)();
using CGSEventIsAppUnresponsiveFn = bool (*)(CGSConnectionID,
                                             const ProcessSerialNumber*);
using GetProcessForPIDFn = OSStatus (*)(pid_t, ProcessSerialNumber*);

// The resolved symbols plus this process's window-server connection, looked up
// once per session (thread-safe static init; only the serial collector calls
// in). `available` is true only when every symbol resolved.
struct CgsApi {
  CGSEventIsAppUnresponsiveFn is_unresponsive = nullptr;
  GetProcessForPIDFn psn_for_pid = nullptr;
  CGSConnectionID connection = 0;
  bool available = false;
};

const CgsApi& Api() {
  static const CgsApi api = [] {
    CgsApi out;
    const auto main_connection = reinterpret_cast<CGSMainConnectionIDFn>(
        dlsym(RTLD_DEFAULT, "CGSMainConnectionID"));
    out.is_unresponsive = reinterpret_cast<CGSEventIsAppUnresponsiveFn>(
        dlsym(RTLD_DEFAULT, "CGSEventIsAppUnresponsive"));
    out.psn_for_pid = reinterpret_cast<GetProcessForPIDFn>(
        dlsym(RTLD_DEFAULT, "GetProcessForPID"));
    out.available = main_connection != nullptr &&
                    out.is_unresponsive != nullptr &&
                    out.psn_for_pid != nullptr;
    if (out.available) {
      out.connection = main_connection();
    }
    return out;
  }();
  return api;
}

}  // namespace

void FillResponsiveness(int32_t pid, NativeResponsiveness* out) {
  const CgsApi& api = Api();
  if (!api.available) {
    out->set_status(NATIVE_FIELD_STATUS_UNSUPPORTED);
    return;
  }

  // A PSN lookup failure means the process has no Process Manager entry (it
  // exited between the NSWorkspace snapshot and this read, or it is not really
  // a window-server client); there is no responsiveness to report.
  ProcessSerialNumber psn = {0, 0};
  if (api.psn_for_pid(static_cast<pid_t>(pid), &psn) != 0) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_unresponsive(api.is_unresponsive(api.connection, &psn));
}

}  // namespace mostats
