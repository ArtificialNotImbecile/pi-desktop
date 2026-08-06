import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type {
  ActivitySettings,
  ActivityStatus,
  AppSettings,
  AppSettingsUpdateRequest,
  AiProvider,
  MemoryRecord,
  McpMarketplaceServer,
  McpServerCreateRequest,
  McpServerRecord,
  McpServerUpdateRequest,
  ModelCapabilities,
  PluginPackageRecord,
  ProviderUpdateRequest,
  PromptTemplateRecord,
  PromptTemplateSource,
  RemoteConnectionCreateRequest,
  RemoteConnectionRecord,
  RemoteConnectionUpdateRequest,
  SkillCreateRequest,
  SkillOpenResponse,
  SkillRecord,
  SkillSource,
  SkillUpdateRequest,
  WebSearchSettings,
  WebSearchSettingsUpdateRequest
} from "../../../shared/ipc";
import { ActivityIcon, BrainIcon, EyeIcon, InfoIcon, PlugIcon, SearchIcon, SettingsIcon, SkillIcon, TerminalIcon } from "../icons/Icons";
import { LocalSettingsPage } from "./LocalSettingsPage";
import { ProviderDetailPage } from "./ProviderDetailPage";
import { RemoteConnectionsSettingsPage } from "./RemoteConnectionsSettingsPage";
import { useI18n } from "../../i18n";
import { FadeScale } from "../ui";
import type { SettingsSection } from "../../navigation/routes";
export type { SettingsSection } from "../../navigation/routes";

