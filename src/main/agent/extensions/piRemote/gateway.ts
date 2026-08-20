import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { URL } from "node:url";
import { PiRemoteError } from "./errors.js";
import type { ProxyAuditEvent } from "./types.js";

export interface ClientGatewayOptions {
  allowedPorts?: number[];
  upstreamProxy?: string;
  token?: string;
  onAudit?: (event: ProxyAuditEvent) => void;
  maxConnections?: number;
  idleTimeoutMs?: number;
}

export interface ClientGatewayAddress {
  host: "127.0.0.1";
  port: number;
  token: string;
  proxyUrl: string;
}

export class ClientGateway {
  private readonly token: string;
  private readonly allowedPorts: Set<number>;
  private readonly onAudit?: (event: ProxyAuditEvent) => void;
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly upstreamProxy?: URL;
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private addressValue?: ClientGatewayAddress;

  constructor(options: ClientGatewayOptions = {}) {
    this.token = options.token ?? randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(this.token)) {
      throw new PiRemoteError("proxy-token-invalid", "Client gateway token must be a high-entropy base64url value.", { phase: "egress" });
    }
    this.allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
    this.onAudit = options.onAudit;
    this.maxConnections = options.maxConnections ?? 128;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.upstreamProxy = parseUpstreamProxy(options.upstreamProxy);
    this.server = http.createServer((request, response) => void this.handleHttp(request, response));
    this.server.on("connect", (request, socket, head) => void this.handleConnect(request, socket, head));
    this.server.on("connection", (socket) => {
      if (this.sockets.size >= this.maxConnections) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<ClientGatewayAddress> {
    if (this.addressValue) return this.addressValue;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Client gateway did not bind a TCP port");
    this.addressValue = {
      host: "127.0.0.1",
      port: address.port,
      token: this.token,
      proxyUrl: `http://pi:${this.token}@127.0.0.1:${address.port}`
    };
    return this.addressValue;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.addressValue = undefined;
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`pi:${this.token}`, "utf8").toString("base64")}`;
    return request.headers["proxy-authorization"] === expected;
  }

  private rejectAuth(response: ServerResponse | Duplex): void {
    if (!(response instanceof http.ServerResponse)) {
      response.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=pi-remote\r\nConnection: close\r\n\r\n");
    } else {
      response.writeHead(407, { "Proxy-Authenticate": "Basic realm=pi-remote", Connection: "close" });
      response.end();
    }
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const started = Date.now();
    let clientClosed = client.destroyed;
    let activeUpstream: Socket | undefined;
    client.once("close", () => {
      clientClosed = true;
      activeUpstream?.destroy();
    });
    if (!this.authorized(request)) {
      this.rejectAuth(client);
      return;
    }
    const target = parseConnectTarget(request.url || "");
    if (!target || !this.allowedPorts.has(target.port)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      this.audit({ host: target?.host ?? "invalid", port: target?.port ?? 0, decision: "deny", method: "CONNECT", errorCode: "target-not-allowed" });
      return;
    }
    try {
      const address = await resolvePublicAddress(target.host);
      if (clientClosed || client.destroyed) return;
      const upstream = this.connectSocket(address, target.port);
      activeUpstream = upstream;
      let bytesUp = head.length;
      let bytesDown = 0;
      let established = false;
      let errorCode: string | undefined;
      let handshakeSettled: Promise<void> = Promise.resolve();
      upstream.setTimeout(this.idleTimeoutMs, () => upstream.destroy());
      upstream.once("connect", () => {
        handshakeSettled = this.establishConnectTunnel(upstream, client, address, target.port, head).then((connected) => {
          established = connected;
          if (!connected) errorCode = "upstream-connect-rejected";
        }).catch((error) => {
          errorCode = error instanceof PiRemoteError ? error.code : "upstream-connect-failed";
          upstream.destroy();
          if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
      });
      client.on("data", (chunk) => { bytesUp += chunk.length; });
      upstream.on("data", (chunk) => { bytesDown += chunk.length; });
      upstream.once("error", () => {
        errorCode ??= "upstream-connect-failed";
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      client.once("error", () => upstream.destroy());
      upstream.once("close", () => {
        void handshakeSettled.then(() => this.audit({
          host: target.host, resolvedAddress: address, port: target.port, decision: established ? "allow" : "deny", method: "CONNECT",
          bytesUp, bytesDown, durationMs: Date.now() - started, ...(errorCode ? { errorCode } : {})
        }));
      });
    } catch (error) {
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      this.audit({
        host: target.host,
        port: target.port,
        decision: "deny",
        method: "CONNECT",
        durationMs: Date.now() - started,
        errorCode: error instanceof PiRemoteError ? error.code : "connect-failed"
      });
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const clientSocket = request.socket;
    let clientClosed = clientSocket.destroyed;
    let activeForward: http.ClientRequest | undefined;
    const onClientClose = () => {
      clientClosed = true;
      activeForward?.destroy();
    };
    clientSocket.once("close", onClientClose);
    response.once("close", () => clientSocket.off("close", onClientClose));
    if (!this.authorized(request)) {
      this.rejectAuth(response);
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url || "");
    } catch {
      response.writeHead(400, { Connection: "close" });
      response.end();
      return;
    }
    const port = Number(target.port || 80);
    if (target.protocol !== "http:" || !this.allowedPorts.has(port)) {
      response.writeHead(403, { Connection: "close" });
      response.end();
      this.audit({ host: target.hostname, port, decision: "deny", method: request.method || "GET", errorCode: "target-not-allowed" });
      return;
    }
    try {
      const address = await resolvePublicAddress(target.hostname);
      if (clientClosed || clientSocket.destroyed) return;
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      let bytesUp = 0;
      let bytesDown = 0;
      let errorCode: string | undefined;
      const transport = this.upstreamProxy?.protocol === "https:" ? https : http;
      if (this.upstreamProxy) {
        const authorization = proxyAuthorization(this.upstreamProxy);
        if (authorization) headers["proxy-authorization"] = authorization;
      }
      const forwarded = transport.request({
        host: this.upstreamProxy?.hostname ?? address,
        port: Number(this.upstreamProxy?.port || (this.upstreamProxy?.protocol === "https:" ? 443 : port)),
        method: request.method,
        path: this.upstreamProxy ? pinnedHttpTarget(target, address, port) : `${target.pathname}${target.search}`,
        headers
      }, (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.on("data", (chunk) => { bytesDown += chunk.length; });
        upstream.once("error", () => {
          errorCode ??= "upstream-http-response-failed";
          response.destroy();
        });
        upstream.pipe(response);
      });
      activeForward = forwarded;
      forwarded.setTimeout(this.idleTimeoutMs, () => forwarded.destroy());
      request.on("data", (chunk) => { bytesUp += chunk.length; });
      request.pipe(forwarded);
      forwarded.once("error", () => {
        errorCode ??= "upstream-http-failed";
        if (!response.headersSent) response.writeHead(502, { Connection: "close" });
        response.end();
      });
      response.once("close", () => this.audit({
        host: target.hostname, resolvedAddress: address, port, decision: errorCode ? "deny" : "allow", method: request.method || "GET",
        bytesUp, bytesDown, durationMs: Date.now() - started, ...(errorCode ? { errorCode } : {})
      }));
    } catch (error) {
      response.writeHead(403, { Connection: "close" });
      response.end();
      this.audit({
        host: target.hostname, port, decision: "deny", method: request.method || "GET",
        durationMs: Date.now() - started,
        errorCode: error instanceof PiRemoteError ? error.code : "connect-failed"
      });
    }
  }

  private audit(event: Omit<ProxyAuditEvent, "timestamp">): void {
    try {
      this.onAudit?.({ timestamp: new Date().toISOString(), ...event });
    } catch {
      // Audit observers cannot affect proxy traffic.
    }
  }

  private connectSocket(address: string, port: number): Socket {
    if (!this.upstreamProxy) return net.connect({ host: address, port });
    const proxyPort = Number(this.upstreamProxy.port || (this.upstreamProxy.protocol === "https:" ? 443 : 80));
    return this.upstreamProxy.protocol === "https:"
      ? tls.connect({ host: this.upstreamProxy.hostname, port: proxyPort, servername: this.upstreamProxy.hostname })
      : net.connect({ host: this.upstreamProxy.hostname, port: proxyPort });
  }

  private async establishConnectTunnel(upstream: Socket, client: Duplex, address: string, port: number, head: Buffer): Promise<boolean> {
    if (this.upstreamProxy) {
      const authority = isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
      const authorization = proxyAuthorization(this.upstreamProxy);
      upstream.write([
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
        "Connection: keep-alive",
        "",
        ""
      ].join("\r\n"));
      const response = await readHttpHead(upstream, 32 * 1024).catch((error) => {
        upstream.destroy();
        throw error;
      });
      if (!/^HTTP\/1\.[01]\s+2\d\d\b/u.test(response.head)) {
        upstream.destroy();
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return false;
      }
      if (response.rest.length) client.write(response.rest);
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    return true;
  }
}

export function pinnedHttpTarget(target: URL, address: string, port: number): string {
  if (target.protocol !== "http:" || !isIP(address)) {
    throw new PiRemoteError("proxy-target-invalid", "A validated IP address is required for an upstream HTTP proxy request.", { phase: "egress" });
  }
  const host = isIP(address) === 6 ? `[${address}]` : address;
  const authority = port === 80 ? host : `${host}:${port}`;
  return `http://${authority}${target.pathname}${target.search}`;
}

export async function resolvePublicAddress(hostname: string): Promise<string> {
  const literal = normalizeHostname(hostname);
  const addresses = isIP(literal)
    ? [{ address: literal }]
    : await dns.lookup(literal, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new PiRemoteError("proxy-dns-empty", `No address was found for ${hostname}.`, { phase: "egress", retryable: true });
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PiRemoteError("proxy-private-target", "Client proxy refuses private, loopback, link-local, and metadata destinations.", {
      phase: "egress",
      safeDetails: { host: hostname }
    });
  }
  return addresses[0]!.address;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  const mapped = ipv4MappedAddress(normalized);
  if (mapped) return isPublicAddress(mapped);
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b! >= 64 && b! <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b! >= 16 && b! <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && (b === 0 || b === 2 || b === 88 && c === 99)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(normalized) === 6) {
    const words = parseIpv6Words(normalized);
    if (!words) return false;
    if (words.every((value) => value === 0) || words.slice(0, 7).every((value) => value === 0) && words[7] === 1) return false;
    if ([
      { prefix: [0, 0, 0, 0, 0, 0], bits: 96 }, // deprecated IPv4-compatible form
      { prefix: [0x0064, 0xff9b, 0, 0, 0, 0], bits: 96 }, // NAT64 well-known prefix
      { prefix: [0x0064, 0xff9b, 1], bits: 48 }, // local-use NAT64 prefix
      { prefix: [0x0100, 0, 0, 0], bits: 64 }, // discard-only
      { prefix: [0x2001, 0], bits: 23 }, // IETF protocol/transition assignments, including Teredo
      { prefix: [0x2002], bits: 16 }, // 6to4
      { prefix: [0x3fff, 0], bits: 20 }, // documentation
      { prefix: [0x5f00], bits: 16 }, // segment-routing SIDs
      { prefix: [0xfc00], bits: 7 }, // unique-local
      { prefix: [0xfe80], bits: 10 }, // link-local
      { prefix: [0xfec0], bits: 10 }, // deprecated site-local
      { prefix: [0xff00], bits: 8 } // multicast
    ].some(({ prefix, bits }) => matchesIpv6Prefix(words, prefix, bits))) return false;
    if (words[5] === 0x5efe) return false; // ISATAP embeds an IPv4 destination in the interface id
    if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
    return true;
  }
  return false;
}

