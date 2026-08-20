import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { defaultProfilesPath } from "./profiles.js";
import type { ProxyAuditEvent, RemoteProfile } from "./types.js";

const MAX_AUDIT_BYTES = 10 * 1024 * 1024;

export class ProxyAuditLog {
  readonly filePath: string;
  private chain = Promise.resolve();

  constructor(profile: RemoteProfile, directory = process.env.PI_REMOTE_AUDIT_DIR || path.join(path.dirname(defaultProfilesPath()), "audit")) {
    this.filePath = path.join(directory, `${profile.id}.jsonl`);
  }

  write(event: ProxyAuditEvent): void {
    const safe: ProxyAuditEvent = {
      timestamp: event.timestamp,
      host: event.host,
      ...(event.resolvedAddress ? { resolvedAddress: event.resolvedAddress } : {}),
      port: event.port,
      decision: event.decision,
      method: event.method,
      ...(event.bytesUp === undefined ? {} : { bytesUp: event.bytesUp }),
      ...(event.bytesDown === undefined ? {} : { bytesDown: event.bytesDown }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.errorCode ? { errorCode: event.errorCode } : {})
    };
    this.chain = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const info = await stat(this.filePath).catch(() => null);
      if (info && info.size >= MAX_AUDIT_BYTES) {
        const rotated = `${this.filePath}.1`;
        await rm(rotated, { force: true }).catch(() => {});
        await rename(this.filePath, rotated);
      }
      await appendFile(this.filePath, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
    }).catch(() => {
      // Audit failure is intentionally fail-isolated from live proxy traffic.
    });
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
