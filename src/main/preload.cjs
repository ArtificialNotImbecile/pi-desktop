const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jasmine", {
  platform: process.platform,
  listThreads() {
    return ipcRenderer.invoke("threads:list");
  },
  createThread(input) {
    return ipcRenderer.invoke("threads:create", input);
  },
  renameThread(request) {
    return ipcRenderer.invoke("threads:rename", request);
  },
  deleteThread(threadId) {
    return ipcRenderer.invoke("threads:delete", threadId);
  },
  deleteThreads(threadIds) {
    return ipcRenderer.invoke("threads:deleteMany", threadIds);
  },
  getThreadDraft(threadId) {
    return ipcRenderer.invoke("threads:draft:get", threadId);
  },
  updateThreadDraft(request) {
    return ipcRenderer.invoke("threads:draft:update", request);
  },
  updateThreadActivePlugins(request) {
    return ipcRenderer.invoke("threads:plugins:update", request);
  },
  getThreadContextUsage(request) {
    return ipcRenderer.invoke("threads:contextUsage:get", request);
  },
  listProjects() {
    return ipcRenderer.invoke("projects:list");
  },
  openProjectFolder() {
    return ipcRenderer.invoke("projects:openFolder");
  },
  createProjectFromPath(request) {
    return ipcRenderer.invoke("projects:createFromPath", request);
  },
  renameProject(request) {
    return ipcRenderer.invoke("projects:rename", request);
  },
  removeProject(request) {
    return ipcRenderer.invoke("projects:remove", request);
  },
  openProjectInExplorer(request) {
    return ipcRenderer.invoke("projects:openInExplorer", request);
  },
  onProjectOpened(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("projects:opened", listener);
    return () => ipcRenderer.removeListener("projects:opened", listener);
  },
  listRemoteProfiles() {
    return ipcRenderer.invoke("remotes:listProfiles");
  },
  createRemoteProfile(request) {
    return ipcRenderer.invoke("remotes:createProfile", request);
  },
  updateRemoteProfile(request) {
    return ipcRenderer.invoke("remotes:updateProfile", request);
  },
  removeRemoteProfile(request) {
    return ipcRenderer.invoke("remotes:removeProfile", request);
  },
  checkRemoteProfile(request) {
    return ipcRenderer.invoke("remotes:checkProfile", request);
  },
  installRemoteRuntime(request) {
    return ipcRenderer.invoke("remotes:installRuntime", request);
  },
  stopRemoteProfile(request) {
    return ipcRenderer.invoke("remotes:stopProfile", request);
  },
  listRemoteProfileStatuses() {
    return ipcRenderer.invoke("remotes:listStatuses");
  },
  listRemoteWorkspaces(request) {
    return ipcRenderer.invoke("remotes:listWorkspaces", request);
  },
  addRemoteWorkspace(request) {
    return ipcRenderer.invoke("remotes:addWorkspace", request);
  },
  updateRemoteWorkspace(request) {
    return ipcRenderer.invoke("remotes:updateWorkspace", request);
  },
  removeRemoteWorkspace(request) {
    return ipcRenderer.invoke("remotes:removeWorkspace", request);
  },
  listRemoteDirectory(request) {
    return ipcRenderer.invoke("remotes:listDirectory", request);
  },
  listRemoteSessions(request) {
    return ipcRenderer.invoke("remotes:listSessions", request);
  },
  refreshRemoteSessions(request) {
    return ipcRenderer.invoke("remotes:refreshSessions", request);
  },
  openRemoteSession(request) {
    return ipcRenderer.invoke("remotes:openSession", request);
  },
  onRemoteStatusChanged(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remotes:status-changed", listener);
    return () => ipcRenderer.removeListener("remotes:status-changed", listener);
  },
  getWorkingSnapshot() {
    return ipcRenderer.invoke("working:snapshot");
  },
  markWorkingRead(requestId) {
    return ipcRenderer.invoke("working:markRead", requestId);
  },
  clearCompletedWorking() {
    return ipcRenderer.invoke("working:clearCompleted");
  },
  stopWorkingTask(requestId) {
    return ipcRenderer.invoke("working:stop", requestId);
  },
  updateWorkingView(request) {
    return ipcRenderer.invoke("working:view", request);
  },
  consumePendingWorkingNavigation() {
    return ipcRenderer.invoke("working:navigation:consume");
  },
  onWorkingChanged(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("working:changed", listener);
    return () => ipcRenderer.removeListener("working:changed", listener);
  },
  onWorkingNavigate(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("working:navigate", listener);
    return () => ipcRenderer.removeListener("working:navigate", listener);
  },
  listMessages(request) {
    return ipcRenderer.invoke("messages:list", request);
  },
  sendChatMessage(request) {
    return ipcRenderer.invoke("chat:send", request);
  },
  retryChatMessage(request) {
    return ipcRenderer.invoke("chat:retry", request);
  },
  editChatMessage(request) {
    return ipcRenderer.invoke("chat:edit", request);
  },
  queueChatMessage(request) {
    return ipcRenderer.invoke("chat:queue", request);
  },
  updateQueuedChatMessage(request) {
    return ipcRenderer.invoke("chat:queue:update", request);
  },
  deleteQueuedChatMessage(request) {
    return ipcRenderer.invoke("chat:queue:delete", request);
  },
  steerQueuedChatMessage(request) {
    return ipcRenderer.invoke("chat:queue:steer", request);
  },
  updateChatContextTaxonomyCapture(request) {
    return ipcRenderer.invoke("chat:contextTaxonomyCapture:update", request);
  },
  cancelChatMessage(requestId) {
    return ipcRenderer.invoke("chat:cancel", requestId);
  },
  answerAskUserQuestion(request) {
    return ipcRenderer.invoke("askUserQuestion:answer", request);
  },
  answerPermissionApproval(request) {
    return ipcRenderer.invoke("permissionApproval:answer", request);
  },
  onChatStream(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:stream", listener);
    return () => ipcRenderer.removeListener("chat:stream", listener);
  },
  onAskUserQuestion(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("askUserQuestion:prompt", listener);
    return () => ipcRenderer.removeListener("askUserQuestion:prompt", listener);
  },
  onAskUserQuestionCancelled(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("askUserQuestion:cancelled", listener);
    return () => ipcRenderer.removeListener("askUserQuestion:cancelled", listener);
  },
  listTracesForThread(threadId) {
    return ipcRenderer.invoke("traces:listForThread", threadId);
  },
  listTracesForMessage(messageId) {
    return ipcRenderer.invoke("traces:listForMessage", messageId);
  },
  getTrace(runId) {
    return ipcRenderer.invoke("traces:get", runId);
  },
  listMemories(request) {
    return ipcRenderer.invoke("memories:list", request);
  },
  createMemory(request) {
    return ipcRenderer.invoke("memories:create", request);
  },
  updateMemory(request) {
    return ipcRenderer.invoke("memories:update", request);
  },
  archiveMemory(request) {
    return ipcRenderer.invoke("memories:archive", request);
  },
  deleteMemory(id) {
    return ipcRenderer.invoke("memories:delete", id);
  },
  listSkills() {
    return ipcRenderer.invoke("skills:list");
  },
  createSkill(request) {
    return ipcRenderer.invoke("skills:create", request);
  },
  updateSkill(request) {
    return ipcRenderer.invoke("skills:update", request);
  },
  deleteSkill(id) {
    return ipcRenderer.invoke("skills:delete", id);
  },
  openSkill(id) {
    return ipcRenderer.invoke("skills:open", id);
  },
  listSkillSources() {
    return ipcRenderer.invoke("skillSources:list");
  },
  addSkillSource(request) {
    return ipcRenderer.invoke("skillSources:add", request);
  },
  deleteSkillSource(id) {
    return ipcRenderer.invoke("skillSources:delete", id);
  },
  pickSkillFolders() {
    return ipcRenderer.invoke("dialog:pickSkillFolders");
  },
  listExecutableDiscovery(kind) {
    return ipcRenderer.invoke("dialog:listExecutableDiscovery", kind);
  },
  pickExecutable(kind) {
    return ipcRenderer.invoke("dialog:pickExecutable", kind);
  },
  listPromptTemplates() {
    return ipcRenderer.invoke("promptTemplates:list");
  },
  listPromptTemplateSources() {
    return ipcRenderer.invoke("promptTemplateSources:list");
  },
  addPromptTemplateSource(request) {
    return ipcRenderer.invoke("promptTemplateSources:add", request);
  },
  deletePromptTemplateSource(id) {
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
  installPlugin(request) {
    return ipcRenderer.invoke("plugins:install", request);
  },
  updatePlugin(request) {
    return ipcRenderer.invoke("plugins:update", request);
  },
  removePlugin(request) {
    return ipcRenderer.invoke("plugins:remove", request);
  },
  setPluginEnabled(request) {
    return ipcRenderer.invoke("plugins:setEnabled", request);
  },
  resolvePluginResources() {
    return ipcRenderer.invoke("plugins:resolveResources");
  },
  getAppSettings() {
    return ipcRenderer.invoke("appSettings:get");
  },
  updateAppSettings(request) {
    return ipcRenderer.invoke("appSettings:update", request);
  },
  onPermissionApproval(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("permissionApproval:prompt", listener);
    return () => ipcRenderer.removeListener("permissionApproval:prompt", listener);
  },
  onPermissionApprovalCancelled(callback) {
    const listener = (_event, payload) => callback(payload);
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
  onAppUpdateStateChanged(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("updater:changed", listener);
    return () => ipcRenderer.removeListener("updater:changed", listener);
  },
  resolveTerminalShell() {
    return ipcRenderer.invoke("terminal:shell:resolve");
  },
  startTerminal(request) {
    return ipcRenderer.invoke("terminal:start", request);
  },
  writeTerminal(request) {
    return ipcRenderer.invoke("terminal:input", request);
  },
  resizeTerminal(request) {
    return ipcRenderer.invoke("terminal:resize", request);
  },
  stopTerminal(request) {
    return ipcRenderer.invoke("terminal:stop", request);
  },
  onTerminalEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
  readClipboardText() {
    return ipcRenderer.invoke("clipboard:readText");
  },
  writeClipboardText(text) {
    return ipcRenderer.invoke("clipboard:writeText", text);
  },
  listThreadArtifacts(threadId) {
    return ipcRenderer.invoke("thread:artifacts:list", threadId);
  },
  getThreadArtifactDetail(threadId, changeId) {
    return ipcRenderer.invoke("thread:artifacts:detail", threadId, changeId);
  },
  listThreadContextTaxonomy(threadId) {
    return ipcRenderer.invoke("thread:contextTaxonomy:list", threadId);
  },
  getContextTaxonomy(captureId) {
    return ipcRenderer.invoke("thread:contextTaxonomy:get", captureId);
  },
  getContextTaxonomyRaw(request) {
    return ipcRenderer.invoke("thread:contextTaxonomy:raw", request);
  },
  getActivitySettings() {
    return ipcRenderer.invoke("activity:settings:get");
  },
  updateActivitySettings(request) {
    return ipcRenderer.invoke("activity:settings:update", request);
  },
  listActivityObservations(request) {
    return ipcRenderer.invoke("activity:observations:list", request);
  },
  createManualActivityObservation(request) {
    return ipcRenderer.invoke("activity:observations:createManual", request);
  },
  listProviders() {
    return ipcRenderer.invoke("providers:list");
  },
  updateProvider(request) {
    return ipcRenderer.invoke("providers:update", request);
  },
  testProvider(providerId) {
    return ipcRenderer.invoke("providers:test", providerId);
  },
  fetchProviderModels(providerId) {
    return ipcRenderer.invoke("providers:models", providerId);
  },
  updateProviderModel(request) {
    return ipcRenderer.invoke("providers:model:update", request);
  },
  searchFiles(request) {
    return ipcRenderer.invoke("dialog:searchFiles", request);
  },
  pickFileFromPath(filePath) {
    return ipcRenderer.invoke("dialog:pickFileFromPath", filePath);
  },
  pickFile() {
    return ipcRenderer.invoke("dialog:pickFile");
  },
  savePastedImage(request) {
    return ipcRenderer.invoke("dialog:savePastedImage", request);
  },
  pickClipboardImage() {
    return ipcRenderer.invoke("dialog:pickClipboardImage");
  },
  pickFolder(title) {
    return ipcRenderer.invoke("dialog:pickFolder", title);
  },
  describeLocalFiles(paths) {
    return ipcRenderer.invoke("files:describe", paths);
  },
  openLocalPath(filePath) {
    return ipcRenderer.invoke("files:openDefault", filePath);
  },
  revealLocalPath(filePath) {
    return ipcRenderer.invoke("files:reveal", filePath);
  },
  openExternalUrl(url) {
    return ipcRenderer.invoke("shell:openExternal", url);
  },
  windowAction(action) {
    return ipcRenderer.invoke("window:action", action);
  },
  getWindowState() {
    return ipcRenderer.invoke("window:state");
  },
  onWindowStateChanged(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("window:state-changed", listener);
    return () => ipcRenderer.removeListener("window:state-changed", listener);
  },
  spotlightSearch(request) {
    return ipcRenderer.invoke("spotlight:search", request);
  },
  spotlightExecute(request) {
    return ipcRenderer.invoke("spotlight:execute", request);
  },
  spotlightConsumePending() {
    return ipcRenderer.invoke("spotlight:consumePending");
  },
  spotlightClose() {
    return ipcRenderer.invoke("spotlight:close");
  },
  getSpotlightShortcutStatus() {
    return ipcRenderer.invoke("spotlight:getShortcutStatus");
  },
  onSpotlightReset(callback) {
    const listener = () => callback();
    ipcRenderer.on("spotlight:reset", listener);
    return () => ipcRenderer.removeListener("spotlight:reset", listener);
  },
  onSpotlightCommand(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("spotlight:command", listener);
    return () => ipcRenderer.removeListener("spotlight:command", listener);
  }
});

contextBridge.exposeInMainWorld("__JASMINE_HARNESS_ENABLED__", process.env.JASMINE_E2E_HARNESS === "1");
