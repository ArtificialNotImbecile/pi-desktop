import type { RefObject } from "react";
import type { SkillRecord } from "../../../shared/ipc";
import { CheckIcon, SettingsIcon } from "../icons/Icons";
import { useI18n } from "../../i18n";
import { MenuSurface } from "../ui";

export function SkillMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  skills: SkillRecord[];
  selectedSkillIds: string[];
  loading: boolean;
  onToggleSkill(skillId: string): void;
  onOpenSettings(): void;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();

  const enabledSkills = props.skills.filter((skill) => skill.enabled);
  const disabledSkills = props.skills.filter((skill) => !skill.enabled);

  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-start" minWidth={280} maxWidth={340} maxHeight={340} className="skill-menu" aria-label={t("skill.menu")}>
      <div className="skill-menu-list">
        {props.loading ? (
          <p className="skill-menu-empty">{t("skill.loading")}</p>
        ) : props.skills.length === 0 ? (
          <p className="skill-menu-empty">{t("skill.empty")}</p>
        ) : (
          <>
            <SkillGroup
              label={t("skill.available")}
              disabledTitle={t("skill.enableBeforeUse")}
              skills={enabledSkills}
              selectedSkillIds={props.selectedSkillIds}
              onToggleSkill={props.onToggleSkill}
            />
            {disabledSkills.length > 0 && (
              <SkillGroup
                label={t("skill.disabled")}
                disabledTitle={t("skill.enableBeforeUse")}
                skills={disabledSkills}
                selectedSkillIds={props.selectedSkillIds}
                onToggleSkill={props.onToggleSkill}
              />
            )}
          </>
        )}
      </div>
      <div className="skill-menu-actions">
        <button type="button" onClick={props.onOpenSettings}>
          <span>{t("skill.settings")}</span>
          <SettingsIcon />
        </button>
      </div>
    </MenuSurface>
  );
}

function SkillGroup(props: {
  label: string;
  disabledTitle: string;
  skills: SkillRecord[];
  selectedSkillIds: string[];
  onToggleSkill(skillId: string): void;
}) {
  if (props.skills.length === 0) return null;

  return (
    <div className="skill-menu-group">
      <span>{props.label}</span>
      {props.skills.map((skill) => {
        const selected = props.selectedSkillIds.includes(skill.id) && skill.enabled;
        return (
          <button
            key={skill.id}
            className={selected ? "active" : ""}
            type="button"
            disabled={!skill.enabled}
            title={skill.enabled ? skill.description : props.disabledTitle}
            onClick={() => props.onToggleSkill(skill.id)}
          >
            <span>
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
            </span>
            {selected && <CheckIcon />}
          </button>
        );
      })}
    </div>
  );
}
