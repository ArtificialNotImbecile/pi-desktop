import { useEffect, useMemo, useState } from "react";
import type {
  ActivitySettings,
  ActivityStatus,
  AppearanceSettings,
  AppLanguage,
  AppSettings,
  AppSettingsUpdateRequest,
  AiProvider,
  ExecutableDiscovery,
  MemoryRecord,
  McpMarketplaceServer,
  McpServerCreateRequest,
  McpServerRecord,
  McpServerUpdateRequest,
  PluginPackageRecord,
  ReasoningEffort,
  PromptTemplateRecord,
  PromptTemplateSource,
  ExecutablePickerKind,
  SkillCreateRequest,
  SkillOpenResponse,
  SkillRecord,
  SkillSource,
  SkillUpdateRequest,
  WebSearchSettings,
  WebSearchSettingsUpdateRequest
} from "../../../shared/ipc";
import type { SettingsSection as SettingsSectionKey } from "./ProviderSettingsPanel";
import { ChromeControlSettingsPage } from "./ChromeControlSettingsPage";
import { McpSettingsPage } from "./McpSettingsPage";
import { PluginsSettingsPage } from "./PluginsSettingsPage";
import { PromptTemplatesSettingsPage } from "./PromptTemplatesSettingsPage";
import { SkillsSettingsPage } from "./SkillsSettingsPage";
import { SettingsHeader } from "./SettingsHeader";
import { WebSearchSettingsPage } from "./WebSearchSettingsPage";
import { DEFAULT_BRAND_SETTINGS } from "../../../shared/brand";
import { defaultAppearance } from "../../hooks/useThemeAppearance";
import { useI18n } from "../../i18n";
import { APPEARANCE_THEMES } from "../../../shared/theme";
import { getBridge } from "../../desktopApi";
import DEFAULT_BRAND_LOGO_URL from "../../assets/jasmine-logo.png";
import { Button, Select, Switch, TextArea, TextInput } from "../ui";
import { BrainIcon, EditIcon, ImageIcon, RefreshIcon, TerminalIcon, WorkingIcon } from "../icons/Icons";
import { ExecutablePickerField, SettingsActions, SettingsListRow, SettingsPage, SettingsRow, SettingsSection } from "./SettingsLayout";
import packageMetadata from "../../../../package.json";

