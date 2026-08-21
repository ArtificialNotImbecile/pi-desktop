import { useState, type ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AskUserQuestionPrompt, AskUserQuestionResponse, ChatThread } from "../../src/shared/ipc";
import { AskUserQuestionDialog } from "../../src/renderer/components/chat/AskUserQuestionDialog";
import { AppShell } from "../../src/renderer/components/shell/AppShell";
import { SearchOverlay } from "../../src/renderer/components/shell/SearchOverlay";
import { I18nProvider } from "../../src/renderer/i18n";

function withI18n(children: ReactNode) {
  return <I18nProvider language="en">{children}</I18nProvider>;
}

describe("shell renderer components", () => {
  test("AskUserQuestion collects batched option and custom answers", () => {
    const prompt: AskUserQuestionPrompt = {
      id: "renderer-batched-questions",
      questions: [
        {
          id: "path",
          header: "Path",
          question: "Which path should the assistant take?",
          options: [
            { label: "Use the fast path", description: "Prefer the existing runtime hook." },
            { label: "Use the full path", description: "Add IPC and UI coverage." }
          ]
        },
        {
          id: "tone",
          header: "Tone",
          question: "How should the answer be framed?",
          options: [{ label: "Short" }, { label: "Detailed" }]
        }
      ]
    };
    const answers: AskUserQuestionResponse[] = [];

    function Harness() {
      const [activePrompt, setActivePrompt] = useState<AskUserQuestionPrompt | null>(prompt);
      return <AskUserQuestionDialog prompt={activePrompt} onAnswer={(response) => {
        answers.push(response);
        setActivePrompt(null);
      }} />;
    }

    render(withI18n(<Harness />));
    const dialog = screen.getByRole("dialog", { name: "Questions from assistant" });
    expect(dialog.textContent).toContain("Question 1 of 2");
    expect(dialog.textContent).not.toContain("How should the answer be framed?");

    const next = within(dialog).getByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Use the full path/ }));
    expect((next as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(next);

    expect(dialog.textContent).toContain("Question 2 of 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(dialog.textContent).toContain("Question 1 of 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));

    fireEvent.click(within(dialog).getByRole("radio", { name: /Other/ }));
    const submit = within(dialog).getByRole("button", { name: "Submit answers" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Custom answer - Tone" }), {
      target: { value: "Use a typed custom framing." }
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(screen.queryByRole("dialog", { name: "Questions from assistant" })).toBeNull();
    expect(answers).toEqual([{
      id: prompt.id,
      answers: [
        {
          questionId: "path",
          question: "Which path should the assistant take?",
          answer: "Use the full path",
          custom: false,
          selectedIndex: 2,
          selectedOptionLabel: "Use the full path"
        },
        {
          questionId: "tone",
          question: "How should the answer be framed?",
          answer: "Use a typed custom framing.",
          custom: true
        }
      ]
    }]);
  });

  test("search filters threads, selects a result, and exposes its empty state", () => {
    const selected = vi.fn();
    const closed = vi.fn();
    const threads: ChatThread[] = [{
      id: "greeting",
      title: "Greeting",
      projectId: null,
      messageCount: 2,
      activePluginIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }];

    function Harness() {
      const [query, setQuery] = useState("");
      return <SearchOverlay
        open
        query={query}
        threads={threads}
        projects={[]}
        onQueryChange={setQuery}
        onClose={closed}
        onSelectThread={selected}
      />;
    }

    render(withI18n(<Harness />));
    const input = screen.getByRole("combobox", { name: "Search" });
    fireEvent.change(input, { target: { value: "Greeting" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selected).toHaveBeenCalledWith("greeting");
    expect(closed).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "no-chat-with-this-title" } });
    expect(screen.getByText("No chats found")).toBeDefined();
  });

  test("collapsing the sidebar keeps its top-row trio reachable as title-bar chrome", () => {
    const toggleSidebar = vi.fn();
    const search = vi.fn();
    const newChat = vi.fn();
    const closeFloatingSurfaces = vi.fn();

    function renderShell(sidebarCollapsed: boolean) {
      return render(withI18n(
        <AppShell
          threads={[]}
          projects={[]}
          activeThreadId={null}
          activeProjectId={null}
          workingActive={false}
          workingActiveCount={0}
          workingAttention={false}
          messagesEmpty
          sidebarCollapsed={sidebarCollapsed}
          moreOpen={false}
          onToggleSidebar={toggleSidebar}
          onSearch={search}
          onNewChat={newChat}
          onNewChatInChats={vi.fn()}
          onNewChatInProject={vi.fn()}
          onOpenProjectFolder={vi.fn()}
          onSelectProject={vi.fn()}
          onSelectThread={vi.fn()}
          onOpenWorking={vi.fn()}
          onToggleMore={vi.fn()}
          onOpenAbout={vi.fn()}
          onOpenSettings={vi.fn()}
          onRenameThread={vi.fn()}
          onDeleteThread={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onOpenProjectInExplorer={vi.fn()}
          onCloseFloatingSurfaces={closeFloatingSurfaces}
          remoteHostGroups={[]}
          remoteWorkspaces={[]}
          remoteSessions={{}}
          remoteStatuses={{}}
          remoteRefreshingProfileIds={[]}
          activeRemoteProfileId={null}
          activeRemoteSessionId={null}
          onAddRemoteProfile={vi.fn()}
          onExpandRemoteProfile={vi.fn()}
          onRefreshRemoteProfile={vi.fn()}
          onOpenRemoteProfileSettings={vi.fn()}
          onCheckRemoteProfile={vi.fn()}
          onAddRemoteWorkspace={vi.fn()}
          onRemoveRemoteWorkspace={vi.fn()}
          onToggleRemoteWorkspacePinned={vi.fn()}
          onOpenRemoteWorkspace={vi.fn()}
          onOpenRemoteSession={vi.fn()}
        >
          <div />
        </AppShell>
      ));
    }

    const expanded = renderShell(false);
    expect(expanded.container.querySelector(".sidebar-restore-bar")).toBeNull();
    expanded.unmount();

    const collapsed = renderShell(true);
    const bar = collapsed.container.querySelector(".sidebar-restore-bar");
    expect(bar).not.toBeNull();
    const toolbar = within(bar as HTMLElement);
    expect(toolbar.getAllByRole("button")).toHaveLength(3);

    fireEvent.click(toolbar.getByRole("button", { name: "Show sidebar" }));
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    fireEvent.click(toolbar.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.click(toolbar.getByRole("button", { name: "New chat" }));
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(closeFloatingSurfaces).toHaveBeenCalledTimes(2);

    // Electron subtracts `no-drag` rects from `drag` rects in layout-tree
    // order, so the shell's drag strip has to be emitted before the toolbar it
    // overlaps or macOS swallows every click on it as a window drag.
    const dragRegion = collapsed.container.querySelector(".window-drag-region");
    expect(dragRegion).not.toBeNull();
    expect((dragRegion as HTMLElement).compareDocumentPosition(bar as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeGreaterThan(0);
  });
});
