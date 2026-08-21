import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import {
  EgressBroker,
  ManagedRemoteRuntime,
  ProfileStore,
  SshRunner,
  loadLocalPiModelConfig,
  shellQuote
} from "../dist/index.js";

const host = requiredEnv("PI_REMOTE_E2E_HOST");
const port = Number(process.env.PI_REMOTE_E2E_PORT || 22);
const packageRoot = path.resolve(import.meta.dirname, "..");
const localRoot = await mkdtemp(path.join(os.tmpdir(), "pi-remote-live-"));
const configPath = path.join(localRoot, "profiles.json");
const previousConfig = process.env.PI_REMOTE_CONFIG_PATH;
process.env.PI_REMOTE_CONFIG_PATH = configPath;
if (process.env.PI_REMOTE_E2E_UPSTREAM_PROXY) process.env.PI_REMOTE_LIVE_UPSTREAM_PROXY = process.env.PI_REMOTE_E2E_UPSTREAM_PROXY;
const ticket = randomBytes(8).toString("hex");
const remoteCwd = process.env.PI_REMOTE_E2E_CWD || `/tmp/pi-remote-live-${ticket}`;
if (!remoteCwd.startsWith("/") || /[\0\r\n]/u.test(remoteCwd)) throw new Error("PI_REMOTE_E2E_CWD must be an absolute POSIX path");
const remoteCwdQuoted = shellQuote(remoteCwd);
const remoteRoot = `/tmp/pi-remote-runtime-${ticket}`;
const remoteRootQuoted = shellQuote(remoteRoot);
const httpHost = process.env.PI_REMOTE_E2E_HTTP_HOST || host.replace(/^.*@/u, "");
const store = new ProfileStore(configPath);
const manager = new ManagedRemoteRuntime();
const results = [];

let direct;
let proxy;
let proxyLlm;
let llmUpstream;
let previousArtifactSha;
let nativePiBaseline = "";
let completed = false;

