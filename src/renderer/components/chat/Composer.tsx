import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { AiProvider, ChatMessage, ChatQueueMode, ChatQueueState, ChatQueuedMessage, ClipboardImagePasteRequest, FileSearchResult, PermissionMode, PickedPath, PluginPackageRecord, PromptTemplateRecord, ReasoningEffort, SkillRecord, WorkspaceProject } from "../../../shared/ipc";
import type { RunState } from "../../types";
import {
  ChevronDownIcon,
  CheckIcon,
  EditIcon,
  FolderIcon,
  PaperclipIcon,
  PlugIcon,
  SendIcon,
  ShieldIcon,
  SkillIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
  WrenchIcon
} from "../icons/Icons";
import { IconButton } from "../ui/IconButton";
import { CommandMenu, MenuItem, MenuSurface, type CommandMenuItem } from "../ui";
import { getBridge } from "../../desktopApi";
import { ModelMenu } from "./ModelMenu";
import { SkillMenu } from "./SkillMenu";
import { useI18n } from "../../i18n";
import { useComposerCommands } from "../../hooks/useComposerCommands";
import { RichComposer, type RichComposerHandle } from "./RichComposer";
import { ImageLightbox } from "./ImageLightbox";
import {
  buildMentionItems,
  buildPromptCommandItems,
  buildSkillCommandItems,
  type MentionItem,
  type PromptCommandItem,
  type SkillCommandItem
} from "./composerCommandItems";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_COMPOSER_RENDERS__?: number;
  }
}

