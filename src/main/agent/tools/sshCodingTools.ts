import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations
} from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { access as accessLocalFile, readFile as readLocalFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sshExec, sshExecWithStatus } from "../../services/remoteConnections.js";
import type { RemoteConnectionRecord as JasmineRemoteConnection } from "../../../shared/ipc.js";

export function createSshCodingTools(input: {
  connection: JasmineRemoteConnection;
  localCwd: string;
  remoteCwd: string;
  localResourcePaths?: string[];
}): ToolDefinition[] {
  const { connection, localCwd, remoteCwd, localResourcePaths = [] } = input;
  const localResourceRoots = localResourcePaths.map(localResourceRoot);
  return [
    createReadTool(localCwd, { operations: createRemoteReadOps(connection, remoteCwd, localCwd, localResourceRoots) }),
    createWriteTool(localCwd, { operations: createRemoteWriteOps(connection, remoteCwd, localCwd) }),
    createEditTool(localCwd, { operations: createRemoteEditOps(connection, remoteCwd, localCwd) }),
    createBashTool(localCwd, { operations: createRemoteBashOps(connection, remoteCwd, localCwd) })
  ];
}

function createRemoteReadOps(connection: JasmineRemoteConnection, remoteCwd: string, localCwd: string, localResourceRoots: string[] = []): ReadOperations {
  return {
    readFile: async (p) => isLocalSkillResource(p, localResourceRoots)
      ? readLocalFile(await assertCanonicalLocalResource(p, localResourceRoots))
      : sshExec(connection, `cat ${quote(toRemotePath(p, remoteCwd, localCwd))}`),
    access: async (p) => isLocalSkillResource(p, localResourceRoots)
      ? accessLocalFile(await assertCanonicalLocalResource(p, localResourceRoots))
      : sshExec(connection, `test -r ${quote(toRemotePath(p, remoteCwd, localCwd))}`).then(() => undefined),
    detectImageMimeType: async (p) => {
      if (isLocalSkillResource(p, localResourceRoots)) return null;
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

function localResourceRoot(resourcePath: string): string {
  return path.basename(resourcePath).toLowerCase() === "skill.md" ? path.dirname(resourcePath) : resourcePath;
}

function isLocalSkillResource(candidate: string, roots: string[]): boolean {
  const normalizedCandidate = normalizeLocalPath(candidate);
  return roots.some((root) => {
    const normalizedRoot = normalizeLocalPath(root);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

async function assertCanonicalLocalResource(candidate: string, roots: string[]): Promise<string> {
  const canonicalCandidate = await realpath(candidate);
  for (const root of roots) {
    const canonicalRoot = await canonicalResourceRoot(root);
    if (isLocalSkillResource(canonicalCandidate, [canonicalRoot])) return canonicalCandidate;
  }
  throw new Error("Local skill resource resolves outside its configured directory.");
}

async function canonicalResourceRoot(root: string): Promise<string> {
  const entry = await stat(root).catch(() => null);
  if (entry?.isDirectory()) return realpath(root);
  return realpath(path.dirname(root));
}

function normalizeLocalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