try {
  llmUpstream = await startLlmUpstreamProxy();
  process.env.PI_REMOTE_LLM_UPSTREAM_PROXY = llmUpstream.url;
  direct = await store.add({ name: `live-${ticket}`, sshHost: host, sshPort: port, defaultCwd: remoteCwd, remoteRoot });
  proxy = await store.add({
    name: `live-proxy-${ticket}`,
    sshHost: host,
    sshPort: port,
    defaultCwd: remoteCwd,
    remoteRoot,
    networkMode: "client-proxy",
    ...(process.env.PI_REMOTE_E2E_UPSTREAM_PROXY ? { upstreamProxyEnv: "PI_REMOTE_LIVE_UPSTREAM_PROXY" } : {})
  });
  proxyLlm = await store.add({
    name: `live-proxy-llm-${ticket}`,
    sshHost: host,
    sshPort: port,
    defaultCwd: remoteCwd,
    remoteRoot,
    networkMode: "client-proxy",
    upstreamProxyEnv: "PI_REMOTE_LLM_UPSTREAM_PROXY"
  });
  nativePiBaseline = await nativePiSnapshot(direct);
  assert((await manager.doctor(direct)).ok, "direct doctor");
  assert((await manager.doctor(proxy)).ok, "proxy doctor");
  results.push("doctor");

  const freshProbe = await manager.ssh.run(direct, `test ! -e ${shellQuote(`${remoteRoot}/current`)}`);
  assert(freshProbe.code === 0, "acceptance root starts without a managed runtime");
  const [info, proxyInfo, proxyLlmInfo] = await Promise.all([
    manager.ensureRuntime(direct),
    manager.ensureRuntime(proxy),
    manager.ensureRuntime(proxyLlm)
  ]);
  assert(info.piVersion === "0.84.2", "runtime version");
  assert(proxyInfo.artifactSha256 === info.artifactSha256 && proxyLlmInfo.artifactSha256 === info.artifactSha256,
    "concurrent first connections reuse the same content-addressed runtime");
  const installedCurrent = await manager.ssh.run(direct, `readlink -f ${shellQuote(`${remoteRoot}/current`)}`);
  assert(installedCurrent.stdout.trim().endsWith(info.artifactSha256), "first connection installs and selects the bundled runtime");
  results.push("first-connect-install");
  results.push("runtime-install-concurrency");
  const noNode = await manager.ssh.run(direct, `env PATH=/usr/bin:/bin ${shellQuote(`${info.remoteRoot}/runtimes/${info.artifactSha256}/pi/pi`)} --version`);
  assert(noNode.code === 0 && noNode.stdout.trim() === "0.84.2", "runtime starts with system Node removed from PATH");
  results.push("no-remote-node");
  const corruptDir = path.join(localRoot, "corrupt-artifact");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(corruptDir, { recursive: true }));
  await writeFile(path.join(corruptDir, "corrupt.tar.gz"), "not-a-runtime", "utf8");
  await writeFile(path.join(corruptDir, "artifact.json"), JSON.stringify({
    version: 1, platform: "linux", arch: "x64", libcMinimum: "2.27", runtimeVersion: "0.1.1", piVersion: "0.84.2",
    archive: "corrupt.tar.gz", archiveSha256: "0".repeat(64)
  }), "utf8");
  let corruptRejected = false;
  try { await new ManagedRemoteRuntime({ artifactDirectory: corruptDir }).ensureRuntime(direct); }
  catch (error) { corruptRejected = error?.code === "runtime-artifact-hash-mismatch"; }
  assert(corruptRejected, "corrupt local artifact rejected before SSH upload");
  const currentAfterCorruption = await manager.ssh.run(direct, `readlink -f ${shellQuote(`${info.remoteRoot}/current`)}`);
  assert(currentAfterCorruption.stdout.trim().endsWith(info.artifactSha256), "corrupt artifact did not change remote current runtime");
  results.push("artifact-rollback");
  results.push("offline-install");

  await manager.ssh.run(direct, `mkdir -p ${remoteCwdQuoted} && chmod 700 ${remoteCwdQuoted}`);
  await manager.putFile(direct, path.join(packageRoot, "tests", "fixtures", "mock_openai.py"), `${remoteCwd}/mock_openai.py`, true);
  const downloadedFixture = path.join(localRoot, "mock_openai.roundtrip.py");
  await manager.getFile(direct, `${remoteCwd}/mock_openai.py`, downloadedFixture, true);
  assert((await readFile(downloadedFixture)).equals(await readFile(path.join(packageRoot, "tests", "fixtures", "mock_openai.py"))), "file download roundtrip");
  const largeFixture = path.join(localRoot, "large-fixture.bin");
  const largeFixtureBytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  await writeFile(largeFixture, largeFixtureBytes);
  await manager.putFile(direct, largeFixture, `${remoteCwd}/large-fixture.bin`, true);
  const downloadedLargeFixture = path.join(localRoot, "large-fixture.roundtrip.bin");
  await manager.getFile(direct, `${remoteCwd}/large-fixture.bin`, downloadedLargeFixture, true);
  assert((await readFile(downloadedLargeFixture)).equals(largeFixtureBytes), "large file download drains stdout before rename");
  const syncAgentDir = path.join(localRoot, "sync-agent");
  await mkdir(syncAgentDir);
  await writeFile(path.join(syncAgentDir, "models.json"), await readFile(path.join(packageRoot, "tests", "fixtures", "models.json")));
  await writeFile(path.join(syncAgentDir, "settings.json"), JSON.stringify({
    ...JSON.parse(await readFile(path.join(packageRoot, "tests", "fixtures", "settings.json"), "utf8")),
    packages: ["C:\\local-only-package"], skills: ["C:\\local-only-skill"], theme: "local-only-theme"
  }));
  await writeFile(path.join(syncAgentDir, "auth.json"), JSON.stringify({ "fixture-provider": { type: "api_key", key: "live-fixture-secret" } }));
  const configSync = runCliCommand(["config", "sync", direct.name, "--from-agent-dir", syncAgentDir, "--yes", "--json"]);
  assert(configSync.status === 0 && configSync.stdout.includes('"providerCount":1'), `CLI model config sync: ${configSync.stderr}`);
  const portableConfig = await loadLocalPiModelConfig(syncAgentDir);
  await manager.syncModelConfig(proxy, portableConfig);

  const proxyLlmAgentDir = path.join(localRoot, "proxy-llm-agent");
  await mkdir(proxyLlmAgentDir);
  await writeFile(path.join(proxyLlmAgentDir, "models.json"), JSON.stringify(clientProxyLlmModels()));
  await writeFile(path.join(proxyLlmAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "client-proxy-mock", defaultModel: "mock", defaultThinkingLevel: "off" }));
  await manager.syncModelConfig(proxyLlm, await loadLocalPiModelConfig(proxyLlmAgentDir));
  const remotePortableSettings = await manager.ssh.run(direct, `cat ${shellQuote(`${info.profileRoot}/agent/settings.json`)}`);
  assert(remotePortableSettings.code === 0 && !/local-only|packages|skills|theme/u.test(remotePortableSettings.stdout), "config sync excludes local packages, skills, and theme paths");
  results.push("local-model-config-sync");
  await writeFile(path.join(syncAgentDir, "settings.json"), "{}\n");
  const clearedConfig = loadLocalPiModelConfig(syncAgentDir);
  await manager.syncModelConfig(direct, await clearedConfig);
  const clearedRemoteSettings = JSON.parse((await manager.ssh.run(direct, `cat ${shellQuote(`${info.profileRoot}/agent/settings.json`)}`)).stdout);
  assert(!Object.hasOwn(clearedRemoteSettings, "defaultProvider")
    && !Object.hasOwn(clearedRemoteSettings, "defaultModel")
    && !Object.hasOwn(clearedRemoteSettings, "defaultThinkingLevel"), "config resync clears portable defaults removed from the local source");
  results.push("local-model-default-clear");
  await writeFile(path.join(syncAgentDir, "settings.json"), await readFile(path.join(packageRoot, "tests", "fixtures", "settings.json")));
  await manager.syncModelConfig(direct, await loadLocalPiModelConfig(syncAgentDir));

  const authSync = runCliCommand(["auth", "import", direct.name, "--provider", "fixture-provider", "--from-agent-dir", syncAgentDir, "--yes", "--json"]);
  assert(authSync.status === 0 && !authSync.stdout.includes("live-fixture-secret") && !authSync.stderr.includes("live-fixture-secret"), `CLI credential import: ${authSync.stderr}`);
  assert((await manager.authList(direct)).some((entry) => entry.provider === "fixture-provider"), "selected local provider credential imported into isolated profile");
  results.push("local-provider-import");

  if (process.env.PI_REMOTE_E2E_PREVIOUS_GIT_REF) {
    const previousArtifactDir = await materializeGitArtifact(process.env.PI_REMOTE_E2E_PREVIOUS_GIT_REF, localRoot);
    const previousManager = new ManagedRemoteRuntime({ artifactDirectory: previousArtifactDir });
    const configHashBefore = await manager.ssh.run(direct, `sha256sum ${shellQuote(`${info.profileRoot}/agent/models.json`)} ${shellQuote(`${info.profileRoot}/agent/settings.json`)}`);
    const previousInfo = await previousManager.ensureRuntime(direct);
    previousArtifactSha = previousInfo.artifactSha256;
    assert(previousInfo.artifactSha256 !== info.artifactSha256, "upgrade fixture uses a distinct content-addressed runtime");
    const upgradedInfo = await manager.ensureRuntime(direct);
    const configHashAfter = await manager.ssh.run(direct, `sha256sum ${shellQuote(`${info.profileRoot}/agent/models.json`)} ${shellQuote(`${info.profileRoot}/agent/settings.json`)}`);
    const upgradedCurrent = await manager.ssh.run(direct, `readlink -f ${shellQuote(`${remoteRoot}/current`)}`);
    assert(upgradedInfo.artifactSha256 === info.artifactSha256 && upgradedCurrent.stdout.trim().endsWith(info.artifactSha256), "next connection automatically selects the package artifact update");
    assert(configHashBefore.stdout === configHashAfter.stdout, "runtime update preserves profile model configuration");
    await manager.ssh.run(direct, `rm -rf -- ${shellQuote(`${remoteRoot}/runtimes/${previousInfo.artifactSha256}`)}`);
    results.push("runtime-auto-upgrade");
  }

  const startMock = await manager.ssh.run(direct, [
    `cd ${remoteCwdQuoted}`,
    "if test -f mock.pid && kill -0 $(cat mock.pid) 2>/dev/null; then kill $(cat mock.pid); fi",
    "nohup python3 ./mock_openai.py >mock.stdout 2>mock.stderr </dev/null & echo $! >mock.pid",
    "sleep 1",
    "curl -fsS http://127.0.0.1:18080/v1/models >/dev/null"
  ].join("; "));
  assert(startMock.code === 0, `mock provider: ${startMock.stderr}`);
  results.push("file-transfer");

  await manager.stop(direct).catch(() => {});
  const concurrentDaemonClients = await Promise.all([manager.listSessions(direct), manager.listSessions(direct)]);
  assert(concurrentDaemonClients.length === 2, "concurrent first clients serialize daemon startup");
  results.push("daemon-start-concurrency");

  const first = await manager.openSession(direct, { cwd: remoteCwd });
  const firstId = await first.createSession(remoteCwd);
  const firstText = collectText(first);
  const firstSettled = waitForAgentEnd(first);
  await first.prompt("live-headless");
  await firstSettled;
  assert(firstText.value.includes("REMOTE_MOCK_OK"), "headless streamed reply");
  const directRequests = await readRemoteMockRequests(direct);
  const directRequest = directRequests.find((entry) => JSON.stringify(entry.body?.messages || []).includes("live-headless"));
  assert(directRequest?.client === "127.0.0.1", "remote-direct LLM request terminates at the provider from the Linux host");
  results.push("llm-remote-direct");

  const checkPackageManagers = process.env.PI_REMOTE_E2E_SKIP_PACKAGES !== "1";
  if (checkPackageManagers) {
    const directPackages = await first.bash([
      `mkdir -p ${shellQuote(`${remoteCwd}/direct-pip`)} ${shellQuote(`${remoteCwd}/direct-npm`)} ${shellQuote(`${remoteCwd}/direct-apt`)} ${shellQuote(`${remoteCwd}/direct-apt-cache/partial`)}`,
      `python3 -m pip install --disable-pip-version-check --no-cache-dir --no-deps --target ${shellQuote(`${remoteCwd}/direct-pip`)} idna==2.10 >/dev/null && echo PIP_DIRECT_OK || echo PIP_DIRECT_FAILED`,
      `(cd ${shellQuote(`${remoteCwd}/direct-npm`)} && npm_config_cache=${shellQuote(`${remoteCwd}/direct-npm-cache`)} npm install --prefer-online --ignore-scripts --no-audit --no-fund is-number@7.0.0 >/dev/null) && echo NPM_DIRECT_OK || echo NPM_DIRECT_FAILED`,
      `(cd ${shellQuote(`${remoteCwd}/direct-apt`)} && apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Dir::Cache::archives=${shellQuote(`${remoteCwd}/direct-apt-cache`)} download cowsay >/dev/null) && echo APT_DIRECT_OK || echo APT_DIRECT_FAILED`
    ].join("\n"));
    for (const marker of ["PIP_DIRECT_OK", "NPM_DIRECT_OK", "APT_DIRECT_OK"]) {
      assert(String(directPackages.output).includes(marker), `${marker}: ${String(directPackages.output).slice(-4000)}`);
    }
    results.push("package-manager-remote-direct");
  }

  const serviceMarker = `PI_REMOTE_LINUX_SERVICE_${ticket}`;
  const serviceSource = [
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    "from socketserver import ThreadingMixIn",
    "class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):",
    "    daemon_threads = True",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    `        body = b\"${serviceMarker}\"`,
    "        self.send_response(200)",
    "        self.send_header('Content-Length', str(len(body)))",
    "        self.end_headers()",
    "        self.wfile.write(body)",
    "    def log_message(self, *_): pass",
    "ThreadingHTTPServer(('0.0.0.0', 4553), Handler).serve_forever()",
    ""
  ].join("\n");
  const linuxService = await first.bash([
    `printf %s ${shellQuote(Buffer.from(serviceSource).toString("base64"))} | base64 -d > ${shellQuote(`${remoteCwd}/linux_service.py`)}`,
    `if test -f ${shellQuote(`${remoteCwd}/service.pid`)}; then kill $(cat ${shellQuote(`${remoteCwd}/service.pid`)}) 2>/dev/null || true; fi`,
    `nohup python3 ${shellQuote(`${remoteCwd}/linux_service.py`)} >${shellQuote(`${remoteCwd}/service.log`)} 2>&1 </dev/null & echo $! >${shellQuote(`${remoteCwd}/service.pid`)}`,
    `for n in 1 2 3 4 5; do curl -fsS http://127.0.0.1:4553/ && break; sleep 1; done`,
    "printf '\nOS='; uname -s; printf ' PROC='; test -r /proc/version && echo yes"
  ].join("\n"));
  assert(String(linuxService.output).includes(serviceMarker) && String(linuxService.output).includes("OS=Linux") && String(linuxService.output).includes("PROC=yes"), `Pi bash runs on Linux and starts the Python service: ${JSON.stringify(linuxService)}`);
  assert((await waitForHttp(`http://${httpHost}:4553/`, 10_000)).includes(serviceMarker), "client reaches the Pi-started Linux HTTP service on port 4553");
  results.push("linux-python-service");

  await first.close({ abort: false });
  results.push("headless-stream");

  const resumedManager = new ManagedRemoteRuntime();
  const resumedFirst = await resumedManager.openSession(direct, { sessionId: firstId });
  const historyBefore = await resumedFirst.getTree();
  assert(JSON.stringify(historyBefore).includes("live-headless"), "new client process restores prior session history");
  assert(collectStopReasons(historyBefore).includes("stop"), "completed session history records stopReason=stop");
  const resumedText = collectText(resumedFirst);
  const resumedSettled = waitForAgentEnd(resumedFirst);
  await resumedFirst.prompt("history-check");
  await resumedSettled;
  assert(resumedText.value.includes("REMOTE_HISTORY_RESUMED"), "resumed turn receives prior history as model context");
  const historyAfter = JSON.stringify(await resumedFirst.getTree());
  assert(historyAfter.includes("live-headless") && historyAfter.includes("history-check"), "resumed session displays old and new turns");
  await resumedFirst.close({ abort: false });
  results.push("session-history-resume");

  const sessionsWithoutCwd = await manager.listSessions({ ...direct, defaultCwd: undefined });
  assert(sessionsWithoutCwd.some((session) => session.id === firstId), "sessions list does not require cwd or start RPC");
  results.push("sessions-list-no-cwd");

  const interrupted = await manager.openSession(direct, { cwd: remoteCwd });
  const interruptedId = await interrupted.createSession(remoteCwd);
  const started = waitForRaw(interrupted, "agent_start");
  await interrupted.prompt("disconnect-survival");
  await started;
  interrupted.client.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const unstableReattach = await manager.openSession(direct, { cwd: remoteCwd, sessionId: interruptedId });
  unstableReattach.client.close();
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const reattached = await manager.openSession(direct, { cwd: remoteCwd, sessionId: interruptedId });
  const interruptedTree = await reattached.getTree();
  const interruptedJson = JSON.stringify(interruptedTree);
  assert(interruptedJson.includes("REMOTE_DISCONNECT_SURVIVED"), "unexpected disconnect survival");
  assert(countOccurrences(interruptedJson, "disconnect-survival") === 1, "network reconnect never replays the prompt");
  assert(collectStopReasons(interruptedTree).includes("stop"), "turn completed during repeated disconnects persists stopReason=stop");
  await reattached.close({ abort: false });
  results.push("rpc-reconnect", "network-instability-no-replay", "disconnect-stop-reason");

  const activeFirst = await manager.openSession(direct, { sessionId: firstId });
  let leaseConflict = false;
  try { await manager.openSession(direct, { sessionId: interruptedId }); }
  catch (error) { leaseConflict = error?.code === "rpc-lease-conflict"; }
  assert(leaseConflict, "a second connected client cannot steal an idle RPC child");
  activeFirst.client.close();
  const switchedSession = await manager.openSession(direct, { sessionId: interruptedId });
  const switchedTree = JSON.stringify(await switchedSession.getTree());
  assert(switchedTree.includes("REMOTE_DISCONNECT_SURVIVED") && !switchedTree.includes("live-headless"), "RPC child switches to the requested session");
  await switchedSession.close({ abort: false });
  results.push("rpc-session-switch", "rpc-client-lease");

  const explicitlyStopped = await manager.openSession(direct, { cwd: remoteCwd });
  const stoppedId = await explicitlyStopped.createSession(remoteCwd);
  const userPersisted = new Promise((resolve) => {
    const unsubscribe = explicitlyStopped.subscribe((event) => {
      const raw = event.type === "rpc.message" ? event.data : undefined;
      if (raw?.type === "message_end" && raw.message?.role === "user") { unsubscribe(); resolve(raw); }
    });
  });
  await explicitlyStopped.prompt("disconnect-survival");
  await userPersisted;
  await manager.stop(direct);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const stoppedVerifier = await manager.openSession(direct, { cwd: remoteCwd, sessionId: stoppedId });
  const stoppedTree = await stoppedVerifier.getTree();
  assert(!JSON.stringify(stoppedTree).includes("REMOTE_DISCONNECT_SURVIVED"), "explicit stop aborted active turn");
  assert(collectStopReasons(stoppedTree).some((reason) => reason === "aborted" || reason === "error"), "explicit stop persists an interrupted stop reason");
  await stoppedVerifier.close({ abort: false });
  results.push("explicit-stop");

  const proxyLlmPort = await manager.openSession(proxyLlm, { cwd: remoteCwd });
  await proxyLlmPort.createSession(remoteCwd);
  const proxyLlmText = collectText(proxyLlmPort);
  const proxyLlmSettled = waitForAgentEnd(proxyLlmPort);
  await proxyLlmPort.prompt("client-proxy-llm");
  await proxyLlmSettled;
  assert(proxyLlmText.value.includes("CLIENT_PROXY_LLM_OK"), "Pi LLM request succeeds through client-proxy");
  await proxyLlmPort.close({ abort: false });
  assert(llmUpstream.requests.some((request) => request.host === "example.com" && JSON.stringify(request.body?.messages || []).includes("client-proxy-llm")), "local upstream observed the proxied Pi LLM request");
  const proxyLlmAudit = await readAuditEvents(proxyLlm.id);
  assert(proxyLlmAudit.some((event) => event.host === "example.com" && event.decision === "allow" && Number(event.bytesUp) > 0), "client gateway audit proves LLM bytes traversed the connecting machine");
  results.push("llm-client-proxy", "llm-client-egress-proof");

  const leaseCommand = manager.hostCommand(proxy, proxyInfo, ["egress", "lease"]);
  const concurrentLeases = await Promise.all([
    manager.ssh.run(proxy, leaseCommand),
    manager.ssh.run(proxy, leaseCommand)
  ]);
  assert(concurrentLeases.every((result) => result.code === 0) && concurrentLeases[0].stdout === concurrentLeases[1].stdout,
    "concurrent clients receive the same locked egress lease");
  results.push("egress-lease-concurrency");

  const proxyPort = await manager.openSession(proxy, { cwd: remoteCwd });
  if (checkPackageManagers) {
    const bash = await proxyPort.bash(publicCurlProbe());
    assert(String(bash.output).includes("Example Domain"), "runtime bash proxy inheritance");
  }
  if (checkPackageManagers) {
    const packages = await proxyPort.bash([
      `mkdir -p ${shellQuote(`${remoteCwd}/pkg-pip`)} ${shellQuote(`${remoteCwd}/pkg-npm`)} ${shellQuote(`${remoteCwd}/pkg-apt`)} ${shellQuote(`${remoteCwd}/pkg-apt-cache/partial`)}`,
      `python3 -m pip install --disable-pip-version-check --no-cache-dir --no-deps --target ${shellQuote(`${remoteCwd}/pkg-pip`)} idna==2.10 >/dev/null && echo PIP_PROXY_OK || echo PIP_PROXY_FAILED`,
      `(cd ${shellQuote(`${remoteCwd}/pkg-npm`)} && npm_config_cache=${shellQuote(`${remoteCwd}/pkg-npm-cache`)} npm install --prefer-online --ignore-scripts --no-audit --no-fund is-number@7.0.0 >/dev/null) && echo NPM_PROXY_OK || echo NPM_PROXY_FAILED`,
      `(cd ${shellQuote(`${remoteCwd}/pkg-apt`)} && pi-remote-net apt -o Dir::Cache::archives=${shellQuote(`${remoteCwd}/pkg-apt-cache`)} download cowsay >/dev/null) && echo APT_PROXY_OK || echo APT_PROXY_FAILED`
    ].join("\n"));
    for (const marker of ["PIP_PROXY_OK", "NPM_PROXY_OK", "APT_PROXY_OK"]) {
      assert(String(packages.output).includes(marker), `${marker} through runtime proxy: ${String(packages.output).slice(-4000)}`);
    }
    results.push("package-manager-proxy");
  }
  await proxyPort.close({ abort: false });
  const leasePath = `${proxyInfo.profileRoot}/egress.json`;
  const leaseHashBefore = await manager.ssh.run(proxy, `sha256sum ${shellQuote(leasePath)} | cut -d ' ' -f1`);
  const resumedProxyPort = await manager.openSession(proxy, { cwd: remoteCwd });
  if (checkPackageManagers) {
    const resumedBash = await resumedProxyPort.bash(publicCurlProbe());
    assert(String(resumedBash.output).includes("Example Domain"), "client restart reused remote runtime proxy lease");
  }
  await resumedProxyPort.close({ abort: false });
  const leaseHashAfter = await manager.ssh.run(proxy, `sha256sum ${shellQuote(leasePath)} | cut -d ' ' -f1`);
  assert(leaseHashBefore.stdout.trim() && leaseHashBefore.stdout.trim() === leaseHashAfter.stdout.trim(), "egress lease remains stable across client restart");
  results.push("client-proxy-restart");
  if (checkPackageManagers) {
    const auditEvents = await readAuditEvents(proxy.id);
    const auditText = JSON.stringify(auditEvents);
    assert(!/authorization|token=|fixture-key-not-secret/iu.test(auditText), "proxy audit redaction");
    assert(auditEvents.some((event) => /pypi|pythonhosted/iu.test(event.host) && event.decision === "allow"), "pip registry traffic traversed the client gateway");
    assert(auditEvents.some((event) => /npmjs/iu.test(event.host) && event.decision === "allow"), "npm registry traffic traversed the client gateway");
    assert(auditEvents.some((event) => /ubuntu|launchpad|aliyun/iu.test(event.host) && event.decision === "allow"),
      `apt archive traffic traversed the client gateway; allow hosts=${JSON.stringify([...new Set(auditEvents.filter((event) => event.decision === "allow").map((event) => event.host))])}`);
    results.push("package-manager-client-egress-proof");
  }
  if (checkPackageManagers) {
    const broker = new EgressBroker(proxy, new SshRunner());
    const egress = await broker.start();
    try {
      const publicResult = await manager.ssh.run(proxy, "sh -s", `env -i PATH=/usr/bin:/bin HTTPS_PROXY='${egress.proxyUrl}' https_proxy='${egress.proxyUrl}' sh -c ${shellQuote(publicCurlProbe(true))}`);
      assert(publicResult.code === 0, "public proxy");
      const denied = await manager.ssh.run(proxy, "sh -s", `env -i PATH=/usr/bin:/bin HTTP_PROXY='${egress.proxyUrl}' http_proxy='${egress.proxyUrl}' curl -fsS --max-time 5 http://127.0.0.1:18080 >/dev/null 2>&1`);
      assert(denied.code !== 0, "private proxy denial");
      broker.tunnel.kill();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const recovered = await manager.ssh.run(proxy, "sh -s", `env -i PATH=/usr/bin:/bin HTTPS_PROXY='${egress.proxyUrl}' https_proxy='${egress.proxyUrl}' sh -c ${shellQuote(publicCurlProbe(true))}`);
      assert(recovered.code === 0, "proxy reconnect");
    } finally {
      await egress.close();
    }
  }
  results.push("client-proxy");

  assert(!(await manager.authList(proxy)).some((entry) => entry.provider === "fixture-provider"), "profile credential isolation");
  await manager.authRemove(direct, "fixture-provider");
  results.push("credential-isolation");

  const parityManaged = await manager.openSession(direct, { cwd: remoteCwd });
  await parityManaged.createSession(remoteCwd);
  const parityManagedSettled = waitForAgentEnd(parityManaged);
  await parityManaged.prompt(`parity-managed-${ticket}`);
  await parityManagedSettled;
  await parityManaged.close({ abort: false });
  await runRawPiPrompt(direct, info, `parity-direct-${ticket}`);
  const parityRequests = await readRemoteMockRequests(direct);
  const managedParityRequest = parityRequests.find((entry) => JSON.stringify(entry.body?.messages || []).includes(`parity-managed-${ticket}`));
  const directParityRequest = parityRequests.find((entry) => JSON.stringify(entry.body?.messages || []).includes(`parity-direct-${ticket}`));
  assert(managedParityRequest && directParityRequest, "managed and raw Pi parity requests reached the provider");
  assert(JSON.stringify(requestContext(managedParityRequest.body, `parity-managed-${ticket}`)) === JSON.stringify(requestContext(directParityRequest.body, `parity-direct-${ticket}`)),
    "pi-remote adds no model prompt or tool behavior beyond raw Pi CLI");
  results.push("pi-cli-request-parity");

  if (process.env.PI_REMOTE_E2E_TUI !== "0") {
    await manager.stop(direct).catch(() => {});
    await nativeTuiSessionHistory(direct.name, firstId);
    results.push("native-tui-session-resume");
    await manager.stop(direct).catch(() => {});
    await nativeTuiRpcConflict(direct);
    results.push("cross-mode-lease");
    await manager.stop(direct).catch(() => {});
    await nativeTuiRoundtrip(direct.name, "live-tui", "REMOTE_MOCK_OK");
    results.push("native-tui");
    await manager.stop(proxy).catch(() => {});
    await nativeTuiReconnect(proxy.name, checkPackageManagers);
    results.push("native-tui-reconnect");
    results.push("native-tui-conflict");
  }

  assert(await nativePiSnapshot(direct) === nativePiBaseline, "native ~/.pi remained unchanged");
  results.push("native-pi-isolation");
  completed = true;
  process.stdout.write(`${JSON.stringify({ ok: true, results, directProfile: direct.id, proxyProfile: proxy.id, sessionIds: [firstId, interruptedId, stoppedId] }, null, 2)}\n`);
} finally {
  if (direct) {
    await manager.stop(direct).catch(() => {});
    const mockPid = shellQuote(`${remoteCwd}/mock.pid`);
    const servicePid = shellQuote(`${remoteCwd}/service.pid`);
    const cleanup = `if test -f ${mockPid}; then kill $(cat ${mockPid}) 2>/dev/null || true; fi; if test -f ${servicePid}; then kill $(cat ${servicePid}) 2>/dev/null || true; fi${/^\/tmp\/pi-remote-live-[a-f0-9]+$/u.test(remoteCwd) ? `; rm -rf -- ${remoteCwdQuoted}` : ""}`;
    await manager.ssh.run(direct, cleanup).catch(() => {});
  }
  if (proxy) await manager.stop(proxy).catch(() => {});
  if (proxyLlm) await manager.stop(proxyLlm).catch(() => {});
  if (direct && /^\/tmp\/pi-remote-runtime-[a-f0-9]+$/u.test(remoteRoot)) await manager.ssh.run(direct, `rm -rf -- ${remoteRootQuoted}`).catch(() => {});
  await llmUpstream?.close().catch(() => {});
  delete process.env.PI_REMOTE_LLM_UPSTREAM_PROXY;
  if (previousConfig === undefined) delete process.env.PI_REMOTE_CONFIG_PATH;
  else process.env.PI_REMOTE_CONFIG_PATH = previousConfig;
  await rm(localRoot, { recursive: true, force: true });
}
if (completed) process.exit(0);

