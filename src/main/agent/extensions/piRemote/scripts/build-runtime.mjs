import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGlibcBaseline, assertLinuxX64BuildHost } from "./glibc-baseline.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../../../../..");
const outputDir = path.join(packageRoot, "runtime", "linux-x64-glibc");
const workRoot = path.join(repoRoot, ".tmp", "pi-remote-runtime-build-linux-x64");
const stage = path.join(workRoot, "stage");
const archivePath = path.join(outputDir, "pi-remote-runtime-linux-x64-glibc.tar.gz");
const upstreamArchive = process.env.PI_REMOTE_PI_ARCHIVE
  ? path.resolve(process.env.PI_REMOTE_PI_ARCHIVE)
  : path.join(repoRoot, ".tmp", "pi-remote-upstream", "pi-linux-x64.tar.gz");
const UPSTREAM_PI_SHA256 = "906fbe787fd225c4ac624fe7ebd5b1d55a60e0f5c7ef51795d231564f9ee1c13";
const PI_VERSION = "0.84.2";
const RUNTIME_VERSION = "0.1.0";
const GLIBC_MINIMUM = "2.27";
const toolCache = path.join(repoRoot, ".tmp", "pi-remote-tools");
const FD_ARCHIVE = "fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz";
const FD_SHA256 = "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde";
const RG_ARCHIVE = "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz";
const RG_SHA256 = "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c";