// Memoized so chat stream ticks stop at ChatPage: every data prop the stream
// touches (draft, runState, queueState, context label) is either stable during
// a tick or changes only when the composer genuinely needs to repaint, and
// ChatPage passes identity-stable callbacks via useStableCallbacks.
export const Composer = memo(function Composer(props: {
  draft: string;
  attachments: PickedPath[];
  editingMessage: ChatMessage | null;
  messagesEmpty: boolean;
  runState: RunState;
  queueState: ChatQueueState;
  provider: AiProvider | null;
  activeProject: WorkspaceProject | null;
  providers: AiProvider[];
  activeProviderId: string;
  modelMenuOpen: boolean;
  skillMenuOpen: boolean;
  webSearchEnabled: boolean;
  webSearchLoading: boolean;
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  permissionModeSaving: boolean;
  reasoningEffort: ReasoningEffort;
  contextUsageLabel: string;
  contextUsageTitle: string;
  skills: SkillRecord[];
  inlineSkillChoices: SkillRecord[];
  selectedSkillIds: string[];
  selectedSkillsCount: number;
  inlineSkillIds: string[];
  inlineSkills: SkillRecord[];
  plugins: PluginPackageRecord[];
  inlinePluginIds: string[];
  inlinePlugins: PluginPackageRecord[];
  skillsLoading: boolean;
  promptTemplates: PromptTemplateRecord[];
  promptTemplatesLoading: boolean;
  testingProvider: boolean;
  onDraftChange(value: string): void;
  onClearError(): void;
  onSubmit(mode?: ChatQueueMode): void;
  onUpdateQueuedMessage(messageId: string, content: string, attachments?: PickedPath[]): void;
  onDeleteQueuedMessage(messageId: string): void;
  onSteerQueuedMessage(messageId: string): void;
  onStop(): void;
  onAttachFile(): void;
  onAttachClipboardImage(request?: ClipboardImagePasteRequest): void;
  onAttachFilePath(path: string): void;
  onRemoveAttachment(path: string): void;
  onCancelEdit(): void;
  onToggleSkillMenu(): void;
  onToggleSkill(skillId: string): void;
  onAddInlineSkill(skillId: string): void;
  onRemoveInlineSkill(skillId: string): void;
  onAddInlinePlugin(pluginId: string): void;
  onRemoveInlinePlugin(pluginId: string): void;
  onOpenSkillSettings(): void;
  onOpenPluginSettings(): void;
  onToggleTools(): void;
  onSelectPermissionMode(mode: PermissionMode): void;
  onToggleModelMenu(): void;
  onSelectProvider(providerId: string): void;
  onSelectModel(providerId: string, modelId: string): void;
  onSelectReasoningEffort(effort: ReasoningEffort): void;
  onOpenSettings(): void;
  onTestProvider(): void;
  onToggleWebSearch(): void;
}) {
  recordHarnessRender();
  const { t } = useI18n();
  const richComposerRef = useRef<RichComposerHandle | null>(null);
  const editorAnchorRef = useRef<HTMLElement | null>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const skillTriggerRef = useRef<HTMLButtonElement | null>(null);
  const permissionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerId = useId();
  const skillTriggerId = useId();
  const toolsTriggerId = useId();
  const permissionTriggerId = useId();
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [queuedDraft, setQueuedDraft] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<PickedPath | null>(null);
  const composerCommands = useComposerCommands();
  const { mention, skillCommand, promptCommand } = composerCommands;
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const lastCursorRef = useRef<number | null>(null);

  function onCommandStateChange(value: string, cursor: number | null) {
    lastCursorRef.current = cursor;
    composerCommands.updateCommandState(value, cursor);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (skillCommand.open) {
      if (handleCommandMenuKey(event, skillCommandItems.length, skillCommand.activeIndex, composerCommands.setSkillCommandActiveIndex, () => closeSkillCommand(), () => selectSkillCommandItem(skillCommandItems[Math.min(skillCommand.activeIndex, skillCommandItems.length - 1)]))) return;
    }
    if (promptCommand.open) {
      if (handleCommandMenuKey(event, promptCommandItems.length, promptCommand.activeIndex, composerCommands.setPromptCommandActiveIndex, () => closePromptCommand(), () => selectPromptCommandItem(promptCommandItems[Math.min(promptCommand.activeIndex, promptCommandItems.length - 1)]))) return;
    }
    if (mention.open) {
      const items = mentionItems;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        composerCommands.setMentionActiveIndex(items.length === 0 ? 0 : (mention.activeIndex + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        composerCommands.setMentionActiveIndex(items.length === 0 ? 0 : (mention.activeIndex - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
      if (event.key === "Enter" && items.length > 0) {
        event.preventDefault();
        void selectMentionItem(items[Math.min(mention.activeIndex, items.length - 1)]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (props.runState === "running" || props.runState === "idle" || props.runState === "error") props.onSubmit();
    }
  }

  const canSend = props.draft.trim().length > 0 || props.attachments.length > 0;
  const isRunning = props.runState === "running";
  const isStopping = props.runState === "stopping";
  const queuedCount = props.queueState.followUp.length + props.queueState.steering.length;
  const queuedMessages = useMemo(() => orderedQueuedMessages(props.queueState), [props.queueState]);
  const mentionItems = useMemo(
    () => buildMentionItems(props.plugins, props.inlinePluginIds, fileResults, mention.query, fileSearchLoading, {
      plugins: t("mention.plugins"),
      pluginEnabled: t("mention.pluginEnabled"),
      pluginTemporary: t("mention.pluginTemporary"),
      searchingFiles: t("mention.searchingFiles"),
      noFiles: props.activeProject ? t("mention.noFiles") : t("mention.noProject"),
      typeToSearch: props.activeProject ? t("mention.typeToSearch") : t("mention.noProject"),
      fileHint: props.activeProject ? t("mention.fileHint") : t("mention.noProjectHint")
    }),
    [props.plugins, props.inlinePluginIds, props.activeProject, fileResults, mention.query, fileSearchLoading, t]
  );
  const skillCommandItems = useMemo(
    () => buildSkillCommandItems(props.inlineSkillChoices, props.inlineSkillIds, skillCommand.query, props.skillsLoading, {
      loading: t("skill.loading"),
      empty: t("skill.empty"),
      noMatch: t("skill.noMatch")
    }),
    [props.inlineSkillChoices, props.inlineSkillIds, skillCommand.query, props.skillsLoading, t]
  );
  const promptCommandItems = useMemo(
    () => buildPromptCommandItems(props.promptTemplates, promptCommand.query, props.promptTemplatesLoading, {
      loading: t("prompt.loading"),
      empty: t("prompt.empty"),
      noMatch: t("prompt.noMatch")
    }),
    [props.promptTemplates, promptCommand.query, props.promptTemplatesLoading, t]
  );

  useEffect(() => {
    if (!mention.open || !mention.query.trim() || !props.activeProject) {
      setFileResults([]);
      setFileSearchLoading(false);
      return;
    }
    const activeProjectId = props.activeProject.id;
    let cancelled = false;
    setFileSearchLoading(true);
    const timer = window.setTimeout(() => {
      void getBridge().searchFiles({ query: mention.query, projectId: activeProjectId, limit: 8 })
        .then((results) => {
          if (!cancelled) setFileResults(results);
        })
        .catch(() => {
          if (!cancelled) setFileResults([]);
        })
        .finally(() => {
          if (!cancelled) setFileSearchLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mention.open, mention.query, props.activeProject?.id]);

  useEffect(() => {
    if (mentionItems.length === 0 || mention.activeIndex < mentionItems.length) return;
    composerCommands.setMentionActiveIndex(0);
  }, [composerCommands, mention.activeIndex, mentionItems.length]);

  useEffect(() => {
    if (skillCommandItems.length === 0 || skillCommand.activeIndex < skillCommandItems.length) return;
    composerCommands.setSkillCommandActiveIndex(0);
  }, [composerCommands, skillCommand.activeIndex, skillCommandItems.length]);

  useEffect(() => {
    if (promptCommandItems.length === 0 || promptCommand.activeIndex < promptCommandItems.length) return;
    composerCommands.setPromptCommandActiveIndex(0);
  }, [composerCommands, promptCommand.activeIndex, promptCommandItems.length]);

  function closeMention() {
    composerCommands.closeMention();
    setFileResults([]);
  }

  function closeSkillCommand() {
    composerCommands.closeSkillCommand();
  }

  function closePromptCommand() {
    composerCommands.closePromptCommand();
  }

  function replaceMentionToken() {
    const cursor = lastCursorRef.current ?? props.draft.length;
    const next = `${props.draft.slice(0, mention.start)}${props.draft.slice(cursor)}`.replace(/\s{2,}/g, " ");
    props.onDraftChange(next);
    window.setTimeout(() => {
      richComposerRef.current?.focus();
    }, 0);
  }

  async function selectMentionItem(item: MentionItem) {
    if (item.type === "status") return;
    if (item.type === "plugin") props.onAddInlinePlugin(item.pluginId);
    else if (item.type === "file") props.onAttachFilePath(item.path);
    replaceMentionToken();
    closeMention();
  }

  function removeCommandToken(start: number) {
    const cursor = lastCursorRef.current ?? props.draft.length;
    const next = `${props.draft.slice(0, start)}${props.draft.slice(cursor)}`.replace(/\s{2,}/g, " ");
    props.onDraftChange(next);
    window.setTimeout(() => {
      richComposerRef.current?.focus();
    }, 0);
  }

  function selectSkillCommandItem(item: SkillCommandItem | undefined) {
    if (!item || item.type !== "skill") return;
    props.onAddInlineSkill(item.id);
    removeCommandToken(skillCommand.start);
    closeSkillCommand();
  }

  function selectPromptCommandItem(item: PromptCommandItem | undefined) {
    if (!item || item.type !== "template") return;
    const next = `/${item.name} `;
    props.onDraftChange(next);
    closePromptCommand();
    window.setTimeout(() => {
      richComposerRef.current?.focus();
    }, 0);
  }

  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!isStopping) props.onSubmit(); }}>
      {props.editingMessage && (
        <div className="edit-banner">
          <span>{t("composer.editing")}</span>
          <button type="button" onClick={props.onCancelEdit}>{t("composer.cancelEdit")}</button>
        </div>
      )}
      {props.attachments.length > 0 && (
        <div className="attachment-row">
          {props.attachments.map((item) => (
            <div key={item.path} className={`attachment-chip ${item.isImage && item.previewDataUrl ? "image-chip" : ""}`} title={item.path}>
              {item.isImage && item.previewDataUrl ? (
                <button
                  className="attachment-chip-main attachment-chip-preview"
                  type="button"
                  aria-label={t("composer.previewAttachment", { name: item.name })}
                  onClick={() => setPreviewAttachment(item)}
                >
                  <img src={item.previewDataUrl} alt="" />
                  <span>{item.name}</span>
                </button>
              ) : (
                <span className="attachment-chip-main">
                  {item.kind === "file" ? <PaperclipIcon /> : <FolderIcon />}
                  <span>{item.name}</span>
                </span>
              )}
              <button
                className="attachment-remove"
                type="button"
                aria-label={t("composer.removeAttachment", { name: item.name })}
                title={t("composer.removeAttachment", { name: item.name })}
                onClick={() => props.onRemoveAttachment(item.path)}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {previewAttachment?.previewDataUrl && (
        <ImageLightbox attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
      )}
      {props.inlineSkills.length > 0 && (
        <div className="inline-skill-row" aria-label={t("composer.inlineSkills")}>
          {props.inlineSkills.map((skill) => (
            <button key={skill.id} type="button" title={skill.description} onClick={() => props.onRemoveInlineSkill(skill.id)}>
              <SkillIcon />
              <span>{skill.name}</span>
              <b>x</b>
            </button>
          ))}
        </div>
      )}
      {props.inlinePlugins.length > 0 && (
        <div className="inline-plugin-row" aria-label={t("composer.inlinePlugins")}>
          {props.inlinePlugins.map((plugin) => (
            <button key={plugin.id} type="button" title={plugin.source} onClick={() => props.onRemoveInlinePlugin(plugin.id)}>
              <PlugIcon />
              <span>{plugin.displayName}</span>
              <b>x</b>
            </button>
          ))}
        </div>
      )}
      {queuedCount > 0 && (
        <div className="queue-row" aria-label={t("composer.queueStatus")} role="list">
          {queuedMessages.map((message, index) => {
            const editable = message.mode === "followUp";
            const editing = editingQueuedId === message.id;
            return (
              <div key={message.id} className={`queue-item ${message.mode === "steer" ? "is-steer" : ""}`} role="listitem">
                <span className="queue-order" aria-hidden="true">{index + 1}</span>
                {editing ? (
                  <input
                    className="queue-edit-input"
                    aria-label={t("composer.queueEditInput", { index: index + 1 })}
                    value={queuedDraft}
                    onChange={(event) => setQueuedDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveQueuedEdit(message);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelQueuedEdit();
                      }
                    }}
                  />
                ) : (
                  <button
                    className="queue-message-text"
                    type="button"
                    title={message.content}
                    disabled={!editable}
                    onClick={() => {
                      if (editable) beginQueuedEdit(message);
                    }}
                  >
                    <span>{message.content || t("composer.queueAttachmentOnly")}</span>
                  </button>
                )}
                <div className="queue-actions">
                  {editing ? (
                    <>
                      <button className="queue-action text-action" type="button" onClick={() => saveQueuedEdit(message)} disabled={!queuedDraft.trim()}>{t("app.save")}</button>
                      <button className="queue-action icon-action" type="button" aria-label={t("composer.cancelQueuedEdit", { index: index + 1 })} title={t("composer.cancelQueuedEdit", { index: index + 1 })} onClick={cancelQueuedEdit}>x</button>
                    </>
                  ) : editable ? (
                    <>
                      <button className="queue-action text-action" type="button" onClick={() => props.onSteerQueuedMessage(message.id)}>{t("composer.steerMode")}</button>
                      <button className="queue-action icon-action" type="button" aria-label={t("composer.editQueuedMessage", { index: index + 1 })} title={t("composer.editQueuedMessage", { index: index + 1 })} onClick={() => beginQueuedEdit(message)}><EditIcon /></button>
                      <button className="queue-action icon-action" type="button" aria-label={t("composer.deleteQueuedMessage", { index: index + 1 })} title={t("composer.deleteQueuedMessage", { index: index + 1 })} onClick={() => props.onDeleteQueuedMessage(message.id)}><TrashIcon /></button>
                    </>
                  ) : (
                    <span className="queue-steer-status">{t("composer.steerChip")}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <RichComposer
        ref={richComposerRef}
        anchorRef={editorAnchorRef}
        value={props.draft}
        ariaLabel={t("composer.ariaDraft")}
        placeholder={props.messagesEmpty ? t("composer.placeholder.empty") : t("composer.placeholder.active")}
        onChange={props.onDraftChange}
        onClearError={props.onClearError}
        onCommandStateChange={onCommandStateChange}
        onKeyDown={onKeyDown}
        onPasteAttachment={props.onAttachClipboardImage}
        onSubmitFromKeyboard={() => {
          if (skillCommand.open && skillCommandItems.length > 0) {
            selectSkillCommandItem(skillCommandItems[Math.min(skillCommand.activeIndex, skillCommandItems.length - 1)]);
            return;
          }
          if (promptCommand.open && promptCommandItems.length > 0) {
            selectPromptCommandItem(promptCommandItems[Math.min(promptCommand.activeIndex, promptCommandItems.length - 1)]);
            return;
          }
          if (mention.open && mentionItems.length > 0) {
            void selectMentionItem(mentionItems[Math.min(mention.activeIndex, mentionItems.length - 1)]);
            return;
          }
          if (props.runState === "running" || props.runState === "idle" || props.runState === "error") props.onSubmit();
        }}
      />
      <MentionMenu
        open={mention.open}
        anchorRef={editorAnchorRef}
        items={mentionItems}
        activeIndex={mention.activeIndex}
        query={mention.query}
        onActiveIdChange={(id) => setActiveIndexFromId(mentionItems, id, composerCommands.setMentionActiveIndex)}
        onOpenChange={(open) => {
          if (!open) closeMention();
        }}
        onSelect={(item) => void selectMentionItem(item)}
      />
      <SkillCommandMenu
        open={skillCommand.open}
        anchorRef={editorAnchorRef}
        items={skillCommandItems}
        activeIndex={skillCommand.activeIndex}
        onActiveIdChange={(id) => setActiveIndexFromId(skillCommandItems, id, composerCommands.setSkillCommandActiveIndex)}
        onOpenChange={(open) => {
          if (!open) closeSkillCommand();
        }}
        onSelect={selectSkillCommandItem}
      />
      <PromptCommandMenu
        open={promptCommand.open}
        anchorRef={editorAnchorRef}
        items={promptCommandItems}
        activeIndex={promptCommand.activeIndex}
        onActiveIdChange={(id) => setActiveIndexFromId(promptCommandItems, id, composerCommands.setPromptCommandActiveIndex)}
        onOpenChange={(open) => {
          if (!open) closePromptCommand();
        }}
        onSelect={selectPromptCommandItem}
      />
      <div className="composer-bar">
        <IconButton label={t("composer.attachFile")} onClick={props.onAttachFile}>
          <PaperclipIcon />
        </IconButton>
        <div className="tools-menu-wrap">
          <button
            ref={toolsTriggerRef}
            id={toolsTriggerId}
            className={`tool ${toolsMenuOpen ? "active" : ""}`}
            type="button"
            aria-label={t("composer.tools")}
            title={t("composer.tools")}
            aria-expanded={toolsMenuOpen}
            onClick={() => setToolsMenuOpen((open) => !open)}
          >
            <WrenchIcon />
          </button>
          <ToolsMenu
            open={toolsMenuOpen}
            anchorRef={toolsTriggerRef}
            triggerId={toolsTriggerId}
            toolsEnabled={props.toolsEnabled}
            onOpenChange={setToolsMenuOpen}
            onOpenPluginSettings={props.onOpenPluginSettings}
          />
        </div>
        <button
          ref={skillTriggerRef}
          id={skillTriggerId}
          className={`tool skill-tool ${props.selectedSkillsCount > 0 || props.skillMenuOpen ? "active" : ""}`}
          type="button"
          aria-label={t("composer.skills")}
          title={props.selectedSkillsCount > 0 ? t("composer.activeSkills", { count: props.selectedSkillsCount }) : t("composer.selectSkills")}
          aria-expanded={props.skillMenuOpen}
          onClick={props.onToggleSkillMenu}
        >
          <SkillIcon />
        </button>
        <SkillMenu
          open={props.skillMenuOpen}
          anchorRef={skillTriggerRef}
          skills={props.skills}
          selectedSkillIds={props.selectedSkillIds}
          loading={props.skillsLoading}
          onToggleSkill={props.onToggleSkill}
          onOpenSettings={props.onOpenSkillSettings}
          onOpenChange={(open) => {
            if (!open && props.skillMenuOpen) props.onToggleSkillMenu();
          }}
        />
        <div className="permission-menu-wrap">
          <button
            ref={permissionTriggerRef}
            id={permissionTriggerId}
            className={`permission-mode-pill ${props.permissionMode === "full-access" ? "full-access" : ""} ${permissionMenuOpen ? "active" : ""}`}
            type="button"
            aria-label={t("permission.mode.menu")}
            aria-expanded={permissionMenuOpen}
            disabled={props.permissionModeSaving}
            onClick={() => setPermissionMenuOpen((open) => !open)}
          >
            <ShieldIcon />
            <span>{props.permissionMode === "full-access" ? t("permission.mode.full") : t("permission.mode.ask")}</span>
            <ChevronDownIcon />
          </button>
          <PermissionModeMenu
            open={permissionMenuOpen}
            anchorRef={permissionTriggerRef}
            triggerId={permissionTriggerId}
            mode={props.permissionMode}
            onOpenChange={setPermissionMenuOpen}
            onSelect={(mode) => {
              setPermissionMenuOpen(false);
              props.onSelectPermissionMode(mode);
            }}
          />
        </div>
        <span className="composer-spacer" />
        <span className="run-meter" title={isRunning ? t("composer.responseRunning") : isStopping ? t("composer.stoppingResponse") : props.contextUsageTitle}>
          {isRunning ? queuedCount > 0 ? t("composer.runningQueued", { count: queuedCount }) : t("composer.running") : isStopping ? t("composer.stopping") : props.contextUsageLabel}
        </span>
        <button ref={modelTriggerRef} id={modelTriggerId} className="model-pill" type="button" onClick={props.onToggleModelMenu} aria-expanded={props.modelMenuOpen}>
          {props.provider?.defaultModel ?? t("composer.noProvider")}
          <span>{props.reasoningEffort}</span>
          <ChevronDownIcon />
        </button>
        <ModelMenu
          open={props.modelMenuOpen}
          anchorRef={modelTriggerRef}
          provider={props.provider}
          providers={props.providers}
          activeProviderId={props.activeProviderId}
          testing={props.testingProvider}
          reasoningEffort={props.reasoningEffort}
          onSelectProvider={props.onSelectProvider}
          onSelectModel={props.onSelectModel}
          onSelectReasoningEffort={props.onSelectReasoningEffort}
          onOpenSettings={props.onOpenSettings}
          onTest={props.onTestProvider}
          onOpenChange={(open) => {
            if (!open && props.modelMenuOpen) props.onToggleModelMenu();
          }}
        />
        {isRunning && (
          <>
            <button
              className="send-button queue-submit-button"
              type="button"
              aria-label={t("composer.queueMessage")}
              title={!canSend ? t("composer.enterMessage") : t("composer.queueMessage")}
              disabled={!canSend}
              onClick={() => props.onSubmit()}
            >
              <SendIcon />
            </button>
          </>
        )}
        <button
          className="send-button"
          type={isRunning ? "button" : "submit"}
          aria-label={isRunning || isStopping ? t("composer.stopResponse") : t("composer.send")}
          title={isRunning ? t("composer.stopResponse") : isStopping ? t("composer.stoppingResponse") : !canSend ? t("composer.enterMessage") : t("composer.send")}
          disabled={isStopping || (!isRunning && !canSend)}
          onClick={isRunning ? props.onStop : undefined}
        >
          {isRunning || isStopping ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </form>
  );

  function beginQueuedEdit(message: ChatQueuedMessage) {
    setEditingQueuedId(message.id);
    setQueuedDraft(message.content);
  }

  function cancelQueuedEdit() {
    setEditingQueuedId(null);
    setQueuedDraft("");
  }

  function saveQueuedEdit(message: ChatQueuedMessage) {
    const next = queuedDraft.trim();
    if (!next) return;
    props.onUpdateQueuedMessage(message.id, next, message.attachments ?? []);
    cancelQueuedEdit();
  }
});

function recordHarnessRender(): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_COMPOSER_RENDERS__ = (window.__JASMINE_COMPOSER_RENDERS__ ?? 0) + 1;
}

function ToolsMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  triggerId: string;
  toolsEnabled: boolean;
  onOpenChange(open: boolean): void;
  onOpenPluginSettings(): void;
}) {
  const { t } = useI18n();

  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-start" minWidth={212} maxWidth={260} maxHeight={220} className="tools-menu" aria-labelledby={props.triggerId}>
      <div className="tools-menu-row read-only" role="menuitem">
        <span className="tools-menu-main">
          <span className="tools-menu-icon"><WrenchIcon /></span>
          <span>{t("composer.piTools")}</span>
        </span>
        <span className="tools-menu-state">
          {props.toolsEnabled ? <CheckIcon /> : null}
          <b>{t("app.on")}</b>
        </span>
      </div>
      <button
        className="tools-menu-row"
        type="button"
        role="menuitem"
        onClick={() => {
          props.onOpenChange(false);
          props.onOpenPluginSettings();
        }}
      >
        <span className="tools-menu-main">
          <span className="tools-menu-icon"><PlugIcon /></span>
          <span>{t("composer.plugins")}</span>
        </span>
        <span className="tools-menu-state">
          <b>{t("composer.manage")}</b>
        </span>
      </button>
    </MenuSurface>
  );
}

function PermissionModeMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  triggerId: string;
  mode: PermissionMode;
  onOpenChange(open: boolean): void;
  onSelect(mode: PermissionMode): void;
}) {
  const { t } = useI18n();

  return (
    <MenuSurface
      anchorRef={props.anchorRef}
      open={props.open}
      onOpenChange={props.onOpenChange}
      placement="top-start"
      minWidth={300}
      maxWidth={360}
      maxHeight={240}
      className="permission-mode-menu"
      aria-labelledby={props.triggerId}
    >
      <MenuItem
        className="permission-mode-item"
        leftIcon={<ShieldIcon />}
        description={t("permission.mode.askDescription")}
        selected={props.mode === "ask"}
        trailing={props.mode === "ask" ? <CheckIcon /> : null}
        onClick={() => props.onSelect("ask")}
      >
        {t("permission.mode.ask")}
      </MenuItem>
      <MenuItem
        className="permission-mode-item full-access"
        leftIcon={<ShieldIcon />}
        description={t("permission.mode.fullDescription")}
        selected={props.mode === "full-access"}
        trailing={props.mode === "full-access" ? <CheckIcon /> : null}
        onClick={() => props.onSelect("full-access")}
      >
        {t("permission.mode.full")}
      </MenuItem>
    </MenuSurface>
  );
}

function handleCommandMenuKey(
  event: KeyboardEvent<HTMLElement>,
  itemCount: number,
  activeIndex: number,
  setActiveIndex: (activeIndex: number) => void,
  close: () => void,
  select: () => void
): boolean {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveIndex(itemCount === 0 ? 0 : (activeIndex + 1) % itemCount);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveIndex(itemCount === 0 ? 0 : (activeIndex - 1 + itemCount) % itemCount);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return true;
  }
  if (event.key === "Enter" && itemCount > 0) {
    event.preventDefault();
    select();
    return true;
  }
  return false;
}

function orderedQueuedMessages(queue: ChatQueueState): ChatQueuedMessage[] {
  return [...queue.followUp, ...queue.steering].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function setActiveIndexFromId<T extends { id: string }>(items: T[], id: string, setActiveIndex: (activeIndex: number) => void): void {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) setActiveIndex(index);
}

function MentionMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: MentionItem[];
  activeIndex: number;
  query: string;
  onActiveIdChange(id: string): void;
  onOpenChange(open: boolean): void;
  onSelect(item: MentionItem): void;
}) {
  const { t } = useI18n();
  const commandItems = props.items.map<CommandMenuItem>((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    disabled: item.type === "status",
    group: item.type === "plugin" ? t("mention.plugins") : t("mention.files"),
    icon: item.type === "file" ? <PaperclipIcon /> : item.type === "plugin" ? <PlugIcon /> : <TerminalIcon />,
    trailing: item.type === "plugin" && item.selected ? <CheckIcon /> : undefined,
    onSelect: () => props.onSelect(item)
  }));

  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-start" minWidth={320} maxWidth={420} maxHeight={320} className="mention-menu" role="listbox" aria-label={t("mention.menu")}>
      <CommandMenu
        ariaLabel={t("mention.menu")}
        emptyLabel={t("mention.noFiles")}
        itemClassName="mention-row"
        itemRole="option"
        items={commandItems}
        onSelectedIdChange={props.onActiveIdChange}
        preserveItemFocus
        rankItems={false}
        selectedId={props.items[props.activeIndex]?.id}
        showInput={false}
      />
    </MenuSurface>
  );
}

function SkillCommandMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: SkillCommandItem[];
  activeIndex: number;
  onActiveIdChange(id: string): void;
  onOpenChange(open: boolean): void;
  onSelect(item: SkillCommandItem): void;
}) {
  const { t } = useI18n();
  const commandItems = props.items.map<CommandMenuItem>((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    disabled: item.type === "status",
    group: t("skill.commandGroup"),
    icon: <SkillIcon />,
    trailing: item.type === "skill" && item.selected ? <CheckIcon /> : undefined,
    onSelect: () => props.onSelect(item)
  }));
  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-start" minWidth={320} maxWidth={420} maxHeight={320} className="mention-menu skill-command-menu" role="listbox" aria-label={t("skill.commandMenu")}>
      <CommandMenu
        ariaLabel={t("skill.commandMenu")}
        emptyLabel={t("skill.empty")}
        itemClassName="mention-row"
        itemRole="option"
        items={commandItems}
        onSelectedIdChange={props.onActiveIdChange}
        preserveItemFocus
        rankItems={false}
        selectedId={props.items[props.activeIndex]?.id}
        showInput={false}
      />
    </MenuSurface>
  );
}

function PromptCommandMenu(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: PromptCommandItem[];
  activeIndex: number;
  onActiveIdChange(id: string): void;
  onOpenChange(open: boolean): void;
  onSelect(item: PromptCommandItem): void;
}) {
  const { t } = useI18n();
  const commandItems = props.items.map<CommandMenuItem>((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    disabled: item.type === "status",
    group: t("prompt.commandGroup"),
    icon: <TerminalIcon />,
    trailing: item.type === "template" && item.argumentHint ? <small>{item.argumentHint}</small> : undefined,
    onSelect: () => props.onSelect(item)
  }));
  return (
    <MenuSurface anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange} placement="top-start" minWidth={320} maxWidth={420} maxHeight={320} className="mention-menu slash-command-menu" role="listbox" aria-label={t("prompt.commandMenu")}>
      <CommandMenu
        ariaLabel={t("prompt.commandMenu")}
        emptyLabel={t("prompt.empty")}
        itemClassName="mention-row"
        itemRole="option"
        items={commandItems}
        onSelectedIdChange={props.onActiveIdChange}
        preserveItemFocus
        rankItems={false}
        selectedId={props.items[props.activeIndex]?.id}
        showInput={false}
      />
    </MenuSurface>
  );
}
