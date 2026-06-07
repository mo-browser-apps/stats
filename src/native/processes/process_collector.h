#ifndef MOSTATS_PROCESSES_PROCESS_COLLECTOR_H_
#define MOSTATS_PROCESSES_PROCESS_COLLECTOR_H_

#include "gen/process_collector.pb.h"

namespace mostats {

/**
 * Collects the current macOS process list into the generated response.
 *
 * Inspection-only and read-only: it enumerates PIDs and reads per-process
 * identity, command name, executable path, command-line arguments, memory,
 * cumulative CPU time, thread count, and owning user, attaching an explicit
 * availability to each field. It never sends signals or performs actions
 * (process actions are main-owned and land in a later iteration), and it
 * computes no rates - the cumulative CPU counter is diffed across snapshots in
 * main.
 *
 * Sources: libproc (proc_listallpids, PROC_PIDTASKALLINFO, proc_name,
 * proc_pidpath), sysctl KERN_PROCARGS2 for arguments, and proc_pid_rusage for
 * the physical footprint. GUI app metadata/icon enrichment (NSWorkspace) is not
 * collected here; those fields stay unspecified until the list UI consumes them.
 *
 * Privacy: command-line arguments are sensitive display/search data. They are
 * returned only for local display and search - the caller must never log,
 * persist, export, auto-copy, or transmit them, and warnings carry counts only,
 * never argument values, paths, or process names.
 *
 * Always reports a result: per-field failures degrade that field rather than the
 * whole record, and a failure to enumerate at all is reported as available=false
 * with no records.
 */
void CollectProcesses(CollectProcessesResponse* response);

}  // namespace mostats

#endif  // MOSTATS_PROCESSES_PROCESS_COLLECTOR_H_
