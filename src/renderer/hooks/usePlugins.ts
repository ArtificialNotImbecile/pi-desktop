import { useEffect, useState } from "react";
import type { PluginPackageEnableRequest, PluginPackageInstallRequest, PluginPackageOperationRequest, PluginPackageRecord, SkillRecord } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function usePlugins(options: {
  onError(message: string | null): void;
  onToast(message: string): void;
}) {
  const [packages, setPackages] = useState<PluginPackageRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingSource, setSavingSource] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [nextPackages, nextSkills] = await Promise.all([
        getBridge().listPlugins(),
        getBridge().listPluginSkills()
      ]);
      setPackages(nextPackages);
      setSkills(nextSkills);
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load packages."));
    } finally {
      setLoading(false);
    }
  }

  async function install(request: PluginPackageInstallRequest) {
    setSavingSource("new");
    try {
      const next = await getBridge().installPlugin(request);
      setPackages(next);
      await refreshSkills();
      options.onToast("Package installed");
      return next;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to install package."));
      return null;
    } finally {
      setSavingSource(null);
    }
  }

  async function update(request: PluginPackageOperationRequest) {
    setSavingSource(request.source);
    try {
      const next = await getBridge().updatePlugin(request);
      setPackages(next);
      await refreshSkills();
      options.onToast("Package updated");
      return next;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update package."));
      return null;
    } finally {
      setSavingSource(null);
    }
  }

  async function remove(request: PluginPackageOperationRequest) {
    setSavingSource(request.source);
    try {
      const next = await getBridge().removePlugin(request);
      setPackages(next);
      await refreshSkills();
      options.onToast("Package removed");
      return next;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to remove package."));
      return null;
    } finally {
      setSavingSource(null);
    }
  }

  async function setEnabled(request: PluginPackageEnableRequest) {
    setSavingSource(request.source);
    try {
      const next = await getBridge().setPluginEnabled(request);
      setPackages(next);
      await refreshSkills();
      options.onToast(request.enabled ? "Package enabled" : "Package disabled");
      return next;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update package."));
      return null;
    } finally {
      setSavingSource(null);
    }
  }

  async function refreshSkills() {
    setSkills(await getBridge().listPluginSkills());
  }

  return {
    packages,
    skills,
    loading,
    savingSource,
    refresh,
    install,
    update,
    remove,
    setEnabled
  };
}
