import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ChatMessage, ChatThread, ContextTaxonomy, TerminalSession, ThreadContextTaxonomyResponse } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { ClipboardIcon, CopyIcon, CutIcon, FolderIcon, MinimizeIcon, PlusIcon, SelectAllIcon, SlidersIcon, TerminalIcon } from "../icons/Icons";
import { MenuItem, MenuSurface } from "../ui";
import { TaxonomyView } from "./ContextTaxonomyView";
import { useI18n } from "../../i18n";
import { useThrottledValue } from "../../hooks/useThrottledValue";
import { rightPanelModeLabel, rightPanelModes, type RightPanelMode, type RightPanelTab } from "../../navigation/routes";
import { ArtifactsPane } from "./ArtifactsPane";
export type { RightPanelMode } from "../../navigation/routes";

export function availableToAdd(openTabs: RightPanelTab[]): RightPanelMode[] {
  const openSingletons = new Set(openTabs.filter((tab) => tab.mode !== "terminal").map((tab) => tab.mode));
  return rightPanelModes.filter((mode) => mode === "terminal" || !openSingletons.has(mode));
}

export function ChatRightPanel(props: {
  activeTabId: string | null;
  openTabs: RightPanelTab[];
  collapsed: boolean;
  activeThread: ChatThread | null;
  activeProjectId: string | null;
  messages: ChatMessage[];
  width: number;
  onResize(width: number): void;
  onSelect(mode: RightPanelMode): void;
  onAdd(mode: RightPanelMode): void;
  onSelectTab(tabId: string): void;
  onClose(tabId: string): void;
  onCollapse(): void;
}) {
  const activeTab = props.openTabs.find((tab) => tab.id === props.activeTabId) ?? null;
  const activeMode = activeTab?.mode ?? null;
  const hasPanel = props.openTabs.length > 0 && activeTab !== null;
  const expanded = hasPanel && !props.collapsed;
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addable = availableToAdd(props.openTabs);

  useEffect(() => {
    if (props.collapsed || addable.length === 0) setAddMenuOpen(false);
  }, [addable.length, props.collapsed]);

  return (
    <>
      <div className={`right-panel-tabs ${expanded ? "panel-open" : ""}`} aria-label="Right panel shortcuts">
        <PanelButton mode="terminal" active={activeMode === "terminal" && !props.collapsed} open={props.openTabs.some((tab) => tab.mode === "terminal")} label="Terminal" onCollapse={props.onCollapse} onSelect={props.onSelect}><TerminalIcon /></PanelButton>
        <PanelButton mode="artifacts" active={activeMode === "artifacts" && !props.collapsed} open={props.openTabs.some((tab) => tab.mode === "artifacts")} label="Artifacts" onCollapse={props.onCollapse} onSelect={props.onSelect}><FolderIcon /></PanelButton>
        <PanelButton mode="context" active={activeMode === "context" && !props.collapsed} open={props.openTabs.some((tab) => tab.mode === "context")} label="Context taxonomy" onCollapse={props.onCollapse} onSelect={props.onSelect}><SlidersIcon /></PanelButton>
      </div>
      {hasPanel && activeTab && (
        <aside className={`chat-right-panel ${props.collapsed ? "chat-right-panel--collapsed" : ""}`} aria-hidden={props.collapsed} aria-label={activeTab.title}>
          <div
            className="right-panel-resize-handle"
            role="separator"
            aria-label="Resize right panel"
            aria-orientation="vertical"
            aria-valuemin={240}
            aria-valuemax={720}
            aria-valuenow={Math.round(props.width)}
            tabIndex={0}
            onKeyDown={(event) => resizeWithKeyboard(event, props.width, props.onResize)}
            onPointerDown={(event) => beginPanelResize(event, props.onResize)}
          />
          <header className="chat-right-panel-header">
            <div className="right-panel-tabbar" role="tablist" aria-label="Open right panels">
              {props.openTabs.map((tab) => (
                <div className={`right-panel-tab ${props.activeTabId === tab.id ? "active" : ""}`} key={tab.id}>
                  <button
                    type="button"
                    className="right-panel-tab-main"
                    role="tab"
                    aria-selected={props.activeTabId === tab.id && !props.collapsed}
                    onClick={() => props.onSelectTab(tab.id)}
                  >
                    {panelIcon(tab.mode)}
                    <span>{tab.title}</span>
                  </button>
                  <button
                    className="right-panel-tab-close"
                    type="button"
                    aria-label={`Close ${tab.title} tab`}
                    title={`Close ${tab.title} tab`}
                    onClick={() => props.onClose(tab.id)}
                  >
                    x
                  </button>
                </div>
              ))}
              <div className="right-panel-add-tab-wrap">
                <button
                  ref={addButtonRef}
                  type="button"
                  className="right-panel-add-tab"
                  aria-expanded={addMenuOpen}
                  aria-haspopup="menu"
                  aria-label="Add panel"
                  disabled={addable.length === 0}
                  title={addable.length ? "Add panel" : "All panels are open"}
                  onClick={() => setAddMenuOpen((open) => !open)}
                >
                  <PlusIcon />
                </button>
                <MenuSurface
                  anchorRef={addButtonRef}
                  aria-label="Add panel menu"
                  className="right-panel-add-menu"
                  minWidth={200}
                  onOpenChange={setAddMenuOpen}
                  open={addMenuOpen}
                  placement="bottom-end"
                  role="menu"
                >
                  {addable.map((mode) => (
                    <MenuItem
                      key={mode}
                      role="menuitem"
                      leftIcon={panelIcon(mode)}
                      onClick={() => {
                        setAddMenuOpen(false);
                        props.onAdd(mode);
                      }}
                    >
                      {rightPanelModeLabel(mode)}
                    </MenuItem>
                  ))}
                </MenuSurface>
              </div>
            </div>
            <div className="right-panel-header-actions">
              <button type="button" className="right-panel-collapse" onClick={props.onCollapse} aria-label="Collapse panel" title="Collapse panel"><MinimizeIcon /></button>
            </div>
          </header>
          {props.openTabs.map((tab) => (
            <section key={tab.id} className={`right-panel-pane ${props.activeTabId === tab.id ? "active" : ""}`} aria-hidden={props.activeTabId !== tab.id}>
              {tab.mode === "terminal" ? (
                <TerminalPane
                  key={`${tab.id}:${props.activeThread?.id ?? "no-thread"}`}
                  active={props.activeTabId === tab.id && !props.collapsed}
                  activeProjectId={props.activeProjectId}
                  activeThreadId={props.activeThread?.id ?? null}
                />
              ) : tab.mode === "artifacts" ? (
                <ArtifactsPane threadId={props.activeThread?.id ?? null} messages={props.messages} />
              ) : (
                <ContextTaxonomyPane threadId={props.activeThread?.id ?? null} messages={props.messages} />
              )}
            </section>
          ))}
        </aside>
      )}
    </>
  );
}

