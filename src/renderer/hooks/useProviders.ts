import { useEffect, useMemo, useState } from "react";
import type { AiProvider, ProviderModelUpdateRequest, ProviderUpdateRequest } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useProviders(options: { onError(message: string): void; onToast(message: string): void }) {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [selectedProviderId, setSelectedProviderIdState] = useState(() => window.localStorage.getItem("jasmine.activeProviderId") ?? "");
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [fetchingModelsProviderId, setFetchingModelsProviderId] = useState<string | null>(null);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers.find((provider) => provider.enabled) ?? providers[0] ?? null,
    [providers, selectedProviderId]
  );

  useEffect(() => {
    void refreshProviders();
  }, []);

  useEffect(() => {
    if (!activeProvider) return;
    if (selectedProviderId !== activeProvider.id) setSelectedProviderId(activeProvider.id);
  }, [activeProvider?.id, selectedProviderId]);

  async function refreshProviders() {
    try {
      setProviders(await getBridge().listProviders());
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load providers."));
    } finally {
      setLoadingProviders(false);
    }
  }

  function setSelectedProviderId(providerId: string) {
    setSelectedProviderIdState(providerId);
    window.localStorage.setItem("jasmine.activeProviderId", providerId);
  }

  async function updateProvider(request: ProviderUpdateRequest) {
    try {
      const updated = await getBridge().updateProvider(request);
      setProviders((current) => current.map((provider) => (provider.id === updated.id ? updated : provider)));
      options.onToast("Provider saved");
      return updated;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save provider."));
      return null;
    }
  }

  async function testProvider(providerId: string) {
    setTestingProviderId(providerId);
    try {
      const result = await getBridge().testProvider(providerId);
      setProviders((current) => current.map((provider) => (provider.id === result.provider.id ? result.provider : provider)));
      if (result.status === "connected") options.onToast("Provider connected");
      if (result.status === "missing_key") options.onToast("Provider key missing");
      if (result.status === "failed") options.onToast("Provider test failed");
      return result;
    } catch (caught) {
      options.onError(errorMessage(caught, "Provider test failed."));
      return null;
    } finally {
      setTestingProviderId(null);
    }
  }

  async function fetchProviderModels(providerId: string) {
    setFetchingModelsProviderId(providerId);
    try {
      const result = await getBridge().fetchProviderModels(providerId);
      setProviders((current) => current.map((provider) => (provider.id === result.provider.id ? result.provider : provider)));
      if (result.models.length > 0) options.onToast("Models loaded");
      else options.onToast("No models loaded");
      return result;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to fetch models."));
      return null;
    } finally {
      setFetchingModelsProviderId(null);
    }
  }

  async function updateProviderModel(request: ProviderModelUpdateRequest) {
    try {
      const updated = await getBridge().updateProviderModel(request);
      setProviders((current) => current.map((provider) => (provider.id === updated.id ? updated : provider)));
      options.onToast("Model saved");
      return updated;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save model."));
      return null;
    }
  }

  return {
    providers,
    activeProvider,
    selectedProviderId: activeProvider?.id ?? selectedProviderId,
    setSelectedProviderId,
    loadingProviders,
    testingProviderId,
    fetchingModelsProviderId,
    refreshProviders,
    updateProvider,
    testProvider,
    fetchProviderModels,
    updateProviderModel
  };
}