function runCliCommand(args) {
  const cli = path.join(packageRoot, "dist", "cli.js");
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, PI_REMOTE_CONFIG_PATH: configPath, TERM: "xterm-256color" },
    encoding: "utf8",
    timeout: 120_000
  });
}

async function materializeGitArtifact(ref, root) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(ref)) throw new Error("PI_REMOTE_E2E_PREVIOUS_GIT_REF is invalid");
  const relativeRoot = "src/main/agent/extensions/piRemote/runtime/linux-x64-glibc";
  const output = path.join(root, "previous-artifact");
  await mkdir(output);
  const descriptorResult = spawnSync("git", ["show", `${ref}:${relativeRoot}/artifact.json`], { cwd: path.resolve(packageRoot, "../../../../.."), encoding: "utf8" });
  if (descriptorResult.status !== 0) throw new Error(`Unable to read previous artifact descriptor: ${descriptorResult.stderr}`);
  const descriptor = JSON.parse(descriptorResult.stdout);
  const archiveResult = spawnSync("git", ["show", `${ref}:${relativeRoot}/${descriptor.archive}`], {
    cwd: path.resolve(packageRoot, "../../../../.."), encoding: "buffer", maxBuffer: 128 * 1024 * 1024
  });
  if (archiveResult.status !== 0) throw new Error(`Unable to read previous runtime archive: ${String(archiveResult.stderr)}`);
  await writeFile(path.join(output, "artifact.json"), descriptorResult.stdout);
  await writeFile(path.join(output, descriptor.archive), archiveResult.stdout);
  return output;
}

