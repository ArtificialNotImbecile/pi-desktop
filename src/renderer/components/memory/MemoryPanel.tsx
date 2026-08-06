import { useState } from "react";
import type { MemoryRecord } from "../../../shared/ipc";
import { BrainIcon, EditIcon, RefreshIcon } from "../icons/Icons";
import { useI18n } from "../../i18n";

export function MemoryPanel(props: {
  open: boolean;
  memories: MemoryRecord[];
  loading: boolean;
  memoryEnabled: boolean;
  onToggleEnabled(): void;
  onClose(): void;
  onRefresh(): void;
  onCreate(content: string): void;
  onUpdate(id: string, content: string): void;
  onArchive(id: string, archived: boolean): void;
  onRequestDelete(memory: MemoryRecord): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  if (!props.open) return null;

  const activeCount = props.memories.filter((memory) => !memory.archived && !memory.deleted).length;

  return (
    <aside className="memory-panel" aria-label={t("memory.panel")}>
      <div className="memory-panel-header">
        <div>
          <strong>{t("memory.title")}</strong>
          <span>{props.loading ? t("app.loading") : t("memory.activeCount", { count: activeCount })}</span>
        </div>
        <button
          type="button"
          className={`memory-use-toggle ${props.memoryEnabled ? "active" : ""}`}
          onClick={props.onToggleEnabled}
          aria-pressed={props.memoryEnabled}
        >
          {props.memoryEnabled ? t("memory.using") : t("app.off")}
        </button>
        <button type="button" onClick={props.onRefresh} aria-label={t("memory.refresh")} title={t("memory.refresh")}>
          <RefreshIcon />
        </button>
        <button type="button" onClick={props.onClose} aria-label={t("memory.close")}>{t("app.close")}</button>
      </div>

      <form
        className="memory-create"
        onSubmit={(event) => {
          event.preventDefault();
          const content = draft.trim();
          if (!content) return;
          props.onCreate(content);
          setDraft("");
        }}
      >
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("memory.newPlaceholder")} />
        <button type="submit" disabled={!draft.trim()}>{t("memory.add")}</button>
      </form>

      {props.memories.length === 0 ? (
        <p className="memory-empty">{t("memory.empty")}</p>
      ) : (
        <div className="memory-list">
          {props.memories.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              onUpdate={props.onUpdate}
              onArchive={props.onArchive}
              onRequestDelete={props.onRequestDelete}
              labels={{
                archived: t("memory.archived"),
                active: t("memory.active"),
                editContent: t("memory.editContent"),
                save: t("app.save"),
                cancel: t("app.cancel"),
                editAria: t("memory.editAria"),
                edit: t("app.edit"),
                restore: t("memory.restore"),
                archive: t("memory.archive"),
                delete: t("app.delete")
              }}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function MemoryRow(props: {
  memory: MemoryRecord;
  onUpdate(id: string, content: string): void;
  onArchive(id: string, archived: boolean): void;
  onRequestDelete(memory: MemoryRecord): void;
  labels: {
    archived: string;
    active: string;
    editContent: string;
    save: string;
    cancel: string;
    editAria: string;
    edit: string;
    restore: string;
    archive: string;
    delete: string;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.memory.content);

  return (
    <article className={`memory-row ${props.memory.archived ? "archived" : ""}`}>
      <div className="memory-row-title">
        <BrainIcon />
        <strong>{props.memory.archived ? props.labels.archived : props.labels.active}</strong>
        <span>{formatDate(props.memory.updatedAt)}</span>
      </div>
      {editing ? (
        <form
          className="memory-edit"
          onSubmit={(event) => {
            event.preventDefault();
            const content = draft.trim();
            if (!content) return;
            props.onUpdate(props.memory.id, content);
            setEditing(false);
          }}
        >
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={props.labels.editContent} />
          <div>
            <button type="submit" disabled={!draft.trim()}>{props.labels.save}</button>
            <button type="button" onClick={() => { setDraft(props.memory.content); setEditing(false); }}>{props.labels.cancel}</button>
          </div>
        </form>
      ) : (
        <p>{props.memory.content}</p>
      )}
      <div className="memory-row-actions">
        <button type="button" onClick={() => setEditing(true)} aria-label={props.labels.editAria}>
          <EditIcon />
          <span>{props.labels.edit}</span>
        </button>
        <button type="button" onClick={() => props.onArchive(props.memory.id, !props.memory.archived)}>
          {props.memory.archived ? props.labels.restore : props.labels.archive}
        </button>
        <button type="button" className="danger" onClick={() => props.onRequestDelete(props.memory)}>
          {props.labels.delete}
        </button>
      </div>
    </article>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
