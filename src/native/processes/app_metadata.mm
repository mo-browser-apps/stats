#include "processes/app_metadata.h"

#import <AppKit/AppKit.h>

#include <cstdint>
#include <cstdio>
#include <iterator>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace mostats {
namespace {

// Icon edge length in points (the offscreen raster scales with the screen's
// backing factor, so Retina yields a 64 px bitmap). Small on purpose: the icon
// is volatile display data sent on every snapshot pull, and the list renders it
// tiny, so this keeps the payload light while staying crisp at row sizes.
constexpr int kIconSizePoints = 32;

// One cached icon: the encoded PNG and its content-hash key for the response's
// dedup table. The key is computed once at encode time so a steady-state pass
// neither re-encodes nor re-hashes.
struct CachedIcon {
  std::string png_base64;
  std::string content_key;
};

// Session cache of encoded icons, keyed by the icon resolution path (the owning
// `.app` bundle, else the executable). Rasterizing an NSImage and
// PNG/base64-encoding it is by far the most expensive step, and an app's icon
// does not change while it runs, so caching the encoded string lets a
// steady-state collection skip the draw/encode entirely. Keying on the `.app`
// bundle means all members of a multi-process app share one entry. Pruned each
// pass to the paths still in use (see PruneIconCache), so it is bounded by the
// live processes rather than every path ever seen.
//
// Threading: unlike the other session caches (touched only by the serial
// collector), this one has a second entry point - the GetIcons RPC reads it by
// content key (CopyIconForKey) and can run concurrently with a collection pass.
// Every access therefore takes IconCacheMutex(). The icon is volatile display
// data and is never logged or persisted.
std::unordered_map<std::string, CachedIcon>& IconCache() {
  static std::unordered_map<std::string, CachedIcon> cache;
  return cache;
}

// Guards IconCache() against the concurrent GetIcons reader (see above).
std::mutex& IconCacheMutex() {
  static std::mutex mutex;
  return mutex;
}

// Content key for an icon's base64 bytes: 64-bit FNV-1a as hex. Non-cryptographic
// is fine - the key only has to collapse identical icons to one table entry and
// tell different ones apart. A collision would at worst show one wrong icon;
// nothing crashes. Computed once per encode and cached alongside the bytes.
std::string IconContentKey(const std::string& base64) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (const unsigned char byte : base64) {
    hash ^= byte;
    hash *= 0x100000001b3ULL;
  }
  char out[17];
  std::snprintf(out, sizeof(out), "%016llx",
                static_cast<unsigned long long>(hash));
  return std::string(out, 16);
}

// One cached NSWorkspace metadata entry, guarded by the app's launch time (the
// same pid+started_at identity discipline the rest of the app uses): a
// different launch time for the same PID means the PID was reused and the entry
// must be re-read. 0 stands in for a nil launchDate. Pointer identity is NOT
// usable as a guard - runningApplications vends fresh autoreleased wrapper
// instances per call (measured: a pointer-guarded cache never hit).
struct CachedAppMetadata {
  double launched_at;
  NativeAppMetadata metadata;
};

// Per-PID cache of NSWorkspace app metadata. The bridged property reads
// (bundleIdentifier, localizedName, bundleURL) cost ~12-15 ms per pass for ~50
// apps - by far the dominant share of the NSWorkspace snapshot - while the
// values themselves are fixed for an app instance's lifetime, so each app is
// read once (plus the cheap pid/launchDate reads per pass) and served from
// here afterwards. Pruned each pass to the apps actually running. Known
// accepted staleness: an app that flips its activation policy after first
// sight keeps its cached bundle-path visibility; grouping still works through
// the executable-path bundle, so nothing user-visible breaks. Threading:
// serial collector contract, same as the other caches.
std::unordered_map<int32_t, CachedAppMetadata>& AppMetadataCache() {
  static std::unordered_map<int32_t, CachedAppMetadata> cache;
  return cache;
}

// Fills a NativeString from an NSString, marking it unavailable when empty so an
// absent value is never confused with a real empty string.
void FillString(NativeString* out, NSString* value) {
  if (value.length == 0) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }
  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_value(value.UTF8String);
}

