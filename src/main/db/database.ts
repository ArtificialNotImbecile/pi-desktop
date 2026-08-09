import { app } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  AiProvider,
  ActivityObservation,
  ActivitySettings,
  AppSettings,
  AppSettingsUpdateRequest,
  ChatMessage,
  ChatRole,
  ChatTimelineItem,
  ChatThread,
  MemoryRecord,
  MemoryReference,
  PickedPath,
  PluginReference,
  PromptTemplateSource,
  PromptTemplateSourceCreateRequest,
  ProviderModelConfig,
  ProviderModelUpdateRequest,
  ProviderStatus,
  ProviderUpdateRequest,
  SkillRecord,
  SkillSource,
  SkillReference,
  McpMarketplaceServer,
  McpServerCreateRequest,
  McpServerRecord,
  McpServerUpdateRequest,
  RemoteConnectionCreateRequest,
  RemoteConnectionImportResult,
  RemoteConnectionRecord,
  RemoteConnectionTestResult,
  RemoteConnectionUpdateRequest,
  WebSearchResult,
  WebSearchSettings,
  WebSearchSettingsUpdateRequest,
  ThreadActivePluginsUpdateRequest,
  ToolRun,
  ToolRunStatus,
  WorkspaceProject
} from "../../shared/ipc.js";
import { migrateDatabase } from "./migrations.js";
import { ensureDefaultActivitySettings, seedDefaultProviders, seedDefaultSkills } from "./seeds.js";
import {
  createManualActivityObservation as createManualActivityObservationRow,
  getActivitySettings as getActivitySettingsRow,
  listActivityObservations as listActivityObservationRows,
  updateActivitySettings as updateActivitySettingsRow
} from "./repositories/activity.js";
import {
  ensureAppSettings as ensureAppSettingsRow,
  getAppSettings as getAppSettingsRow,
  updateAppSettings as updateAppSettingsRow
} from "./repositories/appSettings.js";
import {
  archiveMemory as archiveMemoryRow,
  createMemory as createMemoryRow,
  deleteMemory as deleteMemoryRow,
  getMemory as getMemoryRow,
  listMemories as listMemoryRows,
  updateMemory as updateMemoryRow
} from "./repositories/memories.js";
import {
  addMessage as addMessageRow,
  deleteMessagesByIds as deleteMessageRowsByIds,
  getMessageSessionEntryId as getMessageSessionEntryIdRow,
  linkMessageSessionEntry as linkMessageSessionEntryRow,
  listMessages as listMessageRows,
  updateMessage as updateMessageRow
} from "./repositories/messages.js";
import {
  adjustThreadMessageCount as adjustThreadMessageCountRow,
  createThread as createThreadRow,
  deleteThread as deleteThreadRow,
  deleteThreadsByIds as deleteThreadRowsByIds,
  getThread as getThreadRow,
  getThreadDraft as getThreadDraftRow,
  getThreadMessageCount as getThreadMessageCountRow,
  getThreadSessionBinding as getThreadSessionBindingRow,
  hasThread as hasThreadRow,
  listThreads as listThreadRows,
  touchThread as touchThreadRow,
  updateThreadActivePluginIds as updateThreadActivePluginIdsRow,
  updateThreadDraft as updateThreadDraftRow,
  updateThreadSessionBinding as updateThreadSessionBindingRow,
  updateThreadTitle as updateThreadTitleRow
} from "./repositories/threads.js";
import type { ThreadSessionBinding } from "./repositories/threads.js";
import {
  getProject as getProjectRow,
  listProjects as listProjectRows,
  normalizeProjectRoot,
  openOrCreateProject as openOrCreateProjectRow,
  removeProject as removeProjectRow,
  renameProject as renameProjectRow
} from "./repositories/projects.js";
import {
  getProvider as getProviderRow,
  listProviders as listProviderRows,
  updateProvider as updateProviderRow,
  updateProviderCheck as updateProviderCheckRow,
  updateProviderModel as updateProviderModelRow,
  updateProviderModels as updateProviderModelsRow
} from "./repositories/providers.js";
import {
  addSkillSource as addSkillSourceRow,
  deleteSkill as deleteSkillRow,
  deleteSkillSource as deleteSkillSourceRow,
  listExternalSkillStates as listExternalSkillStateRows,
  listSkillSources as listSkillSourceRows,
  listSkills as listSkillRows,
  updateExternalSkillState as updateExternalSkillStateRow,
} from "./repositories/skills.js";
import {
  addPromptTemplateSource as addPromptTemplateSourceRow,
  deletePromptTemplateSource as deletePromptTemplateSourceRow,
  listPromptTemplateSources as listPromptTemplateSourceRows
} from "./repositories/promptTemplates.js";
import {
  createMcpServer as createMcpServerRow,
  deleteMcpServer as deleteMcpServerRow,
  getMcpServer as getMcpServerRow,
  listMcpServers as listMcpServerRows,
  updateMcpServer as updateMcpServerRow
} from "./repositories/mcpServers.js";
import {
  deleteRemoteConnection as deleteRemoteConnectionRow,
  getActiveRemoteConnection as getActiveRemoteConnectionRow,
  getRemoteConnection as getRemoteConnectionRow,
  listRemoteConnections as listRemoteConnectionRows,
  upsertRemoteConnection as upsertRemoteConnectionRow,
  updateRemoteConnection as updateRemoteConnectionRow,
  updateRemoteConnectionStatus as updateRemoteConnectionStatusRow
} from "./repositories/remoteConnections.js";
import {
  createToolRun as createToolRunRow,
  finishToolRun as finishToolRunRow,
  getToolRun as getToolRunRow,
  listToolRunsForMessage as listToolRunsForMessageRows,
  listToolRunsForThread as listToolRunsForThreadRows
} from "./repositories/toolRuns.js";
import {
  ensureWebSearchSettings as ensureWebSearchSettingsRow,
  getWebSearchSettings as getWebSearchSettingsRow,
  updateWebSearchRun as updateWebSearchRunRow,
  updateWebSearchSettings as updateWebSearchSettingsRow
} from "./repositories/webSearch.js";
import type { SqlDatabase } from "./repositories/types.js";
import { loadExternalSkills } from "../services/externalSkills.js";
import {
  createLocalSkill,
  deleteLocalSkill,
  ensureLocalSkillFiles,
  loadLocalSkills,
  openSkillInEditor,
  skillScanSignature,
  skillSpecName
} from "../services/skillFiles.js";
import { discoverRemoteConnectionsFromSshConfig, testRemoteConnection as testSshRemoteConnection } from "../services/remoteConnections.js";

