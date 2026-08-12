import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultPackageManager, PackageSource, ProgressEvent, ResolvedPaths, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  PluginPackageRecord,
  PluginReference,
  PluginPackageScope,
  PluginResourceCounts,
  SkillRecord,
  WebSearchSettings
} from "../../shared/ipc.js";
import { getJasminePiAgentDir } from "./piAgent.js";

const require = createRequire(import.meta.url);
const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;
const PI_WEB_ACCESS_PACKAGE_NAME = "pi-web-access";
const RETIRED_BUILTIN_CHROME_PACKAGE_NAME = "chrome";
const SKILL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,63}$/u;
const bundledPluginSyncs = new Map<string, Promise<string[]>>();

type PackageEntry = {
  source: string;
  scope: PluginPackageScope;
  packageSource: PackageSource;
};

type PluginServiceOptions = {
  cwd?: string;
  userDataDir: string;
  onProgress?(event: ProgressEvent): void;
};

export function resolvePiWebAccessPackageRoot(): string | null {
  try {
    return path.dirname(require.resolve("pi-web-access/package.json"));
  } catch {
    return null;
  }
}

export function resolveBundledPluginPackageRoot(): string | null {
  return resolveBuiltinResourceRoot({
    envOverride: process.env.JASMINE_BUILTIN_PLUGINS_ROOT,
    subPath: ["builtin-plugins"],
    exists: existsSync
  });
}

function resolveBuiltinResourceRoot(input: {
  envOverride: string | undefined;
  subPath: string[];
  exists(candidate: string): boolean;
}): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packagedResourcesRoot = typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const candidates = [
    input.envOverride,
    packagedResourcesRoot ? path.resolve(packagedResourcesRoot, "jasmine-resources", ...input.subPath) : null,
    path.resolve(process.cwd(), "resources", ...input.subPath),
    path.resolve(moduleDir, "..", "..", "..", "..", "resources", ...input.subPath),
    path.resolve(moduleDir, "..", "..", "..", "resources", ...input.subPath)
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (input.exists(candidate)) return candidate;
  }
  return null;
}

export async function syncBundledPluginPackages(userDataDir: string): Promise<string[]> {
  const outputRoot = defaultPluginPackageRoot(userDataDir);
  const syncKey = path.resolve(outputRoot).toLowerCase();
  const pending = bundledPluginSyncs.get(syncKey);
  if (pending) return pending;
  // Bundled plugins only change with an app rebuild, so one successful sync per
  // process is enough; re-copying them recursively on every send was a large
  // fixed cost on the pre-stream path (plan Phase 5.2). Failures are retried.
  const sync = syncBundledPluginPackagesOnce(outputRoot);
  bundledPluginSyncs.set(syncKey, sync);
  sync.catch(() => {
    if (bundledPluginSyncs.get(syncKey) === sync) bundledPluginSyncs.delete(syncKey);
  });
  return sync;
}

async function syncBundledPluginPackagesOnce(outputRoot: string): Promise<string[]> {
  const bundledRoot = resolveBundledPluginPackageRoot();
  await mkdir(outputRoot, { recursive: true });
  await removeRetiredBundledChromeCopy(outputRoot);
  const bundledPackageNames = bundledRoot ? await listBundledPluginPackageDirectories(bundledRoot) : [];
  if (bundledRoot) {
    for (const packageName of bundledPackageNames) {
      const sourceDir = path.join(bundledRoot, packageName);
      const targetDir = path.join(outputRoot, packageName);
      await cp(sourceDir, targetDir, { recursive: true, force: true });
    }
  }
  const installed: string[] = [];
  for (const packageName of bundledPackageNames) {
    const targetDir = path.join(outputRoot, packageName);
    if (await isPiPluginPackageDirectory(targetDir)) installed.push(targetDir);
  }
  return installed.sort((a, b) => displayNameForSource(a).localeCompare(displayNameForSource(b)));
}