// Rasterizes an app icon to a small base64-encoded PNG string, or returns an
// empty string on any failure (no icon, no CGImage, empty PNG/encode). This is
// the expensive step (offscreen draw + PNG + base64); the caller caches the
// result so a steady-state pass does not repeat it. The icon is not logged.
std::string EncodeIconBase64(NSImage* icon) {
  if (icon == nil) {
    return std::string();
  }

  NSImage* resized =
      [[NSImage alloc] initWithSize:NSMakeSize(kIconSizePoints, kIconSizePoints)];
  [resized lockFocus];
  [icon drawInRect:NSMakeRect(0, 0, kIconSizePoints, kIconSizePoints)
          fromRect:NSZeroRect
         operation:NSCompositingOperationSourceOver
          fraction:1.0
    respectFlipped:YES
             hints:@{NSImageHintInterpolation : @(NSImageInterpolationHigh)}];
  [resized unlockFocus];

  CGImageRef cg_image =
      [resized CGImageForProposedRect:nullptr context:nil hints:nil];
  if (cg_image == nullptr) {
    return std::string();
  }

  NSBitmapImageRep* bitmap =
      [[NSBitmapImageRep alloc] initWithCGImage:cg_image];
  [bitmap setSize:NSMakeSize(kIconSizePoints, kIconSizePoints)];
  NSData* png =
      [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (png.length == 0) {
    return std::string();
  }

  NSString* encoded = [png base64EncodedStringWithOptions:0];
  if (encoded.length == 0) {
    return std::string();
  }
  return encoded.UTF8String;
}

// The owning `.app` bundle of an executable path: the outermost `.app` segment.
// A multi-process app nests every member inside its `.app` (the main process at
// `<App>.app/Contents/MacOS/<App>`, helpers at deeper `.../<Helper>.app/...`
// paths), so matching the first `.app` groups all members under the parent app.
// Returns empty strings for a path with no `.app` (a plain daemon).
struct AppBundle {
  std::string path;  // up to and including the outermost `.app`, or empty
  std::string name;  // bundle basename without `.app`, or empty
};

std::string AppNameFromBundlePath(const std::string& bundle_path) {
  constexpr char kAppExtension[] = ".app";
  constexpr std::string::size_type kAppLen = sizeof(kAppExtension) - 1;
  const std::string::size_type name_start = bundle_path.rfind('/');
  const std::string base = name_start == std::string::npos
                               ? bundle_path
                               : bundle_path.substr(name_start + 1);
  if (base.size() <= kAppLen ||
      base.compare(base.size() - kAppLen, kAppLen, kAppExtension) != 0) {
    return {};
  }
  return base.substr(0, base.size() - kAppLen);
}

void FillBundle(const std::string& bundle_path, NativeAppBundle* out) {
  const std::string name = AppNameFromBundlePath(bundle_path);
  if (name.empty()) {
    return;
  }
  out->mutable_path()->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->mutable_path()->set_value(bundle_path);
  out->mutable_name()->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->mutable_name()->set_value(name);
}

AppBundle AppBundleForPath(const std::string& executable_path) {
  constexpr char kAppSuffix[] = ".app/";
  constexpr std::string::size_type kAppLen = sizeof(kAppSuffix) - 2;  // ".app"
  const std::string::size_type slash = executable_path.find(kAppSuffix);
  if (slash == std::string::npos) {
    return {};
  }
  const std::string path = executable_path.substr(0, slash + kAppLen);
  const std::string name = AppNameFromBundlePath(path);
  if (name.empty()) {
    return {};  // A segment literally named ".app" is not a real bundle.
  }
  return {path, name};
}

}  // namespace

void FillAppBundle(const std::string& executable_path, NativeAppBundle* out) {
  const AppBundle bundle = AppBundleForPath(executable_path);
  if (bundle.path.empty()) {
    return;  // Not inside a `.app`; leave the bundle unset (UNKNOWN downstream).
  }
  FillBundle(bundle.path, out);
}

