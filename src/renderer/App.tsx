import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ActivitySettingsUpdateRequest, AppSettings, ChatMessage, ChatQueueMode, ChatThread, ClipboardImagePasteRequest, MemoryRecord, PickedPath, PluginPackageRecord, ReasoningEffort, SkillRecord, WorkingNavigationTarget, WorkingTask } from "../shared/ipc";
import { ChatPage } from "./components/chat/ChatPage";
import { AppDialogs } from "./components/shell/AppDialogs";
import { AppShell } from "./components/shell/AppShell";
import { CommandPalette } from "./components/shell/CommandPalette";
import { SearchOverlay } from "./components/shell/SearchOverlay";
import { TodoPage } from "./components/todo/TodoPage";
import { WorkingPage } from "./components/working/WorkingPage";
import { useAppSurfaces } from "./hooks/useAppSurfaces";
import { useAskUserQuestion } from "./hooks/useAskUserQuestion";
import { useChatMessages } from "./hooks/useChatMessages";
import { useActivity } from "./hooks/useActivity";
import { useAppSettings } from "./hooks/useAppSettings";
import { useCommandPaletteCommands } from "./hooks/useCommandPaletteCommands";
import { useComposer } from "./hooks/useComposer";
import { useFloatingSurfaceDismissal } from "./hooks/useFloatingSurfaceDismissal";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useMemories } from "./hooks/useMemories";
import { useMcpServers } from "./hooks/useMcpServers";
import { usePlugins } from "./hooks/usePlugins";
import { useProviders } from "./hooks/useProviders";
import { usePromptTemplates } from "./hooks/usePromptTemplates";
import { useProjects } from "./hooks/useProjects";
import { useRemoteConnections } from "./hooks/useRemoteConnections";
import { useSkills } from "./hooks/useSkills";
import { useSpotlightCommandBridge } from "./hooks/useSpotlightCommandBridge";
import { useStableCallbacks } from "./hooks/useStableCallbacks";
import { useThreadDraftPersistence } from "./hooks/useThreadDraftPersistence";
import { useThreads } from "./hooks/useThreads";
import { useTodos } from "./hooks/useTodos";
import { useToast } from "./hooks/useToast";
import { useThemeAppearance } from "./hooks/useThemeAppearance";
import { useWebSearch } from "./hooks/useWebSearch";
import { useWorkingTasks } from "./hooks/useWorkingTasks";
import { useHarnessBridge } from "./harness/useHarnessBridge";
import { useJasmineNavigation } from "./navigation/navigationState";
import { isSettingsSection, rightPanelModeLabel, type JasmineRoute, type RightPanelMode, type RightPanelTab, type SettingsSection } from "./navigation/routes";
import { getBridge } from "./desktopApi";
import { I18nProvider, translate } from "./i18n";

const ProviderSettingsPanel = lazy(() =>
  import("./components/settings/ProviderSettingsPanel").then((module) => ({ default: module.ProviderSettingsPanel }))
);

const UiCatalog = lazy(() =>
  import("./components/ui/UiCatalog").then((module) => ({ default: module.UiCatalog }))
);

const reasoningEfforts: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function initialReasoningEffort(): ReasoningEffort {
  const stored = window.localStorage.getItem("jasmine.reasoningEffort");
  return reasoningEfforts.includes(stored as ReasoningEffort) ? stored as ReasoningEffort : "off";
}

