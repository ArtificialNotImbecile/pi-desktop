import type { PluginPackageRecord, PluginReference, SkillRecord, SkillReference } from "../../shared/ipc";

export function optimisticChatReferences(options: {
  inlineSkillIds: readonly string[];
  inlinePluginIds: readonly string[];
  skillChoices: readonly SkillRecord[];
  pluginChoices: readonly PluginPackageRecord[];
}): { skillsUsed: SkillReference[]; pluginsUsed: PluginReference[] } {
  const wantedSkillIds = new Set(options.inlineSkillIds);
  const seenSkillIds = new Set<string>();
  const requestedNonPluginSkills = options.inlineSkillIds.flatMap((id) => {
    if (seenSkillIds.has(id)) return [];
    const skill = options.skillChoices.find((candidate) => candidate.id === id && candidate.source !== "plugin");
    if (!skill?.enabled) return [];
    seenSkillIds.add(id);
    return [skill];
  });
  // Main resolves local/external skills in request order, then appends package
  // skills in the canonical order returned by the package manager. Mirror that
  // grouping so settlement does not move already-painted skill badges.
  const canonicalPluginSkills = options.skillChoices.flatMap((skill) => {
    if (skill.source !== "plugin" || !skill.enabled || !wantedSkillIds.has(skill.id) || seenSkillIds.has(skill.id)) return [];
    seenSkillIds.add(skill.id);
    return [skill];
  });
  const skillsUsed = [...requestedNonPluginSkills, ...canonicalPluginSkills].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions
  }));
  const wantedPluginIds = new Set(options.inlinePluginIds);
  // The main process resolves package references by filtering its sorted
  // package list. Preserve that same canonical order here so settlement can
  // replace the optimistic row without reordering its badges.
  const pluginsUsed = options.pluginChoices
    .filter((plugin) => wantedPluginIds.has(plugin.id))
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.displayName,
      source: plugin.source,
      scope: plugin.scope,
      enabled: plugin.enabled
    }));
  return { skillsUsed, pluginsUsed };
}
