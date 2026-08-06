import { useEffect, useMemo, useState } from "react";
import type { TodoFileKind, TodoSnapshot } from "../../../shared/ipc";
import { ChevronRightIcon, EditIcon, PlusIcon, RefreshIcon, TodoIcon } from "../icons/Icons";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { Button, EmptyState, Tabs, classNames } from "../ui";
import { TodoAddDialog } from "./TodoAddDialog";
import { useI18n } from "../../i18n";

type TodoTab = "organized" | "log";

export function TodoPage(props: {
  snapshot: TodoSnapshot | null;
  loading: boolean;
  saving: boolean;
  openingKind: TodoFileKind | null;
  addOpen: boolean;
  activeProjectName?: string | null;
  onRefresh(): void;
  onOpenAdd(): void;
  onCloseAdd(): void;
  onAdd(text: string): Promise<boolean>;
  onOpenFile(kind: TodoFileKind): void;
  onCopyCode(code: string): void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<TodoTab>("organized");
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set());
  const sections = props.snapshot?.sections ?? [];
  const hasTasks = useMemo(
    () => sections.some((section) => section.markdown.trim().length > 0),
    [sections]
  );

  useEffect(() => {
    if (!props.snapshot) return;
    setOpenSections(new Set(props.snapshot.sections.map((section) => section.id)));
  }, [props.snapshot?.updatedAt]);

  function toggleSection(id: string) {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="todo-page" aria-label={t("todo.title")}>
      <header className="todo-header">
        <div className="todo-title-group">
          <span className="todo-title-icon"><TodoIcon /></span>
          <div>
            <h1>{t("todo.title")}</h1>
            <p>{props.snapshot?.rootPath ?? t("todo.loadingFiles")}</p>
          </div>
        </div>
        <div className="todo-header-actions">
          <Button size="sm" variant="quiet" leftIcon={<RefreshIcon />} loading={props.loading} onClick={props.onRefresh}>
            {t("app.refresh")}
          </Button>
          <Button size="sm" variant="default" leftIcon={<EditIcon />} loading={props.openingKind === "todo"} disabled={!props.snapshot} onClick={() => props.onOpenFile("todo")}>
            {t("todo.openTodo")}
          </Button>
          <Button size="sm" variant="default" leftIcon={<EditIcon />} loading={props.openingKind === "log"} disabled={!props.snapshot} onClick={() => props.onOpenFile("log")}>
            {t("todo.openLog")}
          </Button>
          <Button size="sm" variant="default" leftIcon={<EditIcon />} loading={props.openingKind === "schema"} disabled={!props.snapshot} onClick={() => props.onOpenFile("schema")}>
            {t("todo.openSchema")}
          </Button>
          <Button size="sm" variant="primary" leftIcon={<PlusIcon />} onClick={props.onOpenAdd}>
            {t("todo.add.button")}
          </Button>
        </div>
      </header>

      <div className="todo-tabs-row">
        <Tabs<TodoTab>
          ariaLabel={t("todo.tabs")}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "organized", label: t("todo.tab.organized") },
            { id: "log", label: t("todo.tab.log") }
          ]}
        />
        {props.snapshot ? (
          <span className="todo-updated">{t("todo.updated", { time: formatUpdated(props.snapshot.updatedAt) })}</span>
        ) : null}
      </div>

      <div className="todo-content">
        {props.loading && !props.snapshot ? (
          <div className="todo-loading" role="status">
            <div />
            <div />
            <div />
          </div>
        ) : tab === "organized" ? (
          hasTasks ? (
            <div className="todo-section-list">
              {sections.map((section) => {
                const open = openSections.has(section.id);
                const total = section.openCount + section.doneCount;
                return (
                  <article className="todo-section" key={section.id}>
                    <Button
                      className="todo-section-toggle"
                      variant="ghost"
                      aria-expanded={open}
                      onClick={() => toggleSection(section.id)}
                      leftIcon={<span className={classNames("todo-section-chevron", open && "open")}><ChevronRightIcon /></span>}
                      rightIcon={<span className="todo-section-count">{t("todo.sectionCount", { open: section.openCount, total })}</span>}
                    >
                      <span className="todo-section-title">{section.title}</span>
                    </Button>
                    {open ? (
                      <div className="todo-section-body">
                        {section.markdown.trim() ? (
                          <MarkdownMessage content={section.markdown} onCopyCode={props.onCopyCode} />
                        ) : (
                          <p className="todo-empty-section">{t("todo.sectionEmpty")}</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title={t("todo.empty.title")} subtitle={t("todo.empty.description")} />
          )
        ) : props.snapshot?.logMarkdown.trim() ? (
          <div className="todo-log">
            <MarkdownMessage content={props.snapshot.logMarkdown} onCopyCode={props.onCopyCode} />
          </div>
        ) : (
          <EmptyState title={t("todo.log.emptyTitle")} subtitle={t("todo.log.emptyDescription")} />
        )}
      </div>

      <TodoAddDialog
        open={props.addOpen}
        saving={props.saving}
        projectName={props.activeProjectName}
        onClose={props.onCloseAdd}
        onSave={props.onAdd}
      />
    </section>
  );
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
