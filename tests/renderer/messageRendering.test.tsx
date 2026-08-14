import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatTimelineItem } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { MessageView } from "../../src/renderer/components/chat/MessageView";

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
    const harness = mountMessages([editMessage, bashMessage, errorMessage]);

    const editTool = harness.container.querySelector('[data-message-id="edit-message"] .tool-run-item');
    expect(editTool?.textContent).toContain("edit");
    expect(editTool?.textContent).toContain("src/example.ts");
    expect(editTool?.textContent).toContain("edited - +1 -1");

    const bashTool = harness.container.querySelector('[data-message-id="bash-message"] .tool-run-item');
    expect(bashTool?.textContent).toContain("bash");
    expect(bashTool?.textContent).toContain("ls src/renderer/components/chat");
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
