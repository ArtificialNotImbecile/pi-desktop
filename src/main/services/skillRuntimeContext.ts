import type { PluginReference, SkillRecord, SkillReference } from "../../shared/ipc.js";

export function mergeRuntimeSkills(...groups: Array<SkillRecord[]>): SkillRecord[] {
  const seen = new Set<string>();
  const merged: SkillRecord[] = [];
  for (const skill of groups.flat()) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    merged.push(skill);
  }
  return merged;
}

export function skillReferenceIds(skills: SkillReference[] | undefined): string[] {
  return Array.from(new Set((skills ?? []).map((skill) => skill.id).filter(Boolean)));
}

export function pluginReferenceIds(plugins: PluginReference[] | undefined): string[] {
  return Array.from(new Set((plugins ?? []).map((plugin) => plugin.id).filter(Boolean)));
}