ResolvedIcon ResolveIconForPath(const std::string& path) {
  if (path.empty()) {
    return ResolvedIcon{};
  }

  // Fast path: the encoded icon is cached per resolution path, so a steady-state
  // pass (every bundle/executable already seen) is a hash lookup with no AppKit
  // work at all. Only the first time a given bundle/executable is seen do we
  // resolve+encode+hash. Measured on a ~700-process machine: a fully warm pass is
  // well under 1 ms, while a cold resolve+encode is the only real cost, per path.
  //
  // The returned pointers stay valid across the unlocked encode below and until
  // PruneIconCache: only the collector thread mutates the map, and unordered_map
  // insertions never invalidate element pointers. The lock only orders this
  // thread's find/emplace against the concurrent CopyIconForKey reader.
  auto& cache = IconCache();
  {
    const std::lock_guard<std::mutex> lock(IconCacheMutex());
    const auto cached = cache.find(path);
    if (cached != cache.end()) {
      return ResolvedIcon{&cached->second.png_base64,
                          &cached->second.content_key};
    }
  }

  std::string encoded;
  @autoreleasepool {
    NSString* file_path = [NSString stringWithUTF8String:path.c_str()];
    // iconForFile: never returns nil: a `.app` bundle yields its real icon, and
    // a plain executable yields the generic Unix-executable icon (the same
    // thing Activity Monitor shows), so this raises icon coverage well beyond
    // the GUI-app-only NSWorkspace enrichment without any private API.
    NSImage* icon = file_path == nil
                        ? nil
                        : [[NSWorkspace sharedWorkspace] iconForFile:file_path];
    encoded = EncodeIconBase64(icon);
  }

  if (encoded.empty()) {
    // A failed resolve/encode is left uncached so a transiently missing icon
    // can still resolve on a later pass.
    return ResolvedIcon{};
  }

  CachedIcon entry;
  entry.content_key = IconContentKey(encoded);
  entry.png_base64 = std::move(encoded);
  const std::lock_guard<std::mutex> lock(IconCacheMutex());
  const auto inserted = cache.emplace(path, std::move(entry)).first;
  return ResolvedIcon{&inserted->second.png_base64,
                      &inserted->second.content_key};
}

void PruneIconCache(const std::unordered_set<std::string>& used_paths) {
  const std::lock_guard<std::mutex> lock(IconCacheMutex());
  auto& cache = IconCache();
  for (auto it = cache.begin(); it != cache.end();) {
    it = used_paths.count(it->first) == 0 ? cache.erase(it) : std::next(it);
  }
}

bool CopyIconForKey(const std::string& key, std::string* png_base64) {
  if (key.empty()) {
    return false;
  }

  // Linear scan: the cache is keyed by resolution path, not content key, and is
  // bounded by the live process set (~hundreds of entries). GetIcons is called
  // only for keys the renderer does not hold yet (first pull, newly seen apps),
  // so a scan per requested key is cheaper than maintaining a second
  // key-indexed map that PruneIconCache would have to keep in sync.
  const std::lock_guard<std::mutex> lock(IconCacheMutex());
  for (const auto& entry : IconCache()) {
    if (entry.second.content_key == key) {
      *png_base64 = entry.second.png_base64;
      return true;
    }
  }
  return false;
}

std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata() {
  std::unordered_map<int32_t, NativeAppMetadata> by_pid;

  @autoreleasepool {
    NSArray<NSRunningApplication*>* applications =
        [[NSWorkspace sharedWorkspace] runningApplications];
    by_pid.reserve(applications.count);
    auto& cache = AppMetadataCache();

    for (NSRunningApplication* application in applications) {
      const int32_t pid = static_cast<int32_t>(application.processIdentifier);
      NSDate* launch_date = application.launchDate;
      const double launched_at =
          launch_date == nil ? 0 : launch_date.timeIntervalSince1970;

      // Metadata is fixed per app instance; serve it from the per-PID cache and
      // pay the expensive bridged reads (bundleIdentifier, localizedName,
      // bundleURL) only the first time an app is seen. The launch time guards
      // PID reuse: a different launch time re-reads.
      const auto cached = cache.find(pid);
      if (cached != cache.end() && cached->second.launched_at == launched_at) {
        by_pid.emplace(pid, cached->second.metadata);
        continue;
      }

      NativeAppMetadata metadata;
      FillString(metadata.mutable_bundle_identifier(),
                 application.bundleIdentifier);
      FillString(metadata.mutable_localized_name(), application.localizedName);
      // Icon is resolved by the collector from the executable path (uniformly for
      // GUI apps and daemons), not here - so NSRunningApplication.icon is never
      // touched. Only the cheap identity fields come from NSWorkspace.
      if (application.activationPolicy !=
          NSApplicationActivationPolicyProhibited) {
        NSString* bundle_path = application.bundleURL.path;
        if (bundle_path.length > 0) {
          FillBundle(bundle_path.UTF8String, metadata.mutable_bundle());
        }
      }
      cache[pid] = CachedAppMetadata{launched_at, metadata};
      by_pid.emplace(pid, std::move(metadata));
    }

    // Drop cache entries for apps no longer running, so the cache tracks only
    // the live set (same prune discipline as the other session caches).
    for (auto it = cache.begin(); it != cache.end();) {
      it = by_pid.count(it->first) == 0 ? cache.erase(it) : std::next(it);
    }
  }

  return by_pid;
}

}  // namespace mostats
