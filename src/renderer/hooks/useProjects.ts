import { useEffect, useState } from "react";
import type { WorkspaceProject } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useProjects(options: {
  onError(message: string): void;
  onToast(message: string): void;
  onProjectOpened?(project: WorkspaceProject): void;
}) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  useEffect(() => {
    void refresh();
    return getBridge().onProjectOpened((project) => {
      void refresh();
      options.onToast(`Opened ${project.name}`);
      options.onProjectOpened?.(project);
    });
  }, []);

  async function refresh() {
    try {
      const nextProjects = await getBridge().listProjects();
      setProjects(nextProjects);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load projects."));
    } finally {
      setLoadingProjects(false);
    }
  }

  async function openFolder(): Promise<WorkspaceProject | null> {
    try {
      const project = await getBridge().openProjectFolder();
      if (!project) return null;
      await refresh();
      options.onToast(`Opened ${project.name}`);
      return project;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to open folder."));
      return null;
    }
  }

  async function renameProject(projectId: string, name: string): Promise<boolean> {
    try {
      const updated = await getBridge().renameProject({ id: projectId, name });
      setProjects((current) => current.map((project) => (project.id === projectId ? updated : project)));
      options.onToast("Project renamed");
      return true;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to rename project."));
      return false;
    }
  }

  async function removeProject(projectId: string): Promise<boolean> {
    try {
      await getBridge().removeProject({ id: projectId });
      await refresh();
      options.onToast("Project removed");
      return true;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to remove project."));
      return false;
    }
  }

  async function openProjectInExplorer(projectId: string): Promise<boolean> {
    try {
      await getBridge().openProjectInExplorer({ id: projectId });
      options.onToast("Opened project in Explorer");
      return true;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to open project in Explorer."));
      return false;
    }
  }

  return {
    projects,
    loadingProjects,
    refreshProjects: refresh,
    openFolder,
    renameProject,
    removeProject,
    openProjectInExplorer
  };
}
