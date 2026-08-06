import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type {
  ActivityObservation,
  ActivitySettings,
  ActivitySettingsUpdateRequest,
  ActivityStatus,
  AiProvider,
  BrandSettings,
  ChatMessage,
  ChatQueueMode,
  ChatQueueState,
  ChatThread,
  ClipboardImagePasteRequest,
  MemoryRecord,
  PickedPath,
  PluginPackageRecord,
  PromptTemplateRecord,
  ReasoningEffort,
  RemoteConnectionRecord,
  SkillRecord,
  WebSearchSettings,
  WorkspaceProject
} from "../../../shared/ipc";
import type { RunState } from "../../types";
import type { RightPanelMode, RightPanelTab } from "../../navigation/routes";
import { useStableCallbacks } from "../../hooks/useStableCallbacks";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

const ActivityPanel = lazy(() =>
  import("../activity/ActivityPanel").then((module) => ({ default: module.ActivityPanel }))
);

const ChatRightPanel = lazy(() =>
  import("./ChatRightPanel").then((module) => ({ default: module.ChatRightPanel }))
);

const MemoryPanel = lazy(() =>
  import("../memory/MemoryPanel").then((module) => ({ default: module.MemoryPanel }))
);

export function ChatPage(props: {
  activeThread: ChatThread | null;
  activeProject: WorkspaceProject | null;
  activeProjectId: string | null;
  brand: BrandSettings;
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  loading: boolean;
  messageActionKey: string;
  runState: RunState;
  runModelLabel: string | null;
  error: string | null;
  queueState: ChatQueueState;
  messageScrollRef: RefObject<HTMLDivElement | null>;
  provider: AiProvider | null;
  providers: AiProvider[];
  activeProviderId: string;
  testingProvider: boolean;
  memoryOpen: boolean;
  activityOpen: boolean;
  memories: MemoryRecord[];
  memoriesLoading: boolean;
  activitySettings: ActivitySettings;
  activityStatus: ActivityStatus;
  activityObservations: ActivityObservation[];
  activityQuery: string;
  activityLoading: boolean;
  modelMenuOpen: boolean;
  skillMenuOpen: boolean;
  memoryEnabled: boolean;
  webSearchSettings: WebSearchSettings;
  webSearchLoading: boolean;
  remoteConnections: RemoteConnectionRecord[];
  activeRemoteConnection: RemoteConnectionRecord | null;
  toolsEnabled: boolean;
  reasoningEffort: ReasoningEffort;
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
  rightPanelTabs: RightPanelTab[];
  activeRightPanelTabId: string | null;
  collapsedRightPanel: boolean;
  draft: string;
  attachments: PickedPath[];
  editingMessage: ChatMessage | null;
  onLoadOlderMessages(): void;
  onCopy(message: ChatMessage): void;
  onCopyCode(code: string): void;
  onRetry(message?: ChatMessage): void;
  onEditMessage(message: ChatMessage): void;
  onRemember(message: ChatMessage): void;
  onMessageWheel(deltaY: number): void;
  onMessageScroll(): void;
  onCloseMemory(): void;
  onRefreshMemories(): void;
  onCreateMemory(content: string): void;
  onUpdateMemory(id: string, content: string): void;
  onArchiveMemory(id: string, archived: boolean): void;
  onRequestDeleteMemory(memory: MemoryRecord): void;
  onCloseActivity(): void;
  onRefreshActivity(): void;
  onSearchActivity(query: string): void;
  onCreateManualActivity(note: string): void;
  onUpdateActivitySettings(update: ActivitySettingsUpdateRequest): void;
  onToggleModelMenu(): void;
  onToggleSkillMenu(): void;
  onToggleSkill(skillId: string): void;
  onAddInlineSkill(skillId: string): void;
  onRemoveInlineSkill(skillId: string): void;
  onAddInlinePlugin(pluginId: string): void;
  onRemoveInlinePlugin(pluginId: string): void;
  onOpenSkillSettings(): void;
  onOpenPluginSettings(): void;
  onSelectProvider(providerId: string): void;
  onSelectModel(providerId: string, modelId: string): void;
  onSelectReasoningEffort(effort: ReasoningEffort): void;
  onOpenSettings(): void;
  onTestProvider(): void;
  onToggleWebSearch(): void;
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
  onToggleMemory(): void;
  onToggleTools(): void;
  onSelectRemoteConnection(id: string | null): void;
  onSelectRightPanel(mode: RightPanelMode): void;
  onAddRightPanel(mode: RightPanelMode): void;
  onSelectRightPanelTab(tabId: string): void;
  onCloseRightPanel(tabId: string): void;
  onCollapseRightPanel(): void;
}) {
  const panelExpanded = props.rightPanelTabs.length > 0 && props.activeRightPanelTabId !== null && !props.collapsedRightPanel;
  // App recreates handler closures every render (each stream tick included);
  // these identity-stable wrappers keep the memoized Composer from reconciling.
  const stable = useStableCallbacks(props);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const chatPageRef = useRef<HTMLElement | null>(null);
  const totalMessageCount = Math.max(props.activeThread?.messageCount ?? 0, props.messages.length);
  const messageCountLabel = useMemo(
    () => `${totalMessageCount} ${totalMessageCount === 1 ? "message" : "messages"}`,
    [totalMessageCount]
  );
  // The live message grows every stream tick; quantizing its length keeps the
  // context-meter estimate (and the memoized Composer receiving its strings)
  // from recomputing per tick. 2048 chars ~= 512 tokens per step.
  const lastMessageLengthStep = Math.ceil((props.messages.at(-1)?.content.length ?? 0) / 2048);
  const contextUsage = useMemo(
    () => estimateContextUsage(props.messages, totalMessageCount, props.draft, props.attachments, props.provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props.messages is intentionally
    // represented by (length, quantized last-message length) to bound stream-tick recompute.
    [props.messages.length, lastMessageLengthStep, totalMessageCount, props.draft, props.attachments, props.provider]
  );
  const queuedMessageCount = props.queueState.followUp.length + props.queueState.steering.length;

  useEffect(() => {
    const chatPage = chatPageRef.current;
    if (!chatPage) return;
    const observer = new ResizeObserver(([entry]) => {
      setRightPanelWidth((current) => clampRightPanelWidth(current, entry.contentRect.width));
    });
    observer.observe(chatPage);
    return () => observer.disconnect();
  }, []);

  const chatPageStyle = {
    "--right-panel-width": `${rightPanelWidth}px`,
    "--right-panel-reserved-width": `${rightPanelWidth + 32}px`,
    "--message-jump-bottom": `${132 + Math.min(queuedMessageCount, 5) * 34}px`
  } as CSSProperties;

  return (
    <section
      ref={chatPageRef}
      className={`chat-page ${props.messages.length === 0 ? "empty-thread" : ""} ${panelExpanded ? "right-panel-open" : ""}`}
      style={chatPageStyle}
    >
      <ChatHeader activeThread={props.activeThread} messageCountLabel={messageCountLabel} />
      <Suspense fallback={null}>
        <ChatRightPanel
          activeTabId={props.activeRightPanelTabId}
          openTabs={props.rightPanelTabs}
          collapsed={props.collapsedRightPanel}
          activeThread={props.activeThread}
          activeProjectId={props.activeProjectId}
          messages={props.messages}
          width={rightPanelWidth}
          onResize={setRightPanelWidth}
          onSelect={props.onSelectRightPanel}
          onAdd={props.onAddRightPanel}
          onSelectTab={props.onSelectRightPanelTab}
          onClose={props.onCloseRightPanel}
          onCollapse={props.onCollapseRightPanel}
        />
      </Suspense>
      <MessageList
        messages={props.messages}
        hasOlderMessages={props.hasOlderMessages}
        loadingOlderMessages={props.loadingOlderMessages}
        loading={props.loading}
        actionKey={props.messageActionKey}
        runState={props.runState}
        runModelLabel={props.runModelLabel}
        error={props.error}
        messageScrollRef={props.messageScrollRef}
        modelLabel={props.provider?.defaultModel ?? "model"}
        brand={props.brand}
        onLoadOlderMessages={props.onLoadOlderMessages}
        onCopy={props.onCopy}
        onCopyCode={props.onCopyCode}
        onRetry={props.onRetry}
        onEditMessage={props.onEditMessage}
        onRemember={props.onRemember}
        onConfigureProvider={props.onOpenSettings}
        onMessageWheel={props.onMessageWheel}
        onMessageScroll={props.onMessageScroll}
      />
      {props.memoryOpen && (
        <Suspense fallback={null}>
          <MemoryPanel
            open={props.memoryOpen}
            memories={props.memories}
            loading={props.memoriesLoading}
            memoryEnabled={props.memoryEnabled}
            onToggleEnabled={props.onToggleMemory}
            onClose={props.onCloseMemory}
            onRefresh={props.onRefreshMemories}
            onCreate={props.onCreateMemory}
            onUpdate={props.onUpdateMemory}
            onArchive={props.onArchiveMemory}
            onRequestDelete={props.onRequestDeleteMemory}
          />
        </Suspense>
      )}
      {props.activityOpen && (
        <Suspense fallback={null}>
          <ActivityPanel
            open={props.activityOpen}
            settings={props.activitySettings}
            status={props.activityStatus}
            observations={props.activityObservations}
            query={props.activityQuery}
            loading={props.activityLoading}
            onClose={props.onCloseActivity}
            onRefresh={props.onRefreshActivity}
            onSearch={props.onSearchActivity}
            onCreateManual={props.onCreateManualActivity}
            onUpdateSettings={props.onUpdateActivitySettings}
          />
        </Suspense>
      )}
      <Composer
        draft={props.draft}
        attachments={props.attachments}
        editingMessage={props.editingMessage}
        messagesEmpty={props.messages.length === 0}
        runState={props.runState}
        queueState={props.queueState}
        provider={props.provider}
        activeProject={props.activeProject}
        providers={props.providers}
        activeProviderId={props.activeProviderId}
        modelMenuOpen={props.modelMenuOpen}
        skillMenuOpen={props.skillMenuOpen}
        webSearchEnabled={props.webSearchSettings.enabled}
        webSearchLoading={props.webSearchLoading}
        remoteConnections={props.remoteConnections}
        activeRemoteConnection={props.activeRemoteConnection}
        toolsEnabled={props.toolsEnabled}
        reasoningEffort={props.reasoningEffort}
        contextUsageLabel={contextUsage.label}
        contextUsageTitle={contextUsage.title}
        skills={props.skills}
        inlineSkillChoices={props.inlineSkillChoices}
        selectedSkillIds={props.selectedSkillIds}
        selectedSkillsCount={props.selectedSkillsCount}
        inlineSkillIds={props.inlineSkillIds}
        inlineSkills={props.inlineSkills}
        plugins={props.plugins}
        inlinePluginIds={props.inlinePluginIds}
        inlinePlugins={props.inlinePlugins}
        skillsLoading={props.skillsLoading}
        promptTemplates={props.promptTemplates}
        promptTemplatesLoading={props.promptTemplatesLoading}
        testingProvider={props.testingProvider}
        onDraftChange={stable.onDraftChange}
        onClearError={stable.onClearError}
        onSubmit={stable.onSubmit}
        onUpdateQueuedMessage={stable.onUpdateQueuedMessage}
        onDeleteQueuedMessage={stable.onDeleteQueuedMessage}
        onSteerQueuedMessage={stable.onSteerQueuedMessage}
        onStop={stable.onStop}
        onAttachFile={stable.onAttachFile}
        onAttachClipboardImage={stable.onAttachClipboardImage}
        onAttachFilePath={stable.onAttachFilePath}
        onRemoveAttachment={stable.onRemoveAttachment}
        onCancelEdit={stable.onCancelEdit}
        onToggleSkillMenu={stable.onToggleSkillMenu}
        onToggleSkill={stable.onToggleSkill}
        onAddInlineSkill={stable.onAddInlineSkill}
        onRemoveInlineSkill={stable.onRemoveInlineSkill}
        onAddInlinePlugin={stable.onAddInlinePlugin}
        onRemoveInlinePlugin={stable.onRemoveInlinePlugin}
        onOpenSkillSettings={stable.onOpenSkillSettings}
        onOpenPluginSettings={stable.onOpenPluginSettings}
        onToggleTools={stable.onToggleTools}
        onToggleModelMenu={stable.onToggleModelMenu}
        onSelectProvider={stable.onSelectProvider}
        onSelectModel={stable.onSelectModel}
        onSelectReasoningEffort={stable.onSelectReasoningEffort}
        onOpenSettings={stable.onOpenSettings}
        onTestProvider={stable.onTestProvider}
        onToggleWebSearch={stable.onToggleWebSearch}
        onSelectRemoteConnection={stable.onSelectRemoteConnection}
      />
    </section>
  );
}

function clampRightPanelWidth(width: number, pageWidth: number) {
  return Math.round(Math.min(Math.max(240, pageWidth - 360), 720, Math.max(240, width)));
}

function estimateContextUsage(messages: ChatMessage[], totalMessageCount: number, draft: string, attachments: PickedPath[], provider: AiProvider | null): { label: string; title: string } {
  const activeModel = provider?.models.find((model) => model.id === provider.defaultModel);
  const contextWindow = activeModel?.contextWindow ?? 128_000;
  const loadedMessageChars = messages.reduce((total, message) => total + message.content.length, 0);
  const unloadedMessageCount = Math.max(0, totalMessageCount - messages.length);
  const averageLoadedChars = messages.length > 0 ? loadedMessageChars / messages.length : 0;
  const messageChars = loadedMessageChars + Math.round(averageLoadedChars * unloadedMessageCount);
  const draftChars = draft.trim().length;
  const attachmentTokens = attachments.reduce((total, attachment) => total + (attachment.isImage ? 768 : 64), 0);
  const estimatedTokens = Math.ceil((messageChars + draftChars) / 4) + attachmentTokens;
  const percent = contextWindow > 0 ? (estimatedTokens / contextWindow) * 100 : 0;
  const windowLabel = formatContextWindow(contextWindow);
  const label = estimatedTokens === 0
    ? `0%/${windowLabel}`
    : percent < 0.1
      ? `<0.1%/${windowLabel}`
      : `${Math.min(percent, 100).toFixed(percent < 10 ? 1 : 0)}%/${windowLabel}`;
  return {
    label,
    title: `Estimated context: ${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
  };
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 1_000_000)}M`;
  if (contextWindow >= 1000) return `${Math.round(contextWindow / 1000)}k`;
  return String(contextWindow);
}
