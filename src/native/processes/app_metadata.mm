#include "processes/app_metadata.h"

#import <AppKit/AppKit.h>

#include <string>
#include <utility>

namespace mostats {
namespace {

// Icon edge length in points. Small on purpose: the icon is volatile display
// data sent on every snapshot pull, and the list renders it tiny, so a 32 px
// PNG keeps the payload light while staying crisp at typical row sizes.
constexpr int kIconSizePx = 32;

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

// Renders an app icon to a small base64-encoded PNG. Any failure along the way
// (no icon, no CGImage, empty PNG) degrades the field to unavailable rather than
// emitting a broken payload. The icon is volatile display data and is not logged.
void FillIcon(NativeImage* out, NSImage* icon) {
  if (icon == nil) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
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
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  NSBitmapImageRep* bitmap =
      [[NSBitmapImageRep alloc] initWithCGImage:cg_image];
  [bitmap setSize:NSMakeSize(kIconSizePx, kIconSizePx)];
  NSData* png =
      [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (png.length == 0) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  NSString* encoded = [png base64EncodedStringWithOptions:0];
  if (encoded.length == 0) {
    out->set_status(NATIVE_FIELD_STATUS_UNAVAILABLE);
    return;
  }

  out->set_status(NATIVE_FIELD_STATUS_AVAILABLE);
  out->set_png_base64(encoded.UTF8String);
}

}  // namespace

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
      FillIcon(metadata.mutable_icon_png(), application.icon);
      by_pid.emplace(static_cast<int32_t>(application.processIdentifier),
                     std::move(metadata));
    }
  }

  return by_pid;
}

}  // namespace mostats