type DatabaseSyncInstance = SqlDatabase;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (filename: string) => DatabaseSyncInstance;
};

const now = () => new Date().toISOString();

export class JasmineDatabase {
  private readonly db: DatabaseSyncInstance;
  private transactionDepth = 0;
  // Parsed skill files keyed by an mtime signature so repeated sends do not
  // re-read and re-parse every SKILL.md (plan Phase 5.2). Enabled states live
  // in the database and are re-applied on every read.
  private skillScanCache: { signature: string; localSkills: SkillRecord[]; externalSkills: SkillRecord[] } | null = null;

  constructor() {
    const dataDir = path.join(app.getPath("userData"), "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    this.db = new DatabaseSync(path.join(dataDir, "jasmine.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    migrateDatabase(this.db, now);
    this.seed();
  }

  // Runs multi-statement writes atomically. Nest-safe: only the outermost call
  // opens/commits the transaction, so helpers that are themselves transactional
  // can be composed inside a larger unit of work.
  runInTransaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE;");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // The transaction may already be gone (e.g. automatic rollback); the
        // original error below is the one that matters.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  listThreads(projectId?: string | null): ChatThread[] {
    return listThreadRows(this.db, { projectId });
  }

  createThread(title = "New chat", projectId: string | null = null): ChatThread {
    if (projectId && !this.getProject(projectId)) throw new Error("Project does not exist.");
    return createThreadRow(this.db, title, now(), projectId);
  }

