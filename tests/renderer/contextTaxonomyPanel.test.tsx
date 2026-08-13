import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { AppLanguage, ContextTaxonomy, ContextTaxonomyItem, ContextTaxonomyPart, ContextTaxonomySegment } from "../../src/shared/ipc";
import { TaxonomyView } from "../../src/renderer/components/chat/ContextTaxonomyView";
import { I18nProvider } from "../../src/renderer/i18n";
import { installFakeBridge } from "./fakeBridge";

/**
 * The Context taxonomy panel is renderer state end to end: grouping, budget
 * arithmetic, default expansion, filtering. None of it needs Electron, so it
 * lives here rather than in tests/e2e, where each case costs a process launch.
 * What stays in E2E is the layout half -- sticky offsets and left-truncated
 * JSONPaths -- which jsdom cannot measure.
 */

function part(input: Partial<ContextTaxonomyPart> & { kind: ContextTaxonomyPart["kind"]; title: string; tokenEstimate: number }): ContextTaxonomyPart {
  return {
    order: 1,
    text: `${input.title} body`,
    format: "json",
    payloadPath: `$.${input.title.replace(/\W+/g, "_")}`,
    ...input
  };
}

function segment(title: string, kind: ContextTaxonomySegment["kind"], tokenEstimate: number): ContextTaxonomySegment {
  return { title, kind, confidence: 0.9, tokenEstimate, text: `${title} text` };
}

/**
 * Mirrors what src/main/agent/extensions/contextCapture/classifier.ts actually
 * emits, including the envelope `metadata` parts it attaches to every message
 * and the single `metadata` part it gives a tool definition. Both shapes are
 * the reason the panel needs its own attribution rules.
 */
function fixtureItems(): ContextTaxonomyItem[] {
  return [
    {
      order: 1,
      role: "system",
      source: "provider.payload.messages",
      label: "Provider message 1",
      kind: "system_prompt",
      payloadPath: "$.messages[0]",
      tokenEstimate: 500,
      preview: "You are Jasmine",
      text: "You are Jasmine",
      segments: [segment("System prompt", "system_prompt", 300), segment("Project context", "project_context", 200)],
      parts: [
        part({ kind: "metadata", title: "Role", tokenEstimate: 1 }),
        part({ kind: "text", title: "Text", tokenEstimate: 499 }),
        part({ kind: "unclassified", title: "Unclassified: cache_control", tokenEstimate: 7, payloadPath: "$.messages[0].cache_control" })
      ]
    },
    {
      order: 2,
      role: "assistant",
      source: "provider.payload.messages",
      label: "Provider message 2",
      kind: "conversation_history",
      payloadPath: "$.messages[1]",
      tokenEstimate: 151,
      preview: "thinking",
      text: "thinking",
      parts: [
        part({ kind: "metadata", title: "Role", tokenEstimate: 1 }),
        part({ kind: "reasoning", title: "Reasoning", tokenEstimate: 120, format: "markdown" }),
        part({ kind: "tool_call", title: "Tool call: read_file", tokenEstimate: 30, toolName: "read_file", toolCallId: "call_a91f" })
      ]
    },
    {
      order: 3,
      role: "tool",
      source: "provider.payload.messages",
      label: "Provider message 3",
      kind: "conversation_history",
      payloadPath: "$.messages[2]",
      tokenEstimate: 806,
      preview: "file contents",
      text: "file contents",
      parts: [
        part({ kind: "metadata", title: "Role", tokenEstimate: 1 }),
        part({ kind: "tool_result", title: "Tool result", tokenEstimate: 800, toolName: "read_file", toolCallId: "call_a91f" }),
        part({ kind: "metadata", title: "Tool name", tokenEstimate: 2 }),
        part({ kind: "metadata", title: "Tool call id", tokenEstimate: 3 })
      ]
    },
    {
      order: 4,
      role: "user",
      source: "provider.payload.messages",
      label: "Current user prompt",
      kind: "current_user_prompt",
      payloadPath: "$.messages[3]",
      tokenEstimate: 41,
      preview: "redesign the panel",
      text: "redesign the panel",
      parts: [
        part({ kind: "metadata", title: "Role", tokenEstimate: 1 }),
        part({ kind: "text", title: "Text", tokenEstimate: 40, format: "markdown" })
      ]
    },
    {
      order: 5,
      role: "tool_definition",
      source: "provider.payload.tools",
      label: "Tool definition: read_file",
      kind: "tool_definition",
      payloadPath: "$.tools[0]",
      tokenEstimate: 200,
      preview: "read_file",
      text: "{}",
      parts: [part({ kind: "metadata", title: "Tool definition", tokenEstimate: 200 })]
    },
    {
      order: 6,
      role: "request_options",
      source: "provider.payload.options",
      label: "Provider request options",
      kind: "provider_options",
      payloadPath: "$",
      tokenEstimate: 9,
      preview: "options",
      text: "{}",
      parts: [
        part({ kind: "metadata", title: "Option: model", tokenEstimate: 5 }),
        part({ kind: "metadata", title: "Option: temperature", tokenEstimate: 4 })
      ]
    },
    {
      order: 7,
      role: "unclassified",
      source: "provider.payload.unclassified",
      label: "Unclassified provider payload fields",
      kind: "unclassified",
      payloadPath: "$",
      tokenEstimate: 12,
      preview: "stream_options",
      text: "{}",
      parts: [part({ kind: "unclassified", title: "Unclassified: stream_options", tokenEstimate: 12, payloadPath: "$.stream_options" })]
    }
  ];
}

