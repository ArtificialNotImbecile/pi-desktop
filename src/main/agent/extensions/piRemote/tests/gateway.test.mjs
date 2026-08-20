import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ClientGateway, EgressBroker, ProxyAuditLog, isPublicAddress, pinnedHttpTarget } from "../dist/index.js";

test("public destination policy rejects local, private, metadata, documentation, and IPv6 special ranges", () => {
  for (const value of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
    "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:ffff:a00:1",
    "::a00:1", "64:ff9b::a00:1", "64:ff9b:1::a00:1", "100::1",
    "2001::1", "2001:0:a00:1::1", "2002:a00:1::1", "2001:4860:4860:0:0:5efe:a00:1",
    "3fff::1", "5f00::1", "fc00::1", "fd00:0:0:0:0:0:0:1", "fe80::1", "fec0::1", "feff::1", "ff02::1", "2001:db8::1"
  ]) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("upstream HTTP requests use the validated address while preserving the original URL path", () => {
  assert.equal(pinnedHttpTarget(new URL("http://provider.example/v1/models?q=1"), "93.184.216.34", 80), "http://93.184.216.34/v1/models?q=1");
  assert.equal(pinnedHttpTarget(new URL("http://provider.example:8080/path"), "2606:4700::1111", 8080), "http://[2606:4700::1111]:8080/path");
});

test("gateway can reuse a profile lease token and rejects weak tokens", async () => {
  assert.throws(() => new ClientGateway({ token: "short" }), /high-entropy/u);
  const token = "A".repeat(43);
  const gateway = new ClientGateway({ token });
  const address = await gateway.start();
  try { assert.equal(address.token, token); }
  finally { await gateway.close(); }
});

test("leased egress startup closes gateway and tunnel after forwarding failure", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.stdout.end(); child.stderr.end(); };
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  const broker = new EgressBroker(profile, { spawn() { queueMicrotask(() => child.emit("exit", 255, null)); return child; } }, undefined, { token: "A".repeat(43), remotePort: 50123 });
  await assert.rejects(() => broker.start(), (error) => error?.code === "remote-forwarding-disabled");
  assert.equal(broker.gateway, undefined);
  assert.equal(broker.tunnel, undefined);
});

test("lease-less egress kills every failed tunnel attempt before retrying", async () => {
  let kills = 0;
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  const broker = new EgressBroker(profile, { spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { kills += 1; child.stdout.end(); child.stderr.end(); };
    queueMicrotask(() => child.emit("exit", 255, null)); return child;
  } });
  await assert.rejects(() => broker.start(), (error) => error?.code === "remote-forwarding-disabled");
  assert.equal(kills, 5);
});

test("egress reconnect kills a failed replacement tunnel before leaving the loop", async () => {
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  let killed = false;
  const child = { stdin: { end() {} }, kill() { killed = true; } };
  const broker = new EgressBroker(profile, {});
  broker.openTunnel = async () => { broker.tunnel = child; broker.closing = true; throw new Error("fixture timeout"); };
  await broker.reconnectLoop();
  assert.equal(killed, true);
  assert.equal(broker.tunnel, undefined);
});

test("egress close during reconnect delay never opens a replacement tunnel", async () => {
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  let opens = 0;
  const broker = new EgressBroker(profile, {});
  broker.openTunnel = async () => { opens += 1; };
  const reconnecting = broker.reconnectLoop();
  broker.reconnecting = reconnecting;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await broker.close();
  assert.equal(opens, 0);
  assert.equal(broker.tunnel, undefined);
});

