export const settingsSections = [
  "general",
  "providers",
  "appearance",
  "memory",
  "skills",
  "plugins",
  "chrome",
  "prompts",
  "remote",
  "mcp",
  "activity",
  "webSearch",
  "about"
] as const;

export type SettingsSection = (typeof settingsSections)[number];

export const rightPanelModes = ["terminal", "artifacts", "context"] as const;

export type RightPanelMode = (typeof rightPanelModes)[number];

export type RightPanelTab = {
  id: string;
  mode: RightPanelMode;
  title: string;
};

export type JasmineRoute =
  | { name: "newChat"; projectId?: string | null }
  | { name: "thread"; threadId: string; projectId?: string | null }
  | { name: "todo" }
  | { name: "working" }
  | { name: "settings"; section: SettingsSection; providerId?: string }
  | { name: "rightPanel"; threadId: string; panel: RightPanelMode; projectId?: string | null };

export function routeToPath(route: JasmineRoute): string {
  switch (route.name) {
    case "newChat":
      return route.projectId ? `/projects/${encodeRouteSegment(route.projectId)}/chat/new` : "/chats/new";
    case "thread":
      return route.projectId
        ? `/projects/${encodeRouteSegment(route.projectId)}/chat/${encodeRouteSegment(route.threadId)}`
        : `/chats/${encodeRouteSegment(route.threadId)}`;
    case "rightPanel":
      return route.projectId
        ? `/projects/${encodeRouteSegment(route.projectId)}/chat/${encodeRouteSegment(route.threadId)}/right-panel/${route.panel}`
        : `/chats/${encodeRouteSegment(route.threadId)}/right-panel/${route.panel}`;
    case "todo":
      return "/todo";
    case "working":
      return "/working";
    case "settings":
      if (route.section === "providers" && route.providerId) {
        return `/settings/providers/${encodeRouteSegment(route.providerId)}`;
      }
      return `/settings/${settingsSectionToPath(route.section)}`;
  }
}

export function parseJasminePath(path: string): JasmineRoute | null {
  const cleanPath = path.trim().replace(/\/+$/, "") || "/";
  if (cleanPath === "/todo") return { name: "todo" };
  if (cleanPath === "/working") return { name: "working" };
  if (cleanPath === "/chats/new" || cleanPath === "/chat/new") return { name: "newChat", projectId: null };

  const projectNewMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/new$/);
  if (projectNewMatch) return { name: "newChat", projectId: decodeRouteSegment(projectNewMatch[1]) };

  const projectThreadMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/([^/]+)$/);
  if (projectThreadMatch) {
    return {
      name: "thread",
      projectId: decodeRouteSegment(projectThreadMatch[1]),
      threadId: decodeRouteSegment(projectThreadMatch[2])
    };
  }

  const projectRightPanelMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/([^/]+)\/right-panel\/([^/]+)$/);
  if (projectRightPanelMatch) {
    const panel = projectRightPanelMatch[3];
    if (isRightPanelMode(panel)) {
      return {
        name: "rightPanel",
        projectId: decodeRouteSegment(projectRightPanelMatch[1]),
        threadId: decodeRouteSegment(projectRightPanelMatch[2]),
        panel
      };
    }
    return null;
  }

  const threadMatch = cleanPath.match(/^\/(?:chats|chat)\/([^/]+)$/);
  if (threadMatch) return { name: "thread", projectId: null, threadId: decodeRouteSegment(threadMatch[1]) };

  const rightPanelMatch = cleanPath.match(/^\/(?:chats|chat)\/([^/]+)\/right-panel\/([^/]+)$/);
  if (rightPanelMatch) {
    const panel = rightPanelMatch[2];
    if (isRightPanelMode(panel)) {
      return {
        name: "rightPanel",
        projectId: null,
        threadId: decodeRouteSegment(rightPanelMatch[1]),
        panel
      };
    }
    return null;
  }

  const settingsMatch = cleanPath.match(/^\/settings\/([^/]+)(?:\/([^/]+))?$/);
  if (settingsMatch) {
    const section = pathToSettingsSection(settingsMatch[1]);
    if (!section) return null;
    return {
      name: "settings",
      section,
      providerId: section === "providers" && settingsMatch[2] ? decodeRouteSegment(settingsMatch[2]) : undefined
    };
  }

  return null;
}

export function routeLabel(route: JasmineRoute): string {
  if (route.name === "newChat") return route.projectId ? `Project ${route.projectId} new chat` : "New chat";
  if (route.name === "thread") return route.projectId ? `Project ${route.projectId} thread ${route.threadId}` : `Thread ${route.threadId}`;
  if (route.name === "todo") return "TODO";
  if (route.name === "working") return "Working";
  if (route.name === "rightPanel") return `${route.panel} panel`;
  return route.providerId ? `Settings ${route.section}/${route.providerId}` : `Settings ${route.section}`;
}

export function isSettingsSection(value: string): value is SettingsSection {
  return (settingsSections as readonly string[]).includes(value);
}

export function isRightPanelMode(value: string): value is RightPanelMode {
  return (rightPanelModes as readonly string[]).includes(value);
}

export function rightPanelModeLabel(mode: RightPanelMode): string {
  if (mode === "terminal") return "Terminal";
  if (mode === "artifacts") return "Artifacts";
  return "Context taxonomy";
}

function settingsSectionToPath(section: SettingsSection): string {
  return section === "webSearch" ? "web-search" : section;
}

function pathToSettingsSection(value: string): SettingsSection | null {
  if (value === "web-search") return "webSearch";
  return isSettingsSection(value) ? value : null;
}

function encodeRouteSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodeRouteSegment(value: string): string {
  return decodeURIComponent(value);
}
