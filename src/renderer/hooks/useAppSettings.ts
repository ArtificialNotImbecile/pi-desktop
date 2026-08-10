import { useEffect, useState } from "react";
import type { AppSettings, AppSettingsUpdateRequest } from "../../shared/ipc";
import { DEFAULT_BRAND_SETTINGS, isSupportedBrandLogoDataUrl, normalizeLegacyBrandSettings } from "../../shared/brand";
import { DEFAULT_APPEARANCE } from "../../shared/theme";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export const APP_SETTINGS_STARTUP_CACHE_KEY = "jasmine.appSettings.startup";

export const defaultAppSettings: AppSettings = {
  toolModel: {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "off",
    updatedAt: ""
  },
  appearance: {
    ...DEFAULT_APPEARANCE,
    updatedAt: ""
  },
  brand: {
    ...DEFAULT_BRAND_SETTINGS,
    updatedAt: ""
  },
  language: "en",
  chromeTakeover: {
    enabled: false,
    extensionId: null
  },
  workingNotifications: {
    mode: "background",
    includeDetails: true
  },
  permissionMode: "ask"
};

export function useAppSettings(
  options: { onError(message: string): void; onToast(message: string): void },
  initialSettings?: AppSettings
) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings ?? defaultAppSettings);
  const [loading, setLoading] = useState(!initialSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const next = await getBridge().getAppSettings();
      setSettings(next);
      writeStartupSettingsCache(next);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load app settings."));
    } finally {
      setLoading(false);
    }
  }

  async function updateSettings(request: AppSettingsUpdateRequest): Promise<AppSettings | null> {
    setSaving(true);
    try {
      const updated = await getBridge().updateAppSettings(request);
      setSettings(updated);
      writeStartupSettingsCache(updated);
      options.onToast("Settings saved");
      return updated;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save app settings."));
      return null;
    } finally {
      setSaving(false);
    }
  }

  return {
    settings,
    loading,
    saving,
    refresh,
    updateSettings
  };
}

export function readStartupSettingsCache(): AppSettings | null {
  try {
    const value = window.localStorage.getItem(APP_SETTINGS_STARTUP_CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<AppSettings>;
    if (
      (parsed.language !== "en" && parsed.language !== "zh") ||
      !parsed.appearance ||
      typeof parsed.appearance.accent !== "string" ||
      typeof parsed.appearance.surface !== "string" ||
      typeof parsed.appearance.ink !== "string" ||
      typeof parsed.appearance.success !== "string" ||
      typeof parsed.appearance.danger !== "string" ||
      !parsed.brand ||
      (parsed.brand.logoDataUrl !== null && (typeof parsed.brand.logoDataUrl !== "string" || !isSupportedBrandLogoDataUrl(parsed.brand.logoDataUrl))) ||
      typeof parsed.brand.mainTitle !== "string" ||
      typeof parsed.brand.subtitle !== "string" ||
      !parsed.chromeTakeover ||
      typeof parsed.chromeTakeover.enabled !== "boolean" ||
      (parsed.chromeTakeover.extensionId !== null && typeof parsed.chromeTakeover.extensionId !== "string") ||
      !parsed.workingNotifications ||
      !["background", "always", "never"].includes(parsed.workingNotifications.mode) ||
      typeof parsed.workingNotifications.includeDetails !== "boolean" ||
      (parsed.permissionMode !== "ask" && parsed.permissionMode !== "full-access") ||
      !parsed.toolModel ||
      typeof parsed.toolModel.providerId !== "string" ||
      typeof parsed.toolModel.modelId !== "string" ||
      typeof parsed.toolModel.reasoningEffort !== "string"
    ) return null;
    const settings = parsed as AppSettings;
    return {
      ...settings,
      brand: normalizeLegacyBrandSettings(settings.brand)
    };
  } catch {
    return null;
  }
}

export function writeStartupSettingsCache(settings: AppSettings): void {
  window.localStorage.setItem(APP_SETTINGS_STARTUP_CACHE_KEY, JSON.stringify(settings));
}
