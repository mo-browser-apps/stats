#ifndef MOSTATS_PROCESSES_APP_METADATA_H_
#define MOSTATS_PROCESSES_APP_METADATA_H_

#include <cstdint>
#include <string>
#include <unordered_map>

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Maps PID -> GUI application identity (bundle id, localized name, exact bundle
 * path when appropriate, and sometimes an icon) for the currently running
 * applications.
 *
 * Backed by NSWorkspace.runningApplications, so it only covers processes that
 * macOS treats as user-facing GUI applications (Finder, Safari, Xcode, ...),
 * not every PID in the process table. The collector merges this onto matching
 * records; processes with no entry keep bundle id / localized name unset.
 *
 * Icon policy: only the running app that is also the outer `.app` MoStats groups
 * by gets its exact NSRunningApplication icon here. Nested helper apps keep their
 * identity metadata but no icon, so the collector resolves the shared owner icon
 * from the executable path. Each field is marked unavailable when missing rather
 * than faked.
 */
std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata();

/**
 * Resolves a small app icon for any process by its executable path, writing the
 * base64 PNG (or an unavailable status) into `out`.
 *
 * Unlike {@link SnapshotRunningAppMetadata}, this is not limited to GUI apps. It
 * resolves the icon from the owning `.app` bundle when the executable lives
 * inside one (a browser helper resolves to the parent app's real icon), and from
 * the executable itself otherwise (a plain daemon gets the generic system icon),
 * via NSWorkspace's iconForFile:. The collector uses it as an icon-only fallback,
 * leaving naming, bundle id, and localized name untouched.
 *
 * The encoded icon is cached per resolution path for the session, so members of
 * one app bundle share a single entry and a steady-state pass is a hash lookup
 * with no AppKit drawing. The icon is volatile display-only data and is never
 * logged or persisted.
 */
void IconForExecutablePath(const std::string& executable_path, NativeImage* out);

/**
 * Resolves an icon for an exact app/file path without applying app grouping.
 */
void IconForFilePath(const std::string& path, NativeImage* out);

/**
 * Fills the owning `.app` bundle (path + display name) for an executable path,
 * used to group a multi-process app's members into one list row.
 *
 * The bundle is the outermost `.app` in the path, so the main app process and
 * its helpers (which carry no bundle id of their own) resolve to the same
 * bundle. A path with no `.app` segment leaves `out` unset, so the renderer
 * keeps it as a singleton.
 */
void FillAppBundle(const std::string& executable_path, NativeAppBundle* out);

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_APP_METADATA_H_
