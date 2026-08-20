import { once } from "node:events";
import { randomInt } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClientGateway, type ClientGatewayAddress } from "./gateway.js";
import { PiRemoteError } from "./errors.js";
import { SshRunner, redactDiagnostic } from "./ssh.js";
import type { ProxyAuditEvent, RemoteProfile } from "./types.js";

export interface EgressSession {
  readonly mode: "client-proxy";
  readonly proxyUrl: string;
  readonly noProxy: string[];
  readonly remotePort: number;
  readonly token: string;
  close(): Promise<void>;
}

export class EgressBroker {
  private gateway?: ClientGateway;
  private address?: ClientGatewayAddress;
  private tunnel?: ChildProcessWithoutNullStreams;
  private closing = false;
  private reconnecting?: Promise<void>;
  private remotePort = 0;

  constructor(
    private readonly profile: RemoteProfile,
    private readonly ssh: SshRunner,
    private readonly onAudit?: (event: ProxyAuditEvent) => void,
    private readonly lease?: { token: string; remotePort: number }
  ) {}

  async start(): Promise<EgressSession> {
    if (this.profile.network.mode !== "client-proxy") {
      throw new PiRemoteError("egress-mode-invalid", "EgressBroker can only start for client-proxy profiles.", { phase: "egress" });
    }
    const upstreamEnv = this.profile.network.clientProxy.upstreamProxyEnv;
    const upstreamProxy = upstreamEnv ? process.env[upstreamEnv] : undefined;
    this.gateway = new ClientGateway({
      allowedPorts: this.profile.network.clientProxy.allowedPorts,
      upstreamProxy,
      token: this.lease?.token,
      onAudit: this.onAudit
    });
    this.address = await this.gateway.start();
    if (this.lease) {
      this.remotePort = this.lease.remotePort;
      try {
        await this.openTunnel();
        return this.session();
      } catch (error) {
        await this.close();
        throw error;
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.remotePort = randomInt(49_152, 65_536);
      try {
        await this.openTunnel();
        return this.session();
      } catch (error) {
        this.closeTunnel();
        if (attempt === 4) {
          await this.close();
          throw error;
        }
      }
    }
    throw new Error("unreachable");
  }

  private session(): EgressSession {
    if (!this.address) throw new Error("gateway is not started");
    return {
      mode: "client-proxy",
      proxyUrl: `http://pi:${this.address.token}@127.0.0.1:${this.remotePort}`,
      noProxy: ["localhost", "127.0.0.1", "::1", ...this.profile.network.clientProxy.noProxy],
      remotePort: this.remotePort,
      token: this.address.token,
      close: () => this.close()
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.closeTunnel();
    await this.reconnecting?.catch(() => {});
    await this.gateway?.close();
    this.gateway = undefined;
    this.address = undefined;
  }

  private closeTunnel(): void {
    if (!this.tunnel) return;
    this.tunnel.stdin.end();
    this.tunnel.kill();
    this.tunnel = undefined;
  }

  private async openTunnel(): Promise<void> {
    if (!this.address) throw new Error("gateway is not started");
    const child = this.ssh.spawn(this.profile, "printf 'PI_REMOTE_EGRESS/1\\n'; cat >/dev/null", {
      remoteForward: { remotePort: this.remotePort, localHost: this.address.host, localPort: this.address.port }
    });
    this.tunnel = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PiRemoteError("egress-tunnel-timeout", "Timed out waiting for the SSH reverse tunnel.", { phase: "egress", retryable: true })), 10_000);
      timer.unref();
      const inspect = () => {
        if (stdout.includes("PI_REMOTE_EGRESS/1")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new PiRemoteError("remote-forwarding-disabled", "SSH reverse forwarding failed.", {
          phase: "egress",
          remediation: "Check sshd AllowTcpForwarding, DisableForwarding, and PermitListen policy.",
          safeDetails: { exitCode: code ?? 255, diagnostic: redactDiagnostic(stderr).slice(0, 400) }
        }));
      });
    });
    await ready;
    child.once("exit", () => {
      if (this.closing || this.tunnel !== child) return;
      this.tunnel = undefined;
      this.reconnecting = this.reconnectLoop();
    });
  }

  private async reconnectLoop(): Promise<void> {
    let delay = 250;
    while (!this.closing) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.closing) return;
      try {
        await this.openTunnel();
        return;
      } catch {
        this.closeTunnel();
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }
}
