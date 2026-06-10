#ifndef MOSTATS_PROCESSES_APP_METADATA_H_
#define MOSTATS_PROCESSES_APP_METADATA_H_

#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Maps PID -> GUI application identity (bundle id, localized name, exact bundle
 * path when appropriate) for the currently running applications.
 *
 * Backed by NSWorkspace.runningApplications, so it only covers processes that
 * macOS treats as user-facing GUI applications (Finder, Safari, Xcode, ...),
 * not every PID in the process table. The collector merges this onto matching
 * records; processes with no entry keep bundle id / localized name unset.
 *
 * Icons are NOT resolved here. The collector resolves every process's icon
 * uniformly via {@link ResolveIconForPath} from the same bundle the row groups by
 * (yielding the owning `.app` icon, identical to NSRunningApplication.icon for a
 * GUI app - verified - and the generic icon for a daemon), so there is no
 * GUI-only icon special case and the per-path icon cache covers every row.
 */
std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata();

/**
 * Resolves a small icon for an exact app/file path and returns its content-hash
 * key, borrowed from the session icon cache - or null when no icon could be
 * resolved. The pointer stays valid only until the next {@link PruneIconCache}
 * call; consume it within the same pass. The encoded bytes stay in the cache
 * and are served by key through {@link CopyIconForKey}.
 *
 * Not limited to GUI apps: a `.app` bundle path yields the app's real icon and a
 * plain executable path yields the generic system executable icon, via
 * NSWorkspace's iconForFile:. The collector passes the owning `.app` bundle when
 * the record has one (so every member of a multi-process app shares the app's
 * icon) and the bare executable path otherwise.
 *
 * The encoded icon and its content key are cached per path while the path stays
 * in use (see {@link PruneIconCache}), so a steady-state pass is a hash lookup
 * with no AppKit drawing, no PNG encode, and no re-hash. The icon is volatile
 * display-only data and is never logged or persisted.
 */
const std::string* ResolveIconForPath(const std::string& path);

/**
 * Drops cached icons whose resolution path is not in `used_paths` (the paths the
 * just-finished pass resolved icons from). Keeps the icon cache bounded by the
 * live processes: per-launch paths such as app-translocation directories would
 * otherwise accumulate for the whole session. An exited app's icon is simply
 * re-encoded once if it launches again.
 */
void PruneIconCache(const std::unordered_set<std::string>& used_paths);

/**
 * Copies the cached icon bytes for a content key (a value previously returned
 * via {@link ResolvedIcon}.content_key) into `png_base64`. Returns false when no
 * cached icon has that key - the app exited and its entry was pruned, or the key
 * was never issued; the caller omits the entry and the row falls back to a
 * generic glyph. Serves the GetIcons RPC, which can run concurrently with a
 * collection pass, so the lookup synchronizes on the icon-cache mutex.
 */
bool CopyIconForKey(const std::string& key, std::string* png_base64);

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