function beginPanelResize(event: PointerEvent<HTMLDivElement>, onResize: (width: number) => void) {
  if (event.button !== 0) return;
  const handle = event.currentTarget;
  const chatPage = handle.closest<HTMLElement>(".chat-page");
  if (!chatPage) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-right-panel");

  const resize = (moveEvent: globalThis.PointerEvent) => {
    const bounds = chatPage.getBoundingClientRect();
    onResize(clampPanelWidth(bounds.right - moveEvent.clientX, bounds.width));
  };
  const finish = () => {
    document.body.classList.remove("resizing-right-panel");
    handle.removeEventListener("pointermove", resize);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
  };

  handle.addEventListener("pointermove", resize);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>, width: number, onResize: (width: number) => void) {
  const chatPage = event.currentTarget.closest<HTMLElement>(".chat-page");
  if (!chatPage) return;
  const pageWidth = chatPage.getBoundingClientRect().width;
  let nextWidth = width;
  if (event.key === "ArrowLeft") nextWidth += 24;
  else if (event.key === "ArrowRight") nextWidth -= 24;
  else if (event.key === "Home") nextWidth = 240;
  else if (event.key === "End") nextWidth = 720;
  else return;
  event.preventDefault();
  onResize(clampPanelWidth(nextWidth, pageWidth));
}

