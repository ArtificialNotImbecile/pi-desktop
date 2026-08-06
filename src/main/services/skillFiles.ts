import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillCreateRequest, SkillOpenResponse, SkillRecord } from "../../shared/ipc.js";
import { listExecutableDiscovery, resolveConfiguredExecutable } from "./executables.js";
import { SKILL_NAME_PATTERN, parseSkillMarkdown, skillIdForPath } from "./skillMarkdown.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function localSkillRoot(userDataDir: string): string {
  return path.join(userDataDir, "skills", "local");
}

function legacyLocalSkillRoot(userDataDir: string): string {
  return path.join(userDataDir, "skills");
}

export async function ensureLocalSkillFiles(userDataDir: string, legacySkills: SkillRecord[]): Promise<void> {
  const root = localSkillRoot(userDataDir);
  await mkdir(root, { recursive: true });
  for (const skill of await defaultLocalSkills()) {
    await writeSkillIfMissing(root, skill);
  }
  for (const skill of legacySkills) {
    await writeSkillIfMissing(root, {
      name: skillSpecName(skill.name || skill.id),
      description: skill.description,
      instructions: skill.instructions
    });
  }
}

// Cheap change-detection signature over every skill root: directory mtimes plus
// each SKILL.md mtime/size. Used to reuse parsed skill scans across chat sends
// (plan Phase 5.2) without missing file edits, additions, or removals.
export async function skillScanSignature(userDataDir: string, externalSourcePaths: string[]): Promise<string> {
  const roots = [localSkillRoot(userDataDir), legacyLocalSkillRoot(userDataDir), ...externalSourcePaths];
  const parts: string[] = [];
  for (const root of roots) {
    const rootStat = await stat(root).catch(() => null);
    parts.push(`${root}:${rootStat ? rootStat.mtimeMs : "missing"}`);
    if (!rootStat?.isDirectory()) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".system") continue;
      const skillFile = path.join(root, entry.name, "SKILL.md");
      const fileStat = await stat(skillFile).catch(() => null);
      parts.push(`${skillFile}:${fileStat ? `${fileStat.mtimeMs}:${fileStat.size}` : "missing"}`);
    }
  }
  return parts.join("|");
}

export async function loadLocalSkills(userDataDir: string, enabledStates: Map<string, boolean>): Promise<SkillRecord[]> {
  const root = localSkillRoot(userDataDir);
  await mkdir(root, { recursive: true });
  const skills = await loadLocalSkillRoots(userDataDir);
  return skills.map((skill) => ({
    ...skill,
    enabled: enabledStates.get(skill.id) ?? true
  }));
}

export async function createLocalSkill(userDataDir: string, request: SkillCreateRequest): Promise<SkillRecord> {
  const root = localSkillRoot(userDataDir);
  await mkdir(root, { recursive: true });
  const name = await uniqueSkillName(root, skillSpecName(request.name ?? "new-skill"));
  const description = request.description?.trim() || "Describe when Jasmine should use this skill.";
  const instructions = request.instructions?.trim() || [
    `# ${name}`,
    "",
    "Use this skill when the user asks for this workflow.",
    "",
    "- Replace this template with concrete instructions.",
    "- Keep examples short and operational.",
    ""
  ].join("\n");
  await writeSkillFile(path.join(root, name), { name, description, instructions });
  const skill = await loadSkillDirectory(path.join(root, name), name, "local");
  if (!skill) throw new Error("Created skill could not be loaded.");
  return { ...skill, enabled: request.enabled ?? true };
}

export async function deleteLocalSkill(userDataDir: string, skill: SkillRecord): Promise<void> {
  if (skill.source !== "local" || !skill.sourcePath) throw new Error("Only local file-backed skills can be deleted.");
  const root = path.resolve(localSkillRoot(userDataDir));
  const target = path.resolve(skill.sourcePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    const legacyRoot = path.resolve(legacyLocalSkillRoot(userDataDir));
    if (target !== legacyRoot && !target.startsWith(`${legacyRoot}${path.sep}`)) {
      throw new Error("Skill path is outside the local skill root.");
    }
  }
  await rm(target, { recursive: true, force: true });
}

export async function openSkillInEditor(input: {
  skill: SkillRecord;
  currentEditorPath?: string;
  saveEditorPath(editorPath: string): void;
}): Promise<SkillOpenResponse> {
  const skillFilePath = input.skill.skillFilePath ?? (input.skill.sourcePath ? path.join(input.skill.sourcePath, "SKILL.md") : undefined);
  if (!skillFilePath) throw new Error("Skill does not have a SKILL.md path.");
  const editorPath = await resolveEditorPath(input.currentEditorPath);
  if (editorPath) {
    input.saveEditorPath(editorPath);
    await launchEditor(editorPath, skillFilePath);
  }
  return {
    skill: input.skill,
    editorPath,
    openedPath: skillFilePath
  };
}

async function loadSkillRoot(root: string, source: SkillRecord["source"]): Promise<SkillRecord[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".system") continue;
    const skill = await loadSkillDirectory(path.join(root, entry.name), entry.name, source).catch(() => null);
    if (skill) skills.push(skill);
  }
  return skills.sort(sortSkills);
}