export function LocalSettingsPage(props: {
  section: Exclude<SettingsSectionKey, "providers" | "remote">;
  providers: AiProvider[];
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
  webSearchSettings: WebSearchSettings;
  webSearchLoading: boolean;
  webSearchSaving: boolean;
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
  onUpdateWebSearch(request: WebSearchSettingsUpdateRequest): Promise<WebSearchSettings | null>;
}) {
  const { t } = useI18n();
  const activeMemories = props.memories.filter((memory) => !memory.archived && !memory.deleted).length;
  const archivedMemories = props.memories.filter((memory) => memory.archived && !memory.deleted).length;

  if (props.section === "memory") {
    return (
      <>
        <SettingsHeader title={t("settings.memory.title")} />
        <section className="settings-group">
          <div className="settings-row">
            <div>
              <strong>{t("settings.memory.saved")}</strong>
              <small>{t("settings.memory.savedDescription", { active: activeMemories, archived: archivedMemories })}</small>
            </div>
            <button className="settings-row-button" type="button" onClick={props.onOpenMemory}>{t("settings.memory.open")}</button>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("settings.memory.context")}</strong>
            </div>
            <span className="settings-state-pill">{t("app.inspectable")}</span>
          </div>
        </section>
      </>
    );
  }

  if (props.section === "activity") {
    return (
      <>
        <SettingsHeader title={t("settings.activity.title")} />
        <section className="settings-group">
          <div className="settings-row">
            <div>
              <strong>{t("settings.activity.status")}</strong>
              <small>{props.activityStatus === "running" ? t("settings.activity.runningDescription") : props.activityStatus === "paused" ? t("settings.activity.pausedDescription") : t("settings.activity.offDescription")}</small>
            </div>
            <span className={`settings-state-pill ${props.activityStatus}`}>{props.activityStatus === "running" ? t("activity.running") : props.activityStatus === "paused" ? t("activity.paused") : t("activity.off")}</span>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("settings.activity.controls")}</strong>
            </div>
            <button className="settings-row-button" type="button" onClick={props.onOpenActivity}>{t("settings.activity.open")}</button>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("settings.activity.capturePolicy")}</strong>
              <small>{t("settings.activity.captureDescription", {
                windowTitles: props.activitySettings.captureWindowTitles ? t("settings.activity.allowedLater") : t("app.off"),
                screenshots: props.activitySettings.captureScreenshots ? t("settings.activity.allowedLater") : t("app.off"),
                days: props.activitySettings.retentionDays
              })}</small>
            </div>
            <span className="settings-state-pill">{t("app.localOnly")}</span>
          </div>
        </section>
      </>
    );
  }

  if (props.section === "skills") {
    return (
      <SkillsSettingsPage
        skills={props.skills}
        skillSources={props.skillSources}
        selectedSkillIds={props.selectedSkillIds}
        onClose={props.onClose}
        onToggleSelectedSkill={props.onToggleSelectedSkill}
        onRefreshSkills={props.onRefreshSkills}
        onAddSkillSources={props.onAddSkillSources}
        onDeleteSkillSource={props.onDeleteSkillSource}
        onCreateSkill={props.onCreateSkill}
        onUpdateSkill={props.onUpdateSkill}
        onDeleteSkill={props.onDeleteSkill}
        onOpenSkill={props.onOpenSkill}
      />
    );
  }

  if (props.section === "webSearch") {
    return (
      <WebSearchSettingsPage
        settings={props.webSearchSettings}
        loading={props.webSearchLoading}
        saving={props.webSearchSaving}
        onClose={props.onClose}
        onUpdate={props.onUpdateWebSearch}
      />
    );
  }

  if (props.section === "plugins") {
    return (
      <PluginsSettingsPage
        packages={props.plugins}
        loading={props.pluginsLoading}
        savingSource={props.pluginSavingSource}
        onClose={props.onClose}
        onRefresh={props.onRefreshPlugins}
        onInstall={props.onInstallPlugin}
        onUpdate={props.onUpdatePlugin}
        onRemove={props.onRemovePlugin}
        onSetEnabled={props.onSetPluginEnabled}
      />
    );
  }

  if (props.section === "chrome") {
    return (
      <ChromeControlSettingsPage
        settings={props.appSettings}
        saving={props.appSettingsSaving}
        onUpdateSettings={props.onUpdateAppSettings}
      />
    );
  }

  if (props.section === "prompts") {
    return (
      <PromptTemplatesSettingsPage
        templates={props.promptTemplates}
        sources={props.promptTemplateSources}
        loading={props.promptTemplatesLoading}
        onClose={props.onClose}
        onRefresh={props.onRefreshPromptTemplates}
        onAddSources={props.onAddPromptTemplateSources}
        onDeleteSource={props.onDeletePromptTemplateSource}
      />
    );
  }

  if (props.section === "mcp") {
    return (
      <McpSettingsPage
        marketplace={props.mcpMarketplace}
        servers={props.mcpServers}
        installedMarketplaceIds={props.installedMcpMarketplaceIds}
        loadingMarketplace={props.mcpMarketplaceLoading}
        loadingServers={props.mcpServersLoading}
        savingServerId={props.mcpSavingServerId}
        onClose={props.onClose}
        onMarketplaceOpened={props.onMcpMarketplaceOpened}
        onRefreshMarketplace={props.onRefreshMcpMarketplace}
        onRefreshServers={props.onRefreshMcpServers}
        onInstall={props.onInstallMcpServer}
        onCreateServer={props.onCreateMcpServer}
        onUpdateServer={props.onUpdateMcpServer}
        onDeleteServer={props.onDeleteMcpServer}
      />
    );
  }

  if (props.section === "about") {
    return (
      <>
        <SettingsHeader title={t("settings.about.title")} />
        <section className="settings-group">
          <div className="settings-row">
            <div>
              <strong>{t("settings.about.positioning")}</strong>
              <small>{t("settings.about.description")}</small>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("settings.about.version")}</strong>
            </div>
            <span className="settings-state-pill">{packageMetadata.version}</span>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("settings.about.dataLocation")}</strong>
              <small>{t("settings.about.dataLocationDescription")}</small>
            </div>
            <span className="settings-state-pill">{t("app.localOnly")}</span>
          </div>
        </section>
      </>
    );
  }

  if (props.section === "appearance") {
    return (
      <AppearanceSettingsPage
        settings={props.appSettings.appearance}
        saving={props.appSettingsSaving}
        onClose={props.onClose}
        onUpdate={props.onUpdateAppSettings}
      />
    );
  }

  return (
    <GeneralSettingsPage
      providers={props.providers}
      settings={props.appSettings}
      loading={props.appSettingsLoading}
      saving={props.appSettingsSaving}
      onClose={props.onClose}
      onUpdate={props.onUpdateAppSettings}
    />
  );
}

