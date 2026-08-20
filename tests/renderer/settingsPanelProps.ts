import type { ComponentProps } from "react";
import type { AiProvider, AppSettings } from "../../src/shared/ipc";
import { DEFAULT_APPEARANCE } from "../../src/shared/theme";
import type { ProviderSettingsPanel } from "../../src/renderer/components/settings/ProviderSettingsPanel";

type PanelProps = ComponentProps<typeof ProviderSettingsPanel>;

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const fakeProvider: AiProvider = {
  id: "provider-1",
  name: "Fake Provider",
  type: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  apiKeyRef: "provider-1-key",
  models: [],
  defaultModel: "",
  enabled: true,
  status: "unchecked",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP
};

export const fakeAppSettings: AppSettings = {
  toolModel: { providerId: "provider-1", modelId: "fake-model", reasoningEffort: "medium", updatedAt: TIMESTAMP },
  appearance: { ...DEFAULT_APPEARANCE, updatedAt: TIMESTAMP },
  brand: { logoDataUrl: null, mainTitle: "Jasmine", subtitle: "Test", updatedAt: TIMESTAMP },
  language: "en",
  workingNotifications: { mode: "background", includeDetails: true },
  permissionMode: "ask",
  fileChangeTrackingMode: "managed-tools-only"
};

/**
 * Minimum viable props for mounting the settings panel. Callbacks resolve
 * without doing anything: these tests are about the panel's own chrome, and a
 * test that needs a callback observed should override it explicitly.
 */
export function settingsPanelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    open: true,
    initialSection: "providers",
    providers: [fakeProvider],
    selectedProviderId: fakeProvider.id,
    provider: fakeProvider,
    testingProviderId: null,
    fetchingModelsProviderId: null,
    memories: [],
    activitySettings: {
      enabled: false,
      paused: false,
      localOnly: true,
      captureWindowTitles: false,
      captureScreenshots: false,
      retentionDays: 30,
      updatedAt: TIMESTAMP
    },
    activityStatus: "disabled",
    appSettings: fakeAppSettings,
    appSettingsLoading: false,
    appSettingsSaving: false,
    skills: [],
    skillSources: [],
    promptTemplates: [],
    promptTemplateSources: [],
    promptTemplatesLoading: false,
    selectedSkillIds: [],
    plugins: [],
    pluginsLoading: false,
    pluginSavingSource: null,
    remoteProfiles: [],
    remoteWorkspaces: [],
    remoteStatuses: {},
    selectedRemoteProfileId: null,
    onSelectRemoteProfile: () => {},
    onAddRemoteProfile: () => {},
    onAddRemoteWorkspace: () => {},
    onRemoveRemoteProfile: async () => {},
    onCheckRemoteProfile: async () => null,
    onInstallRemoteRuntime: async () => false,
    onStopRemoteProfile: async () => false,
    onSelectProvider: () => {},
    onNavigateSection: () => {},
    onClose: () => {},
    onOpenMemory: () => {},
    onOpenActivity: () => {},
    onUpdateAppSettings: async () => fakeAppSettings,
    onToggleSelectedSkill: () => {},
    onRefreshSkills: () => {},
    onAddSkillSources: () => {},
    onDeleteSkillSource: () => {},
    onCreateSkill: async () => null,
    onUpdateSkill: async () => null,
    onDeleteSkill: async () => {},
    onOpenSkill: async () => null,
    onRefreshPromptTemplates: () => {},
    onAddPromptTemplateSources: () => {},
    onDeletePromptTemplateSource: () => {},
    onRefreshPlugins: () => {},
    onInstallPlugin: async () => null,
    onUpdatePlugin: async () => null,
    onRemovePlugin: async () => null,
    onSetPluginEnabled: async () => null,
    onSave: async () => fakeProvider,
    onTest: async () => null,
    onFetchModels: async () => null,
    onUpdateModel: async () => null,
    ...overrides
  };
}