  getThread(threadId: string): ChatThread | null {
    return getThreadRow(this.db, threadId);
  }

  getThreadSessionBinding(threadId: string): ThreadSessionBinding | null {
    return getThreadSessionBindingRow(this.db, threadId);
  }

  updateThreadSessionBinding(threadId: string, binding: ThreadSessionBinding): void {
    if (!this.hasThread(threadId)) throw new Error("Thread does not exist.");
    updateThreadSessionBindingRow(this.db, threadId, binding);
  }

  listProjects(): WorkspaceProject[] {
    return listProjectRows(this.db);
  }

  getProject(projectId: string): WorkspaceProject | null {
    return getProjectRow(this.db, projectId);
  }

  createProjectFromPath(rootPath: string): WorkspaceProject {
    const normalized = normalizeProjectRoot(rootPath);
    if (!isDirectory(normalized.rootPath)) {
      throw new Error("Project path must be an existing folder.");
    }
    return openOrCreateProjectRow(this.db, { rootPath: normalized.rootPath }, now());
  }

  renameProject(projectId: string, name: string): WorkspaceProject {
    return renameProjectRow(this.db, projectId, name, now());
  }

  removeProject(projectId: string): void {
    if (!this.getProject(projectId)) throw new Error("Project does not exist.");
    removeProjectRow(this.db, projectId);
  }

  getThreadCwd(threadId: string): string {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error("Thread does not exist.");
    return thread.projectId ? this.getProjectCwd(thread.projectId) : this.getNeutralScratchCwd();
  }

  getProjectCwd(projectId: string): string {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project does not exist.");
    if (!isDirectory(project.rootPath)) throw new Error("Project folder is unavailable.");
    return project.rootPath;
  }

  getNeutralScratchCwd(): string {
    const scratchCwd = path.join(app.getPath("userData"), "scratch", "chats");
    mkdirSync(scratchCwd, { recursive: true });
    return scratchCwd;
  }

  updateThreadTitle(threadId: string, title: string): ChatThread {
    return updateThreadTitleRow(this.db, threadId, title, now());
  }

  touchThread(threadId: string): void {
    touchThreadRow(this.db, threadId, now());
  }

  deleteThread(threadId: string): void {
    deleteThreadRow(this.db, threadId);
  }

  deleteThreads(threadIds: string[]): void {
    deleteThreadRowsByIds(this.db, threadIds);
  }

  getThreadDraft(threadId: string): string {
    if (!this.hasThread(threadId)) throw new Error("Thread does not exist.");
    return getThreadDraftRow(this.db, threadId);
  }

  updateThreadDraft(input: { threadId: string; content: string }): void {
    if (!this.hasThread(input.threadId)) throw new Error("Thread does not exist.");
    const content = input.content.slice(0, 20_000);
    updateThreadDraftRow(this.db, input.threadId, content, now());
  }

  updateThreadActivePlugins(input: ThreadActivePluginsUpdateRequest): ChatThread {
    if (!this.hasThread(input.threadId)) throw new Error("Thread does not exist.");
    return updateThreadActivePluginIdsRow(this.db, input.threadId, input.pluginIds, now());
  }

  listMessages(threadId: string): ChatMessage[] {
    return listMessageRows(this.db, threadId);
  }

  listMessagesPage(input: {
    threadId: string;
    limit?: number;
    before?: {
      id: string;
      createdAt: string;
    };
  }): ChatMessage[] {
    return listMessageRows(this.db, input.threadId, {
      limit: input.limit,
      before: input.before
    });
  }

  deleteMessagesByIds(threadId: string, messageIds: string[]): void {
    this.runInTransaction(() => {
      const deleted = deleteMessageRowsByIds(this.db, threadId, messageIds);
      if (deleted > 0) adjustThreadMessageCountRow(this.db, threadId, -deleted);
      this.touchThread(threadId);
    });
  }

