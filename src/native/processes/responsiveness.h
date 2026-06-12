#ifndef MOSTATS_PROCESSES_RESPONSIVENESS_H_
#define MOSTATS_PROCESSES_RESPONSIVENESS_H_

#include <cstdint>

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Fills the window-server responsiveness for one GUI app: whether macOS
 * currently marks it "Not Responding" (the exact state behind the beachball,
 * the system Force Quit dialog, and Activity Monitor's red label). The window
 * server flags an app once an event has sat unserviced in its event queue past
 * the system threshold - so a stalled app the user is interacting with is
 * flagged, while an idle stopped app with an empty queue is not, matching what
 * the system itself reports.
 *
 * Call only for PIDs in the NSWorkspace running-apps set: responsiveness is a
 * window-server concept, and daemons/helpers without a Process Manager entry
 * report UNAVAILABLE. macOS exposes no public API for this signal, so it is
 * read through private CGS symbols resolved once at runtime; on a macOS that
 * no longer exposes them every record reports UNSUPPORTED and the UI simply
 * shows no state (verified working on macOS 26 / Darwin 25).
 *
 * Cost (measured, ~57 GUI apps): ~2.5 ms per warm pass, flat whether apps are
 * responsive or hung - the call reads state the window server already tracks;
 * it never pings the app. Threading: serial collector contract, same as the
 * other process sources.
 */
void FillResponsiveness(int32_t pid, NativeResponsiveness* out);

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_RESPONSIVENESS_H_
