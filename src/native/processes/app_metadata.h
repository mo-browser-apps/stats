#ifndef MOSTATS_PROCESSES_APP_METADATA_H_
#define MOSTATS_PROCESSES_APP_METADATA_H_

#include <cstdint>
#include <string>
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

/**
 * Resolves a small app icon for any process by its executable path, writing the
 * base64 PNG (or an unavailable status) into `out`.
 *
 * Unlike {@link SnapshotRunningAppMetadata}, this is not limited to GUI apps: it
 * uses NSWorkspace's standard iconForFile:, which returns a bundled app's real
 * icon and a plain executable's generic system icon, matching what Activity
 * Monitor shows. The collector uses it as an icon-only fallback for processes
 * that the GUI-app enrichment did not cover, so naming, bundle id, and localized
 * name are left untouched.
 *
 * Performance: the encoded icon is cached per executable path for the session
 * (the same cache used by GUI-app icons), so a steady-state pass is a hash
 * lookup with no AppKit drawing - an executable is rasterized and encoded at
 * most once. The icon is volatile display-only data and is never logged or
 * persisted.
 */
void IconForExecutablePath(const std::string& executable_path, NativeImage* out);

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_APP_METADATA_H_
