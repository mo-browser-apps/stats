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

// Session cache of encoded icons, keyed by a stable per-app identity (bundle id,
// else executable path). Rasterizing an NSImage and PNG/base64-encoding it is by
// far the most expensive step of an enrichment pass, and an app's icon does not
// change while it runs, so caching the encoded string lets a steady-state
// collection skip the draw/encode entirely and only pay for the NSWorkspace
// enumeration. Bounded by the number of distinct apps seen this session.
//
// Threading: enrichment runs only from the process collector, which the RPC
// layer invokes serially on the native main thread (one collection at a time),
// so this map needs no lock. The icon is volatile display data and is never
// logged or persisted.
std::unordered_map<std::string, std::string>& IconCache() {
  static std::unordered_map<std::string, std::string> cache;
  return cache;
}

// Stable cache key for an app's icon: the bundle identifier when present, else
// the executable path, else empty (which disables caching for that app).
std::string IconCacheKey(NSRunningApplication* application) {
  NSString* bundle_id = application.bundleIdentifier;
  if (bundle_id.length > 0) {
    return bundle_id.UTF8String;
  }
  NSString* path = application.executableURL.path;
  if (path.length > 0) {
    return path.UTF8String;
  }
  return std::string();
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

}  // namespace

void IconForExecutablePath(const std::string& executable_path,
                           NativeImage* out) {
  if (executable_path.empty()) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  // Fast path: the encoded icon is cached per executable path, so a steady-state
  // pass (every process already seen) is a hash lookup with no AppKit work at
  // all. Only the first time a given executable is seen do we resolve+encode.
  // Measured on a ~600-process machine: a fully warm pass is well under 1 ms,
  // while a cold resolve+encode is the only real cost and happens once per path.
  if (IconCache().count(executable_path) == 0) {
    @autoreleasepool {
      NSString* path = [NSString stringWithUTF8String:executable_path.c_str()];
      // iconForFile: never returns nil: a bundled app yields its real icon, and
      // a plain executable yields the generic Unix-executable icon (the same
      // thing Activity Monitor shows), so this raises icon coverage well beyond
      // the GUI-app-only NSWorkspace enrichment without any private API.
      NSImage* icon = path == nil
                          ? nil
                          : [[NSWorkspace sharedWorkspace] iconForFile:path];
      FillIcon(out, icon, executable_path);
      return;
    }
  }

  FillIcon(out, /*icon=*/nil, executable_path);
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
      FillIcon(metadata.mutable_icon_png(), application.icon,
               IconCacheKey(application));
      by_pid.emplace(static_cast<int32_t>(application.processIdentifier),
                     std::move(metadata));
    }
  }

  return by_pid;
}

}  // namespace mostats
