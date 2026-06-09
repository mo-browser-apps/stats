#include "processes/app_metadata.h"

#import <AppKit/AppKit.h>

#include <iterator>
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

// Session cache of encoded icons, keyed by the icon resolution path (the owning
// `.app` bundle, else the executable). Rasterizing an NSImage and
// PNG/base64-encoding it is by far the most expensive step, and an app's icon
// does not change while it runs, so caching the encoded string lets a
// steady-state collection skip the draw/encode entirely. Keying on the `.app`
// bundle means all members of a multi-process app share one entry. Pruned each
// pass to the paths still in use (see PruneIconCache), so it is bounded by the
// live processes rather than every path ever seen.
//
// Threading: the cache is touched only from the process collector, which the RPC
// layer invokes serially on the native main thread (one collection at a time),
// so this map needs no lock. The icon is volatile display data and is never
// logged or persisted.
std::unordered_map<std::string, std::string>& IconCache() {
  static std::unordered_map<std::string, std::string> cache;
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

void IconForFilePath(const std::string& path, NativeImage* out) {
  if (path.empty()) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  // Fast path: the encoded icon is cached per resolution path, so a steady-state
  // pass (every bundle/executable already seen) is a hash lookup with no AppKit
  // work at all. Only the first time a given bundle/executable is seen do we
  // resolve+encode. Measured on a ~600-process machine: a fully warm pass is well
  // under 1 ms, while a cold resolve+encode is the only real cost, once per path.
  auto& cache = IconCache();
  const auto cached = cache.find(path);
  if (cached != cache.end()) {
    out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
    out->set_png_base64(cached->second);
    return;
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
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_png_base64(encoded);
  cache.emplace(path, std::move(encoded));
}

void PruneIconCache(const std::unordered_set<std::string>& used_paths) {
  auto& cache = IconCache();
  for (auto it = cache.begin(); it != cache.end();) {
    it = used_paths.count(it->first) == 0 ? cache.erase(it) : std::next(it);
  }
}

std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata() {
  std::unordered_map<int32_t, NativeAppMetadata> by_pid;

  @autoreleasepool {
    NSArray<NSRunningApplication*>* applications =
        [[NSWorkspace sharedWorkspace] runningApplications];
    by_pid.reserve(applications.count);

    for (NSRunningApplication* application in applications) {
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
      by_pid.emplace(static_cast<int32_t>(application.processIdentifier),
                     std::move(metadata));
    }
  }

  return by_pid;
}

}  // namespace mostats
