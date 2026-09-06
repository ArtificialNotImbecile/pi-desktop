/**
 * Electron wraps a rejection that crosses `ipcRenderer.invoke` as
 * "Error invoking remote method 'channel': ErrorName: message". The channel and
 * the class name describe plumbing, not what went wrong, so what the user reads
 * is the message the main process actually raised.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/u;

export function errorMessage(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const message = caught.message.replace(IPC_WRAPPER, "").trim();
  return message || fallback;
}