export function ProviderSettingsPanel(props: {
  open: boolean;
  initialSection: SettingsSection;
  providers: AiProvider[];
  selectedProviderId: string;
  provider: AiProvider | null;
  testingProviderId: string | null;
  fetchingModelsProviderId: string | null;
  memories: MemoryRecord[];
  activitySettings: ActivitySettings;
  activityStatus: ActivityStatus;
  appSettings: AppSettings;
  appSettingsLoading: boolean;
  appSettingsSaving: boolean;
  skills: SkillRecord[];
  skillSources: SkillSource[];
  promptTemplates: PromptTemplateRecord[];
  promptTemplateSources: PromptTemplateSource[];
  promptTemplatesLoading: boolean;
  selectedSkillIds: string[];
  mcpMarketplace: McpMarketplaceServer[];
  mcpServers: McpServerRecord[];
  installedMcpMarketplaceIds: Set<string>;
  mcpMarketplaceLoading: boolean;
  mcpServersLoading: boolean;
  mcpSavingServerId: string | null;
  plugins: PluginPackageRecord[];
  pluginsLoading: boolean;
  pluginSavingSource: string | null;
  remoteConnections: RemoteConnectionRecord[];
  remoteConnectionsLoading: boolean;
  remoteConnectionSavingId: string | null;
  webSearchSettings: WebSearchSettings;
  webSearchLoading: boolean;
  webSearchSaving: boolean;
  onSelectProvider(providerId: string): void;
  onNavigateSection?(section: SettingsSection, providerId?: string): void;
  onClose(): void;
  onOpenMemory(): void;
  onOpenActivity(): void;
  onUpdateAppSettings(request: AppSettingsUpdateRequest): Promise<AppSettings | null>;
  onToggleSelectedSkill(skillId: string): void;
  onRefreshSkills(): void;
  onAddSkillSources(): void;
  onDeleteSkillSource(id: string): void;
  onCreateSkill(request: SkillCreateRequest): Promise<SkillRecord | null>;
  onUpdateSkill(request: SkillUpdateRequest): Promise<SkillRecord | null>;
  onDeleteSkill(id: string): Promise<void>;
  onOpenSkill(id: string): Promise<SkillOpenResponse | null>;
  onRefreshPromptTemplates(): void;
  onAddPromptTemplateSources(): void;
  onDeletePromptTemplateSource(id: string): void;
  onMcpMarketplaceOpened(): void;
  onRefreshMcpMarketplace(request?: { query?: string; category?: string }): void;
  onRefreshMcpServers(): void;
  onInstallMcpServer(server: McpMarketplaceServer): void;
  onCreateMcpServer(request: McpServerCreateRequest): Promise<McpServerRecord | null>;
  onUpdateMcpServer(request: McpServerUpdateRequest): void;
  onDeleteMcpServer(id: string): void;
  onRefreshPlugins(): void;
  onInstallPlugin(source: string): Promise<unknown>;
  onUpdatePlugin(source: string, scope: PluginPackageRecord["scope"]): Promise<unknown>;
  onRemovePlugin(source: string, scope: PluginPackageRecord["scope"]): Promise<unknown>;
  onSetPluginEnabled(source: string, scope: PluginPackageRecord["scope"], enabled: boolean): Promise<unknown>;
  onRefreshRemoteConnections(): void;
  onImportRemoteConnections(): void;
  onCreateRemoteConnection(request: RemoteConnectionCreateRequest): Promise<RemoteConnectionRecord | null>;
  onUpdateRemoteConnection(request: RemoteConnectionUpdateRequest): Promise<RemoteConnectionRecord | null>;
  onDeleteRemoteConnection(id: string): void;
  onTestRemoteConnection(id: string): void;
  onSave(request: ProviderUpdateRequest): Promise<AiProvider | null>;
  onTest(providerId: string): Promise<unknown>;
  onFetchModels(providerId: string): Promise<unknown>;
  onUpdateModel(request: {
    providerId: string;
    modelId: string;
    enabled?: boolean;
    capabilities?: Partial<ModelCapabilities>;
    contextWindow?: number;
    maxOutputTokens?: number;
    providerOptionsJson?: string;
  }): Promise<unknown>;
  onUpdateWebSearch(request: WebSearchSettingsUpdateRequest): Promise<WebSearchSettings | null>;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(props.initialSection);
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState({ left: 120, top: 56 });
  const detailRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useEffect(() => {
    if (props.open) {
      setSection(props.initialSection);
      setMinimized(false);
      setPosition({
        left: Math.max(24, Math.round((window.innerWidth - 980) / 2)),
        top: Math.max(24, Math.round((window.innerHeight - 680) / 2))
      });
    }
  }, [props.open, props.initialSection]);

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [props.provider?.id]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", onDragMove);
  }, []);

  if (!props.open || !props.provider) return null;

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (maximized) return;
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", stopDrag, { once: true });
  }

  function onDragMove(event: globalThis.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    setPosition({
      left: clamp(drag.left + event.clientX - drag.startX, 12, window.innerWidth - 320),
      top: clamp(drag.top + event.clientY - drag.startY, 12, window.innerHeight - 48)
    });
  }

  function stopDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
  }

  return (
    <div className="settings-backdrop">
      <FadeScale
        className={`settings-panel ${section === "providers" ? "has-subnav" : "single-nav"} ${maximized ? "maximized" : ""} ${minimized ? "minimized" : ""}`}
        style={maximized ? undefined : { left: position.left, top: position.top }}
        aria-label={t("app.settings")}
        duration={0.16}
      >
        <header className="settings-window-bar" onPointerDown={startDrag}>
          <strong>{t("app.settings")}</strong>
          <div className="settings-window-controls" aria-label={t("settings.windowControls")}>
            <button className="settings-window-control minimize" type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? t("settings.restoreSettings") : t("settings.minimizeSettings")} title={minimized ? t("settings.restoreSettings") : t("settings.minimizeSettings")}><span /></button>
            <button className={`settings-window-control ${maximized ? "restore" : "maximize"}`} type="button" onClick={() => { setMaximized((value) => !value); setMinimized(false); }} aria-label={maximized ? t("settings.restoreSettingsSize") : t("settings.maximizeSettings")} title={maximized ? t("settings.restoreSettingsSize") : t("settings.maximizeSettings")}><span /></button>
            <button className="settings-window-control close" type="button" onClick={props.onClose} aria-label={t("settings.closeSettings")} title={t("settings.closeSettings")}><span /></button>
          </div>
        </header>

        {!minimized && <nav className="settings-nav">
          <strong>{t("app.settings")}</strong>
          <button className={section === "general" ? "active" : ""} type="button" onClick={() => selectSection("general")}><SettingsIcon /><span>{t("settings.nav.general")}</span></button>
          <button className={section === "providers" ? "active" : ""} type="button" onClick={() => selectSection("providers", props.selectedProviderId)}><TerminalIcon /><span>{t("settings.nav.providers")}</span></button>
          <button className={section === "appearance" ? "active" : ""} type="button" onClick={() => selectSection("appearance")}><EyeIcon /><span>{t("settings.nav.appearance")}</span></button>
          <button className={section === "memory" ? "active" : ""} type="button" onClick={() => selectSection("memory")}><BrainIcon /><span>{t("settings.nav.memory")}</span></button>
          <button className={section === "skills" ? "active" : ""} type="button" onClick={() => selectSection("skills")}><SkillIcon /><span>{t("settings.nav.skills")}</span></button>
          <button className={section === "plugins" ? "active" : ""} type="button" onClick={() => selectSection("plugins")}><PlugIcon /><span>{t("settings.nav.plugins")}</span></button>
          <button className={section === "chrome" ? "active" : ""} type="button" onClick={() => selectSection("chrome")}><PlugIcon /><span>{t("settings.nav.chrome")}</span></button>
          <button className={section === "prompts" ? "active" : ""} type="button" onClick={() => selectSection("prompts")}><TerminalIcon /><span>{t("settings.nav.prompts")}</span></button>
          <button className={section === "remote" ? "active" : ""} type="button" onClick={() => selectSection("remote")}><TerminalIcon /><span>{t("settings.nav.remote")}</span></button>
          <button className={section === "mcp" ? "active" : ""} type="button" onClick={() => selectSection("mcp")}><PlugIcon /><span>{t("settings.nav.mcp")}</span></button>
          <button className={section === "activity" ? "active" : ""} type="button" onClick={() => selectSection("activity")}><ActivityIcon /><span>{t("settings.nav.activity")}</span></button>
          <button className={section === "webSearch" ? "active" : ""} type="button" onClick={() => selectSection("webSearch")}><SearchIcon /><span>{t("settings.nav.webSearch")}</span></button>
          <button className={section === "about" ? "active" : ""} type="button" onClick={() => selectSection("about")}><InfoIcon /><span>{t("settings.nav.about")}</span></button>
        </nav>}

        {!minimized && section === "providers" && (
          <aside className="settings-subnav" aria-label={t("settings.providerList")}>
            <span className="settings-nav-label">{t("settings.nav.providers")}</span>
            {props.providers.map((provider) => (
              <button
                key={provider.id}
                className={provider.id === props.selectedProviderId ? "active" : ""}
                type="button"
                onClick={() => {
                  props.onSelectProvider(provider.id);
                  props.onNavigateSection?.("providers", provider.id);
                }}
              >
                <span>{provider.name}</span>
                <small>{provider.defaultModel}</small>
              </button>
            ))}
          </aside>
        )}

        {!minimized && <div className="settings-detail" ref={detailRef}>
          {section === "providers" ? (
            <ProviderDetailPage
              provider={props.provider}
              isTesting={props.testingProviderId === props.provider.id}
              isFetchingModels={props.fetchingModelsProviderId === props.provider.id}
              onSave={props.onSave}
              onTest={props.onTest}
              onFetchModels={props.onFetchModels}
              onUpdateModel={props.onUpdateModel}
            />
          ) : section === "remote" ? (
            <RemoteConnectionsSettingsPage
              connections={props.remoteConnections}
              loading={props.remoteConnectionsLoading}
              savingId={props.remoteConnectionSavingId}
              onClose={props.onClose}
              onRefresh={props.onRefreshRemoteConnections}
              onImport={props.onImportRemoteConnections}
              onCreate={props.onCreateRemoteConnection}
              onUpdate={props.onUpdateRemoteConnection}
              onDelete={props.onDeleteRemoteConnection}
              onTest={props.onTestRemoteConnection}
            />
          ) : (
            <LocalSettingsPage
              section={section}
              providers={props.providers}
              memories={props.memories}
              activitySettings={props.activitySettings}
              activityStatus={props.activityStatus}
              appSettings={props.appSettings}
              appSettingsLoading={props.appSettingsLoading}
              appSettingsSaving={props.appSettingsSaving}
              skills={props.skills}
              skillSources={props.skillSources}
              promptTemplates={props.promptTemplates}
              promptTemplateSources={props.promptTemplateSources}
              promptTemplatesLoading={props.promptTemplatesLoading}
              selectedSkillIds={props.selectedSkillIds}
              mcpMarketplace={props.mcpMarketplace}
              mcpServers={props.mcpServers}
              installedMcpMarketplaceIds={props.installedMcpMarketplaceIds}
              mcpMarketplaceLoading={props.mcpMarketplaceLoading}
              mcpServersLoading={props.mcpServersLoading}
              mcpSavingServerId={props.mcpSavingServerId}
              plugins={props.plugins}
              pluginsLoading={props.pluginsLoading}
              pluginSavingSource={props.pluginSavingSource}
              webSearchSettings={props.webSearchSettings}
              webSearchLoading={props.webSearchLoading}
              webSearchSaving={props.webSearchSaving}
              onClose={props.onClose}
              onOpenMemory={props.onOpenMemory}
              onOpenActivity={props.onOpenActivity}
              onUpdateAppSettings={props.onUpdateAppSettings}
              onToggleSelectedSkill={props.onToggleSelectedSkill}
              onRefreshSkills={props.onRefreshSkills}
              onAddSkillSources={props.onAddSkillSources}
              onDeleteSkillSource={props.onDeleteSkillSource}
              onCreateSkill={props.onCreateSkill}
              onUpdateSkill={props.onUpdateSkill}
              onDeleteSkill={props.onDeleteSkill}
              onOpenSkill={props.onOpenSkill}
              onRefreshPromptTemplates={props.onRefreshPromptTemplates}
              onAddPromptTemplateSources={props.onAddPromptTemplateSources}
              onDeletePromptTemplateSource={props.onDeletePromptTemplateSource}
              onMcpMarketplaceOpened={props.onMcpMarketplaceOpened}
              onRefreshMcpMarketplace={props.onRefreshMcpMarketplace}
              onRefreshMcpServers={props.onRefreshMcpServers}
              onInstallMcpServer={props.onInstallMcpServer}
              onCreateMcpServer={props.onCreateMcpServer}
              onUpdateMcpServer={props.onUpdateMcpServer}
              onDeleteMcpServer={props.onDeleteMcpServer}
              onRefreshPlugins={props.onRefreshPlugins}
              onInstallPlugin={props.onInstallPlugin}
              onUpdatePlugin={props.onUpdatePlugin}
              onRemovePlugin={props.onRemovePlugin}
              onSetPluginEnabled={props.onSetPluginEnabled}
              onUpdateWebSearch={props.onUpdateWebSearch}
            />
          )}
        </div>}
      </FadeScale>
    </div>
  );

  function selectSection(nextSection: SettingsSection, providerId?: string) {
    setSection(nextSection);
    props.onNavigateSection?.(nextSection, providerId);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
