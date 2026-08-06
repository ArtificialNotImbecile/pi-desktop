import { useRef, useState } from "react";
import type { ModelCapabilities, ProviderModelConfig } from "../../../shared/ipc";
import { Button, Dialog, Switch } from "../ui";
import { useI18n } from "../../i18n";

export function ModelOptionsDialog(props: {
  model: ProviderModelConfig;
  originalModel: ProviderModelConfig;
  onChange(model: ProviderModelConfig): void;
  onCancel(): void;
  onSave(): Promise<void>;
}) {
  const { t } = useI18n();
  const [providerOptionsError, setProviderOptionsError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const providerOptionsRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty =
    props.model.enabled !== props.originalModel.enabled ||
    props.model.contextWindow !== props.originalModel.contextWindow ||
    props.model.maxOutputTokens !== props.originalModel.maxOutputTokens ||
    props.model.providerOptionsJson !== props.originalModel.providerOptionsJson ||
    JSON.stringify(props.model.capabilities) !== JSON.stringify(props.originalModel.capabilities);

  function patchCapabilities(capabilities: Partial<ModelCapabilities>) {
    props.onChange({
      ...props.model,
      capabilities: {
        ...props.model.capabilities,
        ...capabilities
      }
    });
  }

  async function save() {
    const providerOptionsJson = providerOptionsRef.current?.value ?? props.model.providerOptionsJson;
    try {
      JSON.parse(providerOptionsJson);
    } catch {
      setProviderOptionsError(t("settings.modelOptions.invalidJson"));
      setSaveState("failed");
      return;
    }

    setProviderOptionsError("");
    setSaveState("saving");
    if (providerOptionsJson !== props.model.providerOptionsJson) {
      props.onChange({ ...props.model, providerOptionsJson });
    }
    try {
      await props.onSave();
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  return (
    <Dialog
      open
      title={t("settings.modelOptions.title")}
      className="model-dialog"
      closeLabel={t("settings.modelOptions.close")}
      onClose={props.onCancel}
      body={<p>{t("settings.modelOptions.description", { model: props.model.id })}</p>}
      actions={
        <div className="model-dialog-actions">
          <span className={`save-state ${saveState}`}>{saveState === "failed" ? t("app.saveFailed") : saveState === "saved" ? t("app.saved") : ""}</span>
          <Button variant="ghost" onClick={props.onCancel}>{t("app.cancel")}</Button>
          <Button variant="primary" disabled={!dirty || saveState === "saving"} loading={saveState === "saving"} onClick={() => void save()}>
            {saveState === "saving" ? t("app.savingDots") : dirty ? t("app.save") : t("app.saved")}
          </Button>
        </div>
      }
    >
        <h4>{t("settings.modelOptions.capabilities")}</h4>
        <p>
          {t("settings.modelOptions.capabilitiesDescription")}
          {props.model.metadataSource && <span className="model-source">{t("settings.modelOptions.detectedBy", { source: props.model.metadataSource })}</span>}
        </p>
        <div className="capability-grid">
          <CapabilityToggle label={t("settings.modelOptions.vision")} value={props.model.capabilities.vision} onChange={(value) => patchCapabilities({ vision: value })} />
          <CapabilityToggle label={t("settings.modelOptions.imageOutput")} value={props.model.capabilities.imageOutput} onChange={(value) => patchCapabilities({ imageOutput: value })} />
          <CapabilityToggle label={t("settings.modelOptions.toolCalling")} value={props.model.capabilities.toolCalling} onChange={(value) => patchCapabilities({ toolCalling: value })} />
          <CapabilityToggle label={t("settings.modelOptions.reasoning")} value={props.model.capabilities.reasoning} onChange={(value) => patchCapabilities({ reasoning: value })} />
          <CapabilityToggle label={t("settings.modelOptions.embedding")} value={props.model.capabilities.embedding} onChange={(value) => patchCapabilities({ embedding: value })} />
        </div>
        <div className="model-number-grid">
          <div>
            <span>{t("settings.modelOptions.contextWindow")}</span>
            <input
              type="number"
              value={props.model.contextWindow}
              onChange={(event) => props.onChange({ ...props.model, contextWindow: Number(event.target.value) })}
            />
          </div>
          <div>
            <span>{t("settings.modelOptions.maxOutputTokens")}</span>
            <input
              type="number"
              value={props.model.maxOutputTokens}
              onChange={(event) => props.onChange({ ...props.model, maxOutputTokens: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="provider-json-field">
          <span>{t("settings.modelOptions.providerOptions")}</span>
          <textarea
            ref={providerOptionsRef}
            value={props.model.providerOptionsJson}
            aria-invalid={providerOptionsError ? "true" : "false"}
            aria-describedby={providerOptionsError ? "provider-options-error" : undefined}
            onChange={(event) => {
              setProviderOptionsError("");
              props.onChange({ ...props.model, providerOptionsJson: event.target.value });
            }}
          />
          {providerOptionsError && <small id="provider-options-error" className="field-error">{providerOptionsError}</small>}
        </div>
        <small>{t("settings.modelOptions.example", { json: '{ "thinking": { "type": "disabled" } }' })}</small>
    </Dialog>
  );
}

function CapabilityToggle(props: { label: string; value: boolean; onChange(value: boolean): void }) {
  return (
    <div className="capability-toggle">
      <span>{props.label}</span>
      <Switch
        checked={props.value}
        className="model-enable"
        aria-label={props.label}
        onLabel=""
        offLabel=""
        onChange={props.onChange}
      />
    </div>
  );
}
