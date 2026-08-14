import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatTimelineItem } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { MessageView } from "../../src/renderer/components/chat/MessageView";
import { MessageList } from "../../src/renderer/components/chat/MessageList";

const createdAt = "2026-01-01T00:00:00.000Z";

function assistantMessage(id: string, timeline: ChatTimelineItem[]): ChatMessage {
  return {
    id,
    threadId: "renderer-message-thread",
    role: "assistant",
    content: "Mock reply from Jasmine.",
    createdAt,
    elapsedMs: 1200,
    timeline
  };
}

function mountMessages(messages: ChatMessage[], language: "en" | "zh" = "en") {
  const onCopy = vi.fn();
  const onRetry = vi.fn();
  const onEdit = vi.fn();
  const onRemember = vi.fn();
  const onCopyCode = vi.fn();
  const view = render(
    <I18nProvider language={language}>
      {messages.map((message) => (
        <MessageView
          key={message.id}
          message={message}
          onCopy={onCopy}
          onCopyCode={onCopyCode}
          onRetry={onRetry}
          onEdit={onEdit}
          onRemember={onRemember}
        />
      ))}
    </I18nProvider>
  );
  return { ...view, onCopy, onRetry, onEdit, onRemember, onCopyCode };
}

function toolTimeline(
  id: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  result: { content: string; isError?: boolean }
): ChatTimelineItem[] {
  return [
    {
      id: `${id}-call`,
      kind: "tool_call",
      toolName,
      title: toolName,
      argumentsJson: JSON.stringify(argumentsValue, null, 2)
    },
    {
      id: `${id}-result`,
      kind: "tool_result",
      toolName,
      title: toolName,
      content: result.content,
      isError: result.isError
    },
    { id: `${id}-output`, kind: "assistant_text", text: "Mock reply from Jasmine." }
  ];
}

/**
 * Renderer-only behavior sunk from rendering.spec.ts. These cases mount the
 * real MessageView; layout, paint timing, Shiki/Twoslash highlighting, and DOM
 * identity remain in Electron E2E where jsdom can provide meaningful evidence.
 */