async function removeRetiredBundledChromeCopy(outputRoot: string): Promise<void> {
  const packageDir = path.join(outputRoot, RETIRED_BUILTIN_CHROME_PACKAGE_NAME);
  try {
    const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const extensions = Array.isArray(packageJson?.pi?.extensions) ? packageJson.pi.extensions : [];
    const skills = Array.isArray(packageJson?.pi?.skills) ? packageJson.pi.skills : [];
    const isJasmineBuiltin = packageJson?.name === RETIRED_BUILTIN_CHROME_PACKAGE_NAME
      && packageJson?.version === "0.1.0"
      && extensions.length === 1
      && extensions[0] === "./index.js"
      && skills.length === 1
      && skills[0] === "./skills";
    if (isJasmineBuiltin) await rm(packageDir, { recursive: true, force: true });
  } catch {
    // Missing, unreadable, or user-modified directories are intentionally kept.
  }
}

export function defaultPluginPackageRoot(userDataDir: string): string {
  return path.join(userDataDir, "plugins");
}

async function listBundledPluginPackageDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isPiPluginPackageDirectory(path.join(root, entry.name))) names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

async function isPiPluginPackageDirectory(packageDir: string): Promise<boolean> {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageStat = await stat(packageJsonPath).catch(() => null);
  if (!packageStat?.isFile()) return false;
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    return Boolean(packageJson?.pi && typeof packageJson.name === "string");
  } catch {
    return false;
  }
}

export async function listPluginPackages(options: PluginServiceOptions): Promise<PluginPackageRecord[]> {
  const cacheKey = path.resolve(options.userDataDir).toLowerCase();
  const signature = await pluginResolutionSignature(options.userDataDir);
  const cached = pluginPackageListCache.get(cacheKey);
  if (cached && cached.signature === signature) return [...cached.records];
  const service = await createPluginPackageService(options);
  await service.bootstrapBuiltins();
  const records = await service.list();
  // Bootstrap may normalize settings files, so sign after resolving.
  pluginPackageListCache.set(cacheKey, { signature: await pluginResolutionSignature(options.userDataDir), records });
  return [...records];
}

export async function installPluginPackage(options: PluginServiceOptions, source: string): Promise<PluginPackageRecord[]> {
  const service = await createPluginPackageService(options);
  await service.install(canonicalPluginSource(source));
  return service.list();
}

export async function updatePluginPackage(options: PluginServiceOptions, source: string): Promise<PluginPackageRecord[]> {
  const service = await createPluginPackageService(options);
  await service.update(canonicalPluginSource(source));
  return service.list();
}

export async function removePluginPackage(options: PluginServiceOptions, source: string, scope: PluginPackageScope = "user"): Promise<PluginPackageRecord[]> {
  const service = await createPluginPackageService(options);
  await service.remove(canonicalPluginSource(source), scope);
  return service.list();
}

export async function setPluginPackageEnabled(
  options: PluginServiceOptions,
  source: string,
  enabled: boolean,
  scope: PluginPackageScope = "user"
): Promise<PluginPackageRecord[]> {
  const service = await createPluginPackageService(options);
  await service.setEnabled(source, enabled, scope);
  return service.list();
}

export async function resolvePluginResources(options: PluginServiceOptions): Promise<{ packages: PluginPackageRecord[] }> {
  return { packages: await listPluginPackages(options) };
}

// The Web Search toggle is the control for pi-web-access, so it has to move the
// package both ways. Enabling only, as this once did, left the agent holding web
// tools after the user switched the setting back off.
export async function syncPiWebAccessPluginWithWebSearch(options: PluginServiceOptions, settings: WebSearchSettings): Promise<void> {
  if (process.env.JASMINE_E2E_MOCK_AI === "1") return;
  const source = resolvePiWebAccessPackageRoot();
  if (!source) return;
  const service = await createPluginPackageService(options);
  if (settings.enabled) await service.enableBuiltinSource(source);
  else await service.disableBuiltinSource(source);
}

// Pre-stream sends resolve enabled package skill paths on every request, and
// the app mount + settings surfaces list packages/skills repeatedly. All of
// these results only change when plugin settings or installed packages change
// on disk, so cache them behind an mtime signature (plan Phase 5.2).
const enabledSkillPathsCache = new Map<string, { signature: string; paths: string[] }>();
const pluginPackageListCache = new Map<string, { signature: string; records: PluginPackageRecord[] }>();
const pluginSkillListCache = new Map<string, { signature: string; skills: SkillRecord[] }>();

export function invalidatePluginResolutionCache(): void {
  enabledSkillPathsCache.clear();
  pluginPackageListCache.clear();
  pluginSkillListCache.clear();
}