  updateMessage(input: {
    threadId: string;
    messageId: string;
    content: string;
    attachments?: PickedPath[];
    skillsUsed?: SkillReference[];
    pluginsUsed?: PluginReference[];
  }): ChatMessage {
    const message = updateMessageRow(this.db, input);
    this.touchThread(input.threadId);
    return message;
  }

  getMessageSessionEntryId(threadId: string, messageId: string): string | null {
    return getMessageSessionEntryIdRow(this.db, threadId, messageId);
  }

  linkMessageSessionEntry(threadId: string, messageId: string, sessionEntryId: string): void {
    linkMessageSessionEntryRow(this.db, threadId, messageId, sessionEntryId);
  }

  addMessage(input: {
    threadId: string;
    runId?: string;
    role: ChatRole;
    content: string;
    attachments?: PickedPath[];
    elapsedMs?: number;
    modelId?: string;
    status?: "sent" | "error";
    memoryUsed?: MemoryReference[];
    skillsUsed?: SkillReference[];
    pluginsUsed?: PluginReference[];
    webSearchUsed?: WebSearchResult[];
    timeline?: ChatTimelineItem[];
    sessionEntryId?: string;
  }): ChatMessage {
    return this.runInTransaction(() => {
      const message = addMessageRow(this.db, input, now());
      adjustThreadMessageCountRow(this.db, input.threadId, 1);
      this.touchThread(input.threadId);
      return message;
    });
  }

  getThreadMessageCount(threadId: string): number {
    return getThreadMessageCountRow(this.db, threadId);
  }

  hasThread(threadId: string): boolean {
    return hasThreadRow(this.db, threadId);
  }

  createToolRun(input: {
    threadId: string;
    title: string;
    providerId?: string;
    modelId?: string;
    inputSummary?: string;
  }): ToolRun {
    return createToolRunRow(this.db, input, now());
  }

  getWebSearchSettings(): WebSearchSettings {
    this.ensureWebSearchSettings();
    const settings = getWebSearchSettingsRow(this.db);
    if (!settings) throw new Error("Web search settings do not exist.");
    return settings;
  }

  updateWebSearchSettings(input: WebSearchSettingsUpdateRequest): WebSearchSettings {
    const current = this.getWebSearchSettings();
    updateWebSearchSettingsRow(this.db, current, input, now());
    return this.getWebSearchSettings();
  }

  updateWebSearchRun(input: { lastError?: string | null }): WebSearchSettings {
    this.ensureWebSearchSettings();
    updateWebSearchRunRow(this.db, input, now());
    return this.getWebSearchSettings();
  }

  getAppSettings(): AppSettings {
    this.ensureAppSettings();
    const settings = getAppSettingsRow(this.db);
    if (!settings) throw new Error("App settings do not exist.");
    return settings;
  }

  updateAppSettings(input: AppSettingsUpdateRequest): AppSettings {
    const current = this.getAppSettings();
    const nextToolModel = {
      providerId: input.toolModel?.providerId?.trim() || current.toolModel.providerId,
      modelId: input.toolModel?.modelId?.trim() || current.toolModel.modelId
    };
    const provider = this.getProvider(nextToolModel.providerId);
    if (!provider) throw new Error("Tool model provider does not exist.");
    if (!provider.models.some((model) => model.id === nextToolModel.modelId)) {
      throw new Error("Tool model does not exist for the selected provider.");
    }
    updateAppSettingsRow(this.db, current, input, now());
    return this.getAppSettings();
  }

  finishToolRun(input: {
    id: string;
    status: Exclude<ToolRunStatus, "running">;
    messageId?: string;
    outputSummary?: string;
    error?: string;
    elapsedMs?: number;
  }): void {
    finishToolRunRow(this.db, input, now());
  }

  listToolRunsForThread(threadId: string): ToolRun[] {
    return listToolRunsForThreadRows(this.db, threadId);
  }

