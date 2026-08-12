import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  listPluginPackages,
  resolvePiWebAccessPackageRoot,
  setPluginPackageEnabled,
  syncBundledPluginPackages,
  syncPiWebAccessPluginWithWebSearch
} = await import("../../dist/main/main/services/plugins.js");
const tempRoot = await mkdtemp(path.join(tmpdir(), "jasmine-packages-"));

try {
  const retiredUserData = path.join(tempRoot, "retired");
  const retiredDir = path.join(retiredUserData, "plugins", "chrome");
  const customDir = path.join(retiredUserData, "plugins", "custom-package");
  await writePackage(retiredDir, {
    name: "chrome",
    version: "0.1.0",
    type: "module",
    pi: { extensions: ["./index.js"], skills: ["./skills"] }
  });
  await writeFile(path.join(retiredDir, "index.js"), "export default function chrome() {}\n", "utf8");
  await mkdir(path.join(retiredDir, "skills"), { recursive: true });
  await writePackage(customDir, { name: "custom-package", version: "1.0.0", pi: {} });

  const installed = await syncBundledPluginPackages(retiredUserData);
  await assert.rejects(access(retiredDir));
  assert.deepEqual(installed, []);
  await access(path.join(customDir, "package.json"));

  const userOwnedData = path.join(tempRoot, "user-owned");
  const userOwnedChrome = path.join(userOwnedData, "plugins", "chrome");
  await writePackage(userOwnedChrome, { name: "chrome", version: "9.9.9", pi: { extensions: ["./custom.js"] } });
  await writeFile(path.join(userOwnedChrome, "custom.js"), "export default function customChrome() {}\n", "utf8");

  assert.deepEqual(await syncBundledPluginPackages(userOwnedData), []);
  await access(path.join(userOwnedChrome, "custom.js"));
  const userOwnedAgentDir = path.join(userOwnedData, "pi-agent");
  await mkdir(userOwnedAgentDir, { recursive: true });
  await writeFile(path.join(userOwnedAgentDir, "settings.json"), JSON.stringify({ packages: [userOwnedChrome] }, null, 2), "utf8");
  const userOwnedRecords = await listPluginPackages({ userDataDir: userOwnedData });
  const userOwnedRecord = userOwnedRecords.find((record) => record.source === userOwnedChrome);
  assert.equal(userOwnedRecord?.builtin, false);
  assert.equal(userOwnedRecord?.removable, true);
  const userOwnedSettings = JSON.parse(await readFile(path.join(userOwnedAgentDir, "settings.json"), "utf8"));
  assert.equal(userOwnedSettings.packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && path.resolve(source) === path.resolve(userOwnedChrome);
  }), true);

  // The Web Search toggle is the only control for pi-web-access, so the sync
  // has to move the package in both directions. It used to only ever enable,
  // which left pi holding web tools after the setting was switched back off.
  const webAccessRoot = resolvePiWebAccessPackageRoot();
  if (webAccessRoot) {
    const webUserData = path.join(tempRoot, "web-access");
    await mkdir(path.join(webUserData, "pi-agent"), { recursive: true });
    const webAccessEnabled = async () => {
      const record = (await listPluginPackages({ userDataDir: webUserData }))
        .find((item) => path.resolve(item.source) === path.resolve(webAccessRoot));
      assert.ok(record, "pi-web-access should be listed");
      return record.enabled;
    };

    await syncPiWebAccessPluginWithWebSearch({ userDataDir: webUserData }, { enabled: true, updatedAt: "" });
    assert.equal(await webAccessEnabled(), true, "enabling web search should enable pi-web-access");

    await syncPiWebAccessPluginWithWebSearch({ userDataDir: webUserData }, { enabled: false, updatedAt: "" });
    assert.equal(await webAccessEnabled(), false, "disabling web search should disable pi-web-access");

    await syncPiWebAccessPluginWithWebSearch({ userDataDir: webUserData }, { enabled: true, updatedAt: "" });
    assert.equal(await webAccessEnabled(), true, "re-enabling web search should enable pi-web-access again");

    // Disabling from a clean profile must not throw: setEnabled rejects an
    // unconfigured package, and the toggle starts off.
    const untouched = path.join(tempRoot, "web-access-untouched");
    await mkdir(path.join(untouched, "pi-agent"), { recursive: true });
    await syncPiWebAccessPluginWithWebSearch({ userDataDir: untouched }, { enabled: false, updatedAt: "" });

    // A project-scoped entry must be disabled too. Disabling only the user
    // scope leaves the resolver loading the extension while the setting reads
    // off, which is the same lie as never disabling at all. The project cwd is
    // a temp dir so this never writes into the checkout.
    const bothScopes = path.join(tempRoot, "web-access-both-scopes");
    const bothScopesProject = path.join(bothScopes, "project");
    await mkdir(path.join(bothScopes, "pi-agent"), { recursive: true });
    await mkdir(bothScopesProject, { recursive: true });
    const bothScopesOptions = { userDataDir: bothScopes, cwd: bothScopesProject };
    // setEnabled reuses whichever scope already holds the package, so the app
    // cannot produce this state itself; it comes from a project that commits
    // .pi/settings.json while the user also enabled the package globally.
    await mkdir(path.join(bothScopesProject, ".pi"), { recursive: true });
    await writeFile(
      path.join(bothScopes, "pi-agent", "settings.json"),
      JSON.stringify({ packages: [webAccessRoot] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(bothScopesProject, ".pi", "settings.json"),
      JSON.stringify({ packages: [webAccessRoot] }, null, 2),
      "utf8"
    );
    const enabledScopes = (await listPluginPackages(bothScopesOptions))
      .filter((item) => path.resolve(item.source) === path.resolve(webAccessRoot));
    assert.equal(enabledScopes.length, 2, "both scopes should hold pi-web-access before disabling");
    assert.deepEqual(enabledScopes.map((item) => item.enabled), [true, true]);

    await syncPiWebAccessPluginWithWebSearch(bothScopesOptions, { enabled: false, updatedAt: "" });
    for (const record of await listPluginPackages(bothScopesOptions)) {
      if (path.resolve(record.source) !== path.resolve(webAccessRoot)) continue;
      assert.equal(record.enabled, false, `${record.scope} scope should not keep pi-web-access enabled`);
    }
  }

  console.log("plugin-packages unit test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function writePackage(directory, packageJson) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
}