function AppearanceSettingsPage(props: {
  settings: AppearanceSettings;
  saving: boolean;
  onClose(): void;
  onUpdate(request: AppSettingsUpdateRequest): Promise<AppSettings | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(props.settings);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const fields = [
    { key: "accent", label: t("settings.appearance.accent") },
    { key: "surface", label: t("settings.appearance.surface") },
    { key: "ink", label: t("settings.appearance.ink") },
    { key: "success", label: t("settings.appearance.success") },
    { key: "danger", label: t("settings.appearance.danger") }
  ] satisfies Array<{ key: AppearanceColorKey; label: string }>;
  const presets = [
    {
      id: "codex",
      name: t("settings.appearance.preset.codex"),
      colors: APPEARANCE_THEMES.codex
    },
    {
      id: "jasmine",
      name: t("settings.appearance.preset.jasmine"),
      colors: APPEARANCE_THEMES.jasmine
    }
  ] satisfies Array<{
    id: string;
    name: string;
    colors: Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">;
  }>;
  const dirty = fields.some((field) => draft[field.key].toLowerCase() !== props.settings[field.key].toLowerCase());
  const invalid = fields.some((field) => !isHexColor(draft[field.key]));

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings.accent, props.settings.surface, props.settings.ink, props.settings.success, props.settings.danger]);

  useEffect(() => {
    setSaveState("idle");
  }, [draft.accent, draft.surface, draft.ink, draft.success, draft.danger]);

  function updateColor(key: AppearanceColorKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyPreset(colors: Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">) {
    setDraft((current) => ({
      ...current,
      accent: colors.accent,
      surface: colors.surface,
      ink: colors.ink,
      success: colors.success,
      danger: colors.danger
    }));
  }

  async function save() {
    setSaveState("saving");
    const result = await props.onUpdate({
      appearance: {
        accent: draft.accent,
        surface: draft.surface,
        ink: draft.ink,
        success: draft.success,
        danger: draft.danger
      }
    });
    setSaveState(result ? "saved" : "failed");
  }

  return (
    <>
      <SettingsHeader title={t("settings.appearance.title")} />
      <SettingsPage>
        <section className="appearance-presets" aria-label={t("settings.appearance.presets")}>
          {presets.map((preset) => {
            const active = colorsEqual(draft, preset.colors);
            return (
              <Button
                className={active ? "active" : ""}
                variant={active ? "primary" : "default"}
                type="button"
                key={preset.id}
                aria-pressed={active}
                onClick={() => applyPreset(preset.colors)}
              >
                <span className="appearance-preset-swatches" aria-hidden="true">
                  <i style={{ background: preset.colors.accent }} />
                  <i style={{ background: preset.colors.surface }} />
                  <i style={{ background: preset.colors.ink }} />
                  <i style={{ background: preset.colors.success }} />
                  <i style={{ background: preset.colors.danger }} />
                </span>
                <span>{preset.name}</span>
              </Button>
            );
          })}
        </section>
        <SettingsSection className="appearance-settings" aria-label={t("settings.appearance.colors")}>
          {fields.map((field) => (
            <SettingsRow
              className="appearance-row"
              key={field.key}
              label={field.label}
              actions={
                <div className="appearance-controls">
                  <input
                    aria-label={t("settings.appearance.colorPicker", { label: field.label })}
                    type="color"
                    value={isHexColor(draft[field.key]) ? draft[field.key] : props.settings[field.key]}
                    onChange={(event) => updateColor(field.key, event.target.value)}
                  />
                  <TextInput
                    aria-label={t("settings.appearance.hexColor", { label: field.label })}
                    value={draft[field.key]}
                    onChange={(event) => updateColor(field.key, event.target.value)}
                    spellCheck={false}
                  />
                </div>
              }
            />
          ))}
        </SettingsSection>
      </SettingsPage>
      <section className="appearance-preview" aria-label={t("settings.appearance.preview")}>
        <div className="appearance-preview-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <strong>{t("empty.title")}</strong>
          <small>{t("settings.appearance.previewCopy")}</small>
        </div>
        <Button variant="primary">Primary</Button>
        <span className="appearance-preview-state success">{t("app.saved")}</span>
        <span className="appearance-preview-state danger">{t("app.saveFailed")}</span>
      </section>
      <SettingsActions
        state={invalid ? "failed" : props.saving ? "saving" : saveState}
        dirty={dirty}
        disabled={invalid || props.saving}
        savingLabel={t("app.saving")}
        savedLabel={t("app.saved")}
        failedLabel={invalid ? t("settings.appearance.useHex") : t("app.saveFailed")}
        saveLabel={t("app.save")}
        onSave={() => void save()}
      >
        <Button size="sm" disabled={props.saving || colorsEqual(draft, defaultAppearance)} onClick={() => setDraft(defaultAppearance)}>
          {t("app.reset")}
        </Button>
      </SettingsActions>
    </>
  );
}

