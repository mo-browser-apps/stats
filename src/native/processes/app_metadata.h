#ifndef MOSTATS_PROCESSES_APP_METADATA_H_
#define MOSTATS_PROCESSES_APP_METADATA_H_

#include <cstdint>
#include <string>
#include <unordered_map>

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Maps PID -> GUI application identity (bundle id + localized name) for the
 * currently running applications.
 *
 * Backed by NSWorkspace.runningApplications, so it only covers processes that
 * macOS treats as user-facing GUI applications (Finder, Safari, Xcode, ...),
 * not every PID in the process table. The process collector merges this onto the
 * matching records; processes with no entry keep bundle id / localized name
 * unset (UNKNOWN downstream).
 *
 * It does NOT fill the icon: {@link IconForExecutablePath} resolves the icon from
 * the owning `.app` bundle for every process (the authoritative source), so an
 * icon here would only be overridden. Each field carries per-field availability,
 * marked unavailable when missing rather than faked.
 */
std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata();

/**
 * Resolves a small app icon for any process by its executable path, writing the
 * base64 PNG (or an unavailable status) into `out`.
 *
 * Unlike {@link SnapshotRunningAppMetadata}, this is not limited to GUI apps. It
 * resolves the icon from the owning `.app` bundle when the executable lives
 * inside one (a browser helper resolves to the parent app's real icon, matching
 * how the renderer groups members by their outermost `.app`), and from the
 * executable itself otherwise (a plain daemon gets the generic system icon, as
 * Activity Monitor shows), via NSWorkspace's standard iconForFile:. The collector
 * uses it as an icon-only fallback for processes that the GUI-app enrichment did
 * not cover, so naming, bundle id, and localized name are left untouched.
 *
 * Performance: the encoded icon is cached per resolution path for the session
 * (the same cache used by GUI-app icons), so all members of one app bundle share
 * a single entry and a steady-state pass is a hash lookup with no AppKit drawing
 * - a bundle/executable is rasterized and encoded at most once. The icon is
 * volatile display-only data and is never logged or persisted.
 */
void IconForExecutablePath(const std::string& executable_path, NativeImage* out);

/**
 * Fills the owning `.app` bundle (path + display name) for an executable path,
 * used to group a multi-process app's members into one list row.
 *
 * The bundle is the outermost `.app` in the path, so the main app process and
 * its helpers (which carry no bundle id of their own) resolve to the same
 * bundle. A path with no `.app` segment (a plain daemon) leaves `out` unset, so
 * grouping falls back to bundle id / name downstream. Reads only the path string
 * (no AppKit); the grouping key is identity, not presentation, so the renderer
 * just buckets by it.
 */
void FillAppBundle(const std::string& executable_path, NativeAppBundle* out);

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_APP_METADATA_H_