function App(props: { initialAppSettings: AppSettings }) {
  const [appError, setAppError] = useState<string | null>(null);
  const [deleteThreadCandidate, setDeleteThreadCandidate] = useState<ChatThread | null>(null);
  const [rememberingMessage, setRememberingMessage] = useState<ChatMessage | null>(null);
  const [deleteMemoryCandidate, setDeleteMemoryCandidate] = useState<MemoryRecord | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initialReasoningEffort);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [uiCatalogOpen, setUiCatalogOpen] = useState(false);
  const [todoAddOpen, setTodoAddOpen] = useState(false);
  const [rightPanelTabs, setRightPanelTabs] = useState<RightPanelTab[]>([]);
  const [activeRightPanelTabId, setActiveRightPanelTabId] = useState<string | null>(null);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const rightPanelTabSequence = useRef(0);
  const [inlineSkillIds, setInlineSkillIds] = useState<string[]>([]);
  const [inlinePluginIds, setInlinePluginIds] = useState<string[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  const surfaces = useAppSurfaces();
  const navigation = useJasmineNavigation();

  const threads = useThreads({
    onError: setAppError,
    onResetChatState: () => undefined,
    onToast: showToast,
    // `chat` is declared below; deletion callbacks only fire from async flows
    // after render, so the binding is initialized by the time this runs.
    onThreadsDeleted: (threadIds) => chat.pruneThreadState(threadIds)
  });
  const projects = useProjects({
    onError: setAppError,
    onToast: showToast,
    onProjectOpened: (project) => {
      selectProjectScope(project.id, "replace");
    }
  });
  const chat = useChatMessages({
    activeThread: threads.activeThread,
    refreshThreads: threads.refreshThreads,
    patchThread: threads.patchThread
  });

  const providers = useProviders({
    onError: setAppError,
    onToast: showToast
  });
  const memories = useMemories({
    open: surfaces.memoryOpen,
    onError: setAppError,
    onToast: showToast
  });
  const skills = useSkills({
    onError: setAppError,
    onToast: showToast
  });
  const mcp = useMcpServers({
    onError: setAppError,
    onToast: showToast
  });
  const plugins = usePlugins({
    onError: setAppError,
    onToast: showToast
  });
  const inlineSkillChoices = useMemo(
    () => [...skills.skills, ...plugins.skills],
    [plugins.skills, skills.skills]
  );
  const remotes = useRemoteConnections({
    onError: setAppError,
    onToast: showToast
  });
  const promptTemplates = usePromptTemplates({
    onError: setAppError,
    onToast: showToast
  });
  const activity = useActivity({
    open: surfaces.activityOpen,
    onError: setAppError,
    onToast: showToast
  });
  const appSettings = useAppSettings({
    onError: setAppError,
    onToast: showToast
  }, props.initialAppSettings);
  const webSearch = useWebSearch({
    onError: setAppError,
    onToast: showToast
  });
  const askUserQuestion = useAskUserQuestion({
    onError: setAppError
  });
  const working = useWorkingTasks({
    onError: setAppError,
    onNavigate: openWorkingTarget
  });
  useThemeAppearance(appSettings.settings.appearance);
  const t = translate(appSettings.settings.language);
  const activeModel = providers.activeProvider?.models.find((model) => model.id === providers.activeProvider?.defaultModel);
  const activeRightPanelTab = useMemo(
    () => rightPanelTabs.find((tab) => tab.id === activeRightPanelTabId) ?? null,
    [activeRightPanelTabId, rightPanelTabs]
  );
  const activeRightPanelMode = activeRightPanelTab?.mode ?? null;
  const activeScopeProjectId = threads.activeThread?.projectId ?? activeProjectId;
  const activeProject = useMemo(
    () => projects.projects.find((project) => project.id === activeScopeProjectId) ?? null,
    [activeScopeProjectId, projects.projects]
  );
  const todos = useTodos({
    enabled: navigation.route.name === "todo" || todoAddOpen,
    messages: {
      loadFailed: t("todo.error.load"),
      saveFailed: t("todo.error.save"),
      saved: t("todo.toast.saved"),
      openFailed: t("todo.error.open"),
      opened: t("todo.toast.opened")
    },
    onError: setAppError,
    onToast: showToast
  });
  const activeThreadPluginKey = threads.activeThread?.activePluginIds?.join("\u0000") ?? "";
  const composer = useComposer({
    runState: chat.runState,
    canSendImages: Boolean(activeModel?.capabilities.vision),
    onErrorReset: clearErrors,
    onToast: showToast,
    onSubmit: async (content, attachments) => {
      const targetThread = threads.activeThread ?? await threads.startNewChat(false, activeScopeProjectId);
      if (!targetThread) return false;
      setActiveProjectId(targetThread.projectId);
      navigation.replace({ name: "thread", threadId: targetThread.id, projectId: targetThread.projectId });
      const sent = await chat.sendMessage(content, providers.activeProvider?.id, attachments, providers.activeProvider?.defaultModel, memoryEnabled, toolsEnabled, skills.selectedSkillIds, webSearch.settings.enabled, reasoningEffort, inlineSkillIds, inlinePluginIds, targetThread);
      if (sent) {
        setInlineSkillIds([]);
      }
      return sent;
    },
    onQueueSubmit: async (content, attachments, mode) => {
      const queued = await chat.queueMessage(content, attachments, mode);
      return queued;
    },
    onEditSubmit: async (messageId, content, attachments) => {
      const sent = await chat.editMessage(messageId, content, providers.activeProvider?.id, attachments, providers.activeProvider?.defaultModel, memoryEnabled, toolsEnabled, skills.selectedSkillIds, webSearch.settings.enabled, reasoningEffort, inlineSkillIds, inlinePluginIds);
      if (sent) {
        setInlineSkillIds([]);
      }
      return sent;
    }
  });
  const inlineSkills = useMemo(
    () => inlineSkillIds
      .map((id) => inlineSkillChoices.find((skill) => skill.id === id))
      .filter((skill): skill is SkillRecord => Boolean(skill && skill.enabled)),
    [inlineSkillChoices, inlineSkillIds]
  );
  const inlinePlugins = useMemo(
    () => inlinePluginIds
      .map((id) => plugins.packages.find((plugin) => plugin.id === id))
      .filter((plugin): plugin is PluginPackageRecord => Boolean(plugin)),
    [inlinePluginIds, plugins.packages]
  );

  useEffect(() => {
    document.documentElement.lang = appSettings.settings.language === "zh" ? "zh-CN" : "en";
  }, [appSettings.settings.language]);

  const commands = useCommandPaletteCommands({
    sidebarCollapsed,
    navigate: navigateToRoute,
    closeFloatingSurfaces,
    openSearch: () => surfaces.setSearchOpen(true),
    openMemory: () => surfaces.setMemoryOpen(true),
    openActivity: () => surfaces.setActivityOpen(true),
    openTodo: () => navigateToRoute({ name: "todo" }),
    addTodo: () => {
      navigateToRoute({ name: "todo" });
      setTodoAddOpen(true);
    },
    openUiCatalog: () => setUiCatalogOpen(true),
    toggleSidebar: () => setSidebarCollapsed((collapsed) => !collapsed),
    t
  });

  useEffect(() => {
    if (navigation.route.name === "todo" || navigation.route.name === "working") return;
    if (surfaces.settingsOpen) return;
    if (threads.activeThreadId && activeRightPanelMode) {
      navigation.replace({ name: "rightPanel", threadId: threads.activeThreadId, projectId: threads.activeThread?.projectId ?? null, panel: activeRightPanelMode });
      return;
    }
    navigation.replace(threads.activeThreadId ? { name: "thread", threadId: threads.activeThreadId, projectId: threads.activeThread?.projectId ?? null } : { name: "newChat", projectId: activeProjectId });
  }, [navigation.route.name, surfaces.settingsOpen, threads.activeThreadId, threads.activeThread?.projectId, activeProjectId, activeRightPanelMode, navigation.replace]);

  useEffect(() => {
    const threadId = navigation.route.name === "thread" || navigation.route.name === "rightPanel"
      ? threads.activeThreadId
      : null;
    void getBridge().updateWorkingView({ threadId });
  }, [navigation.route.name, threads.activeThreadId]);

  useEffect(() => {
    if (!threads.activeThread) return;
    setActiveProjectId(threads.activeThread.projectId);
  }, [threads.activeThread?.id, threads.activeThread?.projectId]);

  useEffect(() => {
    if (composer.editingMessage) return;
    setInlinePluginIds(threads.activeThread?.activePluginIds ?? []);
  }, [threads.activeThread?.id, activeThreadPluginKey, composer.editingMessage?.id]);

  useThreadDraftPersistence({
    threadId: threads.activeThreadId,
    draft: composer.draft,
    editingMessage: composer.editingMessage,
    setDraft: composer.setDraft
  });

  useGlobalShortcuts({
    closeFloatingSurfaces,
    openCommandPalette: () => surfaces.setCommandOpen(true),
    openSearch: () => surfaces.setSearchOpen(true),
    startNewChat: () => void startNewChat(activeScopeProjectId)
  });

  useSpotlightCommandBridge({
    openThread: (threadId, projectId) => {
      navigateToRoute({ name: "thread", threadId, projectId: projectId ?? null });
    },
    newChat: () => {
      void startNewChat(activeScopeProjectId).then((thread) => {
        if (thread) composer.focusComposer();
      });
    },
    openSettings: (section) => {
      openSettingsSection(section && isSettingsSection(section) ? section : "general");
    },
    openTodo: () => {
      closeFloatingSurfaces();
      navigateToRoute({ name: "todo" });
    },
    addTodo: () => {
      closeFloatingSurfaces();
      navigateToRoute({ name: "todo" });
      setTodoAddOpen(true);
    }
  });

  useHarnessBridge({
    activeThread: threads.activeThread,
    activeThreadId: threads.activeThreadId,
    threads: threads.threads,
    messages: chat.messages,
    runState: chat.runState,
    activeProviderId: providers.selectedProviderId,
    activeModelId: providers.activeProvider?.defaultModel ?? null,
    sidebarCollapsed,
    memoryEnabled,
    webSearchEnabled: webSearch.settings.enabled,
    toolsEnabled,
    voiceEnabled: false,
    selectedSkillCount: skills.selectedSkills.length,
    navigation: {
      route: navigation.route,
      path: navigation.path,
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward
    },
    openSurfaces: {
      search: surfaces.searchOpen,
      more: surfaces.moreOpen,
      memory: surfaces.memoryOpen,
      activity: surfaces.activityOpen,
      modelMenu: surfaces.modelMenuOpen,
      skillMenu: surfaces.skillMenuOpen,
      command: surfaces.commandOpen,
      settings: surfaces.settingsOpen,
      clearHistory: surfaces.clearHistoryOpen,
      todoAdd: todoAddOpen,
      deleteThread: Boolean(deleteThreadCandidate),
      rememberDialog: Boolean(rememberingMessage),
      askUserQuestion: Boolean(askUserQuestion.activePrompt)
    },
    actions: {
      closeFloatingSurfaces,
      newChat: () => void startNewChat(activeScopeProjectId),
      openSettings: () => openSettingsSection("general"),
      openModelMenu: () => {
        closeFloatingSurfaces();
        surfaces.setModelMenuOpen(true);
      },
      openMoreMenu: () => {
        closeFloatingSurfaces();
        surfaces.setMoreOpen(true);
      },
      openSearch: () => {
        closeFloatingSurfaces();
        surfaces.setSearchOpen(true);
      }
    }
  });

  useFloatingSurfaceDismissal({
    searchOpen: surfaces.searchOpen,
    moreOpen: surfaces.moreOpen,
    memoryOpen: surfaces.memoryOpen,
    activityOpen: surfaces.activityOpen,
    modelMenuOpen: surfaces.modelMenuOpen,
    skillMenuOpen: surfaces.skillMenuOpen,
    commandOpen: surfaces.commandOpen,
    settingsOpen: surfaces.settingsOpen,
    clearHistoryOpen: surfaces.clearHistoryOpen,
    deleteThreadOpen: Boolean(deleteThreadCandidate),
    rememberDialogOpen: Boolean(rememberingMessage),
    closeFloatingSurfaces,
    setModelMenuOpen: surfaces.setModelMenuOpen,
    setSkillMenuOpen: surfaces.setSkillMenuOpen,
    setMoreOpen: surfaces.setMoreOpen,
    setMemoryOpen: surfaces.setMemoryOpen,
    setActivityOpen: surfaces.setActivityOpen
  });

  // Save the active thread's draft before switching away from it. Fire-and-forget
  // callers use `void persistActiveDraft()`; only new-chat awaits completion.
  function persistActiveDraft(): Promise<void> {
    if (!threads.activeThreadId || composer.editingMessage) return Promise.resolve();
    return getBridge().updateThreadDraft({ threadId: threads.activeThreadId, content: composer.draft }).then(() => undefined, () => undefined);
  }

  function resetWorkspaceState() {
    chat.resetChatState();
    composer.resetComposer();
    setInlineSkillIds([]);
    setInlinePluginIds([]);
  }

  async function startNewChat(projectId: string | null = activeScopeProjectId): Promise<ChatThread | null> {
    await persistActiveDraft();
    const thread = await threads.startNewChat(
      chat.messages.length > 0 ||
      chat.runState === "running" ||
      chat.runState === "stopping" ||
      composer.draft.trim().length > 0 ||
      composer.attachments.length > 0,
      projectId
    );
    setActiveProjectId(projectId);
    resetWorkspaceState();
    closeFloatingSurfaces();
    clearErrors();
    return thread;
  }

  async function clearHistory() {
    const cleared = await threads.clearHistory();
    if (cleared) {
      resetWorkspaceState();
      clearErrors();
    }
    closeFloatingSurfaces();
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard?.writeText(message.content).catch(() => undefined);
    showToast(t("toast.copied"));
  }

  async function copyCode(code: string) {
    await navigator.clipboard?.writeText(code).catch(() => undefined);
    showToast(t("toast.codeCopied"));
  }

  function retryMessage(message?: ChatMessage) {
    const messageId = message?.status === "error" ? undefined : message?.id;
    void chat.retryLastMessage(providers.activeProvider?.id, messageId, providers.activeProvider?.defaultModel, memoryEnabled, toolsEnabled, skills.selectedSkillIds, webSearch.settings.enabled, reasoningEffort);
  }

  function selectReasoningEffort(effort: ReasoningEffort) {
    setReasoningEffort(effort);
    window.localStorage.setItem("jasmine.reasoningEffort", effort);
  }

  async function rememberMessage(content: string, message: ChatMessage) {
    const saved = await memories.createMemory({
      content,
      sourceMessageId: message.id,
      sourceThreadId: message.threadId
    });
    if (saved) {
      setMemoryEnabled(true);
      surfaces.setMemoryOpen(true);
      setRememberingMessage(null);
    }
  }

  function clearErrors() {
    setAppError(null);
    if (chat.runState === "error") {
      chat.setRunState("idle");
      chat.setError(null);
    }
  }

  const visibleError = chat.error ?? appError;
  const workspaceLoading = threads.loadingThreads || projects.loadingProjects || providers.loadingProviders;
  const messageActionKey = useMemo(
    () => [
      appSettings.settings.language,
      providers.activeProvider?.id ?? "",
      providers.activeProvider?.defaultModel ?? "",
      memoryEnabled ? "memory" : "no-memory",
      toolsEnabled ? "tools" : "no-tools",
      skills.selectedSkillIds.join("\u0000"),
      webSearch.settings.enabled ? "web" : "no-web",
      reasoningEffort
    ].join("|"),
    [
      appSettings.settings.language,
      memoryEnabled,
      providers.activeProvider?.defaultModel,
      providers.activeProvider?.id,
      reasoningEffort,
      skills.selectedSkillIds,
      toolsEnabled,
      webSearch.settings.enabled
    ]
  );

  // Stable identities for handlers that flow into memoized components
  // (Sidebar, ChatHeader, Composer). The proxies always invoke the latest
  // closure, so memo boundaries hold across stream ticks without stale state.
  const shellHandlers = useStableCallbacks({
    onToggleSidebar: () => setSidebarCollapsed((collapsed) => !collapsed),
    onSearch: () => {
      closeFloatingSurfaces();
      surfaces.setSearchOpen(true);
    },
    onCloseFloatingSurfaces: () => closeFloatingSurfaces(),
    onNewChat: () => {
      void startNewChat(activeScopeProjectId);
    },
    onNewChatInChats: () => {
      void startNewChat(null);
    },
    onNewChatInProject: (projectId: string) => {
      void startNewChat(projectId);
    },
    onOpenProjectFolder: () => {
      void projects.openFolder().then((project) => {
        if (project) selectProjectScope(project.id);
      });
    },
    onSelectProject: (projectId: string) => {
      selectProjectScope(projectId);
    },
    onSelectThread: (threadId: string) => openThreadById(threadId),
    onOpenTodo: () => navigateToRoute({ name: "todo" }),
    onOpenWorking: () => navigateToRoute({ name: "working" }),
    onRenameProject: (projectId: string, name: string) => void projects.renameProject(projectId, name),
    onRemoveProject: (projectId: string) => {
      void removeProject(projectId);
    },
    onOpenProjectInExplorer: (projectId: string) => {
      void projects.openProjectInExplorer(projectId);
    },
    onToggleMore: () => {
      const nextOpen = !surfaces.moreOpen;
      closeFloatingSurfaces();
      surfaces.setMoreOpen(nextOpen);
    },
    onClearHistory: () => {
      closeFloatingSurfaces();
      surfaces.setClearHistoryOpen(true);
    },
    onOpenSettings: () => openSettingsSection("general"),
    onRenameThread: (threadId: string, title: string) => void threads.renameThread(threadId, title),
    onDeleteThread: (threadId: string) => {
      closeFloatingSurfaces();
      setDeleteThreadCandidate(threads.threads.find((thread) => thread.id === threadId) ?? null);
    }
  });

  const chatPageHandlers = useStableCallbacks({
    onCopy: (message: ChatMessage) => void copyMessage(message),
    onLoadOlderMessages: () => void chat.loadOlderMessages(),
    onCopyCode: (code: string) => void copyCode(code),
    onRetry: (message?: ChatMessage) => retryMessage(message),
    onEditMessage: (message: ChatMessage) => {
      setInlineSkillIds(message.skillsUsed?.map((skill) => skill.id) ?? []);
      setInlinePluginIds(message.pluginsUsed?.map((plugin) => plugin.id) ?? []);
      composer.startEdit(message);
    },
    onRemember: (message: ChatMessage) => setRememberingMessage(message),
    onMessageWheel: (deltaY: number) => chat.onMessageWheel(deltaY),
    onMessageScroll: () => chat.onMessageScroll(),
    onCloseMemory: () => surfaces.setMemoryOpen(false),
    onRefreshMemories: () => void memories.refresh(),
    onCreateMemory: (content: string) => void memories.createMemory({ content }),
    onUpdateMemory: (id: string, content: string) => void memories.updateMemory(id, content),
    onArchiveMemory: (id: string, archived: boolean) => void memories.archiveMemory(id, archived),
    onRequestDeleteMemory: (memory: MemoryRecord) => setDeleteMemoryCandidate(memory),
    onCloseActivity: () => surfaces.setActivityOpen(false),
    onRefreshActivity: () => void activity.refreshObservations(),
    onSearchActivity: (query: string) => activity.setSearchQuery(query),
    onCreateManualActivity: (note: string) => void activity.createManualObservation(note),
    onUpdateActivitySettings: (update: ActivitySettingsUpdateRequest) => void activity.updateSettings(update),
    onToggleModelMenu: () => {
      const nextOpen = !surfaces.modelMenuOpen;
      closeFloatingSurfaces();
      surfaces.setModelMenuOpen(nextOpen);
    },
    onToggleSkillMenu: () => {
      const nextOpen = !surfaces.skillMenuOpen;
      closeFloatingSurfaces();
      surfaces.setSkillMenuOpen(nextOpen);
    },
    onToggleSkill: (skillId: string) => skills.toggleSelected(skillId),
    onAddInlineSkill: (skillId: string) => {
      setInlineSkillIds((current) => current.includes(skillId) ? current : [...current, skillId]);
    },
    onRemoveInlineSkill: (skillId: string) => {
      setInlineSkillIds((current) => current.filter((id) => id !== skillId));
    },
    onAddInlinePlugin: (pluginId: string) => {
      setInlinePluginIds((current) => {
        const next = current.includes(pluginId) ? current : [...current, pluginId];
        if (threads.activeThreadId && !composer.editingMessage) {
          void threads.updateThreadActivePlugins(threads.activeThreadId, next);
        }
        return next;
      });
    },
    onRemoveInlinePlugin: (pluginId: string) => {
      setInlinePluginIds((current) => {
        const next = current.filter((id) => id !== pluginId);
        if (threads.activeThreadId && !composer.editingMessage) {
          void threads.updateThreadActivePlugins(threads.activeThreadId, next);
        }
        return next;
      });
    },
    onOpenSkillSettings: () => openSettingsSection("skills"),
    onOpenPluginSettings: () => openSettingsSection("plugins"),
    onSelectProvider: (providerId: string) => {
      providers.setSelectedProviderId(providerId);
      surfaces.setModelMenuOpen(false);
    },
    onSelectModel: (providerId: string, modelId: string) => {
      providers.setSelectedProviderId(providerId);
      void providers.updateProvider({ id: providerId, defaultModel: modelId });
      surfaces.setModelMenuOpen(false);
    },
    onSelectReasoningEffort: (effort: ReasoningEffort) => selectReasoningEffort(effort),
    onOpenSettings: () => openSettingsSection("providers", providers.selectedProviderId),
    onTestProvider: () => {
      if (providers.activeProvider) void providers.testProvider(providers.activeProvider.id);
    },
    onToggleWebSearch: () => void webSearch.setEnabled(!webSearch.settings.enabled),
    onDraftChange: (value: string) => composer.setDraft(value),
    onClearError: () => clearErrors(),
    onSubmit: (mode?: ChatQueueMode) => void composer.submit(undefined, mode),
    onUpdateQueuedMessage: (messageId: string, content: string, attachments: PickedPath[] = []) => void chat.updateQueuedMessage(messageId, content, attachments),
    onDeleteQueuedMessage: (messageId: string) => void chat.deleteQueuedMessage(messageId),
    onSteerQueuedMessage: (messageId: string) => void chat.steerQueuedMessage(messageId),
    onStop: () => void chat.stopActiveRun(),
    onAttachFile: () => void composer.attachFile(),
    onAttachClipboardImage: (request?: ClipboardImagePasteRequest) => void composer.attachClipboardImage(request),
    onAttachFilePath: (filePath: string) => void composer.attachFileFromPath(filePath),
    onRemoveAttachment: (path: string) => composer.setAttachments((current) => current.filter((attachment) => attachment.path !== path)),
    onCancelEdit: () => {
      setInlineSkillIds([]);
      setInlinePluginIds(threads.activeThread?.activePluginIds ?? []);
      composer.cancelEdit();
    },
    onToggleMemory: () => setMemoryEnabled((enabled) => !enabled),
    onToggleTools: () => setToolsEnabled((enabled) => !enabled),
    onSelectRemoteConnection: (id: string | null) => {
      if (id) void remotes.updateConnection({ id, active: true });
      else if (remotes.activeConnection) void remotes.updateConnection({ id: remotes.activeConnection.id, active: false });
    },
    onSelectRightPanel: (mode: RightPanelMode) => selectRightPanel(mode),
    onAddRightPanel: (mode: RightPanelMode) => addRightPanel(mode),
    onSelectRightPanelTab: (tabId: string) => selectRightPanelTab(tabId),
    onCloseRightPanel: (tabId: string) => closeRightPanel(tabId),
    onCollapseRightPanel: () => collapseRightPanel()
  });

  return (
    <I18nProvider language={appSettings.settings.language}>
    <AppShell
      threads={threads.threads}
      projects={projects.projects}
      activeThreadId={threads.activeThreadId}
      activeProjectId={activeScopeProjectId}
      todoActive={navigation.route.name === "todo"}
      workingActive={navigation.route.name === "working"}
      workingActiveCount={working.snapshot.activeCount}
      workingAttention={working.snapshot.attentionCount > 0}
      messagesEmpty={navigation.route.name !== "todo" && navigation.route.name !== "working" && chat.messages.length === 0}
      sidebarCollapsed={sidebarCollapsed}
      moreOpen={surfaces.moreOpen}
      {...shellHandlers}
    >
      {workspaceLoading && navigation.route.name !== "todo" && navigation.route.name !== "working" ? (
        <main className="workspace-startup" data-jasmine-workspace-startup role="status" aria-label="Jasmine">
          <div className="workspace-startup-line wide" />
          <div className="workspace-startup-line" />
          <div className="workspace-startup-composer" />
        </main>
      ) : navigation.route.name === "todo" ? (
        <TodoPage
          snapshot={todos.snapshot}
          loading={todos.loading}
          saving={todos.saving}
          openingKind={todos.openingKind}
          addOpen={todoAddOpen}
          activeProjectName={activeProject?.name ?? null}
          onRefresh={() => void todos.refresh()}
          onOpenAdd={() => setTodoAddOpen(true)}
          onCloseAdd={() => setTodoAddOpen(false)}
          onAdd={(text) => todos.addTodo({ text, projectId: activeScopeProjectId })}
          onOpenFile={(kind) => void todos.openFile(kind)}
          onCopyCode={(code) => void copyCode(code)}
        />
      ) : navigation.route.name === "working" ? (
        <WorkingPage
          snapshot={working.snapshot}
          loading={working.loading}
          onOpen={(task) => void openWorkingTask(task)}
          onStop={(requestId) => void working.stop(requestId)}
          onClearCompleted={() => void working.clearCompleted()}
        />
      ) : <ChatPage
        activeThread={threads.activeThread}
        activeProject={activeProject}
        activeProjectId={activeScopeProjectId}
        brand={appSettings.settings.brand}
        messages={chat.messages}
        hasOlderMessages={chat.hasOlderMessages}
        loadingOlderMessages={chat.loadingOlderMessages}
        loading={threads.loadingThreads}
        messageActionKey={messageActionKey}
        runState={chat.runState}
        runModelLabel={chat.runModelLabel}
        error={visibleError}
        queueState={chat.queueState}
        messageScrollRef={chat.messageScrollRef}
        provider={providers.activeProvider}
        providers={providers.providers}
        activeProviderId={providers.selectedProviderId}
        testingProvider={providers.testingProviderId === providers.activeProvider?.id}
        memoryOpen={surfaces.memoryOpen}
        activityOpen={surfaces.activityOpen}
        memories={memories.memories}
        memoriesLoading={memories.loading}
        activitySettings={activity.settings}
        activityStatus={activity.status}
        activityObservations={activity.observations}
        activityQuery={activity.query}
        activityLoading={activity.loading}
        modelMenuOpen={surfaces.modelMenuOpen}
        skillMenuOpen={surfaces.skillMenuOpen}
        skills={skills.skills}
        inlineSkillChoices={inlineSkillChoices}
        selectedSkillIds={skills.selectedSkillIds}
        selectedSkillsCount={skills.selectedSkills.length}
        inlineSkillIds={inlineSkillIds}
        inlineSkills={inlineSkills}
        plugins={plugins.packages}
        inlinePluginIds={inlinePluginIds}
        inlinePlugins={inlinePlugins}
        skillsLoading={skills.loading}
        promptTemplates={promptTemplates.templates}
        promptTemplatesLoading={promptTemplates.loading}
        rightPanelTabs={rightPanelTabs}
        activeRightPanelTabId={activeRightPanelTabId}
        collapsedRightPanel={rightPanelCollapsed}
        memoryEnabled={memoryEnabled}
        webSearchSettings={webSearch.settings}
        webSearchLoading={webSearch.loading}
        remoteConnections={remotes.connections}
        activeRemoteConnection={remotes.activeConnection}
        toolsEnabled={toolsEnabled}
        reasoningEffort={reasoningEffort}
        draft={composer.draft}
        attachments={composer.attachments}
        editingMessage={composer.editingMessage}
        {...chatPageHandlers}
      />}

      <SearchOverlay
        open={surfaces.searchOpen}
        query={surfaces.searchQuery}
        threads={threads.threads}
        projects={projects.projects}
        onQueryChange={surfaces.setSearchQuery}
        onClose={() => surfaces.setSearchOpen(false)}
        onSelectThread={(threadId) => openThreadById(threadId)}
      />

      <CommandPalette
        open={surfaces.commandOpen}
        commands={commands}
        onClose={() => surfaces.setCommandOpen(false)}
      />

      {uiCatalogOpen && (
        <Suspense fallback={null}>
          <UiCatalog onClose={() => setUiCatalogOpen(false)} />
        </Suspense>
      )}

      {surfaces.settingsOpen && (
        <Suspense fallback={null}>
          <ProviderSettingsPanel
            open={surfaces.settingsOpen}
            initialSection={surfaces.settingsInitialSection}
            providers={providers.providers}
            selectedProviderId={providers.selectedProviderId}
            provider={providers.activeProvider}
            testingProviderId={providers.testingProviderId}
            fetchingModelsProviderId={providers.fetchingModelsProviderId}
            memories={memories.memories}
            activitySettings={activity.settings}
            activityStatus={activity.status}
            appSettings={appSettings.settings}
            appSettingsLoading={appSettings.loading}
            appSettingsSaving={appSettings.saving}
            skills={skills.skills}
            skillSources={skills.sources}
            promptTemplates={promptTemplates.templates}
            promptTemplateSources={promptTemplates.sources}
            promptTemplatesLoading={promptTemplates.loading}
            selectedSkillIds={skills.selectedSkillIds}
            mcpMarketplace={mcp.marketplace}
            mcpServers={mcp.servers}
            installedMcpMarketplaceIds={mcp.installedMarketplaceIds}
            mcpMarketplaceLoading={mcp.loadingMarketplace}
            mcpServersLoading={mcp.loadingServers}
            mcpSavingServerId={mcp.savingServerId}
            plugins={plugins.packages}
            pluginsLoading={plugins.loading}
            pluginSavingSource={plugins.savingSource}
            remoteConnections={remotes.connections}
            remoteConnectionsLoading={remotes.loading}
            remoteConnectionSavingId={remotes.savingId}
            webSearchSettings={webSearch.settings}
            webSearchLoading={webSearch.loading}
            webSearchSaving={webSearch.saving}
            onSelectProvider={providers.setSelectedProviderId}
            onNavigateSection={(section, providerId) => navigateToRoute({ name: "settings", section, providerId: section === "providers" ? providerId ?? providers.selectedProviderId : undefined }, { keepSettingsOpen: true })}
            onClose={() => surfaces.setSettingsOpen(false)}
            onOpenMemory={() => {
              surfaces.setSettingsOpen(false);
              surfaces.setMemoryOpen(true);
            }}
            onOpenActivity={() => {
              surfaces.setSettingsOpen(false);
              surfaces.setActivityOpen(true);
            }}
            onUpdateAppSettings={appSettings.updateSettings}
            onToggleSelectedSkill={skills.toggleSelected}
            onRefreshSkills={() => void skills.refresh()}
            onAddSkillSources={() => void skills.addSkillSourcesFromPicker()}
            onDeleteSkillSource={(id) => void skills.deleteSkillSource(id)}
            onCreateSkill={skills.createSkill}
            onUpdateSkill={skills.updateSkill}
            onDeleteSkill={skills.deleteSkill}
            onOpenSkill={skills.openSkill}
            onRefreshPromptTemplates={() => void promptTemplates.refresh()}
            onAddPromptTemplateSources={() => void promptTemplates.addSourcesFromPicker()}
            onDeletePromptTemplateSource={(id) => void promptTemplates.deleteSource(id)}
            onMcpMarketplaceOpened={mcp.ensureMarketplace}
            onRefreshMcpMarketplace={(request) => void mcp.refreshMarketplace(request)}
            onRefreshMcpServers={() => void mcp.refreshServers()}
            onInstallMcpServer={(server) => void mcp.installMarketplaceServer(server)}
            onCreateMcpServer={mcp.createServer}
            onUpdateMcpServer={(request) => void mcp.updateServer(request)}
            onDeleteMcpServer={(id) => void mcp.deleteServer(id)}
            onRefreshPlugins={() => void plugins.refresh()}
            onInstallPlugin={(source) => plugins.install({ source })}
            onUpdatePlugin={(source, scope) => plugins.update({ source, scope })}
            onRemovePlugin={(source, scope) => plugins.remove({ source, scope })}
            onSetPluginEnabled={(source, scope, enabled) => plugins.setEnabled({ source, scope, enabled })}
            onRefreshRemoteConnections={() => void remotes.refresh()}
            onImportRemoteConnections={() => void remotes.importFromConfig()}
            onCreateRemoteConnection={remotes.createConnection}
            onUpdateRemoteConnection={remotes.updateConnection}
            onDeleteRemoteConnection={(id) => void remotes.deleteConnection(id)}
            onTestRemoteConnection={(id) => void remotes.testConnection(id)}
            onSave={providers.updateProvider}
            onTest={providers.testProvider}
            onFetchModels={providers.fetchProviderModels}
            onUpdateModel={providers.updateProviderModel}
            onUpdateWebSearch={webSearch.updateSettings}
          />
        </Suspense>
      )}

      <AppDialogs
        clearHistoryOpen={surfaces.clearHistoryOpen}
        deleteThreadCandidate={deleteThreadCandidate}
        deleteMemoryCandidate={deleteMemoryCandidate}
        rememberingMessage={rememberingMessage}
        askUserQuestionPrompt={askUserQuestion.activePrompt}
        toast={toast}
        onCancelClearHistory={() => surfaces.setClearHistoryOpen(false)}
        onConfirmClearHistory={() => void clearHistory()}
        onCancelDeleteThread={() => setDeleteThreadCandidate(null)}
        onConfirmDeleteThread={(thread) => {
          void threads.deleteSingleThread(thread.id, thread.projectId ?? activeProjectId).then(() => {
            chat.resetChatState();
            composer.resetComposer();
          });
          setDeleteThreadCandidate(null);
        }}
        onCancelDeleteMemory={() => setDeleteMemoryCandidate(null)}
        onConfirmDeleteMemory={(memory) => {
          void memories.deleteMemory(memory.id);
          setDeleteMemoryCandidate(null);
        }}
        onCancelRemember={() => setRememberingMessage(null)}
        onConfirmRemember={(content, message) => void rememberMessage(content, message)}
        onAnswerAskUserQuestion={(response) => void askUserQuestion.answer(response)}
      />
    </AppShell>
    </I18nProvider>
  );

  function closeFloatingSurfaces() {
    surfaces.closeFloatingSurfaces();
    setDeleteThreadCandidate(null);
    setRememberingMessage(null);
    setTodoAddOpen(false);
  }

  function selectProjectScope(projectId: string | null, mode: "push" | "replace" = "push") {
    void persistActiveDraft();
    setActiveProjectId(projectId);
    threads.setActiveThreadId(null);
    resetWorkspaceState();
    clearErrors();
    closeFloatingSurfaces();
    const route: JasmineRoute = { name: "newChat", projectId };
    if (mode === "replace") navigation.replace(route);
    else navigation.navigate(route);
  }

  function navigateToRoute(route: JasmineRoute, options: { keepSettingsOpen?: boolean } = {}) {
    const nextRoute: JasmineRoute = route.name === "settings" && route.section === "providers" && !route.providerId
      ? { ...route, providerId: providers.selectedProviderId }
      : route;
    navigation.navigate(nextRoute);
    if (nextRoute.name === "newChat") {
      const projectId = nextRoute.projectId ?? null;
      setActiveProjectId(projectId);
      void startNewChat(projectId);
      return;
    }
    if (nextRoute.name === "thread") {
      selectThread(nextRoute.threadId, nextRoute.projectId ?? null);
      return;
    }
    if (nextRoute.name === "rightPanel") {
      selectThread(nextRoute.threadId, nextRoute.projectId ?? null);
      openRightPanelTab(nextRoute.panel, { forceNew: false, pushRoute: false });
      setRightPanelCollapsed(false);
      closeFloatingSurfaces();
      return;
    }
    if (nextRoute.name === "todo") {
      closeFloatingSurfaces();
      return;
    }
    if (nextRoute.name === "working") {
      closeFloatingSurfaces();
      return;
    }
    openSettingsRoute(nextRoute.section, nextRoute.providerId, options);
  }

  function selectThread(threadId: string, projectId?: string | null) {
    void persistActiveDraft();
    const thread = threads.threads.find((item) => item.id === threadId);
    setActiveProjectId(thread?.projectId ?? projectId ?? null);
    threads.setActiveThreadId(threadId);
    closeFloatingSurfaces();
  }

  async function removeProject(projectId: string) {
    const removed = await projects.removeProject(projectId);
    if (!removed) return;
    await threads.refreshThreads(null);
    if (activeProjectId === projectId) {
      selectProjectScope(null, "replace");
    }
  }

  function openSettingsSection(section: SettingsSection, providerId?: string) {
    closeFloatingSurfaces();
    navigateToRoute({ name: "settings", section, providerId });
  }

  function openThreadById(threadId: string) {
    const thread = threads.threads.find((item) => item.id === threadId);
    navigateToRoute({ name: "thread", threadId, projectId: thread?.projectId ?? null });
  }

  async function openWorkingTask(task: WorkingTask) {
    await working.markRead(task.requestId);
    await openWorkingTarget({ requestId: task.requestId, threadId: task.threadId, projectId: task.projectId });
  }

  async function openWorkingTarget(target: WorkingNavigationTarget) {
    try {
      const latestThreads = await getBridge().listThreads();
      const thread = latestThreads.find((item) => item.id === target.threadId);
      if (!thread) {
        setAppError("This Working chat is no longer available. It may have been deleted.");
        return;
      }
      await threads.refreshThreads(target.threadId);
      navigateToRoute({ name: "thread", threadId: thread.id, projectId: thread.projectId });
    } catch (caught) {
      setAppError(caught instanceof Error ? caught.message : "Failed to open the Working chat.");
    }
  }

  function openSettingsRoute(section: SettingsSection, providerId?: string, options: { keepSettingsOpen?: boolean } = {}) {
    if (!options.keepSettingsOpen) closeFloatingSurfaces();
    if (section === "providers" && providerId) providers.setSelectedProviderId(providerId);
    surfaces.setSettingsInitialSection(section);
    surfaces.setSettingsOpen(true);
  }

  function selectRightPanel(mode: RightPanelMode) {
    openRightPanelTab(mode, { forceNew: false, pushRoute: true });
  }

  function addRightPanel(mode: RightPanelMode) {
    openRightPanelTab(mode, { forceNew: mode === "terminal", pushRoute: true });
  }

  function selectRightPanelTab(tabId: string) {
    const tab = rightPanelTabs.find((item) => item.id === tabId);
    if (!tab) return;
    navigateRightPanel(tab.mode);
    setActiveRightPanelTabId(tab.id);
    setRightPanelCollapsed(false);
  }

  function openRightPanelTab(mode: RightPanelMode, options: { forceNew: boolean; pushRoute: boolean }) {
    if (options.pushRoute) navigateRightPanel(mode);
    const reusable = options.forceNew || mode === "terminal"
      ? null
      : rightPanelTabs.find((tab) => tab.mode === mode) ?? null;
    const existingTerminal = mode === "terminal" && !options.forceNew
      ? (activeRightPanelTab?.mode === "terminal" ? activeRightPanelTab : [...rightPanelTabs].reverse().find((tab) => tab.mode === "terminal") ?? null)
      : null;
    const target = reusable ?? existingTerminal ?? createRightPanelTab(mode);
    if (!rightPanelTabs.some((tab) => tab.id === target.id)) {
      setRightPanelTabs([...rightPanelTabs, target]);
    }
    setActiveRightPanelTabId(target.id);
    setRightPanelCollapsed(false);
  }

  function navigateRightPanel(mode: RightPanelMode) {
    if (threads.activeThreadId) {
      navigation.navigate({ name: "rightPanel", threadId: threads.activeThreadId, projectId: threads.activeThread?.projectId ?? null, panel: mode });
    }
  }

  function createRightPanelTab(mode: RightPanelMode): RightPanelTab {
    rightPanelTabSequence.current += 1;
    if (mode === "terminal") {
      return {
        id: `terminal-${rightPanelTabSequence.current}`,
        mode,
        title: nextTerminalTabTitle(rightPanelTabs)
      };
    }
    return {
      id: `${mode}-${rightPanelTabSequence.current}`,
      mode,
      title: rightPanelModeLabel(mode)
    };
  }

  function closeRightPanel(tabId: string) {
    const closingIndex = rightPanelTabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;
    const next = rightPanelTabs.filter((tab) => tab.id !== tabId);
    setRightPanelTabs(next);
    if (next.length === 0) {
      setActiveRightPanelTabId(null);
      setRightPanelCollapsed(false);
      return;
    }
    if (activeRightPanelTabId === tabId || !next.some((tab) => tab.id === activeRightPanelTabId)) {
      const fallback = next[Math.min(closingIndex, next.length - 1)] ?? next.at(-1) ?? null;
      setActiveRightPanelTabId(fallback?.id ?? null);
      return;
    }
    setActiveRightPanelTabId(activeRightPanelTabId);
  }

  function collapseRightPanel() {
    if (rightPanelTabs.length === 0) return;
    setRightPanelCollapsed(true);
  }
}

function nextTerminalTabTitle(openTabs: RightPanelTab[]): string {
  const used = new Set<number>();
  for (const tab of openTabs) {
    if (tab.mode !== "terminal") continue;
    const match = /^Terminal(?: (\d+))?$/.exec(tab.title);
    if (!match) continue;
    used.add(match[1] ? Number(match[1]) : 1);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index === 1 ? "Terminal" : `Terminal ${index}`;
}

export default App;