async function pluginResolutionSignature(userDataDir: string): Promise<string> {
  const parts: string[] = [];
  const stampOf = async (target: string) => {
    const stats = await stat(target).catch(() => null);
    return stats ? `${target}:${stats.mtimeMs}:${stats.size}` : `${target}:missing`;
  };
  const agentDir = getJasminePiAgentDir(userDataDir);
  for (const entry of await readdir(agentDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".json")) parts.push(await stampOf(path.join(agentDir, entry.name)));
  }
  const pluginsRoot = defaultPluginPackageRoot(userDataDir);
  parts.push(await stampOf(pluginsRoot));
  for (const entry of await readdir(pluginsRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) parts.push(await stampOf(path.join(pluginsRoot, entry.name, "package.json")));
  }
  return parts.join("|");
}

export async function resolveEnabledPackageSkillPaths(options: PluginServiceOptions): Promise<string[]> {
  const cacheKey = path.resolve(options.userDataDir).toLowerCase();
  const signature = await pluginResolutionSignature(options.userDataDir);
  const cached = enabledSkillPathsCache.get(cacheKey);
  if (cached && cached.signature === signature) return [...cached.paths];
  const service = await createPluginPackageService(options);
  await service.bootstrapBuiltins();
  const resolved = await service.resolvePaths();
  const paths = Array.from(new Set(resolved.skills.filter((resource) => resource.enabled).map((resource) => resource.path)));
  // The bootstrap above may normalize settings files, so sign after resolving.
  enabledSkillPathsCache.set(cacheKey, { signature: await pluginResolutionSignature(options.userDataDir), paths });
  return [...paths];
}

export async function listPluginSkills(options: PluginServiceOptions): Promise<SkillRecord[]> {
  const cacheKey = path.resolve(options.userDataDir).toLowerCase();
  const signature = await pluginResolutionSignature(options.userDataDir);
  const cached = pluginSkillListCache.get(cacheKey);
  if (cached && cached.signature === signature) return [...cached.skills];
  const service = await createPluginPackageService(options);
  await service.bootstrapBuiltins();
  const skills = await service.listEnabledSkills();
  pluginSkillListCache.set(cacheKey, { signature: await pluginResolutionSignature(options.userDataDir), skills });
  return [...skills];
}

export async function resolvePluginSkillsForPrompt(options: PluginServiceOptions, skillIds: string[] = []): Promise<SkillRecord[]> {
  if (skillIds.length === 0) return [];
  const wanted = new Set(skillIds);
  return (await listPluginSkills(options)).filter((skill) => wanted.has(skill.id));
}

export async function resolvePluginPackageReferences(options: PluginServiceOptions, pluginIds: string[] = []): Promise<PluginReference[]> {
  if (pluginIds.length === 0) return [];
  const service = await createPluginPackageService(options);
  await service.bootstrapBuiltins();
  return service.resolvePackageReferences(pluginIds);
}

export async function resolvePluginPackageRuntimeSources(options: PluginServiceOptions, pluginIds: string[] = []): Promise<string[]> {
  if (pluginIds.length === 0) return [];
  const service = await createPluginPackageService(options);
  await service.bootstrapBuiltins();
  return service.resolvePackageRuntimeSources(pluginIds);
}

async function createPluginPackageService(options: PluginServiceOptions): Promise<PluginPackageService> {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = options.cwd ?? process.cwd();
  const agentDir = getJasminePiAgentDir(options.userDataDir);
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  packageManager.setProgressCallback(options.onProgress);
  return new PluginPackageService(options.userDataDir, settingsManager, packageManager);
}

class PluginPackageService {
  private builtinPluginSources: string[] | null = null;

  constructor(
    private readonly userDataDir: string,
    private readonly settingsManager: SettingsManager,
    private readonly packageManager: DefaultPackageManager
  ) {}

  async bootstrapBuiltins(): Promise<void> {
    const builtinPluginSources = await this.ensureBuiltinPluginSources();
    this.normalizeBuiltinPackageSources(builtinPluginSources);
    this.ensureBuiltinPluginConfigured(builtinPluginSources);
    await this.flush();
  }

  async enableBuiltinSource(source: string): Promise<void> {
    await this.setEnabled(canonicalPluginSource(source), true, "user");
  }