async function loadLocalSkillRoots(userDataDir: string): Promise<SkillRecord[]> {
  const skills = await loadSkillRoot(localSkillRoot(userDataDir), "local");
  const legacyRoot = legacyLocalSkillRoot(userDataDir);
  const legacyStat = await stat(legacyRoot).catch(() => null);
  if (!legacyStat?.isDirectory()) return skills;
  const seenNames = new Set(skills.map((skill) => skill.name));
  for (const skill of await loadSkillRoot(legacyRoot, "local")) {
    if (!seenNames.has(skill.name)) skills.push(skill);
  }
  return skills.sort(sortSkills);
}

async function loadSkillDirectory(skillPath: string, directoryName: string, source: SkillRecord["source"]): Promise<SkillRecord | null> {
  if (!SKILL_NAME_PATTERN.test(directoryName)) return null;
  const skillFilePath = path.join(skillPath, "SKILL.md");
  const fileStat = await stat(skillFilePath).catch(() => null);
  if (!fileStat?.isFile()) return null;

  const raw = await readFile(skillFilePath, "utf8");
  const parsed = parseSkillMarkdown(raw);
  if (!parsed || parsed.name !== directoryName) return null;
  const now = fileStat.mtime.toISOString();
  return {
    id: skillIdForPath(source, skillPath),
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body.trim(),
    enabled: true,
    source,
    sourcePath: skillPath,
    skillFilePath,
    readonly: source === "external",
    createdAt: now,
    updatedAt: now
  };
}

async function writeSkillIfMissing(root: string, skill: { name: string; description: string; instructions: string }): Promise<void> {
  const name = skillSpecName(skill.name);
  const skillDir = path.join(root, name);
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const exists = await stat(skillFilePath).catch(() => null);
  if (exists?.isFile()) return;
  await writeSkillFile(skillDir, { ...skill, name });
}

async function writeSkillFile(skillDir: string, skill: { name: string; description: string; instructions: string }): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(skill.description)}`,
    "---",
    "",
    skill.instructions.trim(),
    ""
  ].join("\n"), "utf8");
}

async function uniqueSkillName(root: string, baseName: string): Promise<string> {
  let candidate = baseName;
  for (let index = 2; await pathExists(path.join(root, candidate)); index += 1) {
    candidate = `${baseName}-${index}`;
  }
  return candidate;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveEditorPath(currentEditorPath?: string): Promise<string | undefined> {
  const e2eEditorPath = process.env.JASMINE_E2E_EDITOR_PATH?.trim();
  if (e2eEditorPath) return e2eEditorPath;
  const configured = await resolveConfiguredExecutable("editor", currentEditorPath);
  if (configured) return configured.command;
  const detected = (await listExecutableDiscovery("editor")).auto;
  if (detected) return detected.command;

  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    title: "Choose a text editor for Jasmine skills",
    properties: ["openFile"],
    filters: process.platform === "win32"
      ? [{ name: "Applications", extensions: ["exe", "cmd", "bat"] }, { name: "All files", extensions: ["*"] }]
      : [{ name: "Applications", extensions: ["*"] }]
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function launchEditor(editorPath: string, skillFilePath: string): Promise<void> {
  const logPath = process.env.JASMINE_E2E_OPEN_EDITOR_LOG?.trim();
  if (logPath) {
    await appendFile(logPath, `${editorPath}\t${skillFilePath}\n`, "utf8");
    return;
  }
  const child = spawn(editorPath, [skillFilePath], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(editorPath)
  });
  child.unref();
}

async function defaultLocalSkills(): Promise<Array<{ name: string; description: string; instructions: string }>> {
  const bundled = await loadBundledDefaultLocalSkills();
  if (bundled.length > 0) return bundled;
  return [
    {
      name: "technical-writer",
      description: "Tightens explanations, examples, and docs for technical readers.",
      instructions: "When this skill is active, write with clear structure, concrete examples, and concise technical language. Call out assumptions and avoid vague filler."
    },
    {
      name: "code-reviewer",
      description: "Reviews code for bugs, regressions, tests, and maintainability.",
      instructions: "When this skill is active, prioritize concrete bugs, behavioral regressions, missing tests, and risky edge cases before style feedback."
    }
  ];
}

async function loadBundledDefaultLocalSkills(): Promise<Array<{ name: string; description: string; instructions: string }>> {
  const root = await resolveBundledSkillRoot();
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: Array<{ name: string; description: string; instructions: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".system") continue;
    const skillFilePath = path.join(root, entry.name, "SKILL.md");
    const fileStat = await stat(skillFilePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const parsed = parseSkillMarkdown(await readFile(skillFilePath, "utf8"));
    if (!parsed || parsed.name !== entry.name) continue;
    skills.push({
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.body.trim()
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveBundledSkillRoot(): Promise<string | null> {
  const candidates = [
    process.env.JASMINE_BUILTIN_SKILLS_ROOT,
    path.resolve(process.cwd(), "resources", "builtin-skills"),
    path.resolve(moduleDir, "..", "..", "..", "..", "resources", "builtin-skills"),
    path.resolve(moduleDir, "..", "..", "..", "resources", "builtin-skills")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isDirectory()) return candidate;
  }
  return null;
}

export function skillSpecName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "new-skill";
}

function yamlString(value: string): string {
  return JSON.stringify(value.trim());
}

function sortSkills(a: SkillRecord, b: SkillRecord): number {
  return a.name.localeCompare(b.name);
}
