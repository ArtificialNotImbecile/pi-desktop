import { useMemo, useState } from "react";
import type { PromptTemplateRecord, PromptTemplateSource } from "../../../shared/ipc";
import { FolderIcon, PlusIcon, RefreshIcon, SearchIcon, TerminalIcon, TrashIcon } from "../icons/Icons";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n } from "../../i18n";
import { Button, EmptyState, IconButton, TextInput } from "../ui";
import { SettingsList, SettingsListRow, SettingsPage, SettingsToolbar, StatePill } from "./SettingsLayout";

export function PromptTemplatesSettingsPage(props: {
  templates: PromptTemplateRecord[];
  sources: PromptTemplateSource[];
  loading: boolean;
  onClose(): void;
  onRefresh(): void;
  onAddSources(): void;
  onDeleteSource(id: string): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTemplates = useMemo(
    () => props.templates
      .filter((template) => !normalizedQuery || template.name.toLowerCase().includes(normalizedQuery) || template.description.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [normalizedQuery, props.templates]
  );

  return (
    <>
      <SettingsHeader title={t("settings.prompts.title")} />
      <SettingsPage className="prompt-settings">
        <SettingsToolbar className="prompt-settings-toolbar">
          <TextInput
            className="skill-search-control"
            type="search"
            value={query}
            placeholder={t("settings.prompts.search")}
            aria-label={t("settings.prompts.search")}
            leftIcon={<SearchIcon />}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button size="sm" onClick={props.onRefresh} disabled={props.loading} loading={props.loading} leftIcon={<RefreshIcon />}>
            {props.loading ? t("app.loading") : t("app.refresh")}
          </Button>
          <Button size="sm" onClick={props.onAddSources} leftIcon={<PlusIcon />}>
            {t("settings.prompts.addSource")}
          </Button>
        </SettingsToolbar>

        <SettingsList className="prompt-source-list" ariaLabel={t("settings.prompts.sources")}>
          <SettingsListRow
            className="prompt-source-row"
            icon={<span className="prompt-source-icon"><FolderIcon /></span>}
            title={t("settings.prompts.localSource")}
            description="~/.jasmine/prompts"
            status={<StatePill>{t("app.localOnly")}</StatePill>}
          />
          {props.sources.map((source) => (
            <SettingsListRow
              key={source.id}
              className="prompt-source-row"
              icon={<span className="prompt-source-icon"><FolderIcon /></span>}
              title={source.path}
              description={t("settings.prompts.customSource")}
              actions={
                <IconButton label={t("settings.prompts.removeSource", { path: source.path })} variant="danger" size="sm" onClick={() => props.onDeleteSource(source.id)}>
                  <TrashIcon />
                </IconButton>
              }
            />
          ))}
        </SettingsList>

        <SettingsList className="skill-settings-list" ariaLabel={t("settings.prompts.templates")}>
          {filteredTemplates.length === 0 ? (
            <EmptyState icon={<TerminalIcon />} title={props.loading ? t("prompt.loading") : t("prompt.empty")} />
          ) : (
            filteredTemplates.map((template) => (
              <SettingsListRow
                key={template.filePath}
                className="prompt-template-row"
                icon={<TerminalIcon />}
                title={`/${template.name}`}
                description={template.description || template.filePath}
                meta={template.filePath}
                status={template.argumentHint ? <StatePill>{template.argumentHint}</StatePill> : undefined}
              />
            ))
          )}
        </SettingsList>
      </SettingsPage>
    </>
  );
}