  // setEnabled throws when the package was never configured, which is the
  // normal state for a builtin nobody has switched on yet -- nothing to undo.
  async disableBuiltinSource(source: string): Promise<void> {
    const canonical = canonicalPluginSource(source);
    const configured = this.listPackageEntries()
      .some((entry) => this.sourcesMatch(entry.source, canonical, entry.scope));
    if (!configured) return;
    await this.setEnabled(canonical, false, "user");
  }

  async list(): Promise<PluginPackageRecord[]> {
    const builtinPluginSources = await this.ensureBuiltinPluginSources();
    this.normalizeBuiltinPackageSources(builtinPluginSources);
    this.ensureBuiltinPluginConfigured(builtinPluginSources);
    await this.flush();
    const [resolved, configured, builtinPluginResolved] = await Promise.all([
      this.resolvePaths(),
      Promise.resolve(this.listPackageEntries()),
      builtinPluginSources.length > 0
        ? this.packageManager.resolveExtensionSources(builtinPluginSources, { temporary: true })
        : Promise.resolve(null)
    ]);
    const counts = resourceCountsByPackage(resolved);
    const builtinPluginCounts = builtinPluginResolved ? resourceCountsByPackage(builtinPluginResolved) : new Map<string, PluginResourceCounts>();
    const records = configured.map((entry) => {
      const record = this.toRecord(entry, counts.get(packageKey(entry.source, entry.scope)));
      if (record.builtin && this.isBuiltinPluginSourceForScope(record.source, record.scope) && !hasResourceCounts(record.resourceCounts)) {
        const fallbackCounts = builtinPluginCounts.get(packageKey(record.source, "temporary"));
        if (fallbackCounts) record.resourceCounts = record.enabled ? fallbackCounts : disabledResourceCountsFrom(fallbackCounts);
      }
      return record;
    });
    const piWebAccess = resolvePiWebAccessPackageRoot();
    if (piWebAccess && !records.some((record) => sameSource(record.source, piWebAccess))) {
      const builtinResources = await this.packageManager.resolveExtensionSources([piWebAccess], { temporary: true });
      records.push(this.toBuiltinPiWebAccessRecord(piWebAccess, resourceCountsByPackage(builtinResources).get(packageKey(piWebAccess, "temporary"))));
    }
    return records.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.displayName.localeCompare(b.displayName));
  }

  async install(source: string): Promise<void> {
    await this.packageManager.installAndPersist(source);
    await this.flush();
  }

  async update(source: string): Promise<void> {
    await this.packageManager.update(source);
    await this.flush();
  }

  async remove(source: string, scope: PluginPackageScope): Promise<void> {
    const builtinPluginSources = await this.ensureBuiltinPluginSources();
    this.normalizeBuiltinPackageSources(builtinPluginSources);
    source = canonicalPluginSource(source);
    if (this.isBuiltinPluginSourceForScope(source, scope)) throw new Error("Built-in plugin packages cannot be removed.");
    const removed = await this.packageManager.removeAndPersist(source, { local: scope === "project" });
    if (!removed) {
      const currentPackages = this.packagesForScope(scope);
      const nextPackages = currentPackages.filter((item) => !this.sourcesMatch(packageSourceString(item), source, scope));
      if (nextPackages.length === currentPackages.length) return;
      this.setPackagesForScope(scope, nextPackages);
    }
    await this.flush();
  }

  async setEnabled(source: string, enabled: boolean, scope: PluginPackageScope): Promise<void> {
    const builtinPluginSources = await this.ensureBuiltinPluginSources();
    this.normalizeBuiltinPackageSources(builtinPluginSources);
    this.ensureBuiltinPluginConfigured(builtinPluginSources);
    source = canonicalPluginSource(source);
    const entries = this.listPackageEntries();
    const existing = entries.find((entry) => entry.scope === scope && this.sourcesMatch(entry.source, source, entry.scope))
      ?? entries.find((entry) => this.sourcesMatch(entry.source, source, entry.scope));
    const targetScope = existing?.scope ?? scope;
    const currentPackages = this.packagesForScope(targetScope);
    const matchIndex = currentPackages.findIndex((item) => this.sourcesMatch(packageSourceString(item), source, targetScope));
    if (enabled) {
      if (matchIndex >= 0) {
        const current = currentPackages[matchIndex];
        const nextPackages = [...currentPackages];
        nextPackages[matchIndex] = packageSourceString(current);
        this.setPackagesForScope(targetScope, nextPackages);
      } else {
        this.packageManager.addSourceToSettings(source, { local: targetScope === "project" });
      }
    } else {
      if (matchIndex < 0) throw new Error("Plugin package is not configured.");
      const current = currentPackages[matchIndex];
      const nextPackages = [...currentPackages];
      nextPackages[matchIndex] = disabledPackageSource(packageSourceString(current));
      this.setPackagesForScope(targetScope, nextPackages);
    }
    await this.flush();
  }

  async resolvePaths(): Promise<ResolvedPaths> {
    return this.packageManager.resolve(async () => "skip");
  }

  async listEnabledSkills(): Promise<SkillRecord[]> {
    const [resolved, records] = await Promise.all([
      this.resolvePaths(),
      this.list()
    ]);
    const packages = new Map(records.map((record) => [packageKey(record.source, record.scope), record]));
    const skills = await Promise.all(resolved.skills
      .filter((resource) => resource.enabled)
      .map(async (resource) => {
        const scope = resource.metadata.scope === "project" ? "project" : "user";
        const packageId = packageKey(resource.metadata.source, scope);
        const pkg = packages.get(packageId);
        return loadPluginSkillRecord(resource.path, {
          packageId,
          packageName: pkg?.displayName ?? displayNameForSource(resource.metadata.source)
        });
      }));
    return skills.filter((skill): skill is SkillRecord => Boolean(skill)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolvePackageReferences(pluginIds: string[]): Promise<PluginReference[]> {
    const wanted = new Set(pluginIds);
    return (await this.list())
      .filter((record) => wanted.has(record.id))
      .map((record) => ({
        id: record.id,
        name: record.displayName,
        source: record.source,
        scope: record.scope,
        enabled: record.enabled
      }));
  }

  async resolvePackageRuntimeSources(pluginIds: string[]): Promise<string[]> {
    const wanted = new Set(pluginIds);
    const records = (await this.list()).filter((record) => wanted.has(record.id));
    return Array.from(new Set(records.map((record) => record.installedPath ?? record.source)));
  }

  private listPackageEntries(): PackageEntry[] {
    const entries: PackageEntry[] = [];
    for (const source of this.settingsManager.getGlobalSettings().packages ?? []) {
      entries.push({ source: packageSourceString(source), scope: "user", packageSource: source });
    }
    for (const source of this.settingsManager.getProjectSettings().packages ?? []) {
      entries.push({ source: packageSourceString(source), scope: "project", packageSource: source });
    }
    return entries;
  }

  private findPackageEntry(source: string): PackageEntry | undefined {
    return this.listPackageEntries().find((entry) => this.sourcesMatch(entry.source, source, entry.scope));
  }

  private packagesForScope(scope: PluginPackageScope): PackageSource[] {
    return [
      ...((scope === "project"
        ? this.settingsManager.getProjectSettings().packages
        : this.settingsManager.getGlobalSettings().packages) ?? [])
    ];
  }

  private setPackagesForScope(scope: PluginPackageScope, packages: PackageSource[]): void {
    if (scope === "project") {
      this.settingsManager.setProjectPackages(packages);
    } else {
      this.settingsManager.setPackages(packages);
    }
  }

  private toRecord(entry: PackageEntry, counts: PluginResourceCounts | undefined): PluginPackageRecord {
    const source = entry.source;
    const installedPath = this.packageManager.getInstalledPath(source, entry.scope);
    const builtin = this.isPiWebAccessSourceForScope(source, entry.scope)
      || this.isBuiltinPluginSourceForScope(source, entry.scope);
    return {
      id: packageKey(source, entry.scope),
      source,
      displayName: displayNameForSource(source),
      scope: entry.scope,
      enabled: !isDisabledPackageSource(entry.packageSource),
      filtered: typeof entry.packageSource === "object",
      installedPath,
      builtin,
      recommended: builtin,
      removable: !builtin,
      updateable: !builtin && !isLocalSource(source),
      resourceCounts: counts ?? emptyResourceCounts()
    };
  }

  private toBuiltinPiWebAccessRecord(source: string, counts: PluginResourceCounts | undefined): PluginPackageRecord {
    return {
      id: packageKey(source, "user"),
      source,
      displayName: "Pi Web Access",
      scope: "user",
      enabled: false,
      filtered: false,
      installedPath: source,
      builtin: true,
      recommended: true,
      removable: false,
      updateable: false,
      resourceCounts: counts ?? emptyResourceCounts()
    };
  }

  private async flush(): Promise<void> {
    await this.settingsManager.flush();
    // Any settings mutation can change which package skills resolve as enabled.
    invalidatePluginResolutionCache();
  }

  private sourcesMatch(left: string, right: string, scope: PluginPackageScope): boolean {
    left = canonicalPluginSource(left);
    right = canonicalPluginSource(right);
    if (sameSource(left, right)) return true;
    const leftPath = this.packageManager.getInstalledPath(left, scope);
    const rightPath = this.packageManager.getInstalledPath(right, scope);
    return Boolean(leftPath && rightPath && samePath(leftPath, rightPath));
  }

  private normalizeBuiltinPackageSources(builtinPluginSources: string[]): void {
    const piWebAccess = resolvePiWebAccessPackageRoot();
    for (const scope of ["user", "project"] as const) {
      const currentPackages = this.packagesForScope(scope);
      let nextPackages = currentPackages.filter((item) => !isRetiredBuiltinChromeSource(packageSourceString(item), this.userDataDir));
      if (piWebAccess) nextPackages = this.normalizePiWebAccessPackages(nextPackages, scope, piWebAccess);
      if (builtinPluginSources.length > 0) nextPackages = this.normalizeBuiltinPluginPackages(nextPackages, scope, builtinPluginSources);
      if (!samePackageSourceList(currentPackages, nextPackages)) {
        this.setPackagesForScope(scope, nextPackages);
      }
    }
  }

  private normalizePiWebAccessPackages(packages: PackageSource[], scope: PluginPackageScope, builtin: string): PackageSource[] {
    const nextPackages: PackageSource[] = [];
    let piWebAccessEntry: PackageSource | null = null;
    for (const item of packages) {
      if (!this.isPiWebAccessSourceForScope(packageSourceString(item), scope)) {
        nextPackages.push(item);
        continue;
      }
      piWebAccessEntry = mergePiWebAccessEntry(piWebAccessEntry, packageSourceWithSource(item, builtin), builtin);
    }
    if (piWebAccessEntry) nextPackages.push(piWebAccessEntry);
    return nextPackages;
  }

  private normalizeBuiltinPluginPackages(packages: PackageSource[], scope: PluginPackageScope, builtins: string[]): PackageSource[] {
    const nextPackages: PackageSource[] = [];
    const builtinPluginEntries = new Map<string, PackageSource>();
    for (const item of packages) {
      const source = packageSourceString(item);
      const builtin = this.builtinPluginForSource(source, scope, builtins);
      if (!builtin) {
        nextPackages.push(item);
        continue;
      }
      const current = builtinPluginEntries.get(builtin) ?? null;
      builtinPluginEntries.set(builtin, mergePiWebAccessEntry(current, packageSourceWithSource(item, builtin), builtin));
    }
    for (const builtin of builtins) {
      const entry = builtinPluginEntries.get(builtin);
      if (entry) nextPackages.push(entry);
    }
    return nextPackages;
  }

  private isPiWebAccessSourceForScope(source: string, scope: PluginPackageScope): boolean {
    const builtin = resolvePiWebAccessPackageRoot();
    if (!builtin) return isPiWebAccessSource(source);
    if (isPiWebAccessSource(source)) return true;
    const installedPath = this.packageManager.getInstalledPath(source, scope);
    return Boolean(installedPath && samePath(installedPath, builtin));
  }

  private isBuiltinPluginSourceForScope(source: string, scope: PluginPackageScope): boolean {
    return Boolean(this.builtinPluginForSource(source, scope, this.builtinPluginSources ?? []));
  }

  private builtinPluginForSource(source: string, scope: PluginPackageScope, builtins: string[]): string | null {
    for (const builtin of builtins) {
      if (sameSource(source, builtin)) return builtin;
      const installedPath = this.packageManager.getInstalledPath(source, scope);
      if (installedPath && samePath(installedPath, builtin)) return builtin;
    }
    return null;
  }

  private ensureBuiltinPluginConfigured(sources: string[]): void {
    if (sources.length === 0) return;
    const currentPackages = this.packagesForScope("user");
    let nextPackages = currentPackages;
    for (const source of sources) {
      if (nextPackages.some((item) => this.sourcesMatch(packageSourceString(item), source, "user"))) continue;
      nextPackages = [...nextPackages, disabledPackageSource(source)];
    }
    if (!samePackageSourceList(currentPackages, nextPackages)) {
      this.setPackagesForScope("user", nextPackages);
    }
  }

  private async ensureBuiltinPluginSources(): Promise<string[]> {
    if (this.builtinPluginSources) return this.builtinPluginSources;
    this.builtinPluginSources = await syncBundledPluginPackages(this.userDataDir);
    return this.builtinPluginSources;
  }
}

function disabledPackageSource(source: string): Exclude<PackageSource, string> {
  return {
    source,
    extensions: [],
    skills: [],
    prompts: [],
    themes: []
  };
}

function isDisabledPackageSource(source: PackageSource): boolean {
  if (typeof source === "string") return false;
  return RESOURCE_KINDS.every((kind) => Array.isArray(source[kind]) && source[kind]?.length === 0);
}

function packageSourceString(source: PackageSource): string {
  return typeof source === "string" ? source : source.source;
}

function packageSourceWithSource(source: PackageSource, nextSource: string): PackageSource {
  return typeof source === "string" ? nextSource : { ...source, source: nextSource };
}

function mergePiWebAccessEntry(current: PackageSource | null, incoming: PackageSource, builtin: string): PackageSource {
  if (!current) return incoming;
  if (!isDisabledPackageSource(current)) return packageSourceWithSource(current, builtin);
  if (!isDisabledPackageSource(incoming)) return packageSourceWithSource(incoming, builtin);
  return disabledPackageSource(builtin);
}

function samePackageSourceList(first: PackageSource[], second: PackageSource[]): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function resourceCountsByPackage(resolved: ResolvedPaths): Map<string, PluginResourceCounts> {
  const counts = new Map<string, PluginResourceCounts>();
  for (const kind of RESOURCE_KINDS) {
    for (const resource of resolved[kind]) {
      const key = packageKey(resource.metadata.source, resource.metadata.scope);
      const current = counts.get(key) ?? emptyResourceCounts();
      current[kind].total += 1;
      if (resource.enabled) current[kind].enabled += 1;
      counts.set(key, current);
    }
  }
  return counts;
}

function emptyResourceCounts(): PluginResourceCounts {
  return {
    extensions: { enabled: 0, total: 0 },
    skills: { enabled: 0, total: 0 },
    prompts: { enabled: 0, total: 0 },
    themes: { enabled: 0, total: 0 }
  };
}

function hasResourceCounts(counts: PluginResourceCounts): boolean {
  return RESOURCE_KINDS.some((kind) => counts[kind].total > 0 || counts[kind].enabled > 0);
}

function disabledResourceCountsFrom(counts: PluginResourceCounts): PluginResourceCounts {
  return {
    extensions: { enabled: 0, total: counts.extensions.total },
    skills: { enabled: 0, total: counts.skills.total },
    prompts: { enabled: 0, total: counts.prompts.total },
    themes: { enabled: 0, total: counts.themes.total }
  };
}

function packageKey(source: string, scope: PluginPackageScope | "temporary"): string {
  return `${scope}:${normalizeSourceForComparison(source)}`;
}

function sameSource(left: string, right: string): boolean {
  return normalizeSourceForComparison(left) === normalizeSourceForComparison(right);
}

function samePath(left: string, right: string): boolean {
  return resolveComparablePath(left) === resolveComparablePath(right);
}

function resolveComparablePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
}

