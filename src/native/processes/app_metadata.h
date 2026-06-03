#ifndef MOSTATS_PROCESSES_APP_METADATA_H_
#define MOSTATS_PROCESSES_APP_METADATA_H_

#include <cstdint>
#include <unordered_map>

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Maps PID -> GUI application metadata for the currently running applications.
 *
 * Backed by NSWorkspace.runningApplications, so it only covers processes that
 * macOS treats as user-facing GUI applications (Finder, Safari, Xcode, ...),
 * not every PID in the process table. The process collector merges this onto the
 * matching records; processes with no entry keep their app metadata unset and
 * fall back to a generic icon in the UI.
 *
 * Each value carries per-field availability: bundle identifier, localized name,
 * and a small (32 px) base64-encoded PNG icon, each marked unavailable when that
 * piece is missing rather than faked.
 *
 * Privacy: the icon is volatile display-only data. The caller must not log or
 * persist it.
 */
std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata();

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_APP_METADATA_H_