test("gateway client disconnects suppress or destroy CONNECT and HTTP upstreams", async () => {
  const gateway = new ClientGateway();
  const authorization = `Basic ${Buffer.from(`pi:${gateway.token}`).toString("base64")}`;

  let connectCalls = 0;
  gateway.connectSocket = () => { connectCalls += 1; throw new Error("must not connect"); };
  const earlyConnectClient = new PassThrough();
  const earlyConnect = gateway.handleConnect({
    headers: { "proxy-authorization": authorization },
    url: "8.8.8.8:443"
  }, earlyConnectClient, Buffer.alloc(0));
  earlyConnectClient.destroy();
  await earlyConnect;
  assert.equal(connectCalls, 0, "CONNECT closed during resolution must not create an upstream");

  const activeConnectClient = new PassThrough();
  const activeConnectUpstream = new PassThrough();
  activeConnectUpstream.setTimeout = () => activeConnectUpstream;
  gateway.connectSocket = () => activeConnectUpstream;
  await gateway.handleConnect({
    headers: { "proxy-authorization": authorization },
    url: "8.8.8.8:443"
  }, activeConnectClient, Buffer.alloc(0));
  activeConnectClient.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeConnectUpstream.destroyed, true, "active CONNECT upstream must follow client close");

  const originalHttpRequest = http.request;
  let httpCalls = 0;
  try {
    const earlyHttpSocket = new PassThrough();
    const earlyHttpRequest = new PassThrough();
    earlyHttpRequest.socket = earlyHttpSocket;
    earlyHttpRequest.headers = { "proxy-authorization": authorization, host: "8.8.8.8" };
    earlyHttpRequest.method = "GET";
    earlyHttpRequest.url = "http://8.8.8.8/early";
    const earlyHttpResponse = new EventEmitter();
    earlyHttpResponse.destroyed = false;
    http.request = () => { httpCalls += 1; throw new Error("must not forward"); };
    const earlyHttp = gateway.handleHttp(earlyHttpRequest, earlyHttpResponse);
    earlyHttpSocket.destroy();
    await earlyHttp;
    assert.equal(httpCalls, 0, "HTTP closed during resolution must not create an upstream");

    const activeHttpSocket = new PassThrough();
    const activeHttpRequest = new PassThrough();
    activeHttpRequest.socket = activeHttpSocket;
    activeHttpRequest.headers = { "proxy-authorization": authorization, host: "8.8.8.8" };
    activeHttpRequest.method = "GET";
    activeHttpRequest.url = "http://8.8.8.8/active";
    const activeHttpResponse = new EventEmitter();
    activeHttpResponse.destroyed = false;
    activeHttpResponse.headersSent = false;
    activeHttpResponse.writeHead = () => { activeHttpResponse.headersSent = true; };
    activeHttpResponse.end = () => {};
    const forwarded = new PassThrough();
    forwarded.setTimeout = () => forwarded;
    http.request = () => { httpCalls += 1; return forwarded; };
    await gateway.handleHttp(activeHttpRequest, activeHttpResponse);
    activeHttpSocket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forwarded.destroyed, true, "active HTTP upstream must follow requester close");
  } finally {
    http.request = originalHttpRequest;
  }
});

