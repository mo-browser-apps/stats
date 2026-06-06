import { TextDisclosure } from "@/components/processes/disclosure";
import type { DetailCommandLine } from "@/domain/process-detail";

/**
 * The detail view's command-line block: a compact disclosure row that expands
 * to the process's arguments in a readable wrapping, scrollable region. It is a
 * thin specialization of {@link TextDisclosure} with command-line-specific
 * labels.
 *
 * Command-line text is sensitive local debugging data. It is shown and copied
 * only on explicit user action and is never logged, persisted, or auto-copied.
 * Copy is routed through main (the renderer is sandboxed and cannot reach the
 * clipboard); main writes it to the user's clipboard and never logs it.
 */
export function CommandLineBlock({ commandLine }: { commandLine: DetailCommandLine }) {
  const value = commandLine.state === "ok" ? (commandLine.text ?? "") : undefined;

  return (
    <TextDisclosure
      label="Command line"
      value={value}
      state={commandLine.state}
      copyLabel="Copy command line"
      emptyText="No arguments"
      pendingText="..."
    />
  );
}
