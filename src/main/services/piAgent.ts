import path from "node:path";

export function getJasminePiAgentDir(userDataDir: string): string {
  return path.join(userDataDir, "pi-agent");
}
