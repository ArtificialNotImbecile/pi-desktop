import { useEffect, useState } from "react";
import type { PromptTemplateRecord, PromptTemplateSource } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function usePromptTemplates(options: {
  onError(error: string): void;
  onToast(message: string): void;
}) {
  const [templates, setTemplates] = useState<PromptTemplateRecord[]>([]);
  const [sources, setSources] = useState<PromptTemplateSource[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [nextTemplates, nextSources] = await Promise.all([
        getBridge().listPromptTemplates(),
        getBridge().listPromptTemplateSources()
      ]);
      setTemplates(nextTemplates);
      setSources(nextSources);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load prompt templates."));
    } finally {
      setLoading(false);
    }
  }

  async function addSourcesFromPicker() {
    try {
      const paths = await getBridge().pickPromptTemplatePaths();
      for (const sourcePath of paths) {
        await getBridge().addPromptTemplateSource({ path: sourcePath });
      }
      if (paths.length > 0) options.onToast("Prompt templates added");
      await refresh();
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to add prompt templates."));
    }
  }

  async function deleteSource(id: string) {
    try {
      await getBridge().deletePromptTemplateSource(id);
      await refresh();
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to remove prompt template source."));
    }
  }

  return {
    templates,
    sources,
    loading,
    refresh,
    addSourcesFromPicker,
    deleteSource
  };
}
