import type { ChatMessage, ChatThread } from "../../shared/ipc";
import type { JasmineRoute } from "../navigation/routes";
import type { RunState } from "../types";

export type HarnessSeverity = "error" | "warning";

export type HarnessIssue = {
  id: string;
  severity: HarnessSeverity;
  summary: string;
  selector?: string;
  label?: string;
};

export type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export type HarnessControl = {
  selector: string;
  role: string;
  label: string;
  text: string;
  tag: string;
  className: string;
  disabled: boolean;
  disabledReason: string;
  title: string;
  ariaExpanded?: string;
  bounds: Bounds;
};

export type HarnessSnapshot = {
  generatedAt: string;
  app: {
    activeThreadId: string | null;
    activeThreadTitle: string | null;
    threadCount: number;
    messageCount: number;
    runState: RunState;
    activeProviderId: string;
    activeModelId: string | null;
    sidebarCollapsed: boolean;
    memoryEnabled: boolean;
    webSearchEnabled: boolean;
    toolsEnabled: boolean;
    voiceEnabled: boolean;
    selectedSkillCount: number;
    navigation: {
      route: JasmineRoute;
      path: string;
      canGoBack: boolean;
      canGoForward: boolean;
    };
  };
  surfaces: string[];
  controls: HarnessControl[];
  viewport: {
    width: number;
    height: number;
  };
};

export type HarnessAuditResult = {
  generatedAt: string;
  issues: HarnessIssue[];
  errorCount: number;
  warningCount: number;
  snapshot: HarnessSnapshot;
};

export type HarnessBridge = {
  snapshot(): HarnessSnapshot;
  audit(): HarnessAuditResult;
  actions: {
    closeFloatingSurfaces(): void;
    newChat(): void;
    openSettings(): void;
    openModelMenu(): void;
    openMoreMenu(): void;
    openSearch(): void;
  };
};

export type HarnessBridgeInput = {
  activeThread: ChatThread | null;
  activeThreadId: string | null;
  threads: ChatThread[];
  messages: ChatMessage[];
  runState: RunState;
  activeProviderId: string;
  activeModelId: string | null;
  sidebarCollapsed: boolean;
  memoryEnabled: boolean;
  webSearchEnabled: boolean;
  toolsEnabled: boolean;
  voiceEnabled: boolean;
  selectedSkillCount: number;
  navigation: HarnessSnapshot["app"]["navigation"];
  openSurfaces: Record<string, boolean>;
  actions: HarnessBridge["actions"];
};
