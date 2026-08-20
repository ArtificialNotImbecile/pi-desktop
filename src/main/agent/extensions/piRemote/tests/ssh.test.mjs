import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PiRemoteError, SshRunner, redactDiagnostic, shellQuote } from "../dist/index.js";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "fixture",
  sshHost: "root@10.0.0.2",
  sshPort: 4560,
  network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

test("OpenSSH argv honors config/key auth without the Windows ConnectTimeout delay", () => {
  const runner = new SshRunner();
  const args = runner.buildArgs(profile, "true");
  assert.deepEqual(args.slice(0, 2), ["-p", "4560"]);
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("ServerAliveInterval=15"));
  assert.ok(!args.some((arg) => arg.startsWith("ConnectTimeout")), "OpenSSH_for_Windows 8.1 delays successful exits when ConnectTimeout is explicit");
  assert.deepEqual(args.slice(-2), [profile.sshHost, "true"]);
});

test("remote forwarding is explicit and is not cleared by ClearAllForwardings", () => {
  const runner = new SshRunner();
  const args = runner.buildArgs(profile, "cat >/dev/null", {
    remoteForward: { remotePort: 50123, localHost: "127.0.0.1", localPort: 41000 }
  });
  assert.ok(!args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes("127.0.0.1:50123:127.0.0.1:41000"));
});

test("POSIX shell quoting preserves literals and rejects record injection", () => {
  assert.equal(shellQuote("/tmp/it's safe"), "'/tmp/it'\"'\"'s safe'");
  assert.throws(() => shellQuote("bad\ncommand"), PiRemoteError);
});

test("diagnostic redaction removes scheme-qualified credentials", () => {
  const redacted = redactDiagnostic("Authorization: Bearer sk-secret Proxy-Authorization=Basic dXNlcjpwYXNz api_key=value");
  assert.doesNotMatch(redacted, /sk-secret|dXNlcjpwYXNz|value/u);
});

test("SSH run waits for output streams to drain after exit", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const runner = new SshRunner();
  runner.spawn = () => child;
  const pending = runner.run(profile, "fixture");
  child.emit("exit", 0, null);
  child.stdout.write("head"); child.stderr.write("warn");
  setImmediate(() => { child.stdout.end("-tail"); child.stderr.end("-tail"); child.emit("close", 0, null); });
  assert.deepEqual(await pending, { code: 0, stdout: "head-tail", stderr: "warn-tail" });
});

test("SSH run maps an asynchronous stdin EPIPE instead of emitting it uncaught", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
  child.stdin.end = () => setImmediate(() => child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  let killed = false;
  child.kill = () => {
    killed = true;
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 255, null); });
  };
  const runner = new SshRunner(); runner.spawn = () => child;
  await assert.rejects(runner.run(profile, "exit-before-input", "payload"), (error) => error?.code === "ssh-failed" && error.phase === "ssh");
  assert.equal(killed, true);
});

test("forwarding doctor waits for its marker stream to drain", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const runner = new SshRunner(); runner.spawn = () => child;
  const pending = runner.forwardingCheck(profile, 50123);
  child.emit("exit", 0, null);
  setImmediate(() => { child.stdout.end("PI_REMOTE_FORWARD/1\n"); child.stderr.end(); child.emit("close", 0, null); });
  assert.equal((await pending).status, "pass");
});
