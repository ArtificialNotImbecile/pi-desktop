import { useState } from "react";
import type { ActivityObservation, ActivitySettings, ActivityStatus, AppLanguage } from "../../../shared/ipc";
import { ActivityIcon, RefreshIcon } from "../icons/Icons";
import { localeTag, useI18n } from "../../i18n";

export function ActivityPanel(props: {
  open: boolean;
  settings: ActivitySettings;
  status: ActivityStatus;
  observations: ActivityObservation[];
  query: string;
  loading: boolean;
  onClose(): void;
  onRefresh(): void;
  onSearch(query: string): void;
  onCreateManual(note: string): void;
  onUpdateSettings(update: Partial<ActivitySettings>): void;
}) {
  const { language, t } = useI18n();
  const [draft, setDraft] = useState("");

  if (!props.open) return null;

  return (
    <aside className="activity-panel" aria-label={t("activity.panel")}>
      <div className="activity-panel-header">
        <div>
          <strong>{t("activity.title")}</strong>
          <span>{statusCopy(props.status, t)}</span>
        </div>
        <button type="button" onClick={props.onRefresh} aria-label={t("activity.refresh")} title={t("activity.refresh")}>
          <RefreshIcon />
        </button>
        <button type="button" onClick={props.onClose} aria-label={t("activity.close")}>{t("app.close")}</button>
      </div>

      <section className="activity-status-card">
        <div className={`activity-status-dot ${props.status}`} />
        <div>
          <strong>{statusCopy(props.status, t)}</strong>
          <p>{props.settings.enabled ? t("activity.enabledCopy") : t("activity.disabledCopy")}</p>
        </div>
      </section>

      <section className="activity-controls" aria-label={t("activity.settings")}>
        <button
          type="button"
          className={props.settings.enabled ? "active" : ""}
          onClick={() => props.onUpdateSettings({ enabled: !props.settings.enabled })}
        >
          {props.settings.enabled ? t("activity.disable") : t("activity.enable")}
        </button>
        <button
          type="button"
          disabled={!props.settings.enabled}
          onClick={() => props.onUpdateSettings({ paused: !props.settings.paused })}
        >
          {props.settings.paused ? t("activity.resume") : t("activity.pause")}
        </button>
      </section>

      <section className="activity-privacy">
        <strong>{t("activity.privacy")}</strong>
        <label>
          <span>{t("app.localOnly")}</span>
          <input
            type="checkbox"
            checked={props.settings.localOnly}
            onChange={(event) => props.onUpdateSettings({ localOnly: event.target.checked })}
          />
        </label>
        <label>
          <span>{t("activity.allowWindowTitles")}</span>
          <input
            type="checkbox"
            checked={props.settings.captureWindowTitles}
            onChange={(event) => props.onUpdateSettings({ captureWindowTitles: event.target.checked })}
          />
        </label>
        <label>
          <span>{t("activity.allowScreenshots")}</span>
          <input
            type="checkbox"
            checked={props.settings.captureScreenshots}
            onChange={(event) => props.onUpdateSettings({ captureScreenshots: event.target.checked })}
          />
        </label>
        <label className="retention-row">
          {t("activity.retentionDays")}
          <input
            type="number"
            min={1}
            max={3650}
            value={props.settings.retentionDays}
            onChange={(event) => props.onUpdateSettings({ retentionDays: Number(event.target.value) })}
          />
        </label>
        <p>{t("activity.privacyCopy")}</p>
      </section>

      <form
        className="activity-create"
        onSubmit={(event) => {
          event.preventDefault();
          const note = draft.trim();
          if (!note) return;
          props.onCreateManual(note);
          setDraft("");
        }}
      >
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("activity.whatDidYouDo")} />
        <button type="submit" disabled={!draft.trim()}>{t("activity.addObservation")}</button>
      </form>

      <div className="activity-search">
        <input
          value={props.query}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder={t("activity.search")}
          aria-label={t("activity.search")}
        />
      </div>

      {props.observations.length === 0 ? (
        <p className="activity-empty">{props.loading ? t("activity.loading") : t("activity.empty")}</p>
      ) : (
        <div className="activity-list">
          {props.observations.map((observation) => (
            <article key={observation.id} className="activity-row">
              <div>
                <ActivityIcon />
                <strong>{t("activity.manual")}</strong>
                <span>{formatTime(observation.createdAt, language)}</span>
              </div>
              <p>{observation.note}</p>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}

function statusCopy(status: ActivityStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "running") return t("activity.running");
  if (status === "paused") return t("activity.paused");
  return t("activity.off");
}

function formatTime(value: string, language: AppLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(localeTag(language), { hour: "2-digit", minute: "2-digit" });
}