function normalizeSourceForComparison(source: string): string {
  return source.trim().replace(/\\/g, "/").toLowerCase();
}

function canonicalPluginSource(source: string): string {
  const piWebAccess = resolvePiWebAccessPackageRoot();
  if (piWebAccess && isPiWebAccessSource(source)) return piWebAccess;
  return source;
}

function isPiWebAccessSource(source: string | PackageSource): boolean {
  const sourceValue = packageSourceString(source);
  const normalized = normalizeSourceForComparison(sourceValue);
  if (normalized === PI_WEB_ACCESS_PACKAGE_NAME || normalized.startsWith(`${PI_WEB_ACCESS_PACKAGE_NAME}@`)) return true;
  if (normalized === `npm:${PI_WEB_ACCESS_PACKAGE_NAME}` || normalized.startsWith(`npm:${PI_WEB_ACCESS_PACKAGE_NAME}@`)) return true;
  const builtin = resolvePiWebAccessPackageRoot();
  return Boolean(builtin && sameSource(sourceValue, builtin));
}

function isLocalSource(source: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/.test(source.trim());
}

function displayNameForSource(source: string): string {
  if (isPiWebAccessSource(source)) return "Pi Web Access";
  if (source.startsWith("npm:")) return source.slice(4);
  if (source.startsWith("git:")) return source.slice(4);
  if (isLocalSource(source)) return path.basename(source.replace(/[\\/]$/, "")) || source;
  try {
    const url = new URL(source);
    return url.pathname.split("/").filter(Boolean).slice(-2).join("/") || url.hostname;
  } catch {
    return path.basename(source.replace(/[\\/]$/, "")) || source;
  }
}