function matchesIpv6Prefix(words: number[], prefix: number[], bits: number): boolean {
  const completeWords = Math.floor(bits / 16);
  for (let index = 0; index < completeWords; index += 1) if (words[index] !== prefix[index]) return false;
  const remaining = bits % 16;
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (words[completeWords]! & mask) === ((prefix[completeWords] ?? 0) & mask);
}

function ipv4MappedAddress(address: string): string | undefined {
  const values = parseIpv6Words(address);
  if (!values) return undefined;
  if (values.slice(0, 5).some((value) => value !== 0) || values[5] !== 0xffff) return undefined;
  return `${values[6]! >> 8}.${values[6]! & 0xff}.${values[7]! >> 8}.${values[7]! & 0xff}`;
}

function parseIpv6Words(input: string): number[] | undefined {
  if (isIP(input) !== 6) return undefined;
  let address = input;
  const dotted = /(?:^|:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(address);
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some((value) => value < 0 || value > 255)) return undefined;
    address = address.slice(0, dotted.index + (address[dotted.index] === ":" ? 1 : 0))
      + `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const [leftRaw, rightRaw = ""] = address.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  const parts = rightRaw !== "" || address.includes("::")
    ? [...left, ...Array(Math.max(0, missing)).fill("0"), ...right]
    : left;
  if (parts.length !== 8) return undefined;
  const values = parts.map((part) => Number.parseInt(part || "0", 16));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) return undefined;
  return values;
}

function parseConnectTarget(value: string): { host: string; port: number } | null {
  const match = /^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/u.exec(value);
  if (!match) return null;
  const host = match[1] || match[3];
  const port = Number(match[2] || match[4]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function normalizeHostname(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseUpstreamProxy(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new PiRemoteError("upstream-proxy-invalid", "Configured client-side upstream proxy URL is invalid.", { phase: "egress", cause: error }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiRemoteError("upstream-proxy-invalid", "Client-side upstream proxy must use http or https.", { phase: "egress" });
  }
  return url;
}

function proxyAuthorization(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, "utf8").toString("base64")}`;
}

function readHttpHead(socket: Socket, maxBytes: number): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        cleanup();
        reject(new Error("Upstream proxy response headers exceeded the limit"));
        return;
      }
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      resolve({ head: buffer.subarray(0, boundary + 4).toString("latin1"), rest: buffer.subarray(boundary + 4) });
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Upstream proxy closed during CONNECT")); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
