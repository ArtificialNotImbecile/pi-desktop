import { useEffect, useState } from "react";
import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

const fallbackSettings: WebSearchSettings = {
  enabled: false,
  provider: "pi-web-access",
  maxResults: 4,
  timeoutMs: 7000,
  updatedAt: new Date(0).toISOString()
};

export function useWebSearch(options: {
  onError(error: string): void;
  onToast(message: string): void;
}) {
  const [settings, setSettings] = useState<WebSearchSettings>(fallbackSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setSettings(await getBridge().getWebSearchSettings());
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load web search settings."));
    } finally {
      setLoading(false);
    }
  }

  async function updateSettings(request: WebSearchSettingsUpdateRequest, toast = true): Promise<WebSearchSettings | null> {
    setSaving(true);
    try {
      const next = await getBridge().updateWebSearchSettings(request);
      setSettings(next);
      if (toast) options.onToast("Web search saved");
      return next;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save web search settings."));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    await updateSettings({ enabled }, false);
  }

  return {
    settings,
    loading,
    saving,
    refresh,
    updateSettings,
    setEnabled
  };
}
