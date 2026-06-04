#include "processes/app_metadata.h"

#import <AppKit/AppKit.h>

#include <string>
#include <unordered_map>
#include <utility>

namespace mostats {
namespace {

// Icon edge length in points. Small on purpose: the icon is volatile display
// data sent on every snapshot pull, and the list renders it tiny, so a 32 px
// PNG keeps the payload light while staying crisp at typical row sizes.
constexpr int kIconSizePx = 32;

// Session cache of encoded icons, keyed by the icon resolution path (the owning
// `.app` bundle, else the executable). Rasterizing an NSImage and
// PNG/base64-encoding it is by far the most expensive step, and an app's icon
// does not change while it runs, so caching the encoded string lets a
// steady-state collection skip the draw/encode entirely. Keying on the `.app`
// bundle means all members of a multi-process app share one entry. Bounded by
// the number of distinct bundles/executables seen this session.
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
      [[NSImage alloc] initWithSize:NSMakeSize(kIconSizePx, kIconSizePx)];
  [resized lockFocus];
  [icon drawInRect:NSMakeRect(0, 0, kIconSizePx, kIconSizePx)
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
  [bitmap setSize:NSMakeSize(kIconSizePx, kIconSizePx)];
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

// Fills the icon field from an NSImage, reusing the session cache so a given
// icon is rasterized and encoded at most once per session. On a cache hit the
// field is filled from the stored base64 with no drawing. A successful first
// encode is cached; a failed encode degrades the field to unavailable and is not
// cached, so a transiently missing icon can still resolve on a later pass. The
// cache key must be stable for the icon (bundle id / executable path).
void FillIcon(NativeImage* out, NSImage* icon, const std::string& cache_key) {
  if (!cache_key.empty()) {
    const auto cached = IconCache().find(cache_key);
    if (cached != IconCache().end()) {
      out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
      out->set_png_base64(cached->second);
      return;
    }
  }

  const std::string encoded = EncodeIconBase64(icon);
  if (encoded.empty()) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  if (!cache_key.empty()) {
    IconCache().emplace(cache_key, encoded);
  }
  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_png_base64(encoded);
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

AppBundle AppBundleForPath(const std::string& executable_path) {
  constexpr char kAppSuffix[] = ".app/";
  constexpr std::string::size_type kAppLen = sizeof(kAppSuffix) - 2;  // ".app"
  const std::string::size_type slash = executable_path.find(kAppSuffix);
  if (slash == std::string::npos) {
    return {};
  }
  const std::string path = executable_path.substr(0, slash + kAppLen);
  const std::string::size_type name_start = path.rfind('/');
  const std::string base =
      name_start == std::string::npos ? path : path.substr(name_start + 1);
  const std::string name = base.substr(0, base.size() - kAppLen);  // drop ".app"
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
  out->mutable_path()->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->mutable_path()->set_value(bundle.path);
  out->mutable_name()->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->mutable_name()->set_value(bundle.name);
}

void IconForExecutablePath(const std::string& executable_path,
                           NativeImage* out) {
  if (executable_path.empty()) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  // Resolve from the owning `.app` bundle (real app icon) when there is one, else
  // the executable itself (generic system icon). The cache is keyed on this
  // resolution path, so all members of one app bundle share a single entry.
  const AppBundle bundle = AppBundleForPath(executable_path);
  const std::string& resolution_path =
      bundle.path.empty() ? executable_path : bundle.path;

  // Fast path: the encoded icon is cached per resolution path, so a steady-state
  // pass (every bundle/executable already seen) is a hash lookup with no AppKit
  // work at all. Only the first time a given bundle/executable is seen do we
  // resolve+encode. Measured on a ~600-process machine: a fully warm pass is well
  // under 1 ms, while a cold resolve+encode is the only real cost, once per path.
  if (IconCache().count(resolution_path) == 0) {
    @autoreleasepool {
      NSString* path =
          [NSString stringWithUTF8String:resolution_path.c_str()];
      // iconForFile: never returns nil: a `.app` bundle yields its real icon, and
      // a plain executable yields the generic Unix-executable icon (the same
      // thing Activity Monitor shows), so this raises icon coverage well beyond
      // the GUI-app-only NSWorkspace enrichment without any private API.
      NSImage* icon = path == nil
                          ? nil
                          : [[NSWorkspace sharedWorkspace] iconForFile:path];
      FillIcon(out, icon, resolution_path);
      return;
    }
  }

  FillIcon(out, /*icon=*/nil, resolution_path);
}

std::unordered_map<int32_t, NativeAppMetadata> SnapshotRunningAppMetadata() {
  std::unordered_map<int32_t, NativeAppMetadata> by_pid;

  @autoreleasepool {
    NSArray<NSRunningApplication*>* applications =
        [[NSWorkspace sharedWorkspace] runningApplications];
    by_pid.reserve(applications.count);

    for (NSRunningApplication* application in applications) {
      // Identity only (bundle id + localized name). The icon is NOT encoded here:
      // the collector resolves it from the owning `.app` bundle via
      // IconForExecutablePath, which is the authoritative source and would
      // override anything set here, so encoding it now would be wasted work.
      NativeAppMetadata metadata;
      FillString(metadata.mutable_bundle_identifier(),
                 application.bundleIdentifier);
      FillString(metadata.mutable_localized_name(), application.localizedName);
      by_pid.emplace(static_cast<int32_t>(application.processIdentifier),
                     std::move(metadata));
    }
  }

  return by_pid;
}

}  // namespace mostats
