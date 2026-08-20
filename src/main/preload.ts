import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivityObservationCreateRequest,
  ActivityObservationListRequest,
  ActivitySettingsUpdateRequest,
  AppSettingsUpdateRequest,
  AppUpdateState,
  AskUserQuestionPrompt,
  AskUserQuestionResponse,
  ChatEditRequest,
  ChatEditResponse,
  ChatContextTaxonomyCaptureUpdateRequest,
  ChatQueueDeleteRequest,
  ChatQueueRequest,
  ChatQueueResponse,
  ChatQueueSteerRequest,
  ChatQueueUpdateRequest,
  ChatRetryRequest,
  ChatRetryResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatStreamEvent,
  ExecutableDiscovery,
  ExecutablePickerKind,
  FileSearchRequest,
  JasmineApi,
  LocalFileDescription,
  MessageListRequest,
  PickedPath,
  PermissionApprovalPrompt,
  PermissionApprovalResponse,
  PluginPackageEnableRequest,
  PluginPackageInstallRequest,
  PluginPackageOperationRequest,
  ProjectCreateFromPathRequest,
  ProjectOpenInExplorerRequest,
  ProjectRemoveRequest,
  ProjectRenameRequest,
  PromptTemplateSourceCreateRequest,
  ProviderModelUpdateRequest,
  ProviderUpdateRequest,
  MemoryArchiveRequest,
  MemoryCreateRequest,
  MemoryListRequest,
  MemoryUpdateRequest,
  SkillCreateRequest,
  SkillSourceCreateRequest,
  SkillUpdateRequest,
  TerminalEvent,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalStartRequest,
  TerminalStopRequest,
  ThreadActivePluginsUpdateRequest,
  ThreadContextUsageRequest,
  ThreadDraftUpdateRequest,
  ThreadRenameRequest,
  WindowState,
  SpotlightExecuteRequest,
  SpotlightSearchRequest,
  WorkspaceProject
} from "../shared/ipc.js";