type AppearanceColorKey = keyof Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">;

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function colorsEqual(
  left: Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">,
  right: Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">
): boolean {
  return left.accent.toLowerCase() === right.accent.toLowerCase() &&
    left.surface.toLowerCase() === right.surface.toLowerCase() &&
    left.ink.toLowerCase() === right.ink.toLowerCase() &&
    left.success.toLowerCase() === right.success.toLowerCase() &&
    left.danger.toLowerCase() === right.danger.toLowerCase();
}

function GeneralSettingsPage(props: {
  providers: AiProvider[];
  settings: AppSettings;
  loading: boolean;
  saving: boolean;
  onClose(): void;
  onUpdate(request: AppSettingsUpdateRequest): Promise<AppSettings | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(props.settings.toolModel);
  const [languageDraft, setLanguageDraft] = useState<AppLanguage>(props.settings.language);
  const [editorPathDraft, setEditorPathDraft] = useState(props.settings.skillEditorPath ?? "");
  const [terminalShellDraft, setTerminalShellDraft] = useState(props.settings.terminalShellPath ?? "");
  const [brandDraft, setBrandDraft] = useState(props.settings.brand);
  const [workingNotificationsDraft, setWorkingNotificationsDraft] = useState(props.settings.workingNotifications);
  const [editorDiscovery, setEditorDiscovery] = useState<ExecutableDiscovery | null>(null);
  const [terminalDiscovery, setTerminalDiscovery] = useState<ExecutableDiscovery | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [draftTouched, setDraftTouched] = useState(false);
  const activeProvider = useMemo(
    () => props.providers.find((provider) => provider.id === draft.providerId) ?? props.providers[0] ?? null,
    [props.providers, draft.providerId]
  );
  const enabledModels = activeProvider?.models.filter((model) => model.enabled) ?? [];
  const dirty = draft.providerId !== props.settings.toolModel.providerId ||
    draft.modelId !== props.settings.toolModel.modelId ||
    draft.reasoningEffort !== props.settings.toolModel.reasoningEffort ||
    languageDraft !== props.settings.language ||
    editorPathDraft.trim() !== (props.settings.skillEditorPath ?? "") ||
    terminalShellDraft.trim() !== (props.settings.terminalShellPath ?? "") ||
    brandDraft.logoDataUrl !== props.settings.brand.logoDataUrl ||
    brandDraft.mainTitle.trim() !== props.settings.brand.mainTitle ||
    brandDraft.subtitle.trim() !== props.settings.brand.subtitle ||
    workingNotificationsDraft.mode !== props.settings.workingNotifications.mode ||
    workingNotificationsDraft.includeDetails !== props.settings.workingNotifications.includeDetails;
  const brandTitleInvalid = !brandDraft.mainTitle.trim();

  useEffect(() => {
    if (draftTouched) return;
    setDraft(props.settings.toolModel);
    setLanguageDraft(props.settings.language);
    setEditorPathDraft(props.settings.skillEditorPath ?? "");
    setTerminalShellDraft(props.settings.terminalShellPath ?? "");
    setBrandDraft(props.settings.brand);
    setWorkingNotificationsDraft(props.settings.workingNotifications);
  }, [draftTouched, props.settings.toolModel.providerId, props.settings.toolModel.modelId, props.settings.toolModel.reasoningEffort, props.settings.language, props.settings.skillEditorPath, props.settings.terminalShellPath, props.settings.brand.logoDataUrl, props.settings.brand.mainTitle, props.settings.brand.subtitle, props.settings.workingNotifications.mode, props.settings.workingNotifications.includeDetails]);

  useEffect(() => {
    setSaveState("idle");
  }, [draft.providerId, draft.modelId, draft.reasoningEffort, languageDraft, editorPathDraft, terminalShellDraft, brandDraft.logoDataUrl, brandDraft.mainTitle, brandDraft.subtitle, workingNotificationsDraft.mode, workingNotificationsDraft.includeDetails]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getBridge().listExecutableDiscovery("editor"),
      getBridge().listExecutableDiscovery("terminal")
    ])
      .then(([editor, terminal]) => {
        if (cancelled) return;
        setEditorDiscovery(editor);
        setTerminalDiscovery(terminal);
      })
      .catch(() => {
        if (cancelled) return;
        setEditorDiscovery({ kind: "editor", candidates: [] });
        setTerminalDiscovery({ kind: "terminal", candidates: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectProvider(providerId: string) {
    const provider = props.providers.find((item) => item.id === providerId);
    setDraftTouched(true);
    setDraft((current) => ({
      ...current,
      providerId,
      modelId: provider?.defaultModel ?? provider?.models[0]?.id ?? current.modelId
    }));
  }

  async function save() {
    setSaveState("saving");
    const result = await props.onUpdate({
      language: languageDraft,
      toolModel: {
        providerId: draft.providerId,
        modelId: draft.modelId,
        reasoningEffort: draft.reasoningEffort
      },
      brand: {
        logoDataUrl: brandDraft.logoDataUrl,
        mainTitle: brandDraft.mainTitle.trim(),
        subtitle: brandDraft.subtitle.trim()
      },
      workingNotifications: workingNotificationsDraft,
      skillEditorPath: editorPathDraft.trim(),
      terminalShellPath: terminalShellDraft.trim()
    });
    setSaveState(result ? "saved" : "failed");
    if (result) {
      setDraft(result.toolModel);
      setLanguageDraft(result.language);
      setEditorPathDraft(result.skillEditorPath ?? "");
      setTerminalShellDraft(result.terminalShellPath ?? "");
      setBrandDraft(result.brand);
      setWorkingNotificationsDraft(result.workingNotifications);
      setDraftTouched(false);
    }
  }

  async function chooseExecutable(kind: ExecutablePickerKind) {
    const selected = await getBridge().pickExecutable(kind);
    if (!selected) return;
    setDraftTouched(true);
    if (kind === "terminal") {
      setTerminalShellDraft(selected);
    } else {
      setEditorPathDraft(selected);
    }
  }

  async function chooseBrandLogo() {
    const picked = await getBridge().pickFile();
    if (!picked) return;
    if (!picked.isImage || !picked.previewDataUrl) {
      setSaveState("failed");
      return;
    }
    setDraftTouched(true);
    setBrandDraft((current) => ({ ...current, logoDataUrl: picked.previewDataUrl ?? null }));
  }

  function resetBrandLogo() {
    setDraftTouched(true);
    setBrandDraft((current) => ({ ...current, logoDataUrl: DEFAULT_BRAND_SETTINGS.logoDataUrl }));
  }

  function resetBrandCopy() {
    setDraftTouched(true);
    setBrandDraft((current) => ({
      ...current,
      mainTitle: DEFAULT_BRAND_SETTINGS.mainTitle,
      subtitle: DEFAULT_BRAND_SETTINGS.subtitle
    }));
  }

  const editorOptions = buildExecutableOptions(
    editorDiscovery,
    editorPathDraft,
    editorDiscovery?.auto
      ? t("settings.general.autoDetectWith", { app: editorDiscovery.auto.label })
      : t("settings.general.noEditorsDetected"),
    t("settings.general.customApp")
  );
  const terminalOptions = buildExecutableOptions(
    terminalDiscovery,
    terminalShellDraft,
    terminalDiscovery?.auto
      ? t("settings.general.autoDetectWith", { app: terminalDiscovery.auto.label })
      : t("settings.general.noShellsDetected"),
    t("settings.general.customApp")
  );
  const editorDisplayPath = resolveExecutablePath(editorDiscovery, editorPathDraft);
  const terminalDisplayPath = resolveExecutablePath(terminalDiscovery, terminalShellDraft);

  return (
    <>
      <SettingsHeader title={t("settings.general.title")} />
      <SettingsPage className="general-settings-page">
        <SettingsSection className="general-language-section">
          <SettingsRow
            className="general-language-row"
            label={t("settings.general.language")}
            actions={
              <Select
                aria-label={t("settings.general.languageAria")}
                disabled={props.loading || props.saving}
                value={languageDraft}
                onChange={(event) => {
                  setDraftTouched(true);
                  setLanguageDraft(event.target.value as AppLanguage);
                }}
              >
                <option value="en">{t("settings.general.language.en")}</option>
                <option value="zh">{t("settings.general.language.zh")}</option>
              </Select>
            }
          />
        </SettingsSection>
        <SettingsSection className="general-settings-list-section" aria-label={t("settings.general.brand")}>
          <SettingsListRow
            className="general-brand-row"
            icon={<ImageIcon />}
            title={t("settings.general.brand")}
            description={t("settings.general.brandDescription")}
          >
            <div className="brand-settings-controls">
              <div className="brand-logo-control">
                <span className="brand-logo-preview" aria-label={t("settings.general.brandLogoPreview")}>
                  <img src={brandDraft.logoDataUrl || DEFAULT_BRAND_LOGO_URL} alt="" />
                </span>
                <div className="brand-logo-actions">
                  <Button size="sm" disabled={props.loading || props.saving} leftIcon={<ImageIcon />} onClick={() => void chooseBrandLogo()}>
                    {t("settings.general.chooseBrandLogo")}
                  </Button>
                  <Button size="sm" variant="quiet" disabled={props.loading || props.saving || !brandDraft.logoDataUrl} leftIcon={<RefreshIcon />} onClick={resetBrandLogo}>
                    {t("settings.general.resetBrandLogo")}
                  </Button>
                </div>
              </div>
              <div className="brand-copy-controls">
                <div className="brand-copy-field">
                  <span>{t("settings.general.brandTitle")}</span>
                  <TextInput
                    aria-label={t("settings.general.brandTitleAria")}
                    disabled={props.loading || props.saving}
                    value={brandDraft.mainTitle}
                    maxLength={80}
                    error={brandTitleInvalid ? t("settings.general.brandTitleRequired") : false}
                    onChange={(event) => {
                      setDraftTouched(true);
                      setBrandDraft((current) => ({ ...current, mainTitle: event.target.value }));
                    }}
                  />
                </div>
                <div className="brand-copy-field">
                  <span>{t("settings.general.brandSubtitle")}</span>
                  <TextArea
                    aria-label={t("settings.general.brandSubtitleAria")}
                    disabled={props.loading || props.saving}
                    value={brandDraft.subtitle}
                    maxLength={180}
                    rows={3}
                    onChange={(event) => {
                      setDraftTouched(true);
                      setBrandDraft((current) => ({ ...current, subtitle: event.target.value }));
                    }}
                  />
                </div>
                <Button size="sm" variant="quiet" disabled={props.loading || props.saving} leftIcon={<RefreshIcon />} onClick={resetBrandCopy}>
                  {t("settings.general.resetBrandCopy")}
                </Button>
              </div>
            </div>
          </SettingsListRow>
        </SettingsSection>
        <SettingsSection className="general-settings-list-section" aria-label={t("settings.general.openWith")}>
          <SettingsListRow
            className="general-executable-row"
            icon={<EditIcon />}
            title={t("settings.general.editorPath")}
            description={t("settings.general.editorDescription")}
            actions={
              <ExecutablePickerField
                selectLabel={t("settings.general.editorSelectAria")}
                pathLabel={t("settings.general.editorPathAria")}
                value={editorPathDraft}
                pathValue={editorDisplayPath}
                pathPlaceholder={t("settings.general.noEditorsDetected")}
                options={editorOptions}
                disabled={props.loading || props.saving}
                browseLabel={t("settings.general.chooseEditor")}
                onBrowse={() => void chooseExecutable("editor")}
                onChange={(value) => {
                  setDraftTouched(true);
                  setEditorPathDraft(value);
                }}
              />
            }
          />
          <SettingsListRow
            className="general-executable-row"
            icon={<TerminalIcon />}
            title={t("settings.general.terminalShell")}
            description={t("settings.general.terminalDescription")}
            actions={
              <ExecutablePickerField
                selectLabel={t("settings.general.terminalSelectAria")}
                pathLabel={t("settings.general.terminalShellAria")}
                value={terminalShellDraft}
                pathValue={terminalDisplayPath}
                pathPlaceholder={t("settings.general.noShellsDetected")}
                options={terminalOptions}
                disabled={props.loading || props.saving}
                browseLabel={t("settings.general.chooseTerminal")}
                onBrowse={() => void chooseExecutable("terminal")}
                onChange={(value) => {
                  setDraftTouched(true);
                  setTerminalShellDraft(value);
                }}
              />
            }
          />
        </SettingsSection>
        <SettingsSection className="general-settings-list-section" aria-label={t("settings.general.taskNotifications")}>
          <SettingsListRow
            className="general-working-notifications-row"
            icon={<WorkingIcon />}
            title={t("settings.general.taskNotifications")}
            description={t("settings.general.taskNotificationsDescription")}
          >
            <div className="working-notification-controls">
              <label>
                <span>{t("settings.general.notificationMode")}</span>
                <Select
                  aria-label={t("settings.general.notificationModeAria")}
                  disabled={props.loading || props.saving}
                  value={workingNotificationsDraft.mode}
                  onChange={(event) => {
                    setDraftTouched(true);
                    setWorkingNotificationsDraft((current) => ({ ...current, mode: event.target.value as "background" | "always" | "never" }));
                  }}
                >
                  <option value="background">{t("settings.general.notificationMode.background")}</option>
                  <option value="always">{t("settings.general.notificationMode.always")}</option>
                  <option value="never">{t("settings.general.notificationMode.never")}</option>
                </Select>
              </label>
              <Switch
                checked={workingNotificationsDraft.includeDetails}
                disabled={props.loading || props.saving || workingNotificationsDraft.mode === "never"}
                aria-label={t("settings.general.notificationDetailsAria")}
                onChange={(includeDetails) => {
                  setDraftTouched(true);
                  setWorkingNotificationsDraft((current) => ({ ...current, includeDetails }));
                }}
                onLabel={t("app.on")}
                offLabel={t("app.off")}
              />
              <span className="working-notification-detail-copy">{t("settings.general.notificationDetails")}</span>
            </div>
          </SettingsListRow>
        </SettingsSection>
        <SettingsSection className="general-settings-list-section" aria-label={t("settings.general.utility")}>
          <SettingsListRow
            className="general-tool-model-row"
            icon={<BrainIcon />}
            title={t("settings.general.toolModel")}
            description={t("settings.general.toolModelDescription")}
          >
            <div className="tool-model-controls">
              <label>
                <span>{t("settings.general.provider")}</span>
                <Select aria-label={t("settings.general.toolModelProviderAria")} disabled={props.loading || props.providers.length === 0} value={draft.providerId} onChange={(event) => selectProvider(event.target.value)}>
                  {props.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </Select>
              </label>
              <label>
                <span>{t("settings.general.model")}</span>
                <Select
                  aria-label={t("settings.general.toolModelAria")}
                  disabled={props.loading || !activeProvider}
                  value={draft.modelId}
                  onChange={(event) => {
                    setDraftTouched(true);
                    setDraft((current) => ({ ...current, modelId: event.target.value }));
                  }}
                >
                  {(enabledModels.length > 0 ? enabledModels : activeProvider?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.id}</option>
                  ))}
                </Select>
              </label>
              <label>
                <span>{t("settings.general.reasoning")}</span>
                <Select
                  aria-label={t("settings.general.toolModelReasoningAria")}
                  disabled={props.loading}
                  value={draft.reasoningEffort}
                  onChange={(event) => {
                    setDraftTouched(true);
                    setDraft((current) => ({ ...current, reasoningEffort: event.target.value as ReasoningEffort }));
                  }}
                >
                  {(["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ReasoningEffort[]).map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                  ))}
                </Select>
              </label>
            </div>
          </SettingsListRow>
        </SettingsSection>
        <SettingsActions
          className="general-settings-actions"
          state={brandTitleInvalid ? "failed" : props.saving ? "saving" : saveState}
          dirty={dirty}
          disabled={props.saving || brandTitleInvalid}
          savingLabel={t("app.saving")}
          savedLabel={t("app.saved")}
          failedLabel={brandTitleInvalid ? t("settings.general.brandTitleRequired") : t("app.saveFailed")}
          saveLabel={t("app.save")}
          onSave={() => void save()}
        />
      </SettingsPage>
    </>
  );
}

function buildExecutableOptions(
  discovery: ExecutableDiscovery | null,
  currentValue: string,
  autoLabel: string,
  customLabel: string
): Array<{ label: string; value: string }> {
  const options = [{ label: autoLabel, value: "" }];
  const seen = new Set<string>([""]);
  for (const candidate of discovery?.candidates ?? []) {
    const key = candidate.command.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({ label: candidate.label, value: candidate.command });
  }
  const trimmed = currentValue.trim();
  if (trimmed) {
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      options.push({ label: `${customLabel}: ${displayNameForExecutable(trimmed)}`, value: trimmed });
    }
  }
  return options;
}

function resolveExecutablePath(discovery: ExecutableDiscovery | null, currentValue: string): string {
  const trimmed = currentValue.trim();
  if (trimmed) return trimmed;
  return discovery?.auto?.command ?? "";
}

function displayNameForExecutable(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function PathPickerControl(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  chooseLabel: string;
  clearLabel: string;
  onChoose(): void;
  onClear(): void;
}) {
  return (
    <div className="path-picker-control">
      <output className={props.value ? "has-value" : ""} aria-label={props.label} title={props.value || props.placeholder}>
        {props.value || props.placeholder}
      </output>
      <div className="path-picker-actions">
        <button className="settings-row-button" type="button" disabled={props.disabled} onClick={props.onChoose}>
          {props.chooseLabel}
        </button>
        <button className="settings-row-button" type="button" disabled={props.disabled || !props.value} onClick={props.onClear}>
          {props.clearLabel}
        </button>
      </div>
    </div>
  );
}