function clientProxyLlmModels() {
  return {
    providers: {
      "client-proxy-mock": {
        baseUrl: "http://example.com/v1",
        api: "openai-completions",
        apiKey: "fixture-key-not-secret",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: "mock", name: "Client Proxy Mock", reasoning: false, input: ["text", "image"],
          contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }]
      }
    }
  };
}

async function startLlmUpstreamProxy() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* assertion below reports the missing request */ }
    requests.push({ host: String(request.headers.host || ""), method: request.method, url: request.url, body });
    if (request.method !== "POST" || request.headers.host !== "example.com") {
      response.writeHead(502, { Connection: "close" }); response.end(); return;
    }
    const events = [
      { id: "chatcmpl-client-proxy", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "CLIENT_PROXY_LLM_OK" }, finish_reason: null }] },
      { id: "chatcmpl-client-proxy", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LLM upstream proxy did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function readAuditEvents(profileId) {
  const auditPath = path.join(path.dirname(configPath), "audit", `${profileId}.jsonl`);
  return (await readFile(auditPath, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function readRemoteMockRequests(profile) {
  const result = await manager.ssh.run(profile, `cat ${shellQuote(`${remoteCwd}/mock.requests.jsonl`)}`);
  assert(result.code === 0, `read remote mock requests: ${result.stderr}`);
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function runRawPiPrompt(profile, info, prompt) {
  const rawAgent = `${remoteCwd}/raw-pi-agent`;
  const rawSessions = `${remoteCwd}/raw-pi-sessions`;
  const setup = await manager.ssh.run(profile, [
    `rm -rf -- ${shellQuote(rawAgent)} ${shellQuote(rawSessions)}`,
    `mkdir -p ${shellQuote(rawAgent)} ${shellQuote(rawSessions)}`,
    `cp ${shellQuote(`${info.profileRoot}/agent/models.json`)} ${shellQuote(`${info.profileRoot}/agent/settings.json`)} ${shellQuote(`${rawAgent}/`)}`
  ].join("; "));
  assert(setup.code === 0, `raw Pi parity setup: ${setup.stderr}`);
  const pi = `${info.remoteRoot}/runtimes/${info.artifactSha256}/pi/pi`;
  const command = [
    `cd ${remoteCwdQuoted}`,
    `exec env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy PI_CODING_AGENT_DIR=${shellQuote(rawAgent)} PI_CODING_AGENT_SESSION_DIR=${shellQuote(rawSessions)} ${shellQuote(pi)} --mode rpc`
  ].join("; ");
  const child = manager.ssh.spawn(profile, command);
  let stderr = "";
  let buffered = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  child.stdout.setEncoding("utf8");
  const newId = `new-${ticket}`;
  let resolveNew; let rejectNew; let resolveEnd; let rejectEnd;
  const newReady = new Promise((resolve, reject) => { resolveNew = resolve; rejectNew = reject; });
  const agentEnd = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
  const newTimer = setTimeout(() => rejectNew(new Error(`raw Pi new_session timeout: ${stderr}`)), 10_000);
  const endTimer = setTimeout(() => rejectEnd(new Error(`raw Pi parity timeout: ${stderr}`)), 30_000);
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type === "response" && message.id === newId) {
          clearTimeout(newTimer);
          if (message.success) resolveNew(); else rejectNew(new Error(`raw Pi new_session rejected: ${line}`));
        }
        if (message.type === "agent_end") { clearTimeout(endTimer); resolveEnd(); }
      } catch { /* ignore non-JSON diagnostics */ }
    }
  });
  child.once("exit", (code) => {
    if (code && code !== 0) {
      const error = new Error(`raw Pi exited ${code}: ${stderr}`);
      rejectNew(error); rejectEnd(error);
    }
  });
  child.stdin.write(`${JSON.stringify({ id: newId, type: "new_session" })}\n`);
  await newReady;
  child.stdin.write(`${JSON.stringify({ id: `prompt-${ticket}`, type: "prompt", message: prompt })}\n`);
  await agentEnd;
  clearTimeout(newTimer); clearTimeout(endTimer);
  child.stdin.end();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 3_000))]);
}