function isRetiredBuiltinChromeSource(source: string, userDataDir: string): boolean {
  const normalized = normalizeSourceForComparison(source);
  if (normalized === RETIRED_BUILTIN_CHROME_PACKAGE_NAME
    || normalized.startsWith(`${RETIRED_BUILTIN_CHROME_PACKAGE_NAME}@`)
    || normalized === `npm:${RETIRED_BUILTIN_CHROME_PACKAGE_NAME}`
    || normalized.startsWith(`npm:${RETIRED_BUILTIN_CHROME_PACKAGE_NAME}@`)) {
    return true;
  }
  if (!isLocalSource(source)) return false;
  if (samePath(source, path.join(defaultPluginPackageRoot(userDataDir), RETIRED_BUILTIN_CHROME_PACKAGE_NAME))) {
    // The bundled copy is removed before settings normalization. A surviving
    // directory belongs to the user unless it still has Jasmine's exact legacy
    // package identity, so never disable a custom same-named package.
    return !existsSync(source) || isLegacyJasmineChromePackage(source);
  }
  const slashed = normalized.replace(/\/+$/, "");
  return slashed.endsWith("/resources/builtin-plugins/chrome")
    || slashed.endsWith("/jasmine-resources/builtin-plugins/chrome");
}

function isLegacyJasmineChromePackage(packageDir: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const extensions = Array.isArray(packageJson?.pi?.extensions) ? packageJson.pi.extensions : [];
    const skills = Array.isArray(packageJson?.pi?.skills) ? packageJson.pi.skills : [];
    return packageJson?.name === RETIRED_BUILTIN_CHROME_PACKAGE_NAME
      && packageJson?.version === "0.1.0"
      && extensions.length === 1
      && extensions[0] === "./index.js"
      && skills.length === 1
      && skills[0] === "./skills";
  } catch {
    return false;
  }
}

