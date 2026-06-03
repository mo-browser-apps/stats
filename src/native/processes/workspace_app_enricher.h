#ifndef MOSTATS_WORKSPACE_APP_ENRICHER_H_
#define MOSTATS_WORKSPACE_APP_ENRICHER_H_

#include "processes/native_process_types.h"

namespace mostats::processes {

// Optional NSWorkspace enrichment for GUI processes: bundle identifier,
// localized app name, and a small app icon, indexed by PID.
//
// This is the only Objective-C++ in the native module; it is isolated here so
// the rest of the collector stays plain C++. Icons are volatile display data
// only and must not be persisted or logged.
class WorkspaceApplicationEnricher {
 public:
  NativeAppMetadataByPid SnapshotRunningApplications() const;
};

}  // namespace mostats::processes

#endif  // MOSTATS_WORKSPACE_APP_ENRICHER_H_
