import type { RefObject } from "react";
import type { AiProvider, ReasoningEffort } from "../../../shared/ipc";
import { CheckIcon } from "../icons/Icons";
import { useI18n } from "../../i18n";
import { MenuSurface } from "../ui";

const reasoningLevels: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ModelMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  provider: AiProvider | null;
  providers: AiProvider[];
  activeProviderId: string;
  testing: boolean;
  reasoningEffort: ReasoningEffort;
  onSelectProvider(providerId: string): void;
  onSelectModel(providerId: string, modelId: string): void;
  onSelectReasoningEffort(effort: ReasoningEffort): void;
  onOpenSettings(): void;
  onTest(): void;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();

  if (!props.provider) {
    return (
      <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-end" minWidth={220} maxWidth={280} maxHeight={180} className="model-menu">
        {t("model.noProvider")}
      </MenuSurface>
    );
  }

  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-end" minWidth={240} maxWidth={300} maxHeight={360} className="model-menu model-menu-rich">
      <div className="model-menu-models">
        {props.providers.map((provider) => {
          const models = provider.models.filter((model) => model.enabled || model.id === provider.defaultModel);
          return (
            <div className="model-provider-group" key={provider.id}>
              <span>{provider.name}</span>
              {models.map((model) => {
                const active = provider.id === props.activeProviderId && model.id === provider.defaultModel;
                return (
                  <button
                    key={`${provider.id}-${model.id}`}
                    className={active ? "active" : ""}
                    type="button"
                    onClick={() => props.onSelectModel(provider.id, model.id)}
                  >
                    <span>{model.id}</span>
                    <small>{formatModelSummary(model.contextWindow)}</small>
                    {active && <CheckIcon />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="model-menu-actions">
        <span className="model-menu-label">{t("model.reasoning")}</span>
        {reasoningLevels.map((level) => (
          <button
            key={level}
            className={props.reasoningEffort === level ? "active" : ""}
            type="button"
            onClick={() => props.onSelectReasoningEffort(level)}
          >
            <span>{level}</span>
            {props.reasoningEffort === level && <CheckIcon />}
          </button>
        ))}
      </div>
    </MenuSurface>
  );
}

function formatModelSummary(contextWindow: number): string {
  if (!contextWindow) return "auto";
  if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 1_000_000)}M ctx`;
  if (contextWindow >= 1000) return `${Math.round(contextWindow / 1000)}K ctx`;
  return `${contextWindow} ctx`;
}