describe("message rendering", () => {
  test("activity timing follows the run identity instead of provider setting changes", () => {
    vi.useFakeTimers();
    const callbacks = {
      onLoadOlderMessages: vi.fn(),
      onCopy: vi.fn(),
      onCopyCode: vi.fn(),
      onRetry: vi.fn(),
      onEditMessage: vi.fn(),
      onRemember: vi.fn(),
      onConfigureProvider: vi.fn(),
      onMessageWheel: vi.fn(),
      onMessageInteraction: vi.fn(),
      onMessageTailIntent: vi.fn(),
      onMessageScroll: vi.fn()
    };
    const messageScrollRef = createRef<HTMLDivElement>();
    const renderList = (runActivityKey: string, actionKey: string) => (
      <I18nProvider language="en">
        <MessageList
          messages={[]}
          hasOlderMessages={false}
          loadingOlderMessages={false}
          loading={false}
          runState="running"
          runModelLabel="deepseek-v4-flash"
          runActivityKey={runActivityKey}
          error={null}
          actionKey={actionKey}
          messageScrollRef={messageScrollRef}
          modelLabel="deepseek-v4-flash"
          brand={{ logoDataUrl: null, mainTitle: "Jasmine", subtitle: "", updatedAt: createdAt }}
          {...callbacks}
        />
      </I18nProvider>
    );
    const harness = render(renderList("thread-a:request-a", "settings-a"));
    try {
      act(() => vi.advanceTimersByTime(15_000));
      expect(harness.container.querySelector(".turn-activity")?.textContent).toContain("0:15");

      // Updating provider/settings behavior rerenders MessageList but must not
      // restart the clock for the same request.
      harness.rerender(renderList("thread-a:request-a", "settings-b"));
      expect(harness.container.querySelector(".turn-activity")?.textContent).toContain("0:15");

      // Switching to another running task and starting another request in the
      // same thread both receive a fresh activity clock.
      harness.rerender(renderList("thread-b:request-b", "settings-b"));
      expect(harness.container.querySelector(".turn-activity")?.querySelector("time")).toBeNull();
      act(() => vi.advanceTimersByTime(15_000));
      expect(harness.container.querySelector(".turn-activity")?.textContent).toContain("0:15");
      harness.rerender(renderList("thread-b:request-c", "settings-b"));
      expect(harness.container.querySelector(".turn-activity")?.querySelector("time")).toBeNull();
      harness.rerender(renderList("thread-a:request-a", "settings-b"));
      expect(harness.container.querySelector(".turn-activity")?.textContent).toContain("0:30");
    } finally {
      harness.unmount();
      vi.useRealTimers();
    }
  });

  test("assistant actions expose accessible names and dispatch every direct and menu callback", () => {
    const message = assistantMessage("action-message", [
      { id: "action-thinking", kind: "thinking", text: "Need to inspect." },
      { id: "action-output", kind: "assistant_text", text: "Mock reply from Jasmine." }
    ]);
    const harness = mountMessages([message]);

    const copy = screen.getByRole("button", { name: "Copy message" });
    const regenerate = screen.getByRole("button", { name: "Regenerate this response" });
    const actions = screen.getByRole("button", { name: "Message actions" });
    expect(copy.getAttribute("title")).toBe("Copy message");
    expect(regenerate.getAttribute("title")).toBe("Regenerate this response");
    expect(actions.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show work details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Thinking" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Worked for 1s")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Open trace" })).toBeNull();

    fireEvent.click(copy);
    fireEvent.click(regenerate);
    expect(harness.onCopy).toHaveBeenLastCalledWith(message);
    expect(harness.onRetry).toHaveBeenLastCalledWith(message);

    fireEvent.click(actions);
    let menu = document.querySelector(".message-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(within(menu).getAllByRole("button")).toHaveLength(3);
    expect(actions.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.getAttribute("aria-expanded")).toBe("false");
    expect((document.querySelector(".message-menu") as HTMLElement).style.opacity).toBe("0");

    fireEvent.click(actions);
    menu = document.querySelector(".message-menu") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Copy message" }));
    expect(harness.onCopy).toHaveBeenCalledTimes(2);
    expect(harness.onCopy).toHaveBeenLastCalledWith(message);

    fireEvent.click(actions);
    menu = document.querySelector(".message-menu") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Retry from here" }));
    expect(harness.onRetry).toHaveBeenCalledTimes(2);
    expect(harness.onRetry).toHaveBeenLastCalledWith(message);

    fireEvent.click(actions);
    menu = document.querySelector(".message-menu") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Remember this" }));
    expect(harness.onRemember).toHaveBeenCalledOnce();
    expect(harness.onRemember).toHaveBeenLastCalledWith(message);
    expect(actions.getAttribute("aria-expanded")).toBe("false");
  });

  test("completion summaries expose stopped and failed outcomes in their accessible names", () => {
    const stopped = {
      ...assistantMessage("stopped-completion", [
        { id: "stopped-status", kind: "system" as const, title: "Stopped", text: "Stopped by user." }
      ]),
      modelId: undefined
    };
    const failed = {
      ...assistantMessage("failed-completion", []),
      modelId: undefined,
      status: "error" as const
    };
    const harness = mountMessages([stopped, failed]);
    const completionLines = Array.from(harness.container.querySelectorAll<HTMLElement>(".run-completion-line"));

    expect(completionLines).toHaveLength(2);
    expect(completionLines[0].getAttribute("aria-label")).toBe("Stopped after 1s");
    expect(completionLines[1].getAttribute("aria-label")).toBe("Failed after 1s");
  });

  test("thought rows stay compact and summarize the newest live line before settling on the first line", () => {
    const liveMessage = {
      ...assistantMessage("stream-live-thought-0", [
        { id: "thought-summary", kind: "thinking" as const, text: "First plan\nNewest live step" }
      ]),
      elapsedMs: undefined
    };
    const harness = mountMessages([liveMessage]);
    const thought = harness.container.querySelector(".thinking-item") as HTMLElement;
    const toggle = thought.querySelector(".timeline-toggle") as HTMLButtonElement;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    expect(toggle.getAttribute("aria-describedby")).toBe(thought.querySelector(".timeline-summary")?.id);
    expect(thought.textContent).toContain("Newest live step");
    expect(thought.textContent).not.toContain("First plan");
    expect(thought.querySelector(".thinking-markdown")).toBeNull();
    expect(thought.querySelector(".timeline-running-indicator")).not.toBeNull();

    harness.rerender(
      <I18nProvider language="en">
        <MessageView
          message={{ ...liveMessage, id: "settled-thought", renderId: liveMessage.id, elapsedMs: 1400 }}
          onCopy={harness.onCopy}
          onCopyCode={harness.onCopyCode}
          onRetry={harness.onRetry}
          onEdit={harness.onEdit}
          onRemember={harness.onRemember}
        />
      </I18nProvider>
    );

    const settledThought = harness.container.querySelector(".thinking-item") as HTMLElement;
    expect(settledThought.textContent).toContain("First plan");
    expect(settledThought.textContent).not.toContain("Newest live step");
    expect(settledThought.querySelector(".timeline-running-indicator")).toBeNull();
  });

  test("only the active timeline segment keeps live thought presentation", () => {
    const message = {
      ...assistantMessage("stream-multiple-thoughts-0", [
        { id: "completed-thought", kind: "thinking" as const, text: "Completed plan\nCompleted latest line" },
        {
          id: "completed-tool-call",
          kind: "tool_call" as const,
          toolCallId: "completed-tool",
          toolName: "read",
          title: "Read file",
          argumentsJson: JSON.stringify({ path: "README.md" })
        },
        {
          id: "completed-tool-result",
          kind: "tool_result" as const,
          toolCallId: "completed-tool",
          toolName: "read",
          title: "Read file",
          content: "Done"
        },
        { id: "active-thought", kind: "thinking" as const, text: "Active plan\nActive latest line" }
      ]),
      elapsedMs: undefined
    };
    const harness = mountMessages([message]);
    const thoughts = Array.from(harness.container.querySelectorAll<HTMLElement>(".thinking-item"));

    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].classList.contains("done")).toBe(true);
    expect(thoughts[0].textContent).toContain("Completed plan");
    expect(thoughts[0].textContent).not.toContain("Completed latest line");
    expect(thoughts[0].querySelector(".timeline-running-indicator")).toBeNull();
    expect(thoughts[1].classList.contains("running")).toBe(true);
    expect(thoughts[1].textContent).toContain("Active latest line");
    expect(thoughts[1].textContent).not.toContain("Active plan");
    expect(thoughts[1].querySelector(".timeline-running-indicator")).not.toBeNull();
  });

  test("collapsed thought summaries and web provenance redact credentials", () => {
    const signedUrl = "https://user:password@api.example.test/private/report?access_token=provenance-must-not-see-this&X-Amz-Signature=signed#secret";
    const message: ChatMessage = {
      ...assistantMessage("safe-routine-history", [
        {
          id: "credential-thought",
          kind: "thinking",
          text: "Authorization: Bearer thought-summary-must-not-see-this"
        },
        { id: "safe-history-output", kind: "assistant_text", text: "Visible final answer." }
      ]),
      webSearchUsed: [
        { title: signedUrl, url: signedUrl, snippet: "" },
        {
          title: "Authorization: Bearer provenance-title-must-not-see-this",
          url: "https://docs.example.test/guide?api_key=another-hidden-value",
          snippet: ""
        },
        {
          title: "https://alice:hunter2@private.example.test/report?download=secret#fragment",
          url: "https://source.example.test/item",
          snippet: ""
        },
        {
          title: "Mirror: https://mirror-user:mirror-pass@private.example.test/report",
          url: "https://mirror-source.example.test/item",
          snippet: ""
        }
      ]
    };
    const harness = mountMessages([message]);
    const thought = harness.container.querySelector(".thinking-item") as HTMLElement;
    const provenance = harness.container.querySelector(".web-search-used-line") as HTMLElement;

    expect(thought.textContent).toBe("Thinking");
    expect(thought.textContent).not.toContain("thought-summary-must-not-see-this");
    expect(thought.querySelector(".thinking-markdown")).toBeNull();
    expect(provenance.textContent).toContain("https://api.example.test/private/report");
    expect(provenance.textContent).toContain("https://docs.example.test/guide");
    expect(provenance.textContent).toContain("https://private.example.test/report");
    expect(provenance.textContent).not.toContain("password");
    expect(provenance.textContent).not.toContain("alice");
    expect(provenance.textContent).not.toContain("hunter2");
    expect(provenance.textContent).not.toContain("mirror-user");
    expect(provenance.textContent).not.toContain("mirror-pass");
    expect(provenance.textContent).not.toContain("access_token");
    expect(provenance.textContent).not.toContain("provenance-must-not-see-this");
    expect(provenance.textContent).not.toContain("provenance-title-must-not-see-this");

    fireEvent.click(within(thought).getByRole("button", { name: "Thinking" }));
    expect(thought.querySelector(".thinking-markdown")?.textContent).toContain("thought-summary-must-not-see-this");
  });

  test("collapsed previews redact standalone provider credentials", () => {
    const githubToken = ["ghp_", "0123456789abcdefghijklmnopqrstuv"].join("");
    const openAiToken = ["sk-proj-", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
    const awsKey = ["AKIA", "0123456789ABCDEF"].join("");
    const message: ChatMessage = {
      ...assistantMessage("standalone-credential-history", [
        { id: "standalone-token-thought", kind: "thinking", text: `Checking ${githubToken}` },
        {
          id: "standalone-token-tool-call",
          kind: "tool_call",
          toolCallId: "standalone-token-tool",
          toolName: "read",
          title: "Read file",
          argumentsJson: JSON.stringify({ path: `/tmp/${openAiToken}` })
        },
        {
          id: "standalone-token-tool-result",
          kind: "tool_result",
          toolCallId: "standalone-token-tool",
          toolName: "read",
          title: "Read file",
          content: "Done"
        },
        { id: "standalone-token-output", kind: "assistant_text", text: "Visible final answer." }
      ]),
      webSearchUsed: [{
        title: `Credential ${awsKey}`,
        url: `https://api.example.test/private/${githubToken}`,
        snippet: ""
      }]
    };
    const harness = mountMessages([message]);
    const thought = harness.container.querySelector(".thinking-item") as HTMLElement;
    const tool = harness.container.querySelector("[data-tool-name='read']") as HTMLElement;
    const provenance = harness.container.querySelector(".web-search-used-line") as HTMLElement;

    expect(thought.textContent).toBe("Thinking");
    expect(tool.textContent).not.toContain(openAiToken);
    expect(provenance.textContent).toContain("https://api.example.test");
    expect(provenance.textContent).not.toContain(githubToken);
    expect(provenance.textContent).not.toContain(awsKey);
  });

  test("memory provenance keeps content behind deliberate disclosure", () => {
    const message: ChatMessage = {
      ...assistantMessage("memory-provenance-disclosure", [
        { id: "memory-output", kind: "assistant_text", text: "Visible final answer." }
      ]),
      memoryUsed: [
        { id: "sensitive-memory", content: "Authorization: Bearer memory-must-not-see-this" }
      ]
    };
    const harness = mountMessages([message]);
    const toggle = screen.getByRole("button", { name: "Memory used" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(harness.container.querySelector(".memory-used-detail")).toBeNull();
    expect(harness.container.textContent).not.toContain("memory-must-not-see-this");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(harness.container.querySelector(".memory-used-detail")?.textContent).toContain("memory-must-not-see-this");
  });

  test("a disclosure opened live stays open after settlement and a persisted reload", () => {
    const liveMessage = {
      ...assistantMessage("stream-disclosure-navigation-0", [
        { id: "navigation-persisted-thought", kind: "thinking" as const, text: "Keep this detail open." },
        { id: "navigation-persisted-output", kind: "assistant_text" as const, text: "Done." }
      ]),
      elapsedMs: undefined
    };
    const harness = mountMessages([liveMessage]);
    const liveToggle = screen.getByRole("button", { name: "Thinking" });
    fireEvent.click(liveToggle);
    expect(liveToggle.getAttribute("aria-expanded")).toBe("true");

    const settledMessage = {
      ...liveMessage,
      id: "persisted-disclosure-navigation",
      renderId: liveMessage.id,
      elapsedMs: 1_400
    };
    harness.rerender(
      <I18nProvider language="en">
        <MessageView
          message={settledMessage}
          onCopy={harness.onCopy}
          onCopyCode={harness.onCopyCode}
          onRetry={harness.onRetry}
          onEdit={harness.onEdit}
          onRemember={harness.onRemember}
        />
      </I18nProvider>
    );
    expect(screen.getByRole("button", { name: "Thinking" }).getAttribute("aria-expanded")).toBe("true");

    harness.unmount();
    const reloaded = mountMessages([{ ...settledMessage, renderId: undefined }]);
    const reloadedToggle = screen.getByRole("button", { name: "Thinking" });
    expect(reloadedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(reloaded.container.querySelector(".thinking-markdown")?.hasAttribute("hidden")).toBe(false);
  });

  test("internal Pi summaries stay behind a lazy disclosure", () => {
    const compactionSummary = "Internal compaction detail that should not dominate routine history.";
    const branchSummary = "Internal branch detail that should also stay compact.";
    const message = assistantMessage("compaction-message", [
      { id: "compaction-entry", kind: "system", title: "Compaction", text: compactionSummary },
      { id: "branch-summary-entry", kind: "system", title: "Branch summary", text: branchSummary },
      { id: "compaction-output", kind: "assistant_text", text: "Visible final answer." }
    ]);
    const harness = mountMessages([message]);
    const rows = harness.container.querySelectorAll<HTMLElement>(".system-summary-item");
    const compactionToggle = within(rows[0]).getByRole("button", { name: "Context compacted" });
    const branchToggle = within(rows[1]).getByRole("button", { name: "Branch summary" });

    expect(compactionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(branchToggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows[0].textContent).not.toContain(compactionSummary);
    expect(rows[1].textContent).not.toContain(branchSummary);
    expect(rows[0].querySelector(".thinking-markdown")).toBeNull();
    expect(rows[1].querySelector(".thinking-markdown")).toBeNull();
    expect(harness.container.querySelector(".timeline-output")?.textContent).toContain("Visible final answer.");

    fireEvent.click(compactionToggle);
    fireEvent.click(branchToggle);
    expect(compactionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(branchToggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows[0].querySelector(".thinking-markdown")?.textContent).toContain(compactionSummary);
    expect(rows[1].querySelector(".thinking-markdown")?.textContent).toContain(branchSummary);
  });

  test("tool rows summarize edit and bash results and replace undecodable output", () => {
    const editMessage = assistantMessage("edit-message", toolTimeline(
      "edit",
      "edit",
      { path: "src/example.ts", oldText: "return 'hello';", newText: "return 'jasmine';" },
      { content: "--- a/src/example.ts\n+++ b/src/example.ts\n-  return 'hello';\n+  return 'jasmine';" }
    ));
    const bashMessage = assistantMessage("bash-message", toolTimeline(
      "bash",
      "bash",
      { command: "ls src/renderer/components/chat" },
      { content: "MessageTimeline.tsx\nMessageView.tsx\nMarkdownMessage.tsx" }
    ));
    const errorMessage = assistantMessage("error-message", toolTimeline(
      "error",
      "bash",
      { command: "taskkill /F /PID 24552" },
      { content: "����: ���� PID 24552\n\nCommand exited with code 1", isError: true }
    ));
    const secretErrorMessage = assistantMessage("secret-error-message", toolTimeline(
      "secret-error",
      "bash",
      { command: "curl https://example.test" },
      { content: "Authorization: Bearer routine-capture-must-not-see-this\nCommand exited with code 1", isError: true }
    ));
    const secretCommandMessage = assistantMessage("secret-command-message", toolTimeline(
      "secret-command",
      "bash",
      { command: "curl -H 'Authorization: Bearer collapsed-command-must-not-see-this' https://example.test" },
      { content: "ok" }
    ));
    const signedUrlMessage = assistantMessage("signed-url-message", toolTimeline(
      "signed-url",
      "fetch_content",
      { url: "https://user:password@api.example.test/private/report?access_token=collapsed-url-must-not-see-this&X-Amz-Signature=signed#secret" },
      { content: "fetched" }
    ));
    const secretSearchMessage = assistantMessage("secret-search-message", toolTimeline(
      "secret-search",
      "web_search",
      { query: "Authorization: Bearer collapsed-query-must-not-see-this" },
      { content: "https://result.example.test" }
    ));
    const signedSearchResultMessage = assistantMessage("signed-search-result-message", toolTimeline(
      "signed-search-result",
      "get_search_content",
      { url: "https://results.example.test/article?id=42&X-Amz-Signature=collapsed-result-url-must-not-see-this" },
      { content: "article" }
    ));
    const harness = mountMessages([
      editMessage,
      bashMessage,
      errorMessage,
      secretErrorMessage,
      secretCommandMessage,
      signedUrlMessage,
      secretSearchMessage,
      signedSearchResultMessage
    ]);

    const editTool = harness.container.querySelector('[data-message-id="edit-message"] .tool-run-item');
    expect(editTool?.textContent).toContain("edit");
    expect(editTool?.textContent).toContain("src/example.ts");
    expect(editTool?.textContent).toContain("edited - +1 -1");

    const bashTool = harness.container.querySelector('[data-message-id="bash-message"] .tool-run-item');
    expect(bashTool?.textContent).toContain("bash");
    expect(bashTool?.textContent).not.toContain("ls src/renderer/components/chat");
    expect(bashTool?.textContent).toContain("done - 3 lines");
    expect(bashTool?.querySelector(".tool-run-details")).toBeNull();
    const bashToggle = bashTool?.querySelector(".tool-run-toggle") as HTMLButtonElement;
    expect(bashToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bashToggle);
    const bashDetails = bashTool?.querySelector(".tool-run-details") as HTMLDivElement;
    expect(bashToggle.getAttribute("aria-expanded")).toBe("true");
    expect(bashDetails.hidden).toBe(false);
    expect(bashDetails.textContent).toContain("COMMAND");
    expect(bashDetails.textContent).toContain("MessageTimeline.tsx");

    const errorTool = harness.container.querySelector('[data-message-id="error-message"] .tool-run-item.error');
    expect(errorTool?.textContent).toContain("exit 1");
    const errorToggle = errorTool?.querySelector(".tool-run-toggle") as HTMLButtonElement;
    expect(errorToggle.getAttribute("aria-expanded")).toBe("false");
    expect(errorTool?.querySelector(".tool-run-details")).toBeNull();
    const secretErrorTool = harness.container.querySelector('[data-message-id="secret-error-message"] .tool-run-item.error');
    expect(secretErrorTool?.querySelector(".tool-run-details")).toBeNull();
    expect(secretErrorTool?.textContent).not.toContain("routine-capture-must-not-see-this");
    const secretCommandTool = harness.container.querySelector('[data-message-id="secret-command-message"] .tool-run-item');
    expect(secretCommandTool?.querySelector(".tool-run-details")).toBeNull();
    expect(secretCommandTool?.textContent).not.toContain("collapsed-command-must-not-see-this");
    const signedUrlTool = harness.container.querySelector('[data-message-id="signed-url-message"] .tool-run-item') as HTMLElement;
    expect(signedUrlTool.textContent).toContain("https://api.example.test/private/report");
    expect(signedUrlTool.textContent).not.toContain("password");
    expect(signedUrlTool.textContent).not.toContain("access_token");
    expect(signedUrlTool.textContent).not.toContain("collapsed-url-must-not-see-this");
    expect(signedUrlTool.getAttribute("aria-label")).not.toContain("collapsed-url-must-not-see-this");
    const signedUrlToggle = signedUrlTool.querySelector(".tool-run-toggle") as HTMLButtonElement;
    fireEvent.click(signedUrlToggle);
    expect(signedUrlTool.querySelector(".tool-run-details")?.textContent).toContain("collapsed-url-must-not-see-this");
    const secretSearchTool = harness.container.querySelector('[data-message-id="secret-search-message"] .tool-run-item') as HTMLElement;
    expect(secretSearchTool.textContent).not.toContain("collapsed-query-must-not-see-this");
    expect(secretSearchTool.getAttribute("aria-label")).not.toContain("collapsed-query-must-not-see-this");
    expect(secretSearchTool.querySelector(".tool-run-details")).toBeNull();
    const signedSearchResultTool = harness.container.querySelector('[data-message-id="signed-search-result-message"] .tool-run-item') as HTMLElement;
    expect(signedSearchResultTool.textContent).toContain("https://results.example.test/article");
    expect(signedSearchResultTool.textContent).not.toContain("X-Amz-Signature");
    expect(signedSearchResultTool.textContent).not.toContain("collapsed-result-url-must-not-see-this");
    fireEvent.click(errorToggle);
    const errorDetails = errorTool?.querySelector(".tool-run-details") as HTMLDivElement;
    expect(errorToggle.getAttribute("aria-expanded")).toBe("true");
    expect(errorDetails.hidden).toBe(false);
    expect(errorDetails.textContent).toContain("Output encoding could not be decoded.");
    expect(errorDetails.textContent).not.toContain("�");
    fireEvent.click(errorToggle);
    expect(errorToggle.getAttribute("aria-expanded")).toBe("false");
    expect(errorDetails.hidden).toBe(true);
    expect(errorDetails.textContent).toContain("Output encoding could not be decoded.");
    expect(errorDetails.textContent).not.toContain("�");

    // Do not wait on Shiki here: highlighting remains covered by real-renderer
    // E2E. Unmounting also cancels its async state updates for this summary test.
    harness.unmount();
  });

  test("image attachments render a thumbnail and open an Escape-dismissable preview without leaking the path", () => {
    const imagePath = "C:\\private\\attachments\\red-square.png";
    const previewDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const message: ChatMessage = {
      id: "image-message",
      threadId: "renderer-message-thread",
      role: "user",
      content: "What color is this image?",
      createdAt,
      attachments: [{
        name: "red-square.png",
        path: imagePath,
        kind: "file",
        mediaType: "image/png",
        isImage: true,
        previewDataUrl
      }]
    };
    const harness = mountMessages([message]);

    const grid = harness.container.querySelector(".message-image-grid");
    const thumbnail = within(grid as HTMLElement).getByRole("img", { name: "red-square.png" });
    expect(thumbnail.getAttribute("src")).toBe(previewDataUrl);
    expect(harness.container.querySelectorAll(".message-image-grid img")).toHaveLength(1);
    expect(harness.container.querySelector(".user-bubble")?.textContent).not.toContain(imagePath);

    fireEvent.click(screen.getByRole("button", { name: "Preview red-square.png" }));
    const dialog = screen.getByRole("dialog", { name: "red-square.png" });
    expect(within(dialog).getByRole("img", { name: "red-square.png" }).getAttribute("src")).toBe(previewDataUrl);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "red-square.png" })).toBeNull();
  });

  test("interpolated tool and attachment accessible names follow the interface language", () => {
    const toolMessage = assistantMessage("localized-tool", toolTimeline(
      "localized",
      "edit",
      { path: "src/example.ts", oldText: "old", newText: "new" },
      { content: "- old\n+ new" }
    ));
    const imageMessage: ChatMessage = {
      id: "localized-image",
      threadId: "renderer-message-thread",
      role: "user",
      content: "看图",
      createdAt,
      attachments: [{
        name: "red-square.png",
        path: "C:\\private\\red-square.png",
        kind: "file",
        mediaType: "image/png",
        isImage: true,
        previewDataUrl: "data:image/png;base64,iVBORw0KGgo="
      }]
    };

    const harness = mountMessages([toolMessage, imageMessage], "zh");
    const localizedTool = harness.container.querySelector('[data-message-id="localized-tool"] .tool-run-item');
    expect(localizedTool?.getAttribute("aria-label")).toBe("工具 edit src/example.ts");
    expect(localizedTool?.querySelector(".tool-run-toggle")?.getAttribute("aria-label"))
      .toBe("编辑 src/example.ts 已编辑 · +1 -1");
    expect(screen.getByRole("button", { name: "预览 red-square.png" })).toBeDefined();
  });
});