const api: JasmineApi = {
  platform: process.platform,
  listThreads() {
    return ipcRenderer.invoke("threads:list");
  },
  createThread(input) {
    return ipcRenderer.invoke("threads:create", input);
  },
  renameThread(request: ThreadRenameRequest) {
    return ipcRenderer.invoke("threads:rename", request);
  },
  deleteThread(threadId: string) {
    return ipcRenderer.invoke("threads:delete", threadId);
  },
  deleteThreads(threadIds: string[]) {
    return ipcRenderer.invoke("threads:deleteMany", threadIds);
  },
  getThreadDraft(threadId: string) {
    return ipcRenderer.invoke("threads:draft:get", threadId);
  },
  updateThreadDraft(request: ThreadDraftUpdateRequest) {
    return ipcRenderer.invoke("threads:draft:update", request);
  },
  updateThreadActivePlugins(request: ThreadActivePluginsUpdateRequest) {
    return ipcRenderer.invoke("threads:plugins:update", request);
  },
  getThreadContextUsage(request: ThreadContextUsageRequest) {
    return ipcRenderer.invoke("threads:contextUsage:get", request);
  },
  listProjects() {
    return ipcRenderer.invoke("projects:list");
  },
  openProjectFolder() {
    return ipcRenderer.invoke("projects:openFolder");
  },
  createProjectFromPath(request: ProjectCreateFromPathRequest) {
    return ipcRenderer.invoke("projects:createFromPath", request);
  },
  renameProject(request: ProjectRenameRequest) {
    return ipcRenderer.invoke("projects:rename", request);
  },
  removeProject(request: ProjectRemoveRequest) {
    return ipcRenderer.invoke("projects:remove", request);
  },
  openProjectInExplorer(request: ProjectOpenInExplorerRequest) {
    return ipcRenderer.invoke("projects:openInExplorer", request);
  },
  onProjectOpened(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceProject) => callback(payload);
    ipcRenderer.on("projects:opened", listener);
    return () => ipcRenderer.removeListener("projects:opened", listener);
  },
  getWorkingSnapshot() {
    return ipcRenderer.invoke("working:snapshot");
  },
  markWorkingRead(requestId: string) {
    return ipcRenderer.invoke("working:markRead", requestId);
  },
  clearCompletedWorking() {
    return ipcRenderer.invoke("working:clearCompleted");
  },
  stopWorkingTask(requestId: string) {
    return ipcRenderer.invoke("working:stop", requestId);
  },
  updateWorkingView(request) {
    return ipcRenderer.invoke("working:view", request);
  },
  consumePendingWorkingNavigation() {
    return ipcRenderer.invoke("working:navigation:consume");
  },
  onWorkingChanged(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: import("../shared/ipc.js").WorkingSnapshot) => callback(payload);
    ipcRenderer.on("working:changed", listener);
    return () => ipcRenderer.removeListener("working:changed", listener);
  },
  onWorkingNavigate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: import("../shared/ipc.js").WorkingNavigationTarget) => callback(payload);
    ipcRenderer.on("working:navigate", listener);
    return () => ipcRenderer.removeListener("working:navigate", listener);
  },
  listMessages(request: string | MessageListRequest) {
    return ipcRenderer.invoke("messages:list", request);
  },
  sendChatMessage(request: ChatSendRequest): Promise<ChatSendResponse> {
    return ipcRenderer.invoke("chat:send", request);
  },
  retryChatMessage(request: ChatRetryRequest): Promise<ChatRetryResponse> {
    return ipcRenderer.invoke("chat:retry", request);
  },
  editChatMessage(request: ChatEditRequest): Promise<ChatEditResponse> {
    return ipcRenderer.invoke("chat:edit", request);
  },
  queueChatMessage(request: ChatQueueRequest): Promise<ChatQueueResponse> {
    return ipcRenderer.invoke("chat:queue", request);
  },
  updateQueuedChatMessage(request: ChatQueueUpdateRequest): Promise<ChatQueueResponse> {
    return ipcRenderer.invoke("chat:queue:update", request);
  },
  deleteQueuedChatMessage(request: ChatQueueDeleteRequest): Promise<ChatQueueResponse> {
    return ipcRenderer.invoke("chat:queue:delete", request);
  },
  steerQueuedChatMessage(request: ChatQueueSteerRequest): Promise<ChatQueueResponse> {
    return ipcRenderer.invoke("chat:queue:steer", request);
  },
  updateChatContextTaxonomyCapture(request: ChatContextTaxonomyCaptureUpdateRequest): Promise<boolean> {
    return ipcRenderer.invoke("chat:contextTaxonomyCapture:update", request);
  },
  cancelChatMessage(requestId: string): Promise<boolean> {
    return ipcRenderer.invoke("chat:cancel", requestId);
  },
  answerAskUserQuestion(request: AskUserQuestionResponse): Promise<void> {
    return ipcRenderer.invoke("askUserQuestion:answer", request);
  },
  answerPermissionApproval(request: PermissionApprovalResponse): Promise<void> {
    return ipcRenderer.invoke("permissionApproval:answer", request);
  },
  onChatStream(callback: (event: ChatStreamEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent) => callback(payload);
    ipcRenderer.on("chat:stream", listener);
    return () => ipcRenderer.removeListener("chat:stream", listener);
  },
  onAskUserQuestion(callback: (prompt: AskUserQuestionPrompt) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: AskUserQuestionPrompt) => callback(payload);
    ipcRenderer.on("askUserQuestion:prompt", listener);
    return () => ipcRenderer.removeListener("askUserQuestion:prompt", listener);
  },
  onAskUserQuestionCancelled(callback: (id: string) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on("askUserQuestion:cancelled", listener);
    return () => ipcRenderer.removeListener("askUserQuestion:cancelled", listener);
  },
  listTracesForThread(threadId: string) {
    return ipcRenderer.invoke("traces:listForThread", threadId);
  },
  listTracesForMessage(messageId: string) {
    return ipcRenderer.invoke("traces:listForMessage", messageId);
  },
  getTrace(runId: string) {
    return ipcRenderer.invoke("traces:get", runId);
  },
  listMemories(request?: MemoryListRequest) {
    return ipcRenderer.invoke("memories:list", request);
  },
  createMemory(request: MemoryCreateRequest) {
    return ipcRenderer.invoke("memories:create", request);
  },
  updateMemory(request: MemoryUpdateRequest) {
    return ipcRenderer.invoke("memories:update", request);
  },
  archiveMemory(request: MemoryArchiveRequest) {
    return ipcRenderer.invoke("memories:archive", request);
  },
  deleteMemory(id: string) {
    return ipcRenderer.invoke("memories:delete", id);
  },
  listSkills() {
    return ipcRenderer.invoke("skills:list");
  },
  createSkill(request: SkillCreateRequest) {
    return ipcRenderer.invoke("skills:create", request);
  },
  updateSkill(request: SkillUpdateRequest) {
    return ipcRenderer.invoke("skills:update", request);
  },
  deleteSkill(id: string) {
    return ipcRenderer.invoke("skills:delete", id);
  },
  openSkill(id: string) {
    return ipcRenderer.invoke("skills:open", id);
  },
  listSkillSources() {
    return ipcRenderer.invoke("skillSources:list");
  },
  addSkillSource(request: SkillSourceCreateRequest) {
    return ipcRenderer.invoke("skillSources:add", request);
  },
  deleteSkillSource(id: string) {
    return ipcRenderer.invoke("skillSources:delete", id);
  },
  pickSkillFolders() {
    return ipcRenderer.invoke("dialog:pickSkillFolders");
  },
  listExecutableDiscovery(kind: ExecutablePickerKind): Promise<ExecutableDiscovery> {
    return ipcRenderer.invoke("dialog:listExecutableDiscovery", kind);
  },
  pickExecutable(kind: ExecutablePickerKind) {
    return ipcRenderer.invoke("dialog:pickExecutable", kind);
  },
  listPromptTemplates() {
    return ipcRenderer.invoke("promptTemplates:list");
  },
  listPromptTemplateSources() {
    return ipcRenderer.invoke("promptTemplateSources:list");
  },
  addPromptTemplateSource(request: PromptTemplateSourceCreateRequest) {
    return ipcRenderer.invoke("promptTemplateSources:add", request);
  },
  deletePromptTemplateSource(id: string) {
    return ipcRenderer.invoke("promptTemplateSources:delete", id);
  },
  pickPromptTemplatePaths() {
    return ipcRenderer.invoke("dialog:pickPromptTemplatePaths");
  },
  listPlugins() {
    return ipcRenderer.invoke("plugins:list");
  },
  listPluginSkills() {
    return ipcRenderer.invoke("plugins:listSkills");
  },
  installPlugin(request: PluginPackageInstallRequest) {
    return ipcRenderer.invoke("plugins:install", request);
  },
  updatePlugin(request: PluginPackageOperationRequest) {
    return ipcRenderer.invoke("plugins:update", request);
  },
  removePlugin(request: PluginPackageOperationRequest) {
    return ipcRenderer.invoke("plugins:remove", request);
  },
  setPluginEnabled(request: PluginPackageEnableRequest) {
    return ipcRenderer.invoke("plugins:setEnabled", request);
  },
  resolvePluginResources() {
    return ipcRenderer.invoke("plugins:resolveResources");
  },
  getAppSettings() {
    return ipcRenderer.invoke("appSettings:get");
  },
  updateAppSettings(request: AppSettingsUpdateRequest) {
    return ipcRenderer.invoke("appSettings:update", request);
  },
  onPermissionApproval(callback: (prompt: PermissionApprovalPrompt) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: PermissionApprovalPrompt) => callback(payload);
    ipcRenderer.on("permissionApproval:prompt", listener);
    return () => ipcRenderer.removeListener("permissionApproval:prompt", listener);
  },
  onPermissionApprovalCancelled(callback: (id: string) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on("permissionApproval:cancelled", listener);
    return () => ipcRenderer.removeListener("permissionApproval:cancelled", listener);
  },
  getAppUpdateState() {
    return ipcRenderer.invoke("updater:getState");
  },
  checkForAppUpdate() {
    return ipcRenderer.invoke("updater:check");
  },
  downloadAppUpdate() {
    return ipcRenderer.invoke("updater:download");
  },
  installAppUpdate() {
    return ipcRenderer.invoke("updater:install");
  },
  openAppUpdateDownloadPage() {
    return ipcRenderer.invoke("updater:openDownloadPage");
  },
  onAppUpdateStateChanged(callback: (state: AppUpdateState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppUpdateState) => callback(payload);
    ipcRenderer.on("updater:changed", listener);
    return () => ipcRenderer.removeListener("updater:changed", listener);
  },
  resolveTerminalShell() {
    return ipcRenderer.invoke("terminal:shell:resolve");
  },
  startTerminal(request?: TerminalStartRequest) {
    return ipcRenderer.invoke("terminal:start", request);
  },
  writeTerminal(request: TerminalInputRequest) {
    return ipcRenderer.invoke("terminal:input", request);
  },
  resizeTerminal(request: TerminalResizeRequest) {
    return ipcRenderer.invoke("terminal:resize", request);
  },
  stopTerminal(request: TerminalStopRequest) {
    return ipcRenderer.invoke("terminal:stop", request);
  },
  onTerminalEvent(callback: (event: TerminalEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => callback(payload);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("clipboard:readText");
  },
  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke("clipboard:writeText", text);
  },
  listThreadArtifacts(threadId: string) {
    return ipcRenderer.invoke("thread:artifacts:list", threadId);
  },
  getThreadArtifactDetail(threadId: string, changeId: string) {
    return ipcRenderer.invoke("thread:artifacts:detail", threadId, changeId);
  },
  listThreadContextTaxonomy(threadId: string) {
    return ipcRenderer.invoke("thread:contextTaxonomy:list", threadId);
  },
  getContextTaxonomy(captureId: string) {
    return ipcRenderer.invoke("thread:contextTaxonomy:get", captureId);
  },
  getContextTaxonomyRaw(request) {
    return ipcRenderer.invoke("thread:contextTaxonomy:raw", request);
  },
  getActivitySettings() {
    return ipcRenderer.invoke("activity:settings:get");
  },
  updateActivitySettings(request: ActivitySettingsUpdateRequest) {
    return ipcRenderer.invoke("activity:settings:update", request);
  },
  listActivityObservations(request?: ActivityObservationListRequest) {
    return ipcRenderer.invoke("activity:observations:list", request);
  },
  createManualActivityObservation(request: ActivityObservationCreateRequest) {
    return ipcRenderer.invoke("activity:observations:createManual", request);
  },
  listProviders() {
    return ipcRenderer.invoke("providers:list");
  },
  updateProvider(request: ProviderUpdateRequest) {
    return ipcRenderer.invoke("providers:update", request);
  },
  testProvider(providerId: string) {
    return ipcRenderer.invoke("providers:test", providerId);
  },
  fetchProviderModels(providerId: string) {
    return ipcRenderer.invoke("providers:models", providerId);
  },
  updateProviderModel(request: ProviderModelUpdateRequest) {
    return ipcRenderer.invoke("providers:model:update", request);
  },
  searchFiles(request: FileSearchRequest) {
    return ipcRenderer.invoke("dialog:searchFiles", request);
  },
  pickFileFromPath(filePath: string): Promise<PickedPath> {
    return ipcRenderer.invoke("dialog:pickFileFromPath", filePath);
  },
  pickFile(): Promise<PickedPath | null> {
    return ipcRenderer.invoke("dialog:pickFile");
  },
  savePastedImage(request): Promise<PickedPath> {
    return ipcRenderer.invoke("dialog:savePastedImage", request);
  },
  pickClipboardImage(): Promise<PickedPath | null> {
    return ipcRenderer.invoke("dialog:pickClipboardImage");
  },
  pickFolder(title?: string): Promise<PickedPath | null> {
    return ipcRenderer.invoke("dialog:pickFolder", title);
  },
  describeLocalFiles(paths: string[]): Promise<LocalFileDescription[]> {
    return ipcRenderer.invoke("files:describe", paths);
  },
  openLocalPath(filePath: string): Promise<void> {
    return ipcRenderer.invoke("files:openDefault", filePath);
  },
  revealLocalPath(filePath: string): Promise<void> {
    return ipcRenderer.invoke("files:reveal", filePath);
  },
  openExternalUrl(url: string): Promise<void> {
    return ipcRenderer.invoke("shell:openExternal", url);
  },
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
    return ipcRenderer.invoke("window:action", action);
  },
  getWindowState(): Promise<WindowState> {
    return ipcRenderer.invoke("window:state");
  },
  onWindowStateChanged(callback: (state: WindowState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: WindowState) => callback(payload);
    ipcRenderer.on("window:state-changed", listener);
    return () => ipcRenderer.removeListener("window:state-changed", listener);
  },
  spotlightSearch(request: SpotlightSearchRequest) {
    return ipcRenderer.invoke("spotlight:search", request);
  },
  spotlightExecute(request: SpotlightExecuteRequest) {
    return ipcRenderer.invoke("spotlight:execute", request);
  },
  spotlightConsumePending() {
    return ipcRenderer.invoke("spotlight:consumePending");
  },
  spotlightClose() {
    return ipcRenderer.invoke("spotlight:close");
  },
  onSpotlightReset(callback: () => void) {
    const listener = () => callback();
    ipcRenderer.on("spotlight:reset", listener);
    return () => ipcRenderer.removeListener("spotlight:reset", listener);
  },
  onSpotlightCommand(callback: (payload: SpotlightExecuteRequest) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: SpotlightExecuteRequest) => callback(payload);
    ipcRenderer.on("spotlight:command", listener);
    return () => ipcRenderer.removeListener("spotlight:command", listener);
  }
};

contextBridge.exposeInMainWorld("jasmine", api);
contextBridge.exposeInMainWorld("__JASMINE_HARNESS_ENABLED__", process.env.JASMINE_E2E_HARNESS === "1");