async function loadPluginSkillRecord(skillPath: string, pkg: { packageId: string; packageName: string }): Promise<SkillRecord | null> {
  const fileStat = await stat(skillPath).catch(() => null);
  const skillFilePath = fileStat?.isDirectory() ? path.join(skillPath, "SKILL.md") : skillPath;
  const skillFileStat = await stat(skillFilePath).catch(() => null);
  if (!skillFileStat?.isFile()) return null;
  const raw = await readFile(skillFilePath, "utf8");
  const parsed = parseSkillMarkdown(raw);
  if (!parsed || !parsed.body.trim()) return null;
  const sourcePath = path.dirname(skillFilePath);
  const now = skillFileStat.mtime.toISOString();
  return {
    id: pluginSkillId(skillFilePath),
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body.trim(),
    enabled: true,
    source: "plugin",
    sourcePath,
    skillFilePath,
    readonly: true,
    pluginPackageId: pkg.packageId,
    pluginPackageName: pkg.packageName,
    createdAt: now,
    updatedAt: now
  };
}

function parseSkillMarkdown(raw: string): { name: string; description: string; body: string } | null {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = parseFlatYaml(match[1]);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description || !SKILL_NAME_PATTERN.test(name)) return null;
  return { name, description, body: match[2] };
}

function parseFlatYaml(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();
    if (rawValue === ">") {
      const folded: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        folded.push(lines[index].trim());
      }
      result[key] = folded.join(" ").replace(/\s+/g, " ").trim();
    } else {
      result[key] = unquote(rawValue);
    }
  }
  return result;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function pluginSkillId(skillFilePath: string): string {
  return `plugin:${createHash("sha256").update(path.resolve(skillFilePath).toLowerCase()).digest("hex").slice(0, 24)}`;
}