test("gateway requires per-session auth and denies remote attempts to pivot into localhost", async () => {
  const audits = [];
  const gateway = new ClientGateway({ onAudit: (event) => audits.push(event) });
  const address = await gateway.start();
  try {
    const unauthenticated = await rawRequest(address.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n");
    assert.match(unauthenticated, /^HTTP\/1\.1 407/u);
    const auth = Buffer.from(`pi:${address.token}`).toString("base64");
    const privateTarget = await rawRequest(address.port, `CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    assert.match(privateTarget, /^HTTP\/1\.1 403/u);
    assert.ok(audits.some((event) => event.decision === "deny" && event.host === "127.0.0.1"));
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(address.token, "u"));
  } finally {
    await gateway.close();
  }
});

test("gateway chains CONNECT through an authenticated local upstream without leaking its credential", async () => {
  let receivedHead = "";
  let upstreamSocket;
  const upstream = http.createServer();
  upstream.on("connect", (request, socket, head) => {
    upstreamSocket = socket;
    receivedHead = `${request.method} ${request.url} ${request.headers["proxy-authorization"] || ""}`;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const gateway = new ClientGateway({ upstreamProxy: `http://up:stream@127.0.0.1:${upstreamAddress.port}` });
  const address = await gateway.start();
  try {
    const auth = Buffer.from(`pi:${address.token}`).toString("base64");
    const socket = net.connect(address.port, "127.0.0.1");
    let output = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { output += chunk; });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    await waitFor(() => output.includes("200 Connection Established"));
    socket.write("PING");
    await waitFor(() => output.endsWith("PING"));
    socket.destroy();
    assert.match(receivedHead, /^CONNECT 8\.8\.8\.8:443 Basic /u);
    assert.doesNotMatch(receivedHead, /stream/u, "upstream password must not appear in diagnostics");
  } finally {
    await gateway.close();
    upstreamSocket?.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("gateway contains an asynchronous upstream CONNECT handshake failure", async () => {
  const upstream = net.createServer((socket) => socket.destroy());
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const audits = [];
  const gateway = new ClientGateway({
    upstreamProxy: `http://127.0.0.1:${upstreamAddress.port}`,
    onAudit: (event) => audits.push(event)
  });
  const address = await gateway.start();
  let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const auth = Buffer.from(`pi:${address.token}`).toString("base64");
    const output = await rawRequest(address.port, `CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    assert.match(output, /^HTTP\/1\.1 502/u);
    await waitFor(() => audits.length > 0);
    assert.equal(audits[0].decision, "deny");
    assert.equal(audits[0].errorCode, "upstream-connect-failed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await gateway.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("persistent audit log keeps only bounded metadata fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-audit-"));
  const profile = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "fixture",
    sshHost: "host",
    network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [443] } },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  try {
    const audit = new ProxyAuditLog(profile, root);
    audit.write({
      timestamp: new Date(0).toISOString(), host: "example.com", resolvedAddress: "8.8.8.8", port: 443,
      decision: "allow", method: "CONNECT", bytesUp: 10, bytesDown: 20,
      url: "https://example.com/secret?token=abc", headers: { Authorization: "secret" }, token: "secret"
    });
    await audit.flush();
    const content = await readFile(audit.filePath, "utf8");
    assert.match(content, /"host":"example.com"/u);
    assert.doesNotMatch(content, /secret|authorization|url|headers|token/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway forwards ordinary HTTP requests through the configured upstream", async () => {
  let observed = {};
  const upstream = http.createServer((request, response) => {
    observed = { url: request.url, authorization: request.headers["proxy-authorization"] };
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("UPSTREAM_HTTP_OK");
  });
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const gateway = new ClientGateway({ upstreamProxy: `http://up:stream@127.0.0.1:${upstreamAddress.port}` });
  const address = await gateway.start();
  try {
    const auth = Buffer.from(`pi:${address.token}`).toString("base64");
    const output = await httpProxyRequest(address.port, "http://8.8.8.8/test?q=1", auth);
    assert.match(output, /UPSTREAM_HTTP_OK/u);
    assert.equal(observed.url, "http://8.8.8.8/test?q=1");
    assert.match(String(observed.authorization), /^Basic /u);
    assert.doesNotMatch(JSON.stringify(observed), /stream/u);
  } finally {
    await gateway.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("gateway audits a failed ordinary HTTP forward as denied", async () => {
  const upstream = net.createServer((socket) => socket.destroy());
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const audits = [];
  const gateway = new ClientGateway({ upstreamProxy: `http://127.0.0.1:${upstreamAddress.port}`, onAudit: (event) => audits.push(event) });
  const address = await gateway.start();
  try {
    const auth = Buffer.from(`pi:${address.token}`).toString("base64");
    await httpProxyRequest(address.port, "http://8.8.8.8/test", auth);
    await waitFor(() => audits.length > 0);
    assert.equal(audits[0].decision, "deny");
    assert.equal(audits[0].errorCode, "upstream-http-failed");
  } finally {
    await gateway.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("connect", () => socket.end(payload));
    socket.once("close", () => resolve(output));
  });
}
function httpProxyRequest(port, target, authorization) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: target,
      headers: { Host: "8.8.8.8", "Proxy-Authorization": `Basic ${authorization}`, Connection: "close" }
    }, (response) => {
      let output = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { output += chunk; });
      response.once("end", () => resolve(output));
    });
    request.once("error", reject);
    request.end();
  });
}
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}
