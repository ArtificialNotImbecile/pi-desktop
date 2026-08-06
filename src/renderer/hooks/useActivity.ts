import { useEffect, useMemo, useState } from "react";
import type { ActivityObservation, ActivitySettings, ActivitySettingsUpdateRequest, ActivityStatus } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

const fallbackSettings: ActivitySettings = {
  enabled: false,
  paused: false,
  localOnly: true,
  captureWindowTitles: false,
  captureScreenshots: false,
  retentionDays: 30,
  updatedAt: new Date(0).toISOString()
};

export function useActivity(options: {
  open: boolean;
  onError(message: string | null): void;
  onToast(message: string): void;
}) {
  const [settings, setSettings] = useState<ActivitySettings>(fallbackSettings);
  const [observations, setObservations] = useState<ActivityObservation[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const status: ActivityStatus = useMemo(() => {
    if (!settings.enabled) return "disabled";
    return settings.paused ? "paused" : "running";
  }, [settings.enabled, settings.paused]);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    if (options.open) void refreshObservations(query);
  }, [options.open]);

  async function loadSettings() {
    try {
      setSettings(await getBridge().getActivitySettings());
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load activity settings."));
    }
  }

  async function updateSettings(request: ActivitySettingsUpdateRequest) {
    try {
      const next = await getBridge().updateActivitySettings(request);
      setSettings(next);
      options.onToast(activityStatusLabel(getActivityStatus(next)));
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update activity settings."));
    }
  }

  async function refreshObservations(nextQuery = query) {
    setLoading(true);
    try {
      setObservations(await getBridge().listActivityObservations({ query: nextQuery }));
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load activity observations."));
    } finally {
      setLoading(false);
    }
  }

  async function createManualObservation(note: string) {
    try {
      const observation = await getBridge().createManualActivityObservation({ note });
      if (!query.trim() || observation.note.toLowerCase().includes(query.toLowerCase())) {
        setObservations((current) => [observation, ...current]);
      }
      options.onToast("Activity saved");
      options.onError(null);
      return observation;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save activity observation."));
      return null;
    }
  }

  function setSearchQuery(next: string) {
    setQuery(next);
    void refreshObservations(next);
  }

  return {
    settings,
    status,
    observations,
    query,
    loading,
    loadSettings,
    updateSettings,
    refreshObservations,
    createManualObservation,
    setSearchQuery
  };
}

function getActivityStatus(settings: ActivitySettings): ActivityStatus {
  if (!settings.enabled) return "disabled";
  return settings.paused ? "paused" : "running";
}

function activityStatusLabel(status: ActivityStatus): string {
  if (status === "running") return "Activity running";
  if (status === "paused") return "Activity paused";
  return "Activity off";
}