function clampPanelWidth(width: number, pageWidth: number) {
  return Math.round(Math.min(Math.max(240, pageWidth - 360), 720, Math.max(240, width)));
}

function PanelButton(props: { mode: RightPanelMode; active: boolean; open: boolean; label: string; children: ReactNode; onCollapse(): void; onSelect(mode: RightPanelMode): void }) {
  return (
    <button
      type="button"
      className={`${props.active ? "active" : ""} ${props.open ? "open" : ""}`}
      aria-label={`Open ${props.label}`}
      title={props.label}
      onClick={() => {
        if (props.active) {
          props.onCollapse();
          return;
        }
        props.onSelect(props.mode);
      }}
    >
      {props.children}
    </button>
  );
}

function TerminalPane(props: { active: boolean; activeProjectId: string | null; activeThreadId: string | null }) {
  const { t } = useI18n();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState("Starting...");
  const [starting, setStarting] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const selectionTextRef = useRef("");
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);

  useEffect(() => {
    if (props.active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }
  }, [props.active]);

  useEffect(() => {
    const unsubscribe = getBridge().onTerminalEvent((event) => {
      if (sessionRef.current && event.sessionId !== sessionRef.current.id) return;
      const terminal = terminalRef.current;
      if (event.type === "exit" || event.type === "error") {
        sessionRef.current = null;
        setSession(null);
        setStatus(event.type === "exit" ? "Stopped" : "Error");
      }
      if (!terminal) return;
      if (event.type === "data") terminal.write(event.data ?? "");
      if (event.type === "exit") terminal.writeln(`\r\n\x1b[2m[process exited${event.exitCode === null || event.exitCode === undefined ? "" : ` with code ${event.exitCode}`}]\x1b[0m`);
      if (event.type === "error") terminal.writeln(`\r\n\x1b[31m[terminal error]\x1b[0m ${event.data ?? ""}`);
    });
    return unsubscribe;
  }, [props.activeProjectId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const styles = getComputedStyle(document.documentElement);
    const terminal = new XTerm({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: styles.getPropertyValue("--font-code") || '"JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.45,
      rightClickSelectsWord: false,
      scrollback: 5000,
      theme: {
        background: styles.getPropertyValue("--surface").trim() || "#ffffff",
        foreground: styles.getPropertyValue("--ink").trim() || "#0d0d0d",
        cursor: styles.getPropertyValue("--ink").trim() || "#0d0d0d",
        selectionBackground: "rgba(1, 105, 204, 0.18)",
        black: "#0d0d0d",
        red: styles.getPropertyValue("--danger").trim() || "#e02e2a",
        green: styles.getPropertyValue("--success").trim() || "#00a240",
        yellow: "#b88700",
        blue: styles.getPropertyValue("--accent").trim() || "#0169cc",
        magenta: "#8f4cc8",
        cyan: "#0b7c86",
        white: "#d7d7d7",
        brightBlack: "#6f747a",
        brightRed: styles.getPropertyValue("--danger").trim() || "#e02e2a",
        brightGreen: styles.getPropertyValue("--success").trim() || "#00a240",
        brightYellow: "#c99500",
        brightBlue: styles.getPropertyValue("--accent").trim() || "#0169cc",
        brightMagenta: "#9d61d6",
        brightCyan: "#128c96",
        brightWhite: "#ffffff"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();
    terminal.focus();
    terminal.attachCustomKeyEventHandler((event) => handleTerminalShortcut(event, terminal));

    const dataDisposable = terminal.onData((data) => {
      const current = sessionRef.current;
      if (current) void getBridge().writeTerminal({ sessionId: current.id, data }).catch((error) => {
        terminal.writeln(`\r\n\x1b[31m[terminal error]\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    const resizeDisposable = terminal.onResize((size) => {
      const current = sessionRef.current;
      if (current) void getBridge().resizeTerminal({ sessionId: current.id, cols: size.cols, rows: size.rows }).catch(() => undefined);
    });
    const selectionDisposable = terminal.onSelectionChange(() => syncTerminalSelection(terminal));
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(host);

    void start();
    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (sessionRef.current) void getBridge().stopTerminal({ sessionId: sessionRef.current.id }).catch(() => undefined);
    };
  }, []);

  async function start() {
    if (starting || session) return;
    setStarting(true);
    setStatus("Starting...");
    try {
      const proposed = fitRef.current?.proposeDimensions();
      const next = await getBridge().startTerminal({
        ...(props.activeThreadId ? { threadId: props.activeThreadId } : { projectId: props.activeProjectId }),
        cols: proposed?.cols ?? 80,
        rows: proposed?.rows ?? 24
      });
      sessionRef.current = next;
      setSession(next);
      setStatus(next.shell.label);
      terminalRef.current?.focus();
    } catch (error) {
      setStatus("Error");
      terminalRef.current?.writeln(`\x1b[31m[terminal error]\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!session) return;
    await getBridge().stopTerminal({ sessionId: session.id }).catch(() => undefined);
    sessionRef.current = null;
    setSession(null);
    setStatus("Stopped");
  }

  function handleTerminalShortcut(event: globalThis.KeyboardEvent, terminal: XTerm): boolean {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && terminal.hasSelection()) {
      event.preventDefault();
      void copySelection(false);
      return false;
    }
    if (key === "x" && terminal.hasSelection()) {
      event.preventDefault();
      void copySelection(true);
      return false;
    }
    if (key === "v") {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }
    if (key === "a") {
      event.preventDefault();
      selectAllTerminal();
      return false;
    }
    return true;
  }

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (terminalRef.current) syncTerminalSelection(terminalRef.current);
    terminalRef.current?.focus();
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
    setContextMenuOpen(true);
  }

  async function copySelection(clearAfterCopy: boolean) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const selection = getTerminalSelectionText(terminal);
    if (!selection) return;
    await getBridge().writeClipboardText(selection).catch(async () => {
      await navigator.clipboard?.writeText(selection).catch(() => undefined);
    });
    if (clearAfterCopy) {
      terminal.clearSelection();
      selectionTextRef.current = "";
    }
    syncTerminalSelection(terminal);
    terminal.focus();
  }

  async function pasteFromClipboard() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const text = await getBridge().readClipboardText().catch(async () => navigator.clipboard?.readText().catch(() => ""));
    if (text) terminal.paste(text);
    terminal.focus();
  }

  function selectAllTerminal() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.selectAll();
    const selection = terminal.getSelection() || readTerminalFallbackText(terminal);
    selectionTextRef.current = selection;
    setHasTerminalSelection(selection.length > 0);
    terminal.focus();
  }

  function syncTerminalSelection(terminal: XTerm) {
    const selection = terminal.getSelection() || (terminal.hasSelection() ? readTerminalFallbackText(terminal) : "");
    selectionTextRef.current = selection;
    setHasTerminalSelection(selection.length > 0);
  }

  function getTerminalSelectionText(terminal: XTerm): string {
    return terminal.getSelection() || selectionTextRef.current || readTerminalFallbackText(terminal);
  }

  function readTerminalFallbackText(terminal: XTerm): string {
    return readTerminalBufferText(terminal) || readTerminalDomText();
  }

  function readTerminalBufferText(terminal: XTerm): string {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n").trim();
  }

  function readTerminalDomText(): string {
    return (hostRef.current?.innerText ?? "").replace(/\u00a0/g, " ").trim();
  }

  return (
    <div className="terminal-pane">
      <div className="terminal-meta">
        <span>{status}</span>
        <button type="button" onClick={session ? () => void stop() : () => void start()}>{session ? "Stop" : "Start"}</button>
      </div>
      <div
        ref={hostRef}
        className="terminal-output terminal-emulator"
        role="textbox"
        aria-label="Terminal command"
        tabIndex={0}
        onClick={() => terminalRef.current?.focus()}
        onContextMenu={openContextMenu}
      />
      <div
        ref={menuAnchorRef}
        className="terminal-context-anchor"
        style={{ left: `${contextMenuPosition.x}px`, top: `${contextMenuPosition.y}px` }}
      />
      <MenuSurface
        anchorRef={menuAnchorRef}
        aria-label={t("terminal.menu")}
        className="terminal-context-menu"
        minWidth={188}
        onOpenChange={setContextMenuOpen}
        open={contextMenuOpen}
        placement="bottom-start"
        role="menu"
      >
        <MenuItem role="menuitem" leftIcon={<CutIcon />} rightMeta="Ctrl+X" disabled={!hasTerminalSelection} onMouseDown={(event) => event.preventDefault()} onClick={() => { setContextMenuOpen(false); void copySelection(true); }}>
          {t("terminal.cut")}
        </MenuItem>
        <MenuItem role="menuitem" leftIcon={<CopyIcon />} rightMeta="Ctrl+C" disabled={!hasTerminalSelection} onMouseDown={(event) => event.preventDefault()} onClick={() => { setContextMenuOpen(false); void copySelection(false); }}>
          {t("terminal.copy")}
        </MenuItem>
        <MenuItem role="menuitem" leftIcon={<ClipboardIcon />} rightMeta="Ctrl+V" onMouseDown={(event) => event.preventDefault()} onClick={() => { setContextMenuOpen(false); void pasteFromClipboard(); }}>
          {t("terminal.paste")}
        </MenuItem>
        <MenuItem role="menuitem" leftIcon={<SelectAllIcon />} rightMeta="Ctrl+A" onMouseDown={(event) => event.preventDefault()} onClick={() => { setContextMenuOpen(false); selectAllTerminal(); }}>
          {t("terminal.selectAll")}
        </MenuItem>
      </MenuSurface>
    </div>
  );
}

function ContextTaxonomyPane(props: { threadId: string | null; messages: ChatMessage[] }) {
  const [data, setData] = useState<ThreadContextTaxonomyResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taxonomy, setTaxonomy] = useState<ContextTaxonomy | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  // The final persisted assistant replaces a stable-id streaming placeholder
  // without changing message count. Include the last id so the panel refreshes
  // after the capture transaction commits instead of waiting for the next turn.
  const messages = useThrottledValue(props.messages, 1000);
  const messageRefreshKey = `${messages.length}:${messages.at(-1)?.id ?? ""}`;

  useEffect(() => {
    if (!props.threadId) {
      setData(null);
      setSelectedId(null);
      setTaxonomy(null);
      return;
    }
    let active = true;
    setLoading(true);
    getBridge().listThreadContextTaxonomy(props.threadId)
      .then((response) => {
        if (!active) return;
        setData(response);
        setSelectedId((current) => response.captures.some((capture) => capture.id === current)
          ? current
          : response.captures.at(-1)?.id ?? null);
      })
      .catch(() => {
        if (active) setData({ threadId: props.threadId ?? "", captures: [] });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.threadId, messageRefreshKey]);

  useEffect(() => {
    if (!selectedId) {
      setTaxonomy(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    getBridge().getContextTaxonomy(selectedId)
      .then((response) => { if (active) setTaxonomy(response.taxonomy); })
      .catch(() => { if (active) setTaxonomy(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  if (loading) return <p className="panel-empty">Loading context taxonomy...</p>;
  const captures = data?.captures ?? [];
  if (!selectedId || captures.length === 0) return <p className="panel-empty">No captured context taxonomy yet. Send a message to record one.</p>;
  return (
    <div className="taxonomy-pane">
      {detailLoading || !taxonomy
        ? <p className="panel-empty">Loading selected provider request...</p>
        : (
          <TaxonomyView
            key={selectedId}
            taxonomy={taxonomy}
            captureId={selectedId}
            captures={captures}
            onSelectCapture={setSelectedId}
          />
        )}
    </div>
  );
}

function panelIcon(mode: RightPanelMode): ReactNode {
  if (mode === "terminal") return <TerminalIcon />;
  if (mode === "artifacts") return <FolderIcon />;
  return <SlidersIcon />;
}
