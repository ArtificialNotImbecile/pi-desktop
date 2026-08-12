import { useMemo, useState } from "react";
import type { SkillCreateRequest, SkillOpenResponse, SkillRecord, SkillSource, SkillUpdateRequest } from "../../../shared/ipc";
import { SearchIcon, SkillIcon, TrashIcon } from "../icons/Icons";
import { Button, IconButton, Switch } from "../ui";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n, type I18nKey } from "../../i18n";

export function SkillsSettingsPage(props: {
  skills: SkillRecord[];
  skillSources: SkillSource[];
  selectedSkillIds: string[];
  onClose(): void;
  onToggleSelectedSkill(skillId: string): void;
  onRefreshSkills(): void;
  onAddSkillSources(): void;
  onDeleteSkillSource(id: string): void;
  onCreateSkill(request: SkillCreateRequest): Promise<SkillRecord | null>;
  onUpdateSkill(request: SkillUpdateRequest): Promise<SkillRecord | null>;
  onDeleteSkill(id: string): Promise<void>;
  onOpenSkill(id: string): Promise<SkillOpenResponse | null>;
}) {
  const { t } = useI18n();
  const [deleteCandidate, setDeleteCandidate] = useState<SkillRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const visibleSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (!query) return props.skills;
    return props.skills.filter((skill) =>
      [skill.name, skill.description, skill.sourcePath ?? ""].some((value) => value.toLowerCase().includes(query))
    );
  }, [props.skills, skillSearch]);
  const localSkills = visibleSkills.filter((skill) => skill.source === "local");
  const externalSkills = visibleSkills.filter((skill) => skill.source === "external");

  async function createAndOpen() {
    setCreating(true);
    try {
      const skill = await props.onCreateSkill({});
      if (skill) await props.onOpenSkill(skill.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <SettingsHeader title={t("settings.skills.title")} />
      <section className="skill-settings-shell">
        <div className="skill-settings-toolbar">
          <span className="skill-search-control">
            <SearchIcon />
            <input
              aria-label={t("settings.skills.search")}
              value={skillSearch}
              placeholder={t("settings.skills.search")}
              onChange={(event) => setSkillSearch(event.target.value)}
            />
          </span>
          <button className="settings-row-button" type="button" disabled={creating} onClick={() => void createAndOpen()}>
            {creating ? t("app.savingDots") : t("settings.skills.new")}
          </button>
        </div>

        <div className="skill-source-panel">
          <div className="skill-section-heading">
            <span>{t("settings.skills.externalFolders")}</span>
            <button className="settings-row-button" type="button" onClick={props.onAddSkillSources}>{t("settings.skills.addFolder")}</button>
          </div>
        {props.skillSources.length > 0 && (
          <div className="skill-source-list" aria-label={t("settings.skills.folders")}>
            {props.skillSources.map((source) => (
              <div className="skill-source-row" key={source.id}>
                <span title={source.path}>{source.path}</span>
                <button type="button" onClick={props.onRefreshSkills}>{t("settings.skills.refresh")}</button>
                <button type="button" onClick={() => props.onDeleteSkillSource(source.id)}>{t("settings.skills.remove")}</button>
              </div>
            ))}
          </div>
        )}
          {props.skillSources.length === 0 && <div className="skill-source-empty">{t("settings.skills.noFolders")}</div>}
        </div>
      </section>

      <div className="skill-settings-list" aria-label={t("settings.skills.list")}>
        <SkillGroup
          title={t("settings.skills.local")}
          labels={skillLabels(t)}
          skills={localSkills}
          selectedSkillIds={props.selectedSkillIds}
          onToggleSelectedSkill={props.onToggleSelectedSkill}
          onOpenSkill={props.onOpenSkill}
          onUpdateSkill={props.onUpdateSkill}
          onDelete={setDeleteCandidate}
        />
        <SkillGroup
          title={t("settings.skills.external")}
          labels={skillLabels(t)}
          skills={externalSkills}
          selectedSkillIds={props.selectedSkillIds}
          onToggleSelectedSkill={props.onToggleSelectedSkill}
          onOpenSkill={props.onOpenSkill}
          onUpdateSkill={props.onUpdateSkill}
          onDelete={setDeleteCandidate}
        />
        {visibleSkills.length === 0 && (
          <div className="skill-settings-empty">{t("settings.skills.noMatches")}</div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteCandidate)}
        title={t("settings.skills.deleteTitle")}
        body={deleteCandidate ? t("settings.skills.deleteBody", { name: deleteCandidate.name }) : t("settings.skills.deleteFallback")}
        confirmLabel={t("app.delete")}
        onCancel={() => setDeleteCandidate(null)}
        onConfirm={() => {
          if (deleteCandidate) void props.onDeleteSkill(deleteCandidate.id);
          setDeleteCandidate(null);
        }}
      />
    </>
  );
}

type Translate = (key: I18nKey, values?: Record<string, string | number>) => string;

type SkillRowLabels = {
  enabled: string;
  disabled: string;
  external: string;
  selectedInChat: string;
  selectTitle: string;
  enableBeforeSelect: string;
  selected: string;
  select: string;
  open: string;
  enable: string;
  disable: string;
  deleteAria: string;
  deleteTitle: string;
};

function skillLabels(t: Translate): SkillRowLabels {
  return {
    enabled: t("app.enabled"),
    disabled: t("app.disabled"),
    external: t("settings.skills.external"),
    selectedInChat: t("settings.skills.selectedInChat"),
    selectTitle: t("settings.skills.selectTitle"),
    enableBeforeSelect: t("settings.skills.enableBeforeSelect"),
    selected: t("settings.skills.selected"),
    select: t("settings.skills.select"),
    open: t("settings.skills.open"),
    enable: t("settings.skills.enable"),
    disable: t("settings.skills.disable"),
    deleteAria: t("settings.skills.deleteAria", { name: "{name}" }),
    deleteTitle: t("settings.skills.deleteTitleAttr")
  };
}

function SkillGroup(props: {
  title: string;
  labels: SkillRowLabels;
  skills: SkillRecord[];
  selectedSkillIds: string[];
  onToggleSelectedSkill(skillId: string): void;
  onOpenSkill(skillId: string): Promise<SkillOpenResponse | null>;
  onUpdateSkill(request: SkillUpdateRequest): Promise<SkillRecord | null>;
  onDelete(skill: SkillRecord): void;
}) {
  if (props.skills.length === 0) return null;
  return (
    <section className="skill-settings-group">
      <div className="skill-list-heading">
        <span>{props.title}</span>
        <small>{props.skills.length}</small>
      </div>
      {props.skills.map((skill) => (
        <SkillSettingsRow
          key={skill.id}
          skill={skill}
          selected={props.selectedSkillIds.includes(skill.id) && skill.enabled}
          onToggleSelectedSkill={props.onToggleSelectedSkill}
          onOpenSkill={props.onOpenSkill}
          onUpdateSkill={props.onUpdateSkill}
          onDelete={props.onDelete}
          labels={props.labels}
        />
      ))}
    </section>
  );
}

function SkillSettingsRow(props: {
  skill: SkillRecord;
  selected: boolean;
  onToggleSelectedSkill(skillId: string): void;
  onOpenSkill(skillId: string): Promise<SkillOpenResponse | null>;
  onUpdateSkill(request: SkillUpdateRequest): Promise<SkillRecord | null>;
  onDelete(skill: SkillRecord): void;
  labels: SkillRowLabels;
}) {
  const statusText = props.skill.source === "external"
    ? `${props.skill.enabled ? props.labels.enabled : props.labels.disabled} - ${props.skill.sourcePath ?? props.labels.external}`
    : props.skill.enabled ? props.labels.enabled : props.labels.disabled;
  return (
    <article className={`skill-settings-row ${props.selected ? "selected" : ""}`}>
      <span className="skill-row-icon"><SkillIcon /></span>
      <div>
        <strong>{props.skill.name}</strong>
        <p>{props.skill.description}</p>
        <small>{statusText}{props.selected ? ` - ${props.labels.selectedInChat}` : ""}</small>
      </div>
      <div className="skill-row-actions">
        <Button
          size="sm"
          variant={props.selected ? "primary" : "default"}
          disabled={!props.skill.enabled}
          title={props.skill.enabled ? props.labels.selectTitle : props.labels.enableBeforeSelect}
          onClick={() => props.onToggleSelectedSkill(props.skill.id)}
        >
          {props.selected ? props.labels.selected : props.labels.select}
        </Button>
        <Button size="sm" variant="default" onClick={() => void props.onOpenSkill(props.skill.id)}>{props.labels.open}</Button>
        <Switch
          checked={props.skill.enabled}
          aria-label={`${props.skill.enabled ? props.labels.disable : props.labels.enable} ${props.skill.name}`}
          title={`${props.skill.enabled ? props.labels.disable : props.labels.enable} ${props.skill.name}`}
          onChange={(checked) => void props.onUpdateSkill({ id: props.skill.id, enabled: checked })}
        />
        {props.skill.readonly ? (
          <span className="settings-state-pill">{props.labels.external}</span>
        ) : (
          <IconButton className="icon-danger" label={props.labels.deleteAria.replace("{name}", props.skill.name)} title={props.labels.deleteTitle} onClick={() => props.onDelete(props.skill)}>
            <TrashIcon />
          </IconButton>
        )}
      </div>
    </article>
  );
}