function fixture(overrides: Partial<ContextTaxonomy> = {}): ContextTaxonomy {
  return {
    capturedAt: "2026-08-13T06:32:07.000Z",
    provider: "deepseek",
    model: "deepseek-chat",
    source: "provider-payload",
    payloadHash: "8f2ac1d0e4b7aa11",
    payloadSchemaVersion: 7,
    rawState: "complete",
    rawByteCount: 4096,
    payloadShape: { topLevelOrder: ["model", "messages", "tools"], messageCount: 4, toolCount: 1 },
    cacheMetrics: {
      source: "assistant-usage",
      status: "hit",
      inputTokens: 1800,
      cacheHitTokens: 1400,
      cacheMissTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 120,
      totalTokens: 1920,
      hitRate: 1400 / 1800,
      note: "Provider usage parsed by Pi."
    },
    items: fixtureItems(),
    ...overrides
  };
}

function renderPanel(
  taxonomy = fixture(),
  props: Partial<Parameters<typeof TaxonomyView>[0]> = {},
  language: AppLanguage = "en"
) {
  installFakeBridge();
  const view = render(
    <I18nProvider language={language}>
      <TaxonomyView taxonomy={taxonomy} captureId="capture-1" {...props} />
    </I18nProvider>
  );
  return {
    ...view,
    text(selector: string): string[] {
      return Array.from(view.container.querySelectorAll(selector)).map((node) => node.textContent?.trim() ?? "");
    },
    button(name: string): HTMLElement {
      const match = Array.from(view.container.querySelectorAll("button")).find((node) => node.textContent?.trim() === name);
      if (!match) throw new Error(`No button labelled "${name}".`);
      return match;
    }
  };
}

