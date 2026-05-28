// The name of the property in the window object used to communicate
// with the main process. Please don't change the value of this constant.
const MOBROWSER = '__MOBROWSER__';

type MoBrowserBridge = {
  invoke: (cmd: string, ...args: unknown[]) => unknown
}

function getMoBrowserBridge(): MoBrowserBridge | undefined {
  const candidate = window as unknown as Partial<Record<typeof MOBROWSER, MoBrowserBridge>>
  return candidate[MOBROWSER]
}

// Checks if the web page is hosted in the MoBrowser desktop app.
function isIpcSupported(): boolean {
  return getMoBrowserBridge() !== undefined;
}

// Invokes a command on the main process with the given arguments
// and returns the result. Does nothing if the web page is not
// hosted in the MoBrowser desktop app.
export function invoke<Result = unknown>(cmd: string, ...args: unknown[]): Result | undefined {
  return isIpcSupported()
    ? getMoBrowserBridge()?.invoke(cmd, ...args) as Result
    : undefined;
}
