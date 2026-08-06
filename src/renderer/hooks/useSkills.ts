import { useEffect, useMemo, useState } from "react";
import type { SkillCreateRequest, SkillRecord, SkillSource, SkillUpdateRequest } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useSkills(options: {
  onError(message: string | null): void;
  onToast(message: string): void;
}) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedSkillIds.includes(skill.id) && skill.enabled),
    [skills, selectedSkillIds]
  );

  async function refresh() {
    setLoading(true);
    try {
      const [nextSkills, nextSources] = await Promise.all([
        getBridge().listSkills(),
        getBridge().listSkillSources()
      ]);
      setSkills(nextSkills);
      setSources(nextSources);
      setSelectedSkillIds((current) => {
        const validCurrent = current.filter((id) => nextSkills.some((skill) => skill.id === id && skill.enabled));
        return validCurrent;
      });
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load skills."));
    } finally {
      setLoading(false);
    }
  }

  function toggleSelected(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill?.enabled) return;
    setSelectedSkillIds((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId]
    );
  }

  async function createSkill(request: SkillCreateRequest) {
    try {
      const skill = await getBridge().createSkill(request);
      setSkills((current) => [skill, ...current].sort(sortSkills));
      options.onToast("Skill file created");
      return skill;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to create skill."));
      return null;
    }
  }

  async function updateSkill(request: SkillUpdateRequest) {
    try {
      const skill = await getBridge().updateSkill(request);
      setSkills((current) => current.map((item) => item.id === skill.id ? skill : item).sort(sortSkills));
      if (!skill.enabled) setSelectedSkillIds((current) => current.filter((id) => id !== skill.id));
      options.onToast("Skill updated");
      return skill;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update skill."));
      return null;
    }
  }

  async function deleteSkill(id: string) {
    try {
      await getBridge().deleteSkill(id);
      setSkills((current) => current.filter((skill) => skill.id !== id));
      setSelectedSkillIds((current) => current.filter((skillId) => skillId !== id));
      options.onToast("Skill deleted");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to delete skill."));
    }
  }

  async function openSkill(id: string) {
    try {
      const result = await getBridge().openSkill(id);
      setSkills((current) => current.map((skill) => skill.id === result.skill.id ? result.skill : skill).sort(sortSkills));
      options.onToast("Skill opened in editor");
      return result;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to open skill."));
      return null;
    }
  }

  async function addSkillSourcesFromPicker() {
    try {
      const paths = await getBridge().pickSkillFolders();
      for (const sourcePath of paths) {
        await getBridge().addSkillSource({ path: sourcePath });
      }
      if (paths.length > 0) options.onToast(paths.length === 1 ? "Skill folder added" : "Skill folders added");
      await refresh();
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to add skill folder."));
    }
  }

  async function deleteSkillSource(id: string) {
    try {
      await getBridge().deleteSkillSource(id);
      await refresh();
      options.onToast("Skill folder removed");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to remove skill folder."));
    }
  }

  return {
    skills,
    sources,
    selectedSkills,
    selectedSkillIds,
    loading,
    refresh,
    addSkillSourcesFromPicker,
    deleteSkillSource,
    toggleSelected,
    createSkill,
    updateSkill,
    deleteSkill,
    openSkill
  };
}

function sortSkills(a: SkillRecord, b: SkillRecord) {
  return a.name.localeCompare(b.name);
}