describe("context taxonomy panel", () => {
  test("files every item under its section, in a fixed section order", () => {
    const panel = renderPanel();

    expect(panel.text(".taxonomy-group-name")).toEqual([
      "Instructions",
      "Conversation",
      "Current prompt",
      "Tools",
      "Request options",
      "Unknown fields"
    ]);
    expect(panel.text(".taxonomy-item-title")).toEqual([
      "System prompt",
      "Assistant turn",
      "Tool turn",
      "Current user prompt",
      "read_file",
      "Request options",
      "Other payload fields"
    ]);
  });

  test("credits tool definitions and request options to themselves, not to metadata", () => {
    const panel = renderPanel();

    // The classifier describes a tool definition with a single `metadata` part,
    // so attributing composition by part kind filed every tool definition --
    // 12% of this fixture, and far more in a real capture -- under "Metadata".
    const legend = panel.text(".taxonomy-legend button");
    expect(legend[0]).toContain("Tool results");
    expect(legend[0]).toContain("800");
    expect(legend).toContainEqual(expect.stringContaining("Tool definitions"));
    expect(legend.find((row) => row.includes("Tool definitions"))).toContain("200");
    expect(legend.some((row) => row.startsWith("Metadata"))).toBe(false);

    // Every bucket still adds up to the whole payload.
    const total = panel.text(".taxonomy-legend-value").reduce((sum, value) => sum + Number(value.replace(/,/g, "")), 0);
    expect(total).toBe(1719);
  });

  test("legend filters reveal the items that contributed each composition bucket", () => {
    const panel = renderPanel();
    const legendButton = (label: string) => {
      const match = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-legend button"))
        .find((node) => node.textContent?.startsWith(label));
      if (!match) throw new Error(`No legend button starting with "${label}".`);
      return match;
    };

    // The assistant item contains reasoning and a tool call, but no text
    // tokens. Its base message kind must not make it appear under Text.
    fireEvent.click(legendButton("Text"));
    expect(panel.text(".taxonomy-item-title")).not.toContain("Assistant turn");
    expect(panel.text(".taxonomy-item-title")).toContain("Current user prompt");

    fireEvent.click(legendButton("Text"));
    fireEvent.click(legendButton("Options & metadata"));
    // Its folded role token is attributed to Options & metadata, so this
    // filter must reveal the same item that contributed that token.
    expect(panel.text(".taxonomy-item-title")).toContain("Assistant turn");
  });

  test("attributes an empty message's folded envelope fields to metadata", () => {
    const items = fixtureItems();
    items.push({
      order: 8,
      role: "assistant",
      source: "provider.payload.messages",
      label: "Provider message 5",
      kind: "conversation_history",
      payloadPath: "$.messages[4]",
      tokenEstimate: 1,
      preview: "",
      text: "",
      parts: [part({
        kind: "metadata",
        title: "Role",
        tokenEstimate: 1,
        payloadPath: "$.messages[4].role"
      })]
    });
    const panel = renderPanel(fixture({ items }));
    const filter = panel.container.querySelector<HTMLInputElement>(".taxonomy-filter");
    if (!filter) throw new Error("Filter input did not render.");
    fireEvent.change(filter, { target: { value: "$.messages[4]" } });
    expect(panel.text(".taxonomy-item-title")).toEqual(["Assistant turn"]);

    const metadata = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-legend button"))
      .find((node) => node.textContent?.startsWith("Options & metadata"));
    expect(metadata?.textContent).toContain("19");
    fireEvent.click(metadata!);
    expect(panel.text(".taxonomy-item-title")).toEqual(["Assistant turn"]);

    const emptyMessage = panel.container.querySelector<HTMLElement>(".taxonomy-item");
    fireEvent.click(panel.button("Expand all"));
    expect(emptyMessage?.querySelector(".taxonomy-item-meta")?.textContent).toContain("assistant");
    expect(emptyMessage?.querySelector(".taxonomy-body")).toBeNull();
  });

  test("an instruction message keeps the wire fields its segments do not cover", () => {
    const panel = renderPanel();
    fireEvent.click(panel.button("Expand all"));

    // Segments re-split the message's own text, so the `text` part is already
    // represented -- but its siblings are not. Dropping them let the unknown
    // chip name a path that selecting the Unknown legend could not reveal.
    const system = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item"))
      .find((node) => node.querySelector(".taxonomy-item-title")?.textContent === "System prompt");
    if (!system) throw new Error("System prompt item did not render.");

    expect(Array.from(system.querySelectorAll(".taxonomy-tag")).map((node) => node.textContent))
      .toEqual(["system_prompt", "project_context", "unclassified"]);
    expect(system.querySelector(".taxonomy-part[open] .taxonomy-part-meta")?.textContent).toContain("$.messages[0].cache_control");
    expect(system.querySelector(".taxonomy-item-meta")?.textContent).toContain("+1 envelope field");
    // The classifier builds instruction segments from the complete wire text,
    // including the role and unknown field. Preserve those rows and their
    // buckets, but reserve their 8 tokens from the segment budget so the item
    // still equals the classifier's original 500-token estimate.
    expect(system.querySelector(".taxonomy-item-tokens")?.textContent).toBe("500");

    const unknownLegend = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-legend button"))
      .find((node) => node.textContent?.includes("Unknown"));
    fireEvent.click(unknownLegend!);
    expect(panel.text(".taxonomy-item-title")).toEqual(["System prompt", "Other payload fields"]);
  });

  test("instruction segments replace only text and preserve classified non-text wire parts", () => {
    const items = fixtureItems();
    const instruction = items[0];
    items[0] = {
      ...instruction,
      tokenEstimate: 520,
      segments: [segment("System prompt", "system_prompt", 312), segment("Project context", "project_context", 208)],
      parts: [
        ...(instruction.parts ?? []),
        part({
          order: 4,
          kind: "attachment",
          title: "Attachment: requirements.md",
          tokenEstimate: 20,
          payloadPath: "$.messages[0].content[1]"
        })
      ]
    };

    const panel = renderPanel(fixture({ items }));
    fireEvent.click(panel.button("Expand all"));

    const system = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item"))
      .find((node) => node.querySelector(".taxonomy-item-title")?.textContent === "System prompt");
    if (!system) throw new Error("System prompt item did not render.");

    expect(Array.from(system.querySelectorAll(".taxonomy-tag")).map((node) => node.textContent))
      .toEqual(["system_prompt", "project_context", "unclassified", "attachment"]);
    expect(system.textContent).toContain("$.messages[0].content[1]");
    expect(system.querySelector(".taxonomy-item-tokens")?.textContent).toBe("520");

    const attachments = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-legend button"))
      .find((node) => node.textContent?.startsWith("Attachments"));
    expect(attachments?.textContent).toContain("20");
    fireEvent.click(attachments!);
    expect(panel.text(".taxonomy-item-title")).toEqual(["System prompt"]);
  });

  test("the filter reaches JSONPaths that only exist on a part", () => {
    const panel = renderPanel();
    const filter = panel.container.querySelector<HTMLInputElement>(".taxonomy-filter");
    if (!filter) throw new Error("Filter input did not render.");

    // The control says it filters paths, and a nested path is not visible while
    // its item is collapsed, so it has to be in the index rather than the DOM.
    fireEvent.change(filter, { target: { value: "$.messages[0].cache_control" } });
    expect(panel.text(".taxonomy-item-title")).toEqual(["System prompt"]);
  });

  test("shows the actual input total against the estimate", () => {
    const panel = renderPanel();

    expect(panel.container.querySelector(".taxonomy-total-value")?.textContent).toBe("1,800");
    expect(panel.container.querySelector(".taxonomy-total-label")?.textContent).toBe("actual input tokens");
    expect(panel.container.querySelector(".taxonomy-total-estimate")?.textContent).toContain("est. 1,719");
    expect(panel.container.querySelector(".taxonomy-total-estimate")?.textContent).toContain("4.5%");
  });

  test("falls back to the estimate when the provider reported no usage", () => {
    const panel = renderPanel(fixture({ cacheMetrics: undefined }));

    expect(panel.container.querySelector(".taxonomy-total-value")?.textContent).toBe("1,719");
    expect(panel.container.querySelector(".taxonomy-total-label")?.textContent).toBe("estimated input tokens");
    expect(panel.container.querySelector(".taxonomy-total-estimate")).toBeNull();
  });

  test("folds message envelope fields into the meta line but keeps their tokens", () => {
    const panel = renderPanel();
    fireEvent.click(panel.button("Expand all"));

    const toolTurn = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item"))
      .find((node) => node.querySelector(".taxonomy-item-title")?.textContent === "Tool turn");
    if (!toolTurn) throw new Error("Tool turn item did not render.");

    // role, name and tool_call_id are one content-free row per message in the
    // tree, and they are already named by the meta line.
    expect(Array.from(toolTurn.querySelectorAll(".taxonomy-tag")).map((node) => node.textContent)).toEqual(["tool_result"]);
    expect(toolTurn.querySelector(".taxonomy-item-meta")?.textContent).toContain("+3 envelope fields");
    // Folded rows are hidden, not dropped: the item still accounts for them.
    expect(toolTurn.querySelector(".taxonomy-item-tokens")?.textContent).toBe("806");
  });

  test("keeps the more specific JSONPath when a lone part collapses into its item", () => {
    const panel = renderPanel();
    fireEvent.click(panel.button("Expand all"));

    // An unknown-fields item is a container at "$" holding one field part. When
    // the part row collapses into the item body, the path that identifies the
    // field has to come with it -- "$" alone names nothing.
    const unknown = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item"))
      .find((node) => node.querySelector(".taxonomy-item-title")?.textContent === "Other payload fields");
    expect(unknown?.querySelector(".taxonomy-item-meta")?.textContent).toContain("$.stream_options");
    expect(unknown?.querySelectorAll(".taxonomy-part")).toHaveLength(0);
  });

  test("opens only the current user prompt", () => {
    const panel = renderPanel();

    const open = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item[open]"));
    expect(open).toHaveLength(1);
    expect(open[0].querySelector(".taxonomy-item-title")?.textContent).toBe("Current user prompt");
    expect(panel.container.querySelectorAll(".taxonomy-part[open]")).toHaveLength(0);
    // A closed <details> only hides its descendants in CSS. If the bodies are
    // still mounted, a large capture duplicates the complete conversation into
    // hundreds of Markdown/code DOM subtrees and makes unrelated typing lag.
    expect(panel.container.querySelectorAll(".taxonomy-item-body")).toHaveLength(1);
    expect(panel.container.querySelectorAll(".taxonomy-part-body")).toHaveLength(0);
  });

  test("expand all opens every item and part, and collapses back", () => {
    const panel = renderPanel();

    fireEvent.click(panel.button("Expand all"));
    expect(panel.container.querySelectorAll(".taxonomy-item[open]")).toHaveLength(7);
    expect(panel.container.querySelectorAll(".taxonomy-part[open]").length).toBeGreaterThan(0);

    fireEvent.click(panel.button("Collapse all"));
    expect(panel.container.querySelectorAll(".taxonomy-item[open]")).toHaveLength(0);
  });

  test("the filter narrows the tree to matching items and restores it", () => {
    const panel = renderPanel();
    const filter = panel.container.querySelector<HTMLInputElement>(".taxonomy-filter");
    if (!filter) throw new Error("Filter input did not render.");

    // The filter reaches into part titles and tool names, so the turn that
    // called read_file and the turn that carries its result both survive.
    fireEvent.change(filter, { target: { value: "read_file" } });
    expect(panel.text(".taxonomy-group-name")).toEqual(["Conversation", "Tools"]);
    expect(panel.text(".taxonomy-item-title")).toEqual(["Assistant turn", "Tool turn", "read_file"]);

    fireEvent.change(filter, { target: { value: "nothing matches this" } });
    expect(panel.container.querySelector(".taxonomy-empty")?.textContent).toContain("No context items match");

    fireEvent.change(filter, { target: { value: "" } });
    expect(panel.text(".taxonomy-item-title")).toHaveLength(7);
  });

  test("a legend row filters the tree by its bucket and toggles off", () => {
    const panel = renderPanel();
    const toolResults = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-legend button"))
      .find((node) => node.textContent?.includes("Tool results"));
    if (!toolResults) throw new Error("Tool results legend row did not render.");

    fireEvent.click(toolResults);
    expect(toolResults.getAttribute("aria-pressed")).toBe("true");
    expect(panel.text(".taxonomy-item-title")).toEqual(["Tool turn"]);
    expect(panel.container.querySelectorAll(".taxonomy-bar span.dimmed")).toHaveLength(7);

    fireEvent.click(toolResults);
    expect(toolResults.getAttribute("aria-pressed")).toBe("false");
    expect(panel.text(".taxonomy-item-title")).toHaveLength(7);
  });

  test("a status chip expands its own detail inside the budget card", () => {
    const panel = renderPanel();
    expect(panel.container.querySelectorAll(".taxonomy-status-detail")).toHaveLength(0);

    const cache = panel.container.querySelector<HTMLElement>(".taxonomy-chip");
    if (!cache) throw new Error("Cache chip did not render.");
    fireEvent.click(cache);

    const detail = panel.container.querySelector(".taxonomy-status-detail");
    expect(detail?.textContent).toContain("1,400");
    expect(detail?.textContent).toContain("Cache miss");
  });

  test("unknown payload fields raise a chip carrying their exact paths", () => {
    const panel = renderPanel();
    const chip = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-chip"))
      .find((node) => node.textContent?.includes("unknown field"));
    if (!chip) throw new Error("Unknown-field chip did not render.");

    expect(chip.textContent).toBe("2 unknown fields");
    expect(chip.dataset.tone).toBe("bad");
    fireEvent.click(chip);
    const detail = panel.container.querySelector(".taxonomy-status-detail")?.textContent ?? "";
    expect(detail).toContain("$.stream_options");
    expect(detail).toContain("$.messages[0].cache_control");
  });

  test("a failed reasoning check opens the reasoning it is about", () => {
    const panel = renderPanel(fixture({
      reasoningValidation: {
        status: "fail",
        policyId: "deepseek-tool-interval-v1",
        policyVersion: 1,
        summary: "A required reasoning block was not sent back.",
        requiredCount: 2,
        sentCount: 1,
        blocks: []
      }
    }));

    const open = Array.from(panel.container.querySelectorAll<HTMLElement>(".taxonomy-item[open]"))
      .map((node) => node.querySelector(".taxonomy-item-title")?.textContent);
    expect(open).toContain("Assistant turn");
    expect(panel.text(".taxonomy-part[open] .taxonomy-tag")).toEqual(["reasoning"]);
    expect(panel.container.querySelector(".taxonomy-chip[data-tone='bad']")?.textContent).toBe("Reasoning dropped");
  });

  test("toolbar and diagnostic control names follow the Chinese interface language", async () => {
    const panel = renderPanel(fixture({
      source: "jasmine-assembly",
      assemblyReason: "no-capture",
      reasoningValidation: {
        status: "fail",
        policyId: "deepseek-tool-interval-v1",
        policyVersion: 1,
        summary: "A required reasoning block was not sent back.",
        requiredCount: 2,
        sentCount: 1,
        blocks: []
      }
    }), {}, "zh");

    expect(panel.button("全部展开")).toBeDefined();
    expect(panel.button("重建的近似结果")).toBeDefined();
    expect(panel.button("缓存命中率 77.8%")).toBeDefined();
    expect(panel.button("推理 已丢弃")).toBeDefined();
    expect(panel.button("2 个未知字段")).toBeDefined();
    expect(panel.button("复制全部")).toBeDefined();
    expect(panel.text(".taxonomy-group-name")).toEqual(["说明", "对话", "当前提示", "工具", "请求选项", "未知字段"]);
    expect(panel.text(".taxonomy-legend-label")).toContain("工具调用");
    expect(panel.text(".taxonomy-item-title")).toContain("当前用户提示");
    expect(panel.container.querySelector(".taxonomy-raw-head")?.textContent).toContain("脱敏后的原始载荷");
    expect(panel.container.querySelector(".taxonomy-raw-head")?.textContent).toContain("完整 · 4,096 字节");

    const hash = panel.container.querySelector<HTMLElement>(".taxonomy-head-hash");
    if (!hash) throw new Error("Payload hash button did not render.");
    fireEvent.click(hash);
    await waitFor(() => expect(hash.textContent).toBe("复制失败"));
  });

  test("a reconstructed capture is marked in the header and explained by a chip", () => {
    const panel = renderPanel(fixture({ source: "jasmine-assembly", assemblyReason: "no-capture" }));

    expect(panel.container.querySelector(".taxonomy-head-approximate")?.textContent).toBe("approximate");
    const chip = panel.container.querySelector<HTMLElement>(".taxonomy-chip[data-tone='bad']");
    expect(chip?.textContent).toBe("Reconstructed approximation");
    fireEvent.click(chip!);
    expect(panel.container.querySelector(".taxonomy-status-detail")?.textContent).toContain("no-capture");
  });

  test("the request switcher reports the request the user picked", () => {
    const onSelectCapture = vi.fn();
    const panel = renderPanel(fixture(), {
      captureId: "c2",
      captures: [
        { id: "c1", requestIndex: 1, requestCount: 2 },
        { id: "c2", requestIndex: 2, requestCount: 2 }
      ],
      onSelectCapture
    });

    const switcher = panel.container.querySelectorAll<HTMLElement>(".taxonomy-request-switcher button");
    expect(switcher).toHaveLength(2);
    expect(switcher[1].getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(switcher[0]);
    expect(onSelectCapture).toHaveBeenCalledWith("c1");
  });

  test("reports a payload-hash clipboard failure instead of claiming success", async () => {
    const panel = renderPanel();
    const hash = panel.container.querySelector<HTMLElement>(".taxonomy-head-hash");
    if (!hash) throw new Error("Payload hash button did not render.");

    // The strict renderer bridge intentionally has no clipboard method, so the
    // real click exercises the user-visible rejection path.
    fireEvent.click(hash);
    await waitFor(() => expect(hash.textContent).toBe("copy failed"));
    expect(hash.getAttribute("title")).toContain("Fake desktop bridge has no");
  });

  test("a single capture shows no switcher", () => {
    const panel = renderPanel(fixture(), { captures: [{ id: "capture-1", requestIndex: 1, requestCount: 1 }], onSelectCapture: vi.fn() });
    expect(panel.container.querySelector(".taxonomy-request-switcher")).toBeNull();
  });
});
