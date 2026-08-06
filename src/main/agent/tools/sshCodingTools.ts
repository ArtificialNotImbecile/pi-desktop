import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations
} from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { sshExec, sshExecWithStatus } from "../../services/remoteConnections.js";
import type { RemoteConnectionRecord as JasmineRemoteConnection } from "../../../shared/ipc.js";

export function createSshCodingTools(input: {
  connection: JasmineRemoteConnection;
  localCwd: string;
  remoteCwd: string;
}): ToolDefinition[] {
  const { connection, localCwd, remoteCwd } = input;
  return [
    createReadTool(localCwd, { operations: createRemoteReadOps(connection, remoteCwd, localCwd) }),
    createWriteTool(localCwd, { operations: createRemoteWriteOps(connection, remoteCwd, localCwd) }),
    createEditTool(localCwd, { operations: createRemoteEditOps(connection, remoteCwd, localCwd) }),
    createBashTool(localCwd, { operations: createRemoteBashOps(connection, remoteCwd, localCwd) })
  ];
}

function createRemoteReadOps(connection: JasmineRemoteConnection, remoteCwd: string, localCwd: string): ReadOperations {
  return {
    readFile: (p) => sshExec(connection, `cat ${quote(toRemotePath(p, remoteCwd, localCwd))}`),
    access: (p) => sshExec(connection, `test -r ${quote(toRemotePath(p, remoteCwd, localCwd))}`).then(() => undefined),
    detectImageMimeType: async (p) => {
      try {
        const output = await sshExec(connection, `file --mime-type -b ${quote(toRemotePath(p, remoteCwd, localCwd))}`);
        const mimeType = output.toString("utf8").trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
      } catch {
        return null;
      }
    }
  };
}

function createRemoteWriteOps(connection: JasmineRemoteConnection, remoteCwd: string, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await sshExec(connection, `echo ${quote(b64)} | base64 -d > ${quote(toRemotePath(p, remoteCwd, localCwd))}`);
    },
    mkdir: (dir) => sshExec(connection, `mkdir -p ${quote(toRemotePath(dir, remoteCwd, localCwd))}`).then(() => undefined)
  };
}

function createRemoteEditOps(connection: JasmineRemoteConnection, remoteCwd: string, localCwd: string): EditOperations {
  const readOps = createRemoteReadOps(connection, remoteCwd, localCwd);
  const writeOps = createRemoteWriteOps(connection, remoteCwd, localCwd);
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile
  };
}

function createRemoteBashOps(connection: JasmineRemoteConnection, remoteCwd: string, localCwd: string): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      sshExecWithStatus(connection, `cd ${quote(toRemotePath(cwd, remoteCwd, localCwd))} && ${command}`, {
        signal,
        timeoutMs: timeout ? timeout * 1000 : undefined,
        onData
      }).then((result) => ({ exitCode: result.exitCode }))
  };
}

function toRemotePath(value: string, remoteCwd: string, localCwd: string): string {
  const normalized = value.replace(/\\/g, "/");
  const normalizedLocal = localCwd.replace(/\\/g, "/");
  if (normalized.startsWith(remoteCwd)) return normalized;
  if (normalized.startsWith(normalizedLocal)) {
    const suffix = normalized.slice(normalizedLocal.length).replace(/^\/+/, "");
    return suffix ? `${remoteCwd.replace(/\/+$/, "")}/${suffix}` : remoteCwd;
  }
  return normalized;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
