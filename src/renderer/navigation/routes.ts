export const settingsSections = [
  "general",
  "providers",
  "remotes",
  "appearance",
  "memory",
  "skills",
  "plugins",
  "prompts",
  "activity",
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
  | { name: "working" }
  | { name: "settings"; section: SettingsSection; providerId?: string }
  | { name: "remoteWorkspace"; profileId: string; cwd: string }
  | { name: "remoteSession"; profileId: string; sessionId: string }
  | { name: "rightPanel"; threadId: string; panel: RightPanelMode; projectId?: string | null };

export function routeToPath(route: JasmineRoute): string {
  switch (route.name) {
    case "newChat":
      return route.projectId ? `/projects/${encodeURIComponent(route.projectId)}/chat/new` : "/chats/new";
    case "thread":
      return route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}/chat/${encodeURIComponent(route.threadId)}`
        : `/chats/${encodeURIComponent(route.threadId)}`;
    case "rightPanel":
      return route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}/chat/${encodeURIComponent(route.threadId)}/right-panel/${route.panel}`
        : `/chats/${encodeURIComponent(route.threadId)}/right-panel/${route.panel}`;
    case "working":
      return "/working";
    case "remoteWorkspace":
      return `/remotes/${encodeURIComponent(route.profileId)}/workspace/${encodeURIComponent(route.cwd)}`;
    case "remoteSession":
      return `/remotes/${encodeURIComponent(route.profileId)}/session/${encodeURIComponent(route.sessionId)}`;
    case "settings":
      if (route.section === "providers" && route.providerId) {
        return `/settings/providers/${encodeURIComponent(route.providerId)}`;
      }
      return `/settings/${route.section}`;
  }
}

export function parseJasminePath(path: string): JasmineRoute | null {
  const cleanPath = path.trim().replace(/\/+$/, "") || "/";
  if (cleanPath === "/working") return { name: "working" };
  if (cleanPath === "/chats/new" || cleanPath === "/chat/new") return { name: "newChat", projectId: null };

  const projectNewMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/new$/);
  if (projectNewMatch) return { name: "newChat", projectId: decodeURIComponent(projectNewMatch[1]) };

  const projectThreadMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/([^/]+)$/);
  if (projectThreadMatch) {
    return {
      name: "thread",
      projectId: decodeURIComponent(projectThreadMatch[1]),
      threadId: decodeURIComponent(projectThreadMatch[2])
    };
  }

  const projectRightPanelMatch = cleanPath.match(/^\/projects\/([^/]+)\/chat\/([^/]+)\/right-panel\/([^/]+)$/);
  if (projectRightPanelMatch) {
    const panel = projectRightPanelMatch[3];
    if (isRightPanelMode(panel)) {
      return {
        name: "rightPanel",
        projectId: decodeURIComponent(projectRightPanelMatch[1]),
        threadId: decodeURIComponent(projectRightPanelMatch[2]),
        panel
      };
    }
    return null;
  }

  const threadMatch = cleanPath.match(/^\/(?:chats|chat)\/([^/]+)$/);
  if (threadMatch) return { name: "thread", projectId: null, threadId: decodeURIComponent(threadMatch[1]) };

  const rightPanelMatch = cleanPath.match(/^\/(?:chats|chat)\/([^/]+)\/right-panel\/([^/]+)$/);
  if (rightPanelMatch) {
    const panel = rightPanelMatch[2];
    if (isRightPanelMode(panel)) {
      return {
        name: "rightPanel",
        projectId: null,
        threadId: decodeURIComponent(rightPanelMatch[1]),
        panel
      };
    }
    return null;
  }

  const remoteWorkspaceMatch = cleanPath.match(/^\/remotes\/([^/]+)\/workspace\/([^/]+)$/);
  if (remoteWorkspaceMatch) {
    return {
      name: "remoteWorkspace",
      profileId: decodeURIComponent(remoteWorkspaceMatch[1]),
      cwd: decodeURIComponent(remoteWorkspaceMatch[2])
    };
  }

  const remoteSessionMatch = cleanPath.match(/^\/remotes\/([^/]+)\/session\/([^/]+)$/);
  if (remoteSessionMatch) {
    return {
      name: "remoteSession",
      profileId: decodeURIComponent(remoteSessionMatch[1]),
      sessionId: decodeURIComponent(remoteSessionMatch[2])
    };
  }

  const settingsMatch = cleanPath.match(/^\/settings\/([^/]+)(?:\/([^/]+))?$/);
  if (settingsMatch) {
    const section = settingsMatch[1];
    if (!isSettingsSection(section)) return null;
    return {
      name: "settings",
      section,
      providerId: section === "providers" && settingsMatch[2] ? decodeURIComponent(settingsMatch[2]) : undefined
    };
  }

  return null;
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