await rm(workRoot, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(outputDir, { recursive: true });

try {
  if (await sha256(upstreamArchive).catch(() => "") !== UPSTREAM_PI_SHA256) {
    throw new Error(`Expected verified pi ${PI_VERSION} archive at ${upstreamArchive}. Download the official release and SHA256SUMS first.`);
  }
  await run("tar", ["-xzf", upstreamArchive, "-C", stage]);
  await mkdir(path.join(stage, "bin"), { recursive: true });
  const bunCommand = process.env.PI_REMOTE_BUN || (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "bun", "bin", "bun.exe")
    : "bun");
  await run(bunCommand, [
    "build", path.join(packageRoot, "dist", "host.js"),
    "--compile",
    "--target=bun-linux-x64-baseline",
    `--outfile=${path.join(stage, "bin", "pi-remote-host")}`
  ]);
  await bundleTmux(stage);
  await bundleSearchTools(stage);
  await writeFile(path.join(stage, "bin", "pi-remote-net"), [
    "#!/bin/sh",
    "set -eu",
    "command=${1:-}",
    "test -n \"$command\" || { echo 'usage: pi-remote-net apt <apt-get args...>' >&2; exit 2; }",
    "shift",
    "case \"$command\" in",
    "  apt)",
    "    proxy=${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}",
    "    case \"$proxy\" in http://*) ;; *) echo 'pi-remote-net apt requires the managed HTTP proxy' >&2; exit 2 ;; esac",
    "    umask 077",
    "    config=$(mktemp \"${TMPDIR:-/tmp}/pi-remote-apt.XXXXXX\")",
    "    trap 'rm -f -- \"$config\"' EXIT HUP INT TERM",
    "    printf 'Acquire::http::Proxy \"%s\";\\nAcquire::https::Proxy \"%s\";\\n' \"$proxy\" \"$proxy\" >\"$config\"",
    "    if test \"$(id -u)\" -eq 0; then apt-get -c \"$config\" \"$@\"; code=$?; else sudo apt-get -c \"$config\" \"$@\"; code=$?; fi",
    "    rm -f -- \"$config\"",
    "    trap - EXIT HUP INT TERM",
    "    exit \"$code\"",
    "    ;;",
    "  *) echo \"unsupported pi-remote-net command: $command\" >&2; exit 2 ;;",
    "esac",
    ""
  ].join("\n"), "utf8");
  await chmod(path.join(stage, "bin", "pi-remote-net"), 0o755).catch(() => {});
  await writeFile(path.join(stage, "tmux.conf"), [
    "set -g status off",
    "set -g prefix None",
    "set -g escape-time 10",
    "set -g remain-on-exit off",
    "set -g default-terminal screen-256color",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(stage, "RUNTIME_NOTICES.md"), [
    "# pi-remote runtime notices",
    "",
    `- Pi ${PI_VERSION}: MIT, unmodified official linux-x64 release payload.`,
    "- pi-remote-host: MIT, compiled with Bun 1.3.14 linux-x64-baseline.",
    "- tmux and its bundled non-glibc shared libraries: see licenses/ copied from the Ubuntu package metadata used by the builder.",
    "- fd 10.4.2: Apache-2.0 OR MIT; unmodified official x86_64 musl release binary.",
    "- ripgrep 15.2.0: Unlicense OR MIT; unmodified official x86_64 musl release binary.",
    "- pi-remote-net: package-owned helper that passes apt proxy credentials through a mode-0600 temporary config instead of process arguments.",
    ""
  ].join("\n"), "utf8");
  const checksumFiles = await fileManifest(stage, new Set(["manifest.json", "SHA256SUMS"]));
  await writeFile(path.join(stage, "SHA256SUMS"), `${checksumFiles.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`, "utf8");
  const files = await fileManifest(stage, new Set(["manifest.json"]));
  await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({
    version: 1,
    runtimeVersion: RUNTIME_VERSION,
    piVersion: PI_VERSION,
    platform: "linux",
    arch: "x64",
    libcMinimum: GLIBC_MINIMUM,
    upstreamPiSha256: UPSTREAM_PI_SHA256,
    files
  }, null, 2)}\n`, "utf8");
  await createArchive(stage, archivePath);
  const archiveSha256 = await sha256(archivePath);
  const previousDescriptor = await readFile(path.join(outputDir, "artifact.json"), "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  const archiveUrl = process.env.PI_REMOTE_RUNTIME_URL || previousDescriptor.archiveUrl;
  await writeFile(path.join(outputDir, "artifact.json"), `${JSON.stringify({
    version: 1,
    platform: "linux",
    arch: "x64",
    libcMinimum: GLIBC_MINIMUM,
    runtimeVersion: RUNTIME_VERSION,
    piVersion: PI_VERSION,
    archive: path.basename(archivePath),
    archiveSha256,
    ...(archiveUrl ? { archiveUrl } : {}),
    upstreamPiSha256: UPSTREAM_PI_SHA256
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ archivePath, archiveSha256, files: files.length })}\n`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

async function bundleSearchTools(targetRoot) {
  const fdArchive = path.join(toolCache, FD_ARCHIVE);
  const rgArchive = path.join(toolCache, RG_ARCHIVE);
  if (await sha256(fdArchive).catch(() => "") !== FD_SHA256) throw new Error(`Missing or invalid pinned ${FD_ARCHIVE}`);
  if (await sha256(rgArchive).catch(() => "") !== RG_SHA256) throw new Error(`Missing or invalid pinned ${RG_ARCHIVE}`);
  const extractRoot = path.join(workRoot, "tools");
  await mkdir(extractRoot, { recursive: true });
  await run("tar", ["-xzf", fdArchive, "-C", extractRoot]);
  await run("tar", ["-xzf", rgArchive, "-C", extractRoot]);
  const fdRoot = path.join(extractRoot, "fd-v10.4.2-x86_64-unknown-linux-musl");
  const rgRoot = path.join(extractRoot, "ripgrep-15.2.0-x86_64-unknown-linux-musl");
  await copyFile(path.join(fdRoot, "fd"), path.join(targetRoot, "bin", "fd"));
  await copyFile(path.join(rgRoot, "rg"), path.join(targetRoot, "bin", "rg"));
  await chmod(path.join(targetRoot, "bin", "fd"), 0o755).catch(() => {});
  await chmod(path.join(targetRoot, "bin", "rg"), 0o755).catch(() => {});
  for (const name of ["LICENSE-APACHE", "LICENSE-MIT"]) {
    await copyFile(path.join(fdRoot, name), path.join(targetRoot, "licenses", `fd-${name}`));
  }
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
    await copyFile(path.join(rgRoot, name), path.join(targetRoot, "licenses", `ripgrep-${name}`));
  }
}

async function bundleTmux(targetRoot) {
  const binDir = path.join(targetRoot, "bin");
  const libDir = path.join(targetRoot, "lib");
  const licenseDir = path.join(targetRoot, "licenses");
  await Promise.all([mkdir(binDir, { recursive: true }), mkdir(libDir, { recursive: true }), mkdir(licenseDir, { recursive: true })]);
  if (process.platform === "win32") {
    const distro = process.env.PI_REMOTE_WSL_DISTRO || "Ubuntu-18.04";
    assertLinuxX64BuildHost(await wslText(distro, "uname -m"), `WSL distro ${distro}`);
    const tmuxPath = (await wslText(distro, "command -v tmux")).trim();
    if (!tmuxPath) throw new Error(`tmux is unavailable in WSL distro ${distro}`);
    const binDirWsl = await toWslPath(distro, binDir);
    const libDirWsl = await toWslPath(distro, libDir);
    const licenseDirWsl = await toWslPath(distro, licenseDir);
    const glibcTargets = [`${binDirWsl}/tmux.real`];
    await runWsl(distro, `cp -L ${shellQuote(tmuxPath)} ${shellQuote(glibcTargets[0])}`);
    const ldd = await wslText(distro, `ldd ${shellQuote(tmuxPath)}`);
    for (const source of parseBundledLibraries(ldd)) {
      const target = `${libDirWsl}/${path.posix.basename(source)}`;
      await runWsl(distro, `cp -L ${shellQuote(source)} ${shellQuote(target)}`);
      glibcTargets.push(target);
    }
    for (const target of glibcTargets) {
      const versionInfo = await wslText(distro, `readelf --version-info ${shellQuote(target)}`);
      assertGlibcBaseline(versionInfo, GLIBC_MINIMUM, path.posix.basename(target));
    }
    for (const packageName of ["tmux", "libevent-2.1-6", "libtinfo5", "libutempter0"]) {
      await runWsl(distro, `source=/usr/share/doc/${packageName}/copyright; if test -f \"$source\"; then cp -L \"$source\" ${shellQuote(`${licenseDirWsl}/${packageName}.copyright`)}; fi`);
    }
  } else if (process.platform === "linux") {
    assertLinuxX64BuildHost((await runCapture("uname", ["-m"])).toString("utf8"), "Linux build host");
    const tmuxPath = (await runCapture("sh", ["-c", "command -v tmux"])).toString("utf8").trim();
    if (!tmuxPath) throw new Error("tmux is unavailable on the Linux build host");
    const tmuxTarget = path.join(binDir, "tmux.real");
    const glibcTargets = [tmuxTarget];
    await copyFile(tmuxPath, tmuxTarget);
    const ldd = (await runCapture("ldd", [tmuxPath])).toString("utf8");
    for (const source of parseBundledLibraries(ldd)) {
      const target = path.join(libDir, path.basename(source));
      await copyFile(source, target);
      glibcTargets.push(target);
    }
    for (const target of glibcTargets) {
      const versionInfo = (await runCapture("readelf", ["--version-info", target])).toString("utf8");
      assertGlibcBaseline(versionInfo, GLIBC_MINIMUM, path.basename(target));
    }
    await copyFile("/usr/share/doc/tmux/copyright", path.join(licenseDir, "tmux.copyright")).catch(() => {});
  } else {
    throw new Error("linux-x64 runtime artifacts must be built on Linux or Windows with WSL");
  }
  await writeFile(path.join(binDir, "tmux"), [
    "#!/bin/sh",
    "here=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "export LD_LIBRARY_PATH=\"$here/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\"",
    "exec \"$here/tmux.real\" \"$@\"",
    ""
  ].join("\n"), "utf8");
  await chmod(path.join(binDir, "tmux"), 0o755).catch(() => {});
  await chmod(path.join(binDir, "tmux.real"), 0o755).catch(() => {});
}