  listToolRunsForMessage(messageId: string): ToolRun[] {
    return listToolRunsForMessageRows(this.db, messageId);
  }

  getToolRun(runId: string): ToolRun | null {
    return getToolRunRow(this.db, runId);
  }

  listMemories(input: { includeArchived?: boolean } = {}): MemoryRecord[] {
    return listMemoryRows(this.db, input);
  }

  getMemory(memoryId: string): MemoryRecord | null {
    return getMemoryRow(this.db, memoryId);
  }

  createMemory(input: { content: string; sourceMessageId?: string; sourceThreadId?: string }): MemoryRecord {
    return createMemoryRow(this.db, input, now());
  }

  updateMemory(input: { id: string; content: string }): MemoryRecord {
    updateMemoryRow(this.db, input, now());
    const memory = this.getMemory(input.id);
    if (!memory) throw new Error("Memory does not exist.");
    return memory;
  }

  archiveMemory(input: { id: string; archived: boolean }): MemoryRecord {
    archiveMemoryRow(this.db, input, now());
    const memory = this.getMemory(input.id);
    if (!memory) throw new Error("Memory does not exist.");
    return memory;
  }

  deleteMemory(memoryId: string): void {
    deleteMemoryRow(this.db, memoryId, now());
  }

  findRelevantMemories(text: string, limit = 3): MemoryReference[] {
    const tokens = tokenize(text);
    if (tokens.length === 0) return [];
    return this.listMemories()
      .map((memory) => ({
        memory,
        score: scoreMemory(memory.content, tokens)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, limit)
      .map((item) => ({ id: item.memory.id, content: item.memory.content }));
  }

  async listSkills(): Promise<SkillRecord[]> {
    const legacySkills = listSkillRows(this.db);
    await ensureLocalSkillFiles(app.getPath("userData"), legacySkills);
    const migratedLocalSkills = await loadLocalSkills(app.getPath("userData"), listExternalSkillStateRows(this.db));
    for (const legacySkill of legacySkills) {
      if (legacySkill.enabled) continue;
      const migratedSkill = migratedLocalSkills.find((skill) => skill.name === skillSpecName(legacySkill.name || legacySkill.id));
      if (migratedSkill) updateExternalSkillStateRow(this.db, migratedSkill.id, false, now());
    }
    for (const skill of legacySkills) {
      deleteSkillRow(this.db, skill.id);
    }
    return loadLocalSkills(app.getPath("userData"), listExternalSkillStateRows(this.db));
  }

  async listAllSkills(): Promise<SkillRecord[]> {
    const sources = this.listSkillSources();
    const externalStates = listExternalSkillStateRows(this.db);
    const signature = await skillScanSignature(app.getPath("userData"), sources.map((source) => source.path));
    if (this.skillScanCache?.signature === signature) {
      return [...this.skillScanCache.localSkills, ...this.skillScanCache.externalSkills]
        .map((skill) => ({ ...skill, enabled: externalStates.get(skill.id) ?? true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const localSkills = await this.listSkills();
    const rawExternalSkills = await loadExternalSkills(sources);
    const externalSkills = rawExternalSkills.map((skill) => ({
      ...skill,
      enabled: externalStates.get(skill.id) ?? skill.enabled
    }));
    this.skillScanCache = {
      // listSkills may have written default/migrated skill files, so re-sign
      // after the scan to avoid caching against a stale signature.
      signature: await skillScanSignature(app.getPath("userData"), sources.map((source) => source.path)),
      localSkills: localSkills.map((skill) => ({ ...skill, enabled: true })),
      externalSkills: rawExternalSkills
    };
    return [...localSkills, ...externalSkills].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createSkill(input: { name?: string; description?: string; instructions?: string; enabled?: boolean }): Promise<SkillRecord> {
    const skill = await createLocalSkill(app.getPath("userData"), input);
    this.skillScanCache = null;
    if (input.enabled === false) updateExternalSkillStateRow(this.db, skill.id, false, now());
    return { ...skill, enabled: input.enabled ?? true };
  }

  async updateSkill(input: { id: string; name?: string; description?: string; instructions?: string; enabled?: boolean }): Promise<SkillRecord> {
    const existing = (await this.listAllSkills()).find((skill) => skill.id === input.id);
    if (!existing) throw new Error("Skill does not exist.");
    if (existing.source !== "local" || input.name !== undefined || input.description !== undefined || input.instructions !== undefined) {
      return this.updateExternalSkill(input);
    }

    if (input.enabled !== undefined) updateExternalSkillStateRow(this.db, input.id, input.enabled, now());
    const skill = (await this.listAllSkills()).find((item) => item.id === input.id);
    if (!skill) throw new Error("Skill does not exist.");
    return skill;
  }

  private async updateExternalSkill(input: { id: string; name?: string; description?: string; instructions?: string; enabled?: boolean }): Promise<SkillRecord> {
    if (input.name !== undefined || input.description !== undefined || input.instructions !== undefined) {
      throw new Error("External skills are read-only except for enabled state.");
    }
    if (input.enabled === undefined) throw new Error("Skill does not exist.");
    updateExternalSkillStateRow(this.db, input.id, input.enabled, now());
    const skill = (await this.listAllSkills()).find((item) => item.id === input.id);
    if (!skill) throw new Error("Skill does not exist.");
    return skill;
  }

  async deleteSkill(skillId: string): Promise<void> {
    const existing = (await this.listAllSkills()).find((skill) => skill.id === skillId);
    if (!existing || existing.source !== "local") throw new Error("Only local skills can be deleted.");
    await deleteLocalSkill(app.getPath("userData"), existing);
    this.skillScanCache = null;
    deleteSkillRow(this.db, skillId);
  }

  async openSkill(skillId: string) {
    const skill = (await this.listAllSkills()).find((item) => item.id === skillId);
    if (!skill) throw new Error("Skill does not exist.");
    return openSkillInEditor({
      skill,
      currentEditorPath: this.getAppSettings().skillEditorPath,
      saveEditorPath: (editorPath) => {
        this.updateAppSettings({ skillEditorPath: editorPath });
      }
    });
  }

  listSkillSources(): SkillSource[] {
    return listSkillSourceRows(this.db);
  }

  addSkillSource(input: { path: string }): SkillSource {
    this.skillScanCache = null;
    return addSkillSourceRow(this.db, input, now());
  }

  deleteSkillSource(sourceId: string): void {
    this.skillScanCache = null;
    deleteSkillSourceRow(this.db, sourceId);
  }

  listPromptTemplateSources(): PromptTemplateSource[] {
    return listPromptTemplateSourceRows(this.db);
  }

  addPromptTemplateSource(input: PromptTemplateSourceCreateRequest): PromptTemplateSource {
    return addPromptTemplateSourceRow(this.db, input, now());
  }

  deletePromptTemplateSource(sourceId: string): void {
    deletePromptTemplateSourceRow(this.db, sourceId);
  }

  listMcpServers(): McpServerRecord[] {
    return listMcpServerRows(this.db);
  }

  createMcpServer(input: McpServerCreateRequest): McpServerRecord {
    return createMcpServerRow(this.db, input, now());
  }

  installMcpServer(input: McpMarketplaceServer): McpServerRecord {
    return createMcpServerRow(this.db, {
      name: input.name,
      description: input.description,
      command: input.command,
      args: input.args,
      envJson: input.envJson,
      enabled: true,
      transport: input.transport,
      source: "marketplace",
      marketplaceId: input.id,
      packageName: input.packageName,
      homepage: input.homepage,
      category: input.category
    }, now());
  }

  updateMcpServer(input: McpServerUpdateRequest): McpServerRecord {
    const existing = getMcpServerRow(this.db, input.id);
    if (!existing) throw new Error("MCP server does not exist.");
    updateMcpServerRow(this.db, existing, input, now());
    const updated = getMcpServerRow(this.db, input.id);
    if (!updated) throw new Error("MCP server does not exist.");
    return updated;
  }

  deleteMcpServer(id: string): void {
    deleteMcpServerRow(this.db, id);
  }

  listRemoteConnections(): RemoteConnectionRecord[] {
    return listRemoteConnectionRows(this.db);
  }

  getActiveRemoteConnection(): RemoteConnectionRecord | null {
    return getActiveRemoteConnectionRow(this.db);
  }

  async importRemoteConnections(): Promise<RemoteConnectionImportResult> {
    const discovered = await discoverRemoteConnectionsFromSshConfig();
    const imported = discovered.candidates.map((candidate) => upsertRemoteConnectionRow(this.db, candidate, now()));
    return { imported, scannedPaths: discovered.scannedPaths };
  }

  createRemoteConnection(input: RemoteConnectionCreateRequest): RemoteConnectionRecord {
    return upsertRemoteConnectionRow(this.db, { ...input, source: input.source ?? "manual" }, now());
  }

  updateRemoteConnection(input: RemoteConnectionUpdateRequest): RemoteConnectionRecord {
    const existing = getRemoteConnectionRow(this.db, input.id);
    if (!existing) throw new Error("Remote connection does not exist.");
    updateRemoteConnectionRow(this.db, existing, input, now());
    const updated = getRemoteConnectionRow(this.db, input.id);
    if (!updated) throw new Error("Remote connection does not exist.");
    return updated;
  }

  deleteRemoteConnection(id: string): void {
    deleteRemoteConnectionRow(this.db, id);
  }

  async testRemoteConnection(id: string): Promise<RemoteConnectionTestResult> {
    const existing = getRemoteConnectionRow(this.db, id);
    if (!existing) throw new Error("Remote connection does not exist.");
    try {
      const result = await testSshRemoteConnection(existing);
      updateRemoteConnectionStatusRow(this.db, id, {
        status: "connected",
        lastConnectedAt: now(),
        lastError: null,
        remotePath: result.remotePath
      }, now());
      const connection = getRemoteConnectionRow(this.db, id);
      if (!connection) throw new Error("Remote connection does not exist.");
      return { connection, ok: true, remotePath: result.remotePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateRemoteConnectionStatusRow(this.db, id, {
        status: "failed",
        lastError: message
      }, now());
      const connection = getRemoteConnectionRow(this.db, id);
      if (!connection) throw new Error("Remote connection does not exist.");
      return { connection, ok: false, error: message };
    }
  }

  async getSkillsForPrompt(skillIds: string[] = []): Promise<SkillRecord[]> {
    const uniqueIds = Array.from(new Set(skillIds)).slice(0, 12);
    if (uniqueIds.length === 0) return [];
    const allSkills = await this.listAllSkills();
    const skills = uniqueIds
      .map((id) => allSkills.find((skill) => skill.id === id))
      .filter((skill): skill is SkillRecord => Boolean(skill));
    return skills.filter((skill) => skill.enabled);
  }

  getActivitySettings(): ActivitySettings {
    this.ensureActivitySettings();
    const settings = getActivitySettingsRow(this.db);
    if (!settings) throw new Error("Activity settings do not exist.");
    return settings;
  }

  updateActivitySettings(input: Partial<Omit<ActivitySettings, "updatedAt">>): ActivitySettings {
    const current = this.getActivitySettings();
    const next = {
      enabled: input.enabled ?? current.enabled,
      paused: input.paused ?? current.paused,
      localOnly: input.localOnly ?? current.localOnly,
      captureWindowTitles: input.captureWindowTitles ?? current.captureWindowTitles,
      captureScreenshots: input.captureScreenshots ?? current.captureScreenshots,
      retentionDays: input.retentionDays ?? current.retentionDays
    };

    if (!next.enabled) next.paused = false;
    if (next.retentionDays < 1 || next.retentionDays > 3650) throw new Error("Retention must be between 1 and 3650 days.");

    updateActivitySettingsRow(this.db, next, now());

    return this.getActivitySettings();
  }

  listActivityObservations(input: { query?: string } = {}): ActivityObservation[] {
    return listActivityObservationRows(this.db, input);
  }

  createManualActivityObservation(input: { note: string }): ActivityObservation {
    return createManualActivityObservationRow(this.db, input, now());
  }

  listProviders(): AiProvider[] {
    return listProviderRows(this.db);
  }

  getProvider(providerId: string): AiProvider | null {
    return getProviderRow(this.db, providerId);
  }

  getDefaultProvider(): AiProvider {
    const provider = this.getProvider("deepseek") ?? this.listProviders()[0];
    if (!provider) throw new Error("No provider is configured.");
    return provider;
  }

  getRuntimeProvider(providerId?: string): AiProvider {
    if (providerId) {
      const provider = this.getProvider(providerId);
      if (!provider) throw new Error("Provider does not exist.");
      return provider;
    }

    const providers = this.listProviders();
    const provider = providers.find((item) => item.enabled) ?? providers[0];
    if (!provider) throw new Error("No provider is configured.");
    return provider;
  }

  updateProvider(input: ProviderUpdateRequest): AiProvider {
    const existing = this.getProvider(input.id);
    if (!existing) throw new Error("Provider does not exist.");

    updateProviderRow(this.db, existing, input, now());
    return this.getProvider(input.id) ?? existing;
  }

  updateProviderCheck(providerId: string, input: { status: ProviderStatus; lastError?: string | null }): AiProvider {
    updateProviderCheckRow(this.db, providerId, input, now());
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error("Provider does not exist.");
    return provider;
  }

  updateProviderModels(providerId: string, modelIds: string[], defaultModel?: string, metadata?: ProviderModelConfig[]): AiProvider {
    const existing = this.getProvider(providerId);
    if (!existing) throw new Error("Provider does not exist.");

    updateProviderModelsRow(this.db, existing, modelIds, defaultModel, metadata, now());
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error("Provider does not exist.");
    return provider;
  }

  updateProviderModel(input: ProviderModelUpdateRequest): AiProvider {
    const existing = this.getProvider(input.providerId);
    if (!existing) throw new Error("Provider does not exist.");

    updateProviderModelRow(this.db, existing, input, now());
    const provider = this.getProvider(input.providerId);
    if (!provider) throw new Error("Provider does not exist.");
    return provider;
  }

  private seed(): void {
    this.ensureActivitySettings();
    this.ensureWebSearchSettings();
    this.ensureAppSettings();
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_threads").get() as { count?: number };
    if (Number(row?.count ?? 0) > 0) {
      this.seedDefaults();
      return;
    }

    const thread = this.createThread("Greeting");
    this.addMessage({
      threadId: thread.id,
      role: "user",
      content: "Hello"
    });
    this.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: "Hi, I am here. Send an idea, a question, a paste, or a file path and I will help from there.",
      elapsedMs: 849,
      modelId: "deepseek-v4-flash"
    });

    this.seedDefaults();
  }

  private ensureActivitySettings(): void {
    ensureDefaultActivitySettings(this.db, now());
  }

  private seedDefaults(): void {
    const timestamp = now();
    seedDefaultProviders(this.db, timestamp);
    seedDefaultSkills(this.db, timestamp);
  }

  private ensureWebSearchSettings(): void {
    ensureWebSearchSettingsRow(this.db, now());
  }

  private ensureAppSettings(): void {
    ensureAppSettingsRow(this.db, now());
  }
}

function tokenize(value: string): string[] {
  const words = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return Array.from(new Set(words));
}

function scoreMemory(content: string, queryTokens: string[]): number {
  const memoryTokens = new Set(tokenize(content));
  return queryTokens.reduce((score, token) => {
    if (memoryTokens.has(token)) return score + 2;
    if (content.toLowerCase().includes(token)) return score + 1;
    return score;
  }, 0);
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
