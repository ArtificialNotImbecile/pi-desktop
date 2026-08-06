import { ipcMain } from "electron";
import type {
  SpotlightExecuteRequest,
  SpotlightItem,
  SpotlightSearchRequest,
  SpotlightSearchResponse
} from "../../shared/ipc.js";
import { spotlightExecuteSchema, spotlightSearchSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

const MAX_RECENT = 8;
const MAX_SEARCH = 12;

export type SpotlightWindowHelpers = {
  hideSpotlight(): void;
  routeCommand(payload: SpotlightExecuteRequest): void;
  consumePendingCommand(): SpotlightExecuteRequest | null;
};

export function registerSpotlightIpc(context: IpcContext, helpers: SpotlightWindowHelpers): void {
  ipcMain.handle("spotlight:search", (_event, request: SpotlightSearchRequest): SpotlightSearchResponse => {
    const { query } = spotlightSearchSchema.parse(request);
    const normalized = query.trim().toLowerCase();

    let threads;
    try {
      threads = context.getDatabase().listThreads();
    } catch {
      return { items: buildFixedCommands(normalized) };
    }

    const threadItems = (normalized
      ? threads.filter((thread) => thread.title.toLowerCase().includes(normalized))
      : [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_RECENT)
    )
      .slice(0, MAX_SEARCH)
      .map<SpotlightItem>((thread) => ({
        id: `thread:${thread.id}`,
        commandId: "open-thread",
        label: thread.title,
        description: `${thread.messageCount}`,
        group: normalized ? "chats" : "recent",
        keywords: [thread.title],
        threadId: thread.id,
        projectId: thread.projectId
      }));

    return { items: [...buildFixedCommands(normalized), ...threadItems] };
  });

  ipcMain.handle("spotlight:execute", (_event, request: SpotlightExecuteRequest): void => {
    const parsed = spotlightExecuteSchema.parse(request);
    helpers.routeCommand(parsed);
  });

  ipcMain.handle("spotlight:consumePending", (): SpotlightExecuteRequest | null => {
    return helpers.consumePendingCommand();
  });

  ipcMain.handle("spotlight:close", (): void => {
    helpers.hideSpotlight();
  });
}

function buildFixedCommands(query: string): SpotlightItem[] {
  const all: SpotlightItem[] = [
    {
      id: "cmd:new-chat",
      commandId: "new-chat",
      label: "New Chat",
      description: "Start a fresh chat",
      group: "commands",
      keywords: ["new", "chat", "\u65b0\u5bf9\u8bdd"]
    },
    {
      id: "cmd:todo",
      commandId: "open-todo",
      label: "TODO",
      description: "Open TODO",
      group: "commands",
      keywords: ["todo", "task", "tasks", "\u5f85\u529e", "\u4ee3\u529e", "\u8bb0\u5f55"]
    },
    {
      id: "cmd:add-todo",
      commandId: "add-todo",
      label: "Add TODO",
      description: "Capture a task or idea",
      group: "commands",
      keywords: ["add", "todo", "task", "capture", "\u6dfb\u52a0", "\u5f85\u529e", "\u8bb0\u5f55"]
    },
    {
      id: "cmd:settings",
      commandId: "open-settings",
      label: "Settings",
      description: "Open settings",
      group: "commands",
      keywords: ["settings", "\u8bbe\u7f6e"],
      section: "general"
    },
    {
      id: "cmd:providers",
      commandId: "open-settings",
      label: "Provider Settings",
      description: "Configure providers and models",
      group: "commands",
      keywords: ["provider", "model", "\u6a21\u578b", "\u670d\u52a1"],
      section: "providers"
    }
  ];
  if (!query) return all;
  return all.filter(
    (command) =>
      command.label.toLowerCase().includes(query) ||
      command.keywords?.some((keyword) => keyword.toLowerCase().includes(query))
  );
}
