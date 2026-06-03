#include "processes/workspace_app_enricher.h"

#import <AppKit/AppKit.h>

#include <utility>

namespace mostats::processes {
namespace {

NativeStringSnapshot AvailableStringFromNSString(NSString* value) {
  NativeStringSnapshot snapshot;
  if (value.length == 0) {
    // A running app with no bundle id / name is a real "no value" case, not a
    // collection failure, so report NOT_APPLICABLE.
    snapshot.availability = NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE;
    return snapshot;
  }

  snapshot.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  snapshot.value = value.UTF8String;
  return snapshot;
}

// Rasterizes the app icon to a small fixed-size PNG. Returns unavailable if any
// step fails; the caller degrades only the icon, never the whole record.
NativePngImageSnapshot AvailableIconFromImage(NSImage* icon) {
  NativePngImageSnapshot snapshot;
  if (icon == nil) {
    snapshot.availability = NATIVE_AVAILABILITY_REASON_NOT_APPLICABLE;
    return snapshot;
  }

  constexpr int kIconSizePx = 32;
  NSImage* resized_icon =
      [[NSImage alloc] initWithSize:NSMakeSize(kIconSizePx, kIconSizePx)];
  [resized_icon lockFocus];
  [icon drawInRect:NSMakeRect(0, 0, kIconSizePx, kIconSizePx)
          fromRect:NSZeroRect
         operation:NSCompositingOperationSourceOver
          fraction:1.0
    respectFlipped:YES
             hints:@{NSImageHintInterpolation : @(NSImageInterpolationHigh)}];
  [resized_icon unlockFocus];

  CGImageRef cg_image = [resized_icon CGImageForProposedRect:nullptr
                                                     context:nil
                                                       hints:nil];
  if (cg_image == nullptr) {
    snapshot.availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
    return snapshot;
  }

  NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg_image];
  bitmap.size = NSMakeSize(kIconSizePx, kIconSizePx);
  NSData* data = [bitmap representationUsingType:NSBitmapImageFileTypePNG
                                      properties:@{}];
  if (data.length == 0) {
    snapshot.availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
    return snapshot;
  }

  NSString* encoded = [data base64EncodedStringWithOptions:0];
  if (encoded.length == 0) {
    snapshot.availability = NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
    return snapshot;
  }

  snapshot.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  snapshot.png_base64 = encoded.UTF8String;
  snapshot.width_px = kIconSizePx;
  snapshot.height_px = kIconSizePx;
  return snapshot;
}

}  // namespace

NativeAppMetadataByPid WorkspaceApplicationEnricher::SnapshotRunningApplications()
    const {
  NativeAppMetadataByPid metadata_by_pid;

  @autoreleasepool {
    NSArray<NSRunningApplication*>* applications =
        [[NSWorkspace sharedWorkspace] runningApplications];
    for (NSRunningApplication* application in applications) {
      NativeAppMetadataSnapshot metadata;
      metadata.bundle_identifier =
          AvailableStringFromNSString(application.bundleIdentifier);
      metadata.localized_name =
          AvailableStringFromNSString(application.localizedName);
      metadata.icon_png = AvailableIconFromImage(application.icon);
      metadata_by_pid.emplace(static_cast<int>(application.processIdentifier),
                              std::move(metadata));
    }
  }

  return metadata_by_pid;
}

}  // namespace mostats::processes
