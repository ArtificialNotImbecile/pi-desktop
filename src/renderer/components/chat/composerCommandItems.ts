import type { FileSearchResult, PluginPackageRecord, PromptTemplateRecord, RemoteConnectionRecord, SkillRecord } from "../../../shared/ipc";

export type MentionItem =
  | {
      id: string;
      type: "remote";
      label: string;
      description: string;
      active: boolean;
      connectionId: string | null;
    }
  | {
      id: string;
      type: "file";
      label: string;
      description: string;
      path: string;
    }
  | {
      id: string;
      type: "plugin";
      label: string;
      description: string;
      pluginId: string;
      selected: boolean;
    }
  | {
      id: string;
      type: "status";
      label: string;
      description: string;
    };

export type SkillCommandItem =
  | {
      id: string;
      type: "skill";
      label: string;
      description: string;
      selected: boolean;
    }
  | {
      id: string;
      type: "status";
      label: string;
      description: string;
    };

export type PromptCommandItem =
  | {
      id: string;
      type: "template";
      name: string;
      label: string;
      description: string;
      argumentHint?: string;
    }
  | {
      id: string;
      type: "status";
      label: string;
      description: string;
    };

export function buildMentionItems(
  remotes: RemoteConnectionRecord[],
  activeRemote: RemoteConnectionRecord | null,
  plugins: PluginPackageRecord[],
  selectedPluginIds: string[],
  files: FileSearchResult[],
  query: string,
  loading: boolean,
  copy: {
    localMachine: string;
    localMachineActive: string;
    localMachineDescription: string;
    plugins: string;
    pluginEnabled: string;
    pluginTemporary: string;
    searchingFiles: string;
    noFiles: string;
    typeToSearch: string;
    fileHint: string;
  }
): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const remoteItems: MentionItem[] = [
    {
      id: "remote:local",
      type: "remote",
      label: copy.localMachine,
      description: activeRemote ? copy.localMachineDescription : copy.localMachineActive,
      active: !activeRemote,
      connectionId: null
    },
    ...remotes
      .filter((remote) => !normalizedQuery || remote.name.toLowerCase().includes(normalizedQuery) || remoteTarget(remote).toLowerCase().includes(normalizedQuery))
      .map((remote) => ({
        id: `remote:${remote.id}`,
        type: "remote" as const,
        label: remote.name,
        description: remoteTarget(remote),
        active: remote.active,
        connectionId: remote.id
      }))
  ];
  const pluginItems: MentionItem[] = plugins
    .filter((plugin) => !normalizedQuery || plugin.displayName.toLowerCase().includes(normalizedQuery) || plugin.source.toLowerCase().includes(normalizedQuery))
    .map((plugin) => ({
      id: `plugin:${plugin.id}`,
      type: "plugin" as const,
      label: `@${plugin.displayName}`,
      description: plugin.enabled ? copy.pluginEnabled : copy.pluginTemporary,
      pluginId: plugin.id,
      selected: selectedPluginIds.includes(plugin.id)
    }));
  const fileItems: MentionItem[] = normalizedQuery
    ? loading
      ? [{ id: "file:loading", type: "status", label: copy.searchingFiles, description: normalizedQuery }]
      : files.length > 0
        ? files.map((file) => ({
            id: `file:${file.path}`,
            type: "file" as const,
            label: file.name,
            description: file.relativePath,
            path: file.path
          }))
        : [{ id: "file:empty", type: "status", label: copy.noFiles, description: normalizedQuery }]
    : [{ id: "file:hint", type: "status", label: copy.typeToSearch, description: copy.fileHint }];
  return [...remoteItems, ...pluginItems, ...fileItems];
}

export function buildSkillCommandItems(
  skills: SkillRecord[],
  selectedSkillIds: string[],
  query: string,
  loading: boolean,
  copy: { loading: string; empty: string; noMatch: string }
): SkillCommandItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (loading) return [{ id: "skill:loading", type: "status", label: copy.loading, description: "" }];
  const enabledSkills = skills.filter((skill) => skill.enabled);
  if (enabledSkills.length === 0) return [{ id: "skill:empty", type: "status", label: copy.empty, description: "" }];
  const filtered = enabledSkills
    .filter((skill) => !normalizedQuery || skill.name.toLowerCase().includes(normalizedQuery) || skill.description.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (filtered.length === 0) return [{ id: "skill:no-match", type: "status", label: copy.noMatch, description: query }];
  return filtered.map((skill) => ({
    id: skill.id,
    type: "skill",
    label: `$${skill.name}`,
    description: skill.description,
    selected: selectedSkillIds.includes(skill.id)
  }));
}

export function buildPromptCommandItems(
  templates: PromptTemplateRecord[],
  query: string,
  loading: boolean,
  copy: { loading: string; empty: string; noMatch: string }
): PromptCommandItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (loading) return [{ id: "prompt:loading", type: "status", label: copy.loading, description: "" }];
  if (templates.length === 0) return [{ id: "prompt:empty", type: "status", label: copy.empty, description: "" }];
  const filtered = templates
    .filter((template) => !normalizedQuery || template.name.toLowerCase().includes(normalizedQuery) || template.description.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (filtered.length === 0) return [{ id: "prompt:no-match", type: "status", label: copy.noMatch, description: query }];
  return filtered.map((template) => ({
    id: `prompt:${template.filePath}`,
    type: "template",
    name: template.name,
    label: `/${template.name}`,
    description: template.description || template.filePath,
    argumentHint: template.argumentHint
  }));
}

export function remoteTarget(connection: RemoteConnectionRecord): string {
  if (connection.configHost) return connection.configHost;
  return `${connection.user ? `${connection.user}@` : ""}${connection.host}${connection.remotePath ? `:${connection.remotePath}` : ""}`;
}
