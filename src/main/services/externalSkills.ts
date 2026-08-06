import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillRecord, SkillSource } from "../../shared/ipc.js";
import { SKILL_NAME_PATTERN, parseSkillMarkdown, skillIdForPath } from "./skillMarkdown.js";

export async function loadExternalSkills(sources: SkillSource[]): Promise<SkillRecord[]> {
  const batches = await Promise.all(sources.map((source) => loadSkillsFromSource(source).catch(() => [])));
  return batches.flat().sort(sortSkills);
}

async function loadSkillsFromSource(source: SkillSource): Promise<SkillRecord[]> {
  const entries = await readdir(source.path, { withFileTypes: true });
  const skills: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".system") continue;
    const skill = await loadSkillDirectory(source, path.join(source.path, entry.name), entry.name).catch(() => null);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function loadSkillDirectory(source: SkillSource, skillPath: string, directoryName: string): Promise<SkillRecord | null> {
  if (!SKILL_NAME_PATTERN.test(directoryName)) return null;
  const skillFile = path.join(skillPath, "SKILL.md");
  const fileStat = await stat(skillFile).catch(() => null);
  if (!fileStat?.isFile()) return null;

  const raw = await readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(raw);
  if (!parsed || parsed.name !== directoryName) return null;
  if (!parsed.body.trim()) return null;

  const now = source.updatedAt;
  return {
    id: skillIdForPath("external", skillPath),
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body.trim(),
    enabled: true,
    source: "external",
    sourcePath: skillPath,
    skillFilePath: skillFile,
    readonly: true,
    createdAt: now,
    updatedAt: now
  };
}

function sortSkills(a: SkillRecord, b: SkillRecord): number {
  return a.name.localeCompare(b.name);
}
