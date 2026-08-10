import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillRecord } from "../../shared/ipc.js";

export type RuntimeSkillManifest = {
  id: string;
  name: string;
  description: string;
  source: SkillRecord["source"];
  skillFilePath: string;
};

export async function prepareSkillManifests(skills: SkillRecord[], userDataDir: string): Promise<RuntimeSkillManifest[]> {
  return Promise.all(skills.map((skill) => prepareSkillManifest(skill, userDataDir)));
}

export async function prepareEnabledSkillManifests(skills: SkillRecord[], userDataDir: string): Promise<RuntimeSkillManifest[]> {
  return prepareSkillManifests(skills.filter((skill) => skill.enabled), userDataDir);
}

async function prepareSkillManifest(skill: SkillRecord, userDataDir: string): Promise<RuntimeSkillManifest> {
  if (skill.skillFilePath || skill.sourcePath) {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      skillFilePath: skill.skillFilePath ?? path.join(skill.sourcePath ?? "", "SKILL.md")
    };
  }

  const skillDir = path.join(userDataDir, "skills", "local", safePathSegment(specName(skill.name)));
  const skillFilePath = path.join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFilePath, localSkillMarkdown(skill), "utf8");
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    skillFilePath
  };
}

function localSkillMarkdown(skill: SkillRecord): string {
  return [
    "---",
    `name: ${yamlString(specName(skill.name))}`,
    `description: ${yamlString(skill.description)}`,
    "---",
    "",
    `# ${skill.name.trim()}`,
    "",
    skill.instructions.trim(),
    ""
  ].join("\n");
}

function specName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "local-skill";
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 96) || "skill";
}

function yamlString(value: string): string {
  return JSON.stringify(value.trim());
}