function parseBundledLibraries(ldd) {
  return ldd.split(/\r?\n/u).flatMap((line) => {
    const match = /=>\s+(\/[^\s]+)\s+/u.exec(line);
    if (!match) return [];
    const name = path.posix.basename(match[1]);
    return /^(libevent|libtinfo|libutempter)/u.test(name) ? [match[1]] : [];
  });
}

async function fileManifest(root, excluded) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replaceAll(path.sep, "/");
      if (excluded.has(relative)) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const info = await stat(target);
        files.push({ path: relative, size: info.size, sha256: await sha256(target) });
      }
    }
  };
  await walk(root);
  return files;
}

async function createArchive(source, target) {
  await removeGeneratedFile(target);
  if (process.platform !== "win32") {
    await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--use-compress-program=gzip -n", "-cf", target, "-C", source, "."]);
    return;
  }
  const distro = process.env.PI_REMOTE_WSL_DISTRO || "Ubuntu-18.04";
  const sourceWsl = (await wslText(distro, `wslpath -a ${shellQuote(source)}`)).trim();
  const targetWsl = (await wslText(distro, `wslpath -a ${shellQuote(target)}`)).trim();
  await run("wsl.exe", ["-d", distro, "--", "bash", "-lc", `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --use-compress-program='gzip -n' -cf ${shellQuote(targetWsl)} -C ${shellQuote(sourceWsl)} .`]);
}

async function removeGeneratedFile(target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, { force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, args) {
  const result = await runProcess(command, args, false);
  if (result.code !== 0) throw new Error(`${command} failed (${result.code}): ${result.stderr.toString("utf8")}`);
}

async function runCapture(command, args) {
  const result = await runProcess(command, args, true);
  if (result.code !== 0) throw new Error(`${command} failed (${result.code}): ${result.stderr.toString("utf8")}`);
  return result.stdout;
}

async function runProcess(command, args, capture) {
  const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
  const stdout = [];
  const stderr = [];
  if (capture) {
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function wslBytes(distro, command) {
  return runCapture("wsl.exe", ["-d", distro, "--", "bash", "-lc", command]);
}
async function wslText(distro, command) { return (await wslBytes(distro, command)).toString("utf8"); }
async function runWsl(distro, command) { return run("wsl.exe", ["-d", distro, "--", "bash", "-lc", command]); }
async function toWslPath(distro, windowsPath) { return (await wslText(distro, `wslpath -a ${shellQuote(windowsPath)}`)).trim(); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\"'\"'`)}'`; }
