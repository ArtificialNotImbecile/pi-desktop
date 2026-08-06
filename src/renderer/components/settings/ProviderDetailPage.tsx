import { useEffect, useState } from "react";
import type { AiProvider, ModelCapabilities, ProviderModelConfig, ProviderUpdateRequest } from "../../../shared/ipc";
import { Button, Select, Switch, TextInput } from "../ui";
import { ModelOptionsDialog } from "./ModelOptionsDialog";
import { SecretField, SettingsActions, SettingsRow, SettingsSection, StatePill } from "./SettingsLayout";
import { useI18n, type I18nKey } from "../../i18n";

export function ProviderDetailPage(props: {
  provider: AiProvider;
  isTesting: boolean;
  isFetchingModels: boolean;
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
}) {
  const { language, t } = useI18n();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyMode, setApiKeyMode] = useState<"env" | "direct">("env");
  const [apiKeyEnvName, setApiKeyEnvName] = useState("");
  const [directApiKey, setDirectApiKey] = useState("");
  const [showDirectApiKey, setShowDirectApiKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [modelQuery, setModelQuery] = useState("");
  const [editingModel, setEditingModel] = useState<ProviderModelConfig | null>(null);
  const [modelDraft, setModelDraft] = useState<ProviderModelConfig | null>(null);

  useEffect(() => {
    setBaseUrl(props.provider.baseUrl);
    setApiKeyMode(providerApiKeyMode(props.provider.apiKeyRef));
    setApiKeyEnvName(envNameFromRef(props.provider.apiKeyRef));
    setDirectApiKey("");
    setShowDirectApiKey(false);
    setDefaultModel(props.provider.defaultModel);
    setEnabled(props.provider.enabled);
  }, [props.provider.id, props.provider.baseUrl, props.provider.apiKeyRef, props.provider.defaultModel, props.provider.enabled]);

  useEffect(() => {
    setSaveState("idle");
    setModelQuery("");
  }, [props.provider.id]);

  const apiKeyRef = apiKeyRefFromDraft(apiKeyMode, apiKeyEnvName, directApiKey);
  const apiKeyDirty = apiKeyMode === "direct"
    ? directApiKey.trim().length > 0 || !isDirectKeyRef(props.provider.apiKeyRef)
    : apiKeyRef !== props.provider.apiKeyRef;
  const apiKeyInvalid = apiKeyMode === "direct"
    ? !isDirectKeyRef(props.provider.apiKeyRef) && directApiKey.trim().length === 0
    : apiKeyEnvName.trim().length === 0;

  const dirty =
    baseUrl !== props.provider.baseUrl ||
    apiKeyDirty ||
    defaultModel !== props.provider.defaultModel ||
    enabled !== props.provider.enabled;

  async function save() {
    if (apiKeyInvalid) {
      setSaveState("failed");
      return;
    }

    const request: ProviderUpdateRequest = {
      id: props.provider.id,
      baseUrl,
      defaultModel,
      enabled
    };
    if (apiKeyDirty && apiKeyRef) request.apiKeyRef = apiKeyRef;

    setSaveState("saving");
    const result = await props.onSave(request);
    setSaveState(result ? "saved" : "failed");
  }

  function reset() {
    const defaults = providerDefaults(props.provider.id);
    setBaseUrl(defaults.baseUrl);
    setApiKeyMode("env");
    setApiKeyEnvName(envNameFromRef(defaults.apiKeyRef));
    setDirectApiKey("");
    setShowDirectApiKey(false);
    setDefaultModel(defaults.defaultModel);
    setEnabled(true);
    setSaveState("idle");
  }

  return (
    <>
      <div className="provider-card">
        <div className="provider-title-row">
          <div>
            <h3>{props.provider.name}</h3>
            <p>{props.provider.type} - {props.provider.id}</p>
          </div>
          <StatePill className={`provider-status ${props.provider.status}`} tone={props.provider.status === "connected" ? "success" : props.provider.status === "failed" || props.provider.status === "missing_key" ? "danger" : "neutral"}>
            {statusText(props.provider, t)}
          </StatePill>
        </div>

        <SettingsSection aria-label={t("settings.provider.connection")}>
          <SettingsRow
            label={t("app.enabled")}
            actions={
              <Switch
                checked={enabled}
                aria-label={t("settings.provider.enabled")}
                onChange={(checked) => {
                  setSaveState("idle");
                  setEnabled(checked);
                }}
              />
            }
          />

          <SettingsRow
            label={t("settings.provider.baseUrl")}
            actions={
              <TextInput
                id="provider-base-url"
                value={baseUrl}
                onChange={(event) => {
                  setSaveState("idle");
                  setBaseUrl(event.target.value);
                }}
              />
            }
          />

          <SettingsRow label={t("settings.provider.apiKey")} description={t("settings.provider.apiKeyDescription")}>
            <div className="api-key-control">
              <div className="api-key-mode" role="group" aria-label={t("settings.provider.apiKeyInputType")}>
                <Button
                  className={apiKeyMode === "env" ? "active" : ""}
                  size="sm"
                  variant={apiKeyMode === "env" ? "primary" : "default"}
                  onClick={() => {
                    setSaveState("idle");
                    setApiKeyMode("env");
                  }}
                >
                  {t("settings.provider.envVar")}
                </Button>
                <Button
                  className={apiKeyMode === "direct" ? "active" : ""}
                  size="sm"
                  variant={apiKeyMode === "direct" ? "primary" : "default"}
                  onClick={() => {
                    setSaveState("idle");
                    setApiKeyMode("direct");
                  }}
                >
                  {t("settings.provider.directKey")}
                </Button>
              </div>

              {apiKeyMode === "env" ? (
                <TextInput
                  id="provider-api-key-ref"
                  aria-label={t("settings.provider.apiKeyEnvironmentVariable")}
                  value={apiKeyEnvName}
                  onChange={(event) => {
                    setSaveState("idle");
                    setApiKeyEnvName(stripEnvPrefix(event.target.value));
                  }}
                />
              ) : (
                <SecretField
                  id="provider-api-key-direct"
                  hidden={!showDirectApiKey}
                  value={directApiKey}
                  placeholder={isDirectKeyRef(props.provider.apiKeyRef) ? t("settings.provider.savedKey", { key: props.provider.apiKeyRef.slice(4) }) : t("settings.provider.pasteApiKey")}
                  revealLabel={showDirectApiKey ? t("settings.provider.hideApiKey") : t("settings.provider.showApiKey")}
                  onToggleHidden={() => setShowDirectApiKey((value) => !value)}
                  onChange={(value) => {
                    setSaveState("idle");
                    setDirectApiKey(value);
                  }}
                />
              )}
              <small className="field-hint">
                {apiKeyMode === "env"
                  ? t("settings.provider.envHint")
                  : t("settings.provider.directHint")}
              </small>
            </div>
          </SettingsRow>

          <SettingsRow
            label={t("settings.provider.defaultModel")}
            actions={
              <Select id="provider-default-model" value={defaultModel} onChange={(event) => {
                setSaveState("idle");
                setDefaultModel(event.target.value);
              }}>
                {modelOptions(props.provider, defaultModel).map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </Select>
            }
          />
        </SettingsSection>

        <SettingsActions state={saveState} dirty={dirty} disabled={apiKeyInvalid || props.isTesting} onSave={() => void save()} saveLabel={t("app.save")} savedLabel={t("app.saved")} savingLabel={t("app.saving")} failedLabel={t("app.saveFailed")}>
          <Button size="sm" onClick={() => void props.onTest(props.provider.id)} disabled={props.isTesting} loading={props.isTesting}>
            {props.isTesting ? t("settings.provider.testing") : t("settings.provider.test")}
          </Button>
          <Button size="sm" onClick={reset}>{t("app.reset")}</Button>
        </SettingsActions>

        <div className="models-section">
          <div className="models-header">
            <strong>{t("settings.provider.models")}</strong>
            <Button size="sm" onClick={() => void props.onFetchModels(props.provider.id)} disabled={props.isFetchingModels} loading={props.isFetchingModels}>
              {props.isFetchingModels ? t("settings.provider.fetching") : t("settings.provider.fetch")}
            </Button>
          </div>
          <TextInput
            className="model-search"
            placeholder={t("settings.provider.searchModels")}
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
          />
          <div className="model-list">
            {filteredModels(props.provider.models, modelQuery).map((model) => (
              <div className="model-row" key={model.id}>
                <button
                  className="model-options-button"
                  type="button"
                  title={t("settings.provider.modelOptions")}
                  onClick={() => {
                    setEditingModel(model);
                    setModelDraft(model);
                  }}
                >
                  <span>{model.id}</span>
                  <small>{capabilitySummary(model, language, t)}</small>
                </button>
                <Switch
                  checked={model.enabled}
                  className="model-enable"
                  aria-label={t(model.enabled ? "settings.provider.disableModel" : "settings.provider.enableModel", { model: model.id })}
                  title={t(model.enabled ? "settings.provider.disableModel" : "settings.provider.enableModel", { model: model.id })}
                  onLabel=""
                  offLabel=""
                  onChange={(checked) => void props.onUpdateModel({ providerId: props.provider.id, modelId: model.id, enabled: checked })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="provider-meta">
          <span>{t("settings.provider.lastChecked")}</span>
          <b>{props.provider.lastCheckedAt ? new Date(props.provider.lastCheckedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US") : t("app.never")}</b>
          <span>{t("settings.provider.lastError")}</span>
          <b>{props.provider.lastError ?? t("settings.provider.none")}</b>
        </div>

      </div>

      {editingModel && modelDraft && (
        <ModelOptionsDialog
          model={modelDraft}
          originalModel={editingModel}
          onChange={setModelDraft}
          onCancel={() => {
            setEditingModel(null);
            setModelDraft(null);
          }}
          onSave={async () => {
            await props.onUpdateModel({
              providerId: props.provider.id,
              modelId: modelDraft.id,
              enabled: modelDraft.enabled,
              capabilities: modelDraft.capabilities,
              contextWindow: modelDraft.contextWindow,
              maxOutputTokens: modelDraft.maxOutputTokens,
              providerOptionsJson: modelDraft.providerOptionsJson
            });
            setEditingModel(null);
            setModelDraft(null);
          }}
        />
      )}
    </>
  );
}

function modelOptions(provider: AiProvider, defaultModel: string): string[] {
  return Array.from(new Set([defaultModel, ...provider.models.map((model) => model.id)].filter(Boolean)));
}

function providerDefaults(providerId: string) {
  if (providerId === "moonshot") {
    return {
      baseUrl: "https://api.moonshot.cn/v1",
      apiKeyRef: "env:KIMI_API_KEY",
      defaultModel: "kimi-k2.6"
    };
  }

  return {
    baseUrl: "https://api.deepseek.com",
    apiKeyRef: "env:DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash"
  };
}

function providerApiKeyMode(apiKeyRef: string): "env" | "direct" {
  return isDirectKeyRef(apiKeyRef) ? "direct" : "env";
}

function envNameFromRef(apiKeyRef: string): string {
  const trimmed = apiKeyRef.trim();
  return trimmed.startsWith("env:") ? trimmed.slice(4).trim() : "";
}

function stripEnvPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("env:") ? trimmed.slice(4).trim() : value;
}

function apiKeyRefFromDraft(mode: "env" | "direct", envName: string, directKey: string): string | undefined {
  if (mode === "env") {
    const name = stripEnvPrefix(envName).trim();
    return name ? `env:${name}` : undefined;
  }

  const key = directKey.trim();
  return key ? `key:${key}` : undefined;
}

function isDirectKeyRef(apiKeyRef: string): boolean {
  return apiKeyRef.trim().startsWith("key:");
}

function filteredModels(models: ProviderModelConfig[], query: string): ProviderModelConfig[] {
  const normalized = query.trim().toLowerCase();
  return [...models]
    .filter((model) => !normalized || model.id.toLowerCase().includes(normalized))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
}

function capabilitySummary(model: ProviderModelConfig, language: "en" | "zh", t: (key: I18nKey, values?: Record<string, string | number>) => string): string {
  const labels = [
    model.capabilities.vision ? t("settings.provider.capability.vision") : "",
    model.capabilities.toolCalling ? t("settings.provider.capability.tools") : "",
    model.capabilities.reasoning ? t("settings.provider.capability.reasoning") : "",
    model.capabilities.embedding ? t("settings.provider.capability.embedding") : ""
  ].filter(Boolean);
  return t("settings.provider.contextSummary", {
    count: model.contextWindow.toLocaleString(language === "zh" ? "zh-CN" : "en-US"),
    source: t(model.customized ? "settings.provider.source.custom" : "settings.provider.source.auto"),
    capabilities: labels.length ? ` - ${labels.join(language === "zh" ? "、" : ", ")}` : ""
  });
}

function statusText(provider: AiProvider, t: (key: I18nKey) => string): string {
  if (!provider.enabled) return t("app.disabled");
  if (provider.status === "connected") return t("settings.provider.status.connected");
  if (provider.status === "missing_key") return t("settings.provider.status.missingKey");
  if (provider.status === "failed") return t("settings.provider.status.failed");
  return t("settings.provider.status.unchecked");
}