function requestContext(body, prompt) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const promptIndex = messages.findIndex((message) => JSON.stringify(message?.content ?? "").includes(prompt));
  assert(promptIndex >= 0, `provider request contains ${prompt}`);
  return { model: body.model, messagesBeforePrompt: messages.slice(0, promptIndex), tools: body.tools ?? [] };
}

function collectStopReasons(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) { for (const entry of value) collectStopReasons(entry, output); return output; }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "stopReason" && typeof nested === "string") output.push(nested);
    else collectStopReasons(nested, output);
  }
  return output;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function publicCurlProbe(quiet = false) {
  const match = quiet ? "grep -q 'Example Domain'" : "grep -o 'Example Domain' | head -1";
  return `ok=0; for attempt in 1 2 3; do curl -fsS --max-time 20 http://example.com/ | ${match} && { ok=1; break; }; sleep $attempt; done; test \"$ok\" = 1`;
}

async function waitForHttp(url, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.text();
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`HTTP service did not become reachable: ${lastError}`);
}

async function nativeTuiRpcConflict(profile) {
  const session = openTui(profile.name);
  await waitFor(() => session.output().includes("0.0%/128k"), 20_000, session.output);
  let conflict = false;
  try { await manager.openSession(profile, { cwd: remoteCwd }); }
  catch (error) { conflict = error?.code === "daemon-start-failed" || error?.code === "session-mode-conflict"; }
  assert(conflict, "native TUI and RPC share one profile mode lease");
  session.terminal.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function nativeTuiSessionHistory(profileName, sessionId) {
  const session = openTui(profileName, ["--session", sessionId]);
  await waitFor(() => session.output().includes("history-check") && session.output().includes("REMOTE_HISTORY_RESUMED"), 20_000, session.output);
  session.terminal.write("\x04");
  await new Promise((resolve) => setTimeout(resolve, 300));
  session.terminal.write("\x04");
  await Promise.race([
    new Promise((resolve) => session.terminal.onExit(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Resumed history TUI did not exit")), 10_000))
  ]);
}

async function nativeTuiRoundtrip(profileName, prompt, expected) {
  const session = openTui(profileName);
  await waitFor(() => session.output().includes("0.0%/128k"), 20_000, session.output);
  session.terminal.write(`${prompt}\r`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  session.terminal.write("\r");
  await waitFor(() => session.output().includes(expected), 20_000, session.output);
  session.terminal.write("\x04");
  await new Promise((resolve) => setTimeout(resolve, 300));
  session.terminal.write("\x04");
  await Promise.race([
    new Promise((resolve) => session.terminal.onExit(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TUI did not exit")), 10_000))
  ]);
}

async function nativeTuiReconnect(profileName, verifyProxy = false) {
  const interrupted = openTui(profileName);
  await waitFor(() => interrupted.output().includes("0.0%/128k"), 20_000, interrupted.output);
  interrupted.terminal.write("disconnect-survival\r");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  interrupted.terminal.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 500));
  interrupted.terminal.kill();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const cli = path.join(packageRoot, "dist", "cli.js");
  const conflict = spawnSync(process.execPath, [cli, "connect", profileName, "--cwd", `${remoteCwd}/different`], {
    cwd: packageRoot,
    env: { ...process.env, TERM: "xterm-256color" },
    encoding: "utf8",
    timeout: 15_000
  });
  assert(conflict.status !== 0 && `${conflict.stdout}${conflict.stderr}`.includes("tui-session-conflict"), "TUI reattach rejects changed cwd/session options");
  const reattached = openTui(profileName);
  await waitFor(() => reattached.output().includes("REMOTE_DISCONNECT_SURVIVED"), 20_000, reattached.output);
  if (verifyProxy) {
    reattached.terminal.write("!curl -fsS --max-time 20 https://example.com/ | grep -o 'Example Domain' | head -1\r");
    await waitFor(() => reattached.output().includes("Example Domain"), 20_000, reattached.output);
  }
  reattached.terminal.write("\x04");
  await new Promise((resolve) => setTimeout(resolve, 300));
  reattached.terminal.write("\x04");
  await Promise.race([
    new Promise((resolve) => reattached.terminal.onExit(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Reattached TUI did not exit")), 10_000))
  ]);
}

function openTui(profileName, args = []) {
  const cli = path.join(packageRoot, "dist", "cli.js");
  const terminal = pty.spawn(process.execPath, [cli, "connect", profileName, ...args], {
    name: "xterm-256color", cols: 120, rows: 36, cwd: packageRoot,
    env: { ...process.env, TERM: "xterm-256color" }
  });
  let output = "";
  terminal.onData((chunk) => { output = `${output}${chunk}`.slice(-2_000_000); });
  return { terminal, output: () => output };
}

function collectText(port) {
  const state = { value: "" };
  port.subscribe((event) => {
    const raw = event.type === "rpc.message" ? event.data : undefined;
    if (raw?.type === "message_update" && raw.assistantMessageEvent?.type === "text_delta") state.value += raw.assistantMessageEvent.delta;
  });
  return state;
}
function waitForAgentEnd(port) { return waitForRaw(port, "agent_end"); }
function waitForRaw(port, type) {
  return new Promise((resolve) => {
    const unsubscribe = port.subscribe((event) => {
      const raw = event.type === "rpc.message" ? event.data : undefined;
      if (raw?.type === type) { unsubscribe(); resolve(raw); }
    });
  });
}
async function nativePiSnapshot(profile) {
  const result = await manager.ssh.run(profile, "if test -d \"$HOME/.pi\"; then find \"$HOME/.pi\" -type f -print0 | sort -z | xargs -0 -r sha256sum; else printf 'ABSENT\\n'; fi");
  return result.stdout;
}
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function assert(condition, message) { if (!condition) throw new Error(`Live E2E failed: ${message}`); }
async function waitFor(predicate, timeout, debug) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out. Tail: ${debug().slice(-3000)}`);
}
