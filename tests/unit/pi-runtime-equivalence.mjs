import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const fakeProviderSecret = ["sk", "test-fixture-1234567890"].join("-");
const invalidProviderSecret = ["sk", "invalid-provider-fixture-0987654321"].join("-");
const unrelatedAccessToken = "access-token-fixture-abcdef1234567890";
const unrelatedJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYXNtaW5lIn0.fixture-signature";

const { buildJasminePromptAppend, buildLocalRuntimePromptAppend, generateAssistantReply, resolvePiShellRuntime } = await import("../../dist/main/main/agent/runtime.js");
const {
  buildTurnContext,
  createAskUserQuestionTool,
  isJasmineFileChangesPackageExtensionPath,
  isJasmineFileChangesPackageSourcePath,
  runPiCodingAgentChat
} = await import("../../dist/main/main/agent/providers/piCodingAgent.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { classifyTextSegments, estimateTokens, providerPayloadToContextTaxonomy, withContextCacheMetrics, withMissingContextTaxonomySegments } = await import("../../dist/main/main/agent/extensions/contextCapture/classifier.js");
const { validateReasoningRetention } = await import("../../dist/main/main/agent/extensions/contextCapture/reasoningPolicy.js");
const { modelContentForMessage, nonSecretError } = await import("../../dist/main/main/ipc/chatSupport.js");
const { prepareEnabledSkillManifests } = await import("../../dist/main/main/services/skillManifests.js");
const { jasmineSessionDir } = await import("../../dist/main/main/services/piSessions.js");
const { listExecutableDiscovery, resolveConfiguredExecutable } = await import("../../dist/main/main/services/executables.js");
const { fallbackTitle, generateTitleWithProvider, generateTitleWithProviderResult } = await import("../../dist/main/main/services/threadTitles.js");
const { testProvider } = await import("../../dist/main/main/services/providers.js");
const {
  listPluginPackages,
  listPluginSkills,
  resolveEnabledPackageSkillPaths,
  resolvePluginPackageRuntimeSources,
  resolvePiWebAccessPackageRoot,
  setPluginPackageEnabled
} = await import("../../dist/main/main/services/plugins.js");
const { pluginPackageInstallSchema } = await import("../../dist/main/shared/schemas.js");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const tempDir = await mkdtemp(path.join(tmpdir(), "jasmine-pi-equivalence-"));
const userDataDir = path.join(tempDir, "user-data");
const agentDir = path.join(userDataDir, "pi-agent");
await mkdir(agentDir, { recursive: true });
const fakeBashPath = path.join(tempDir, "bash.exe");
const fakePowerShellPath = path.join(tempDir, "powershell.exe");
const fakeCmdPath = path.join(tempDir, "cmd.exe");
await writeFile(fakeBashPath, "");
await writeFile(fakePowerShellPath, "");
await writeFile(fakeCmdPath, "");

const shortSessionCwd = path.join(tempDir, "short-workspace");
const legacyShortComponent = `--${path.resolve(shortSessionCwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
assert.equal(path.basename(jasmineSessionDir(userDataDir, shortSessionCwd)), legacyShortComponent);

const longAsciiSessionCwd = path.join(tempDir, "a".repeat(400));
const longMultibyteSessionCwd = path.join(tempDir, "界".repeat(120));
const longAsciiComponent = path.basename(jasmineSessionDir(userDataDir, longAsciiSessionCwd));
const longMultibyteComponent = path.basename(jasmineSessionDir(userDataDir, longMultibyteSessionCwd));
assert.match(longAsciiComponent, /^--cwd-sha256-[0-9a-f]{64}--$/);
assert.match(longMultibyteComponent, /^--cwd-sha256-[0-9a-f]{64}--$/);
assert.equal(Buffer.byteLength(longAsciiComponent, "utf8") < 100, true);
assert.equal(Buffer.byteLength(longMultibyteComponent, "utf8") < 100, true);
assert.equal(path.basename(jasmineSessionDir(userDataDir, longAsciiSessionCwd)), longAsciiComponent);
assert.notEqual(longAsciiComponent, longMultibyteComponent);

assert.throws(() => pluginPackageInstallSchema.parse({ source: "" }), /Package source is required/);
assert.throws(() => pluginPackageInstallSchema.parse({ source: `npm:bad\nsource` }), /control characters/);

const askUserQuestionTool = createAskUserQuestionTool(async (prompt) => ({
  id: "unit-question",
  answers: [
    {
      questionId: prompt.questions[0].id,
      question: prompt.questions[0].question,
      answer: prompt.questions[0].options[1].label,
      custom: false,
      selectedIndex: 2,
      selectedOptionLabel: prompt.questions[0].options[1].label
    },
    {
      questionId: prompt.questions[1].id,
      question: prompt.questions[1].question,
      answer: "Keep the batch compact.",
      custom: true
    }
  ]
}));
assert.equal(askUserQuestionTool.name, "AskUserQuestion");
assert.match(askUserQuestionTool.description, /context prompt explicitly says AskUserQuestion is allowed/);
assert.match(askUserQuestionTool.description, /one to three/);
const askUserQuestionToolResult = await askUserQuestionTool.execute("ask-call-1", {
  questions: [
    {
      id: "implementation",
      header: "Implementation",
      question: "Which implementation should Jasmine use?",
      options: [
        { label: "Use local state", description: "Keep the change renderer-only." },
        { label: "Use main-process IPC", description: "Wait on an Electron dialog." }
      ]
    },
    {
      id: "followup",
      header: "Follow-up",
      question: "How should follow-up questions be handled?",
      options: [
        { label: "Ask one at a time" },
        { label: "Batch related questions" }
      ]
    }
  ]
});
assert.match(askUserQuestionToolResult.content[0].text, /User has answered your questions:/);
assert.match(askUserQuestionToolResult.content[0].text, /implementation \(2\): Use main-process IPC/);
assert.match(askUserQuestionToolResult.content[0].text, /followup \(custom\): Keep the batch compact/);
assert.deepEqual(askUserQuestionToolResult.details.questions[0].options, ["Use local state", "Use main-process IPC"]);
assert.equal(askUserQuestionToolResult.details.answers[0].wasCustom, false);
assert.equal(askUserQuestionToolResult.details.answers[1].wasCustom, true);

const customAskUserQuestionTool = createAskUserQuestionTool(async () => ({
  id: "unit-question-custom",
  answers: [{
    questionId: "question_1",
    question: "What should the user answer?",
    answer: "Use a scoped app-owned custom tool.",
    custom: true
  }]
}));
const customAskUserQuestionToolResult = await customAskUserQuestionTool.execute("ask-call-2", {
  question: "What should the user answer?",
  options: [{ label: "A" }, { label: "B" }]
});
assert.match(customAskUserQuestionToolResult.content[0].text, /question_1 \(custom\): Use a scoped app-owned custom tool/);
assert.equal(customAskUserQuestionToolResult.details.answers[0].wasCustom, true);

const classifierTaxonomy = providerPayloadToContextTaxonomy({
  model: "jasmine-test",
  apiKey: fakeProviderSecret,
  messages: [
    {
      role: "system",
      content: [
        "You are Jasmine.",
        "<project_context>",
        "# AGENTS.md",
        "Jasmine Agent Instructions",
        "</project_context>",
        "<skill_instructions>",
        "Read SKILL.md when relevant.",
        "</skill_instructions>"
      ].join("\n")
    },
    { role: "user", content: "previous turn" },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "current turn" }
  ],
  tools: [{ type: "function", function: { name: "read", description: "Read file contents.", parameters: { type: "object" } } }],
  stream: true
}, {
  provider: "jasmine-mock",
  model: "jasmine-test"
});
assert.equal(classifierTaxonomy.payloadSchemaVersion, 7);
assert.deepEqual(classifierTaxonomy.payloadShape.topLevelOrder, ["model", "apiKey", "messages", "tools", "stream"]);
assert.equal(classifierTaxonomy.payloadShape.messagesBeforeTools, true);
assert.equal(classifierTaxonomy.rawPayload.includes(fakeProviderSecret), false);
assert.match(classifierTaxonomy.rawPayload, /\[redacted\]/);
assert.deepEqual(classifierTaxonomy.items.map((item) => item.payloadPath), [
  "$.messages[0]", "$.messages[1]", "$.messages[2]", "$.messages[3]", "$.tools[0]", "$", "$"
]);
const classifierSystemItem = classifierTaxonomy.items.find((item) => item.payloadPath === "$.messages[0]");
assert.equal(classifierSystemItem.kind, "system_prompt");
assert.equal(classifierSystemItem.segments.some((segment) => segment.kind === "project_context"), true);
assert.equal(classifierSystemItem.segments.some((segment) => segment.kind === "skill_instructions"), true);
assert.equal(classifierTaxonomy.items.find((item) => item.kind === "current_user_prompt")?.parts.some((part) => part.kind === "text" && part.text === "current turn"), true);
const classifierOptions = classifierTaxonomy.items.find((item) => item.kind === "provider_options");
assert.equal(classifierTaxonomy.items.filter((item) => item.role === "request_options").length, 1);
assert.deepEqual(classifierOptions.parts.map((part) => part.payloadPath), ["$.model", "$.stream"]);
const classifierUnclassified = classifierTaxonomy.items.find((item) => item.kind === "unclassified");
assert.equal(classifierUnclassified.parts[0].payloadPath, "$.apiKey");
assert.equal(classifierUnclassified.parts[0].kind, "unclassified");
assert.match(classifierUnclassified.text, /redacted/);
assert.equal(classifierTaxonomy.items.at(-3).kind, "tool_definition");
assert.equal(classifierTaxonomy.items.at(-2).kind, "provider_options");
assert.equal(classifierTaxonomy.items.at(-1).kind, "unclassified");
const classifierTaxonomyWithCache = withContextCacheMetrics(classifierTaxonomy, {
  input: 137,
  output: 18,
  cacheRead: 4096,
  cacheWrite: 0,
  totalTokens: 4251
});
assert.equal(classifierTaxonomyWithCache.cacheMetrics.cacheHitTokens, 4096);
assert.equal(classifierTaxonomyWithCache.cacheMetrics.cacheMissTokens, 137);
assert.equal(classifierTaxonomyWithCache.cacheMetrics.status, "hit");

const toolsFirstTaxonomy = providerPayloadToContextTaxonomy({
  model: "jasmine-test",
  tools: [{ type: "function", function: { name: "search", description: "Search files.", parameters: { type: "object" } } }],
  messages: [
    { role: "system", content: "You are Jasmine." },
    { role: "user", content: "Find workspace notes." }
  ],
  stream: true
}, {
  provider: "jasmine-mock",
  model: "jasmine-test"
});
assert.deepEqual(toolsFirstTaxonomy.payloadShape.topLevelOrder, ["model", "tools", "messages", "stream"]);
assert.equal(toolsFirstTaxonomy.payloadShape.messagesBeforeTools, false);
assert.ok(
  toolsFirstTaxonomy.items.findIndex((item) => item.payloadPath === "$.messages[0]")
    < toolsFirstTaxonomy.items.findIndex((item) => item.kind === "tool_definition"),
  "derived taxonomy should keep messages before tools even when raw payload order is tools-first"
);
assert.equal(toolsFirstTaxonomy.items.filter((item) => item.role === "request_options").length, 1);
assert.deepEqual(
  toolsFirstTaxonomy.items.find((item) => item.role === "request_options").parts.map((part) => part.payloadPath),
  ["$.model", "$.stream"]
);
assert.equal(toolsFirstTaxonomy.items.at(-1).kind, "provider_options");

const legacyTaxonomyWithoutSegments = {
  ...classifierTaxonomy,
  payloadSchemaVersion: 2,
  items: classifierTaxonomy.items.map((item) => {
    const { segments, ...withoutSegments } = item;
    return withoutSegments;
  })
};
const filledLegacyTaxonomy = withMissingContextTaxonomySegments(legacyTaxonomyWithoutSegments);
assert.deepEqual(filledLegacyTaxonomy.items[0].segments, classifierTaxonomy.items[0].segments);
assert.equal(legacyTaxonomyWithoutSegments.items[0].segments, undefined);

const taxonomyWithSyntheticToolImage = providerPayloadToContextTaxonomy({
  model: "jasmine-test",
  messages: [
    { role: "system", content: "You are Jasmine." },
    { role: "user", content: "Please open the page by URL." },
    { role: "assistant", content: "I will inspect the screenshot." },
    {
      role: "user",
      content: [
        "Attached image(s) from tool result:",
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${"A".repeat(96)}`
          }
        }
      ]
    }
  ]
}, {
  provider: "jasmine-mock",
  model: "jasmine-test",
  currentUserPromptText: "Please open the page by URL."
});
const syntheticCurrentItems = taxonomyWithSyntheticToolImage.items.filter((item) => item.kind === "current_user_prompt");
assert.equal(syntheticCurrentItems.length, 1);
assert.equal(syntheticCurrentItems[0].parts.some((part) => part.kind === "text" && part.text === "Please open the page by URL."), true);
const syntheticImageItem = taxonomyWithSyntheticToolImage.items.find((item) => item.payloadPath === "$.messages[3]");
assert.equal(syntheticImageItem?.kind, "attachment");
assert.doesNotMatch(taxonomyWithSyntheticToolImage.rawPayload, /A{64}/);
assert.match(taxonomyWithSyntheticToolImage.rawPayload, /data:image\/png;base64,\[redacted 96 chars\]/);

const taxonomyWithAttachmentAnchor = providerPayloadToContextTaxonomy({
  model: "jasmine-test",
  messages: [
    { role: "user", content: "Describe this image." },
    { role: "user", content: "Adapter handoff user message that should not become current." }
  ]
}, {
  provider: "jasmine-mock",
  model: "jasmine-test",
  currentUserPromptText: [
    "Describe this image.",
    "",
    "Attached local paths:",
    "- image file (image/png): C:\\tmp\\image.png"
  ].join("\n")
});
assert.equal(taxonomyWithAttachmentAnchor.items.find((item) => item.kind === "current_user_prompt")?.parts.some((part) => part.kind === "text" && part.text === "Describe this image."), true);

// Regression: the provider payload may put visible text, reasoning, and tool
// calls on the same assistant object. The old `content ?? item` shortcut hid
// both reasoning and tool_calls whenever content was present (including "").
const structuredAssistantTaxonomy = providerPayloadToContextTaxonomy({
  model: "deepseek-v4-flash",
  max_tokens: 1024,
  usage: { prompt_tokens: 2048, token_count: 2048 },
  accessToken: "secret-access-token-value",
  callback: "https://example.test/cb?X-Amz-Signature=secret-signature&token=secret-query-token",
  messages: [
    { role: "user", content: "inspect" },
    {
      role: "assistant",
      reasoning_content: "I should inspect both files before answering.",
      content: "I will inspect the files.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }]
    },
    { role: "tool", tool_call_id: "call_1", name: "read", content: "file contents" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{\"path\":\"b.txt\"}" } }] },
    { role: "user", content: "Please explain the phrase: Attached image(s) from tool result" }
  ],
  media: { source: { type: "base64", data: "A".repeat(96) } },
  googleMedia: { inlineData: { mimeType: "image/png", data: "B".repeat(96) } }
}, { provider: "deepseek", model: "deepseek-v4-flash" });
const richAssistant = structuredAssistantTaxonomy.items.find((item) => item.payloadPath === "$.messages[1]");
assert.deepEqual(richAssistant.parts.map((part) => part.kind), ["metadata", "reasoning", "text", "tool_call"]);
assert.equal(richAssistant.parts.find((part) => part.kind === "tool_call")?.toolCallId, "call_1");
assert.equal(richAssistant.text.includes("I should inspect"), true);
assert.equal(richAssistant.text.includes("call_1"), true);
const toolResultItem = structuredAssistantTaxonomy.items.find((item) => item.payloadPath === "$.messages[2]");
assert.deepEqual(toolResultItem.parts.map((part) => part.kind), ["metadata", "metadata", "metadata", "tool_result"]);
assert.equal(toolResultItem.parts.find((part) => part.kind === "tool_result")?.toolCallId, "call_1");
const emptyContentAssistant = structuredAssistantTaxonomy.items.find((item) => item.payloadPath === "$.messages[3]");
assert.deepEqual(emptyContentAssistant.parts.map((part) => part.kind), ["metadata", "tool_call"]);
assert.equal(structuredAssistantTaxonomy.items.find((item) => item.payloadPath === "$.messages[4]")?.kind, "current_user_prompt");
assert.doesNotMatch(structuredAssistantTaxonomy.rawPayload, /secret-access-token-value|secret-signature|secret-query-token|A{64}|B{64}/);
assert.match(structuredAssistantTaxonomy.rawPayload, /redacted/);
assert.match(structuredAssistantTaxonomy.rawPayload, /"max_tokens": 1024/);
assert.match(structuredAssistantTaxonomy.rawPayload, /"prompt_tokens": 2048/);
assert.ok(estimateTokens("这是中文测试") >= 6, "CJK composition estimates should not use chars/4");

// Lossless fallback: unsupported top-level and message fields must remain
// nested under a visible unclassified section instead of being absorbed into
// request options or silently dropped. Raw top-level order stays exact in the
// payload shape while each semantic section preserves its own source order.
const taxonomyWithUnclassifiedFields = providerPayloadToContextTaxonomy({
  model: "future-provider-model",
  contents: [{ role: "user", parts: [{ text: "Gemini-shaped input" }] }],
  messages: [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "inspect first", signature: "provider-signature" },
      { type: "text", text: "answer", cache_control: { type: "ephemeral" } }
    ],
    vendor_state: { checkpoint: 3 },
    tool_calls: [{ id: "future-call", function: { name: "read", arguments: "{}" } }]
  }],
  stream: true
}, { provider: "future-provider", model: "future-provider-model" });
assert.deepEqual(taxonomyWithUnclassifiedFields.items.map((item) => item.payloadPath), [
  "$.messages[0]", "$", "$"
]);
assert.deepEqual(taxonomyWithUnclassifiedFields.payloadShape.topLevelOrder, ["model", "contents", "messages", "stream"]);
assert.deepEqual(Object.keys(JSON.parse(taxonomyWithUnclassifiedFields.rawPayload)), taxonomyWithUnclassifiedFields.payloadShape.topLevelOrder);
assert.equal(taxonomyWithUnclassifiedFields.items.filter((item) => item.role === "request_options").length, 1);
assert.deepEqual(taxonomyWithUnclassifiedFields.items[1].parts.map((part) => part.payloadPath), ["$.model", "$.stream"]);
assert.equal(taxonomyWithUnclassifiedFields.items[2].kind, "unclassified");
assert.equal(taxonomyWithUnclassifiedFields.items[2].parts[0].payloadPath, "$.contents");
assert.match(taxonomyWithUnclassifiedFields.items[2].text, /Gemini-shaped input/);
const futureMessage = taxonomyWithUnclassifiedFields.items[0];
assert.deepEqual(futureMessage.parts.map((part) => part.kind), [
  "metadata", "reasoning", "unclassified", "text", "unclassified", "unclassified", "tool_call"
]);
assert.deepEqual(futureMessage.parts.map((part) => part.payloadPath), [
  "$.messages[0].role",
  "$.messages[0].content[0].thinking",
  "$.messages[0].content[0].signature",
  "$.messages[0].content[1].text",
  "$.messages[0].content[1].cache_control",
  "$.messages[0].vendor_state",
  "$.messages[0].tool_calls[0]"
]);
assert.equal(futureMessage.parts.find((part) => part.payloadPath.endsWith("vendor_state"))?.text.includes("checkpoint"), true);

const quotedOwnedTags = classifyTextSegments("<project_context>quoted, not trusted</project_context>", "current_user_prompt", "user");
assert.equal(quotedOwnedTags.length, 1);
assert.equal(quotedOwnedTags[0].kind, "current_user_prompt");
const availableSkills = classifyTextSegments("<available_skills>\n- read\n</available_skills>", "system_prompt", "system");
assert.equal(availableSkills.some((segment) => segment.kind === "skill_manifest"), true);

const canonicalDeepSeekToolTurn = [
  { role: "user", content: "question 1" },
  { role: "assistant", content: [{ type: "thinking", thinking: "reasoning 1.1" }, { type: "toolCall", id: "call_1", name: "read", arguments: {} }] },
  { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "result" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "reasoning 1.3" }, { type: "text", text: "answer 1" }] },
  { role: "user", content: "question 2" }
];
const missingFinalReasoning = validateReasoningRetention({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  canonicalMessages: canonicalDeepSeekToolTurn,
  payload: { messages: [
    { role: "user", content: "question 1" },
    { role: "assistant", reasoning_content: "reasoning 1.1", content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "question 2" }
  ] }
});
assert.equal(missingFinalReasoning.status, "fail");
assert.equal(missingFinalReasoning.requiredCount, 2);
assert.equal(missingFinalReasoning.sentCount, 1);
const completeDeepSeekReasoning = validateReasoningRetention({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  canonicalMessages: canonicalDeepSeekToolTurn,
  payload: { messages: [
    { role: "assistant", reasoning_content: "reasoning 1.1", tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
    { role: "assistant", reasoning_content: "reasoning 1.3", content: "answer 1" },
    { role: "user", content: "question 2" }
  ] }
});
assert.equal(completeDeepSeekReasoning.status, "pass");
const kimiK3MissingReasoning = validateReasoningRetention({
  provider: "moonshot",
  model: "kimi-k3",
  canonicalMessages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "thinking", thinking: "always keep me" }, { type: "text", text: "a" }] }, { role: "user", content: "next" }],
  payload: { messages: [{ role: "assistant", content: "a" }, { role: "user", content: "next" }] }
});
assert.equal(kimiK3MissingReasoning.status, "fail");
const deepSeekNoToolReasoning = validateReasoningRetention({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  canonicalMessages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "thinking", thinking: "ordinary reasoning" }, { type: "text", text: "a" }] }, { role: "user", content: "next" }],
  payload: { messages: [{ role: "assistant", content: "a" }, { role: "user", content: "next" }] }
});
assert.equal(deepSeekNoToolReasoning.status, "not_applicable");
const kimi26DefaultCrossTurn = validateReasoningRetention({
  provider: "moonshot",
  model: "kimi-k2.6",
  canonicalMessages: canonicalDeepSeekToolTurn,
  payload: { thinking: { type: "enabled" }, messages: [{ role: "assistant", content: "answer 1" }, { role: "user", content: "question 2" }] }
});
assert.equal(kimi26DefaultCrossTurn.status, "not_applicable");
const kimi26KeepAll = validateReasoningRetention({
  provider: "moonshot",
  model: "kimi-k2.6",
  canonicalMessages: canonicalDeepSeekToolTurn,
  payload: { thinking: { type: "enabled", keep: "all" }, messages: [{ role: "assistant", content: "answer 1" }, { role: "user", content: "question 2" }] }
});
assert.equal(kimi26KeepAll.status, "fail");
const kimi26CurrentToolLoop = validateReasoningRetention({
  provider: "moonshot",
  model: "kimi-k2.6",
  canonicalMessages: canonicalDeepSeekToolTurn.slice(0, 3),
  payload: { thinking: { type: "enabled" }, messages: [{ role: "user", content: "question 1" }, { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] }, { role: "tool", content: "result" }] }
});
assert.equal(kimi26CurrentToolLoop.status, "fail");
assert.equal(validateReasoningRetention({ provider: "moonshot", model: "kimi-k2.5", canonicalMessages: [], payload: {} }).status, "not_applicable");

const looseUserSegments = classifyTextSegments("I changed my workspace and lost some memory.", "conversation_history", "user");
assert.equal(looseUserSegments.length, 1);
assert.equal(looseUserSegments[0].kind, "conversation_history");
const looseSystemSegments = classifyTextSegments("# AGENTS.md\nCurrent working directory: C:\\repo", "system_prompt", "system");
assert.equal(looseSystemSegments[0].kind, "project_context");
const userGenericTagSegments = classifyTextSegments("<context>not Jasmine context</context>\n<system>not a system prompt</system>", "current_user_prompt", "user");
assert.equal(userGenericTagSegments.length, 1);
assert.equal(userGenericTagSegments[0].kind, "current_user_prompt");

const htmlToolArgumentSegments = classifyTextSegments([
  "<!doctype html>",
  "<html>",
  "<head><title>Summer Admin</title></head>",
  "<body><main>Dashboard</main></body>",
  "</html>"
].join("\n"), "conversation_history", "assistant");
assert.equal(htmlToolArgumentSegments.length, 1);
assert.equal(htmlToolArgumentSegments[0].kind, "conversation_history");
assert.doesNotMatch(htmlToolArgumentSegments[0].title, /head|body/i);
const ownedTagSegments = classifyTextSegments("<project_context>Jasmine repo</project_context>\n<skill_instructions>Read SKILL.md</skill_instructions>", "conversation_history", "system");
assert.equal(ownedTagSegments.some((segment) => segment.kind === "project_context"), true);
assert.equal(ownedTagSegments.some((segment) => segment.kind === "skill_instructions"), true);

const jasminePromptAppend = buildJasminePromptAppend();
assert.match(jasminePromptAppend, /operating through Jasmine/);
assert.match(jasminePromptAppend, /user's language/);
assert.doesNotMatch(jasminePromptAppend, /Current working directory/);
assert.equal(buildTurnContext([]), undefined);
assert.match(buildTurnContext(["Remember the user's preference."]) ?? "", /relevant_memories/);
if (process.platform === "win32") {
  const systemBashPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "bash.exe");
  const gitBashPath = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  const defaultRuntimePrompt = buildLocalRuntimePromptAppend();
  assert.match(defaultRuntimePrompt, /Git Bash or another bash\.exe/);
  assert.match(defaultRuntimePrompt, /bash syntax/);
  assert.deepEqual(resolvePiShellRuntime(fakeBashPath), {
    kind: "bash",
    shellPath: fakeBashPath,
    configuredPath: fakeBashPath
  });
  assert.deepEqual(resolvePiShellRuntime(fakePowerShellPath), {
    kind: "powershell",
    shellPath: fakePowerShellPath,
    configuredPath: fakePowerShellPath
  });
  assert.deepEqual(resolvePiShellRuntime(fakeCmdPath), {
    kind: "unsupported",
    configuredPath: fakeCmdPath
  });
  assert.equal(resolvePiShellRuntime(path.join(tempDir, "missing-pwsh.exe")).kind, "unsupported");
  const powerShellPrompt = buildLocalRuntimePromptAppend(resolvePiShellRuntime(fakePowerShellPath));
  assert.match(powerShellPrompt, /executes through PowerShell/);
  assert.match(powerShellPrompt, /PowerShell syntax/);
  const unsupportedShellPrompt = buildLocalRuntimePromptAppend(resolvePiShellRuntime(fakeCmdPath));
  assert.match(unsupportedShellPrompt, /incompatible with Pi/);
  assert.match(unsupportedShellPrompt, /falls back to Git Bash or another bash\.exe/);
  if (await fileExists(systemBashPath)) {
    assert.equal((await resolveConfiguredExecutable("terminal", systemBashPath)).label, "WSL Bash");
    const wslPiShell = resolvePiShellRuntime(systemBashPath);
    assert.equal(wslPiShell.configuredPath, systemBashPath);
    if (await fileExists(gitBashPath)) {
      assert.deepEqual(wslPiShell, {
        kind: "bash",
        shellPath: gitBashPath,
        configuredPath: systemBashPath,
        fallbackReason: "wsl-bash-launcher"
      });
      const wslFallbackPrompt = buildLocalRuntimePromptAppend(wslPiShell);
      assert.match(wslFallbackPrompt, /WSL bash launcher/);
      assert.match(wslFallbackPrompt, /uses Git Bash/);
    }
    const terminalDiscovery = await listExecutableDiscovery("terminal");
    assert.notEqual(terminalDiscovery.auto?.command, systemBashPath);
    assert.equal(terminalDiscovery.candidates.some((candidate) => candidate.command === systemBashPath && candidate.label === "Git Bash"), false);
  }
}

const captures = [];
let retryableTitleRequestCount = 0;
let resolveQueuedAbortRequestStarted;
const queuedAbortRequestStarted = new Promise((resolve) => {
  resolveQueuedAbortRequestStarted = resolve;
});
let resolveSteerAbortRequestStarted;
const steerAbortRequestStarted = new Promise((resolve) => {
  resolveSteerAbortRequestStarted = resolve;
});
let resolveSteerAbortRequestFinished;
const steerAbortRequestFinished = new Promise((resolve) => {
  resolveSteerAbortRequestFinished = resolve;
});
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  captures.push(body);

  if (request.headers.authorization === `Bearer ${invalidProviderSecret}`) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "AuthError",
        message: `Invalid API key ${invalidProviderSecret}.`
      }
    }));
    return;
  }

  const requestText = JSON.stringify(body.messages ?? body.input ?? []);
  const latestUserRequestText = JSON.stringify(
    [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? ""
  );
  if (requestText.includes("foreign reasoning history regression")) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-foreign-reasoning-history",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "native deepseek reasoning remains separate" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-foreign-reasoning-history",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { content: "foreign reasoning history passed" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-foreign-reasoning-history",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, completion_tokens_details: { reasoning_tokens: 4 } }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("deepseek content-only thinking fallback")) {
    const toolResultPresent = (body.messages ?? []).some((message) => message.role === "tool");
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    if (!toolResultPresent) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-content-only-thinking",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "The user asked me to inspect the fixture first, so I need to read it before I can produce the final answer." }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-content-only-thinking",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "content-only-tool-call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: path.join(tempDir, "reasoning-replay.txt") }) } }] },
          finish_reason: null
        }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-content-only-thinking",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
      })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-content-only-thinking",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "content-only fallback passed" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-content-only-thinking",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
      })}\n\n`);
    }
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("timeline correlation replay follow-up")) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-correlation-replay",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "timeline correlation replay passed" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-correlation-replay",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("reasoning replay regression")) {
    const toolResultPresent = (body.messages ?? []).some((message) => message.role === "tool");
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    if (!toolResultPresent) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-replay",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "exact reasoning chain for tool replay" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-replay",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "replay-tool-call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: path.join(tempDir, "reasoning-replay.txt") }) } },
              { index: 1, id: "replay-tool-call-2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: path.join(tempDir, "reasoning-replay-2.txt") }) } }
            ]
          },
          finish_reason: null
        }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-replay",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
      })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-replay",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "reasoning replay passed" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-reasoning-replay",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
      })}\n\n`);
    }
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("abort stable timeline regression")) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-abort-stable-timeline",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "abort reasoning stays mounted" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-abort-stable-timeline",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { content: "partial answer stays mounted" }, finish_reason: null }]
    })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!response.destroyed && !response.writableEnded) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-abort-stable-timeline",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    }
    return;
  }
  if (requestText.includes("quarterly planning title")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ title: "Quarterly planning" }) }, finish_reason: "stop" }]
    }));
    return;
  }
  if (requestText.includes("empty title request")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-empty-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ title: "" }) }, finish_reason: "stop" }]
    }));
    return;
  }
  if (requestText.includes("direct reply title regression")) {
    const isRetry = requestText.includes("A previous attempt was empty or looked like a conversational reply");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-direct-reply-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: isRetry
            ? JSON.stringify({ title: "钉钉近期消息查看" })
            : "你好！我暂时无法直接登录或查看你的钉钉账户，因此看不到你最近的消息。不过，你可以把具体内容发给我"
        },
        finish_reason: "stop"
      }]
    }));
    return;
  }
  if (requestText.includes("short conversational title regression")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-short-conversational-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ title: "我很好，谢谢你的关心！你呢？" }) }, finish_reason: "stop" }]
    }));
    return;
  }
  if (requestText.includes("retryable title request regression")) {
    retryableTitleRequestCount += 1;
    if (retryableTitleRequestCount === 1) {
      response.writeHead(408, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: "request timeout" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-retried-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ title: "超时后的标题重试" }) }, finish_reason: "stop" }]
    }));
    return;
  }
  if (requestText.includes("provider auth failure regression")) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "AuthError",
        message: `Invalid API key ${fakeProviderSecret}. token=${unrelatedAccessToken} jwt=${unrelatedJwt}`
      }
    }));
    return;
  }
  if (latestUserRequestText.includes("queued provider error then success regression")) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "ProviderError",
        message: "Initial queued run authentication failure."
      }
    }));
    return;
  }
  if (latestUserRequestText.includes("queued provider later failure regression")) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "ProviderError",
        message: "Queued follow-up authentication failure."
      }
    }));
    return;
  }
  if (latestUserRequestText.includes("initial provider error with active steer regression")) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-initial-error-active-steer",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (latestUserRequestText.includes("active steer failure after initial error")) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ type: "error", error: { type: "ProviderError", message: "Steer provider failure." } }));
    return;
  }
  if (latestUserRequestText.includes("failed steer attachment regression")) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ type: "error", error: { type: "ProviderError", message: "Attachment steer provider failure." } }));
    return;
  }
  if (latestUserRequestText.includes("steer attachment initial success")) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (requestText.includes("provider base url failure regression")) {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<!DOCTYPE html><html><head><title>Not Found</title></head><body>API route not found</body></html>");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  if (requestText.includes("reasoning only empty response")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I am thinking without producing final text." }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 6, completion_tokens: 3, total_tokens: 13 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("totally empty response")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 6, completion_tokens: 0, total_tokens: 10 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("answers for streaming regression")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I understand the numbered answers." }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: { content: "new streaming answer" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 6, completion_tokens: 3, total_tokens: 13 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("queued follow up unit request")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: { role: "assistant", content: "unit follow up answer" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("steer abort before assistant update")) {
    resolveSteerAbortRequestStarted?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!response.destroyed && !response.writableEnded) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-steer-abort",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "late steer answer must not arrive" }, finish_reason: null }]
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    }
    resolveSteerAbortRequestFinished?.();
    return;
  }
  if (requestText.includes("steer abort runtime start")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-steer-abort-initial",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "unit steer abort previous reasoning" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-steer-abort-initial",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { content: "unit steer abort previous answer" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-steer-abort-initial",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("queued abort before assistant update")) {
    resolveQueuedAbortRequestStarted?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!response.destroyed && !response.writableEnded) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-queued-abort",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "late queued answer must not arrive" }, finish_reason: null }]
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    }
    return;
  }
  if (requestText.includes("queue abort runtime start")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-queued-abort-initial",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "unit queued abort previous answer" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-queued-abort-initial",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (requestText.includes("queue runtime start")) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: { role: "assistant", content: "unit initial answer" }, finish_reason: null }]
    })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 160));
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-equivalence",
      object: "chat.completion.chunk",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-equivalence",
    object: "chat.completion.chunk",
    created: 0,
    model: "jasmine-test",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }]
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-equivalence",
    object: "chat.completion.chunk",
    created: 0,
    model: "jasmine-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 6, completion_tokens: 1, total_tokens: 11 }
  })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const systemPrompt = "You are Jasmine. Keep replies concise.";

  const now = new Date().toISOString();
  const providerUnderTest = {
    id: "third-party-openai-compatible",
    name: "Third-party OpenAI-compatible",
    type: "openai-compatible",
    baseUrl,
    apiKeyRef: `key:${invalidProviderSecret}`,
    models: [],
    defaultModel: "jasmine-test",
    enabled: true,
    status: "unchecked",
    createdAt: now,
    updatedAt: now
  };
  let savedProviderCheck;
  const providerTestDatabase = {
    getProvider(providerId) {
      return providerId === providerUnderTest.id ? providerUnderTest : undefined;
    },
    updateProviderCheck(providerId, check) {
      assert.equal(providerId, providerUnderTest.id);
      savedProviderCheck = check;
      return {
        ...providerUnderTest,
        status: check.status,
        lastError: check.lastError ?? undefined,
        lastCheckedAt: now
      };
    }
  };
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let failedProviderTest;
  try {
    failedProviderTest = await testProvider(providerTestDatabase, providerUnderTest.id);
  } finally {
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
  assert.equal(failedProviderTest.status, "failed");
  assert.equal(failedProviderTest.provider.status, "failed");
  assert.equal(savedProviderCheck.status, "failed");
  assert.match(savedProviderCheck.lastError, /authentication failed \(401\)/);
  assert.match(savedProviderCheck.lastError, /Invalid API key/);
  assert.doesNotMatch(savedProviderCheck.lastError, new RegExp(invalidProviderSecret));
  assert.doesNotMatch(savedProviderCheck.lastError, /completed without final assistant text/);
  captures.length = 0;

  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "jasmine-mock": {
          name: "Jasmine Mock",
          baseUrl,
          apiKey: "$JASMINE_MOCK_API_KEY",
          api: "openai-completions",
          models: [
            {
              id: "jasmine-test",
              name: "Jasmine Test",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1200,
              compat: {
                supportsStore: false,
                supportsUsageInStreaming: true,
                maxTokensField: "max_tokens"
              }
            }
          ]
        }
      }
    }, null, 2)
  );

  await runPiCli({
    agentDir,
    appendPrompt: systemPrompt,
    message: "hello from pi"
  });
  assert.equal(captures.length, 1);
  const cliPayload = normalizePayload(captures[0]);

  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello from pi" }],
    content: "hello from pi",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, 2);
  const sdkPayload = normalizePayload(captures[1]);

  assert.deepEqual(sdkPayload, cliPayload);
  const sdkSystemPromptText = sdkPayload.messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(sdkSystemPromptText, /You are an expert coding assistant operating inside pi/);
  assert.match(sdkSystemPromptText, /You are Jasmine\. Keep replies concise\./);
  assert.equal((sdkSystemPromptText.match(/Current working directory:/g) ?? []).length, 1);

  const promptRegressionCwd = path.join(tempDir, "prompt-regression-workspace");
  const promptRegressionAgentDir = path.join(tempDir, "prompt-regression-agent");
  await mkdir(promptRegressionCwd, { recursive: true });
  await mkdir(promptRegressionAgentDir, { recursive: true });
  await writeFile(path.join(promptRegressionAgentDir, "APPEND_SYSTEM.md"), "PRESERVE_DISCOVERED_APPEND_SYSTEM");
  const promptRegressionStart = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "prompt ownership regression" }],
    content: "prompt ownership regression",
    attachments: [],
    jasminePromptAppend: "JASMINE_MINIMAL_APPEND",
    localRuntimePromptAppend: "LOCAL_RUNTIME_APPEND",
    memoryContext: ["TURN_MEMORY_MUST_NOT_BE_SYSTEM"],
    cwd: promptRegressionCwd,
    agentDir: promptRegressionAgentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, promptRegressionStart + 1);
  const promptRegressionPayload = captures.at(-1);
  const promptRegressionSystem = promptRegressionPayload.messages.find((message) => message.role === "system")?.content ?? "";
  const promptRegressionMessages = JSON.stringify(promptRegressionPayload.messages.filter((message) => message.role !== "system"));
  assert.match(promptRegressionSystem, /You are an expert coding assistant operating inside pi/);
  assert.match(promptRegressionSystem, /JASMINE_MINIMAL_APPEND/);
  assert.match(promptRegressionSystem, /LOCAL_RUNTIME_APPEND/);
  assert.match(promptRegressionSystem, /PRESERVE_DISCOVERED_APPEND_SYSTEM/);
  assert.doesNotMatch(promptRegressionSystem, /TURN_MEMORY_MUST_NOT_BE_SYSTEM/);
  assert.equal((promptRegressionSystem.match(/Current working directory:/g) ?? []).length, 1);
  assert.match(promptRegressionMessages, /TURN_MEMORY_MUST_NOT_BE_SYSTEM/);

  const captureThinkingPayload = async (provider, reasoningEffort, content) => {
    const captureCount = captures.length;
    await runPiCodingAgentChat({
      provider,
      messages: [{ role: "user", content }],
      content,
      attachments: [],
      jasminePromptAppend: systemPrompt,
      agentDir,
      toolsEnabled: false,
      reasoningEffort
    });
    assert.equal(captures.length, captureCount + 1);
    return captures.at(-1);
  };
  const reasoningProviderBase = {
    apiKey: "test-key",
    baseUrl,
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: true,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  };
  const deepSeekXHighPayload = await captureThinkingPayload({
    ...reasoningProviderBase,
    providerName: "deepseek",
    modelId: "deepseek-v4-flash"
  }, "xhigh", "deepseek xhigh thinking request");
  assert.deepEqual(deepSeekXHighPayload.thinking, { type: "enabled" });
  assert.equal(deepSeekXHighPayload.reasoning_effort, "max");

  const kimiThinkingPayload = await captureThinkingPayload({
    ...reasoningProviderBase,
    providerName: "moonshot",
    modelId: "kimi-k2.6"
  }, "xhigh", "kimi thinking enabled request");
  assert.deepEqual(kimiThinkingPayload.thinking, { type: "enabled" });
  assert.equal(kimiThinkingPayload.reasoning_effort, undefined);

  const kimiOffPayload = await captureThinkingPayload({
    ...reasoningProviderBase,
    providerName: "moonshot",
    modelId: "kimi-k2.6"
  }, "off", "kimi thinking disabled request");
  assert.deepEqual(kimiOffPayload.thinking, { type: "disabled" });
  assert.equal(kimiOffPayload.reasoning_effort, undefined);

  const kimiCodeOffPayload = await captureThinkingPayload({
    ...reasoningProviderBase,
    providerName: "moonshot",
    modelId: "kimi-k2.7-code"
  }, "off", "kimi k2.7 code always thinking request");
  assert.equal(kimiCodeOffPayload.thinking, undefined);
  assert.equal(kimiCodeOffPayload.reasoning_effort, undefined);

  const streamingUpdates = [];
  const streamingReply = await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: true,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [
      { role: "user", content: "design a memo app" },
      { role: "assistant", content: "OLD CLARIFYING QUESTION" },
      { role: "user", content: "answers for streaming regression" }
    ],
    content: "answers for streaming regression",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    onUpdate: (update) => streamingUpdates.push(update)
  });
  assert.equal(streamingReply.content, "new streaming answer");
  assert.equal(streamingUpdates.length > 0, true);
  assert.equal(streamingUpdates.some((update) => update.content.includes("OLD CLARIFYING QUESTION")), false);
  assert.equal(streamingUpdates.some((update) => update.content === "new streaming answer"), true);
  const liveAssistantContent = (update) =>
    update.liveMessages?.filter((message) => message.role === "assistant").at(-1)?.content ?? update.content;
  const firstLiveAnswerIndex = streamingUpdates.findIndex((update) => liveAssistantContent(update) === "new streaming answer");
  assert.notEqual(firstLiveAnswerIndex, -1);
  assert.deepEqual(
    streamingUpdates.slice(firstLiveAnswerIndex).map(liveAssistantContent),
    streamingUpdates.slice(firstLiveAnswerIndex).map(() => "new streaming answer")
  );
  const streamingTimelineIds = new Map();
  for (const update of streamingUpdates) {
    const liveTimeline = update.liveMessages
      ?.filter((message) => message.role === "assistant")
      .at(-1)?.timeline ?? update.timeline;
    for (const item of liveTimeline ?? []) {
      if (item.kind !== "thinking" && item.kind !== "assistant_text") continue;
      const previousId = streamingTimelineIds.get(item.kind);
      if (previousId) assert.equal(item.id, previousId, `${item.kind} must keep its id across Pi message updates`);
      else streamingTimelineIds.set(item.kind, item.id);
    }
  }
  assert.equal(streamingTimelineIds.size, 2);
  for (const kind of ["thinking", "assistant_text"]) {
    assert.equal(
      streamingReply.timeline.find((item) => item.kind === kind)?.id,
      streamingTimelineIds.get(kind),
      `${kind} must keep its live id after Pi persists the session entry`
    );
  }

  const abortController = new AbortController();
  const abortUpdates = [];
  const abortedReply = await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: true,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "abort stable timeline regression" }],
    content: "abort stable timeline regression",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    signal: abortController.signal,
    onUpdate: (update) => {
      abortUpdates.push(update);
      if (!abortController.signal.aborted && update.content.includes("partial answer stays mounted")) {
        abortController.abort();
      }
    }
  });
  const abortLiveTimeline = abortUpdates
    .findLast((update) => update.content.includes("partial answer stays mounted"))
    ?.liveMessages?.filter((message) => message.role === "assistant").at(-1)?.timeline ?? [];
  const abortedAssistant = abortedReply.generatedMessages?.filter((message) => message.role === "assistant").at(-1);
  assert.ok(abortedAssistant);
  for (const kind of ["thinking", "assistant_text"]) {
    const liveItem = abortLiveTimeline.find((item) => item.kind === kind);
    const settledItem = abortedAssistant.timeline?.find((item) => item.kind === kind);
    assert.ok(liveItem, `aborted live Pi snapshot should contain ${kind}`);
    assert.equal(settledItem?.id, liveItem.id, `aborted ${kind} must retain its last live id`);
    assert.equal(abortedReply.timeline.find((item) => item.kind === kind)?.id, liveItem.id);
  }
  assert.equal(abortedAssistant.timeline?.some((item) => item.id === "assistant-output"), false);
  assert.equal(abortedAssistant.timeline?.some((item) => item.kind === "system" && item.title === "Stopped"), true);

  const queuedAbortController = new AbortController();
  const queuedAbortUpdates = [];
  let queuedAbortControls;
  let queuedAbortAdded = false;
  let queuedAbortQueuePromise = Promise.resolve();
  const queuedAbortReplyPromise = runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "queue abort runtime start" }],
    content: "queue abort runtime start",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    signal: queuedAbortController.signal,
    onQueueReady: (controls) => {
      queuedAbortControls = controls;
    },
    onUpdate: (update) => {
      queuedAbortUpdates.push(update);
      if (queuedAbortAdded || !update.content.includes("unit queued abort previous answer")) return;
      queuedAbortAdded = true;
      queuedAbortQueuePromise = queuedAbortControls.queueMessage({
        mode: "followUp",
        content: "queued abort before assistant update",
        attachments: []
      });
    }
  });
  await Promise.race([
    queuedAbortRequestStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("queued abort request did not start")), 5_000))
  ]);
  queuedAbortController.abort();
  const queuedAbortReply = await queuedAbortReplyPromise;
  await queuedAbortQueuePromise;
  const trailingQueuedUserSnapshot = queuedAbortUpdates.find((update) => (
    update.liveMessages?.at(-1)?.role === "user"
    && update.liveMessages.at(-1)?.content === "queued abort before assistant update"
  ));
  assert.ok(trailingQueuedUserSnapshot, "Pi must expose the delivered queued user before its first assistant update");
  assert.equal(trailingQueuedUserSnapshot.content, "");
  assert.deepEqual(trailingQueuedUserSnapshot.timeline, []);
  const generatedMessages = queuedAbortReply.generatedMessages ?? [];
  assert.deepEqual(generatedMessages.map((message) => message.role), ["assistant", "user", "assistant"]);
  const [completedAssistant, queuedUser, stoppedQueuedAssistant] = generatedMessages;
  const liveCompletedAssistant = trailingQueuedUserSnapshot.liveMessages.findLast((message) => message.role === "assistant");
  assert.ok(liveCompletedAssistant);
  assert.equal(completedAssistant.content, liveCompletedAssistant.content);
  assert.deepEqual(completedAssistant.timeline, liveCompletedAssistant.timeline);
  assert.equal(queuedUser.content, "queued abort before assistant update");
  assert.equal(stoppedQueuedAssistant.content, "Response stopped.");
  assert.deepEqual(stoppedQueuedAssistant.timeline, [{
    id: "user-abort",
    kind: "system",
    title: "Stopped",
    text: "The response was stopped by the user."
  }]);
  assert.equal(queuedAbortReply.content, "Response stopped.");
  assert.deepEqual(queuedAbortReply.timeline, stoppedQueuedAssistant.timeline);

  const steerAbortController = new AbortController();
  const steerAbortUpdates = [];
  const steerAbortSession = SessionManager.inMemory(tempDir);
  const steerAbortGateExtensionPath = path.join(tempDir, "steer-abort-input-gate.mjs");
  let resolveSteerAbortGateEntered;
  const steerAbortGateEntered = new Promise((resolve) => {
    resolveSteerAbortGateEntered = resolve;
  });
  let resolveSteerAbortGateIdle;
  const steerAbortGateIdle = new Promise((resolve) => {
    resolveSteerAbortGateIdle = resolve;
  });
  let releaseSteerAbortGate;
  const steerAbortGateRelease = new Promise((resolve) => {
    releaseSteerAbortGate = resolve;
  });
  globalThis.__JASMINE_PI_STEER_ABORT_GATE__ = {
    entered: () => resolveSteerAbortGateEntered?.(),
    idle: () => resolveSteerAbortGateIdle?.(),
    release: steerAbortGateRelease
  };
  await writeFile(steerAbortGateExtensionPath, [
    "export default function steerAbortInputGate(pi) {",
    "  pi.on('input', async (event, ctx) => {",
    "    if (event.streamingBehavior !== 'steer' || !event.text.includes('steer abort before assistant update')) {",
    "      return { action: 'continue' };",
    "    }",
    "    const gate = globalThis.__JASMINE_PI_STEER_ABORT_GATE__;",
    "    if (!gate) throw new Error('Steer abort input gate is missing.');",
    "    gate.entered();",
    "    while (!ctx.isIdle()) await new Promise((resolve) => setTimeout(resolve, 1));",
    "    gate.idle();",
    "    await gate.release;",
    "    return { action: 'continue' };",
    "  });",
    "}"
  ].join("\n"));
  let steerAbortControls;
  let steerAbortAdded = false;
  let steerAbortQueuePromise = Promise.resolve();
  const steerAbortReplyPromise = runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: true,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "steer abort runtime start" }],
    content: "steer abort runtime start",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    signal: steerAbortController.signal,
    sessionManager: steerAbortSession,
    packageExtensionPaths: [steerAbortGateExtensionPath],
    onQueueReady: (controls) => {
      steerAbortControls = controls;
    },
    onUpdate: (update) => {
      steerAbortUpdates.push(update);
      if (steerAbortAdded || !update.content.includes("unit steer abort previous answer")) return;
      steerAbortAdded = true;
      steerAbortQueuePromise = steerAbortControls.queueMessage({
        mode: "steer",
        content: "steer abort before assistant update",
        attachments: []
      });
    }
  });
  await Promise.race([
    steerAbortGateEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("steer abort input did not reach its gate")), 5_000))
  ]);
  await Promise.race([
    steerAbortGateIdle,
    new Promise((_, reject) => setTimeout(() => reject(new Error("initial steer-abort agent loop did not become idle")), 5_000))
  ]);
  assert.equal(steerAbortSession.getEntries().some((entry) => (
    entry.type === "message"
    && entry.message?.role === "assistant"
    && entry.message.stopReason === "stop"
    && JSON.stringify(entry.message.content).includes("unit steer abort previous answer")
  )), true, "Pi must commit the initial answer before the independent steer starts");
  // Let the outer runtime observe the completed initial prompt and enter its
  // steering-task join before the gate starts the independent provider call.
  await new Promise((resolve) => setImmediate(resolve));
  releaseSteerAbortGate?.();
  await Promise.race([
    steerAbortRequestStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("independent steer abort HTTP request did not start")), 5_000))
  ]);
  steerAbortController.abort();
  const steerAbortReply = await steerAbortReplyPromise;
  await steerAbortQueuePromise;
  await Promise.race([
    steerAbortRequestFinished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("steer abort held response did not finish")), 5_000))
  ]);
  delete globalThis.__JASMINE_PI_STEER_ABORT_GATE__;

  const trailingSteerUserSnapshot = steerAbortUpdates.find((update) => (
    update.liveMessages?.at(-1)?.role === "user"
    && update.liveMessages.at(-1)?.content === "steer abort before assistant update"
  ));
  assert.ok(trailingSteerUserSnapshot, "Pi must expose the delivered steer user before its first assistant update");
  assert.equal(trailingSteerUserSnapshot.content, "");
  assert.deepEqual(trailingSteerUserSnapshot.timeline, []);
  assert.equal(trailingSteerUserSnapshot.liveMessages.at(-1).role, "user");

  const steerGeneratedMessages = steerAbortReply.generatedMessages ?? [];
  assert.deepEqual(steerGeneratedMessages.map((message) => message.role), ["assistant", "user", "assistant"]);
  const [completedSteerAssistant, deliveredSteerUser, stoppedSteerAssistant] = steerGeneratedMessages;
  assert.equal(completedSteerAssistant.content, "unit steer abort previous answer");
  assert.equal(completedSteerAssistant.timeline?.some((item) => (
    item.kind === "thinking" && item.text === "unit steer abort previous reasoning"
  )), true);
  assert.equal(completedSteerAssistant.timeline?.some((item) => (
    item.kind === "assistant_text" && item.text === "unit steer abort previous answer"
  )), true);
  assert.equal(completedSteerAssistant.timeline?.some((item) => item.id === "user-abort"), false);
  assert.equal(deliveredSteerUser.content, "steer abort before assistant update");
  assert.equal(deliveredSteerUser.timeline, undefined);
  assert.equal(stoppedSteerAssistant.content, "Response stopped.");
  assert.deepEqual(stoppedSteerAssistant.timeline, [{
    id: "user-abort",
    kind: "system",
    title: "Stopped",
    text: "The response was stopped by the user."
  }]);
  assert.equal(steerAbortReply.content, stoppedSteerAssistant.content);
  assert.deepEqual(steerAbortReply.timeline, stoppedSteerAssistant.timeline);
  assert.equal(JSON.stringify(steerAbortUpdates).includes("late steer answer must not arrive"), false);
  assert.equal(JSON.stringify(steerAbortReply).includes("late steer answer must not arrive"), false);
  assert.equal(JSON.stringify(stoppedSteerAssistant.timeline).includes("unit steer abort previous"), false);

  const queueUpdates = [];
  let queueControls;
  let queuedDuringStream = false;
  let queuePromise = Promise.resolve();
  const queuedReply = await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "queue runtime start" }],
    content: "queue runtime start",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    onQueueReady: (controls) => {
      queueControls = controls;
    },
    onQueueUpdate: (queue) => {
      queueUpdates.push({
        steering: queue.steering.length,
        followUp: queue.followUp.length
      });
    },
    onUpdate: (update) => {
      if (queuedDuringStream || !update.content.includes("unit initial answer")) return;
      queuedDuringStream = true;
      queuePromise = queueControls.queueMessage({
        mode: "followUp",
        content: "queued follow up unit request",
        attachments: []
      });
    }
  });
  await queuePromise;
  assert.equal(queuedReply.generatedMessages?.map((message) => `${message.role}:${message.content}`).join("|"), [
    "assistant:unit initial answer",
    "user:queued follow up unit request",
    "assistant:unit follow up answer"
  ].join("|"));
  assert.deepEqual(queueUpdates.at(-1), { steering: 0, followUp: 0 });
  assert.equal(queueUpdates.some((queue) => queue.followUp === 1), true);

  const reasoningOnlyReply = await generateAssistantReply({
    threadId: "reasoning-only-thread",
    messages: [{ role: "user", content: "reasoning only empty response" }],
    content: "reasoning only empty response",
    attachments: [],
    piAgentDir: agentDir,
    toolsEnabled: true,
    reasoningEffort: "high"
  }, {
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: true,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  });
  assert.equal(reasoningOnlyReply.content, "");
  assert.equal(reasoningOnlyReply.timeline.some((item) => item.kind === "thinking" && item.text.includes("thinking without producing final text")), true);

  await writeFile(path.join(tempDir, "reasoning-replay.txt"), "tool replay fixture");
  await writeFile(path.join(tempDir, "reasoning-replay-2.txt"), "second tool replay fixture");
  for (const provider of [
    { providerName: "deepseek", modelId: "deepseek-v4-flash" },
    { providerName: "moonshot", modelId: "kimi-k2.6" }
  ]) {
    const captureStart = captures.length;
    const replayUpdates = [];
    const replayReply = await runPiCodingAgentChat({
      provider: {
        providerName: provider.providerName,
        apiKey: "test-key",
        baseUrl,
        modelId: provider.modelId,
        capabilities: {
          vision: provider.providerName === "moonshot",
          imageOutput: false,
          toolCalling: true,
          reasoning: true,
          embedding: false
        }
      },
      messages: [{ role: "user", content: `reasoning replay regression ${provider.providerName}` }],
      content: `reasoning replay regression ${provider.providerName}`,
      attachments: [],
      jasminePromptAppend: "Use the read tool and then answer.",
      cwd: tempDir,
      agentDir,
      toolsEnabled: true,
      reasoningEffort: "high",
      onUpdate: (update) => replayUpdates.push(update)
    });
    assert.equal(replayReply.content, "reasoning replay passed");
    const replayPayloads = captures.slice(captureStart);
    assert.equal(replayPayloads.length, 2, `${provider.providerName} should perform exactly one tool loop`);
    const replayAssistant = replayPayloads[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.equal(replayAssistant.reasoning_content, "exact reasoning chain for tool replay");
    const expectedToolCallIds = ["replay-tool-call-1", "replay-tool-call-2"];
    assert.deepEqual(replayAssistant.tool_calls.map((call) => call.id), expectedToolCallIds);
    assert.deepEqual(
      replayPayloads[1].messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
      expectedToolCallIds
    );
    assert.equal(replayPayloads[1].temperature, undefined);
    const stableKinds = ["thinking", "tool_call", "tool_result", "assistant_text"];
    const expectedKindCounts = new Map([
      ["thinking", 1],
      ["tool_call", 2],
      ["tool_result", 2],
      ["assistant_text", 1]
    ]);
    const liveIdsByKind = new Map(stableKinds.map((kind) => [kind, new Set()]));
    for (const update of replayUpdates) {
      const liveTimeline = update.liveMessages
        ?.filter((message) => message.role === "assistant")
        .flatMap((message) => message.timeline ?? []) ?? update.timeline;
      for (const item of liveTimeline) liveIdsByKind.get(item.kind)?.add(item.id);
    }
    for (const kind of stableKinds) {
      const liveIds = liveIdsByKind.get(kind);
      const persistedItems = replayReply.timeline.filter((item) => item.kind === kind);
      assert.equal(liveIds.size, expectedKindCounts.get(kind), `${provider.providerName} ${kind} must not remount across real Pi events`);
      assert.equal(persistedItems.length, expectedKindCounts.get(kind), `${provider.providerName} should persist every ${kind}`);
      assert.deepEqual(
        [...liveIds].sort(),
        persistedItems.map((item) => item.id).sort(),
        `${provider.providerName} ${kind} must retain every live id after persistence`
      );
    }
    const persistedVisibleItems = replayReply.timeline.filter((item) => stableKinds.includes(item.kind));
    assert.deepEqual(
      persistedVisibleItems.map((item) => item.kind),
      ["thinking", "tool_call", "tool_call", "tool_result", "tool_result", "assistant_text"]
    );
    assert.equal(new Set(persistedVisibleItems.map((item) => item.id)).size, persistedVisibleItems.length);
    assert.deepEqual(
      persistedVisibleItems.filter((item) => item.kind === "tool_call").map((item) => item.toolCallId),
      expectedToolCallIds
    );
    assert.deepEqual(
      persistedVisibleItems.filter((item) => item.kind === "tool_result").map((item) => item.toolCallId),
      expectedToolCallIds
    );

    const correlationCaptureStart = captures.length;
    await runPiCodingAgentChat({
      provider: {
        providerName: provider.providerName,
        apiKey: "test-key",
        baseUrl,
        modelId: provider.modelId,
        capabilities: {
          vision: provider.providerName === "moonshot",
          imageOutput: false,
          toolCalling: true,
          reasoning: true,
          embedding: false
        }
      },
      messages: [
        { role: "user", content: "persisted double-tool history" },
        {
          role: "assistant",
          content: replayReply.content,
          // Match SQLite's JSON round trip before restoring this history into Pi.
          timeline: JSON.parse(JSON.stringify(replayReply.timeline))
        },
        { role: "user", content: `timeline correlation replay follow-up ${provider.providerName}` }
      ],
      content: `timeline correlation replay follow-up ${provider.providerName}`,
      attachments: [],
      jasminePromptAppend: "Keep persisted tool correlation ids unchanged.",
      cwd: tempDir,
      agentDir,
      toolsEnabled: true,
      reasoningEffort: "high"
    });
    const correlationPayloads = captures.slice(correlationCaptureStart);
    assert.equal(correlationPayloads.length, 1);
    const correlationAssistant = correlationPayloads[0].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.deepEqual(correlationAssistant.tool_calls.map((call) => call.id), expectedToolCallIds);
    assert.deepEqual(
      correlationPayloads[0].messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
      expectedToolCallIds
    );
  }

  const foreignHistorySession = SessionManager.inMemory(tempDir);
  foreignHistorySession.appendMessage({
    role: "user",
    content: "Inspect the fixture with the old model.",
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "FOREIGN_GLM_PRIVATE_REASONING_MUST_NOT_BECOME_CONTENT", thinkingSignature: "reasoning_content" },
      { type: "text", text: "Visible GLM tool preamble remains available." },
      { type: "toolCall", id: "foreign-glm-tool-call", name: "read", arguments: { path: path.join(tempDir, "reasoning-replay.txt") } }
    ],
    api: "openai-completions",
    provider: "aliyun-bailian",
    model: "glm-5-2",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "toolResult",
    toolCallId: "foreign-glm-tool-call",
    toolName: "read",
    content: [{ type: "text", text: "foreign tool result" }],
    isError: false,
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Visible GLM final answer remains available." }],
    api: "openai-completions",
    provider: "aliyun-bailian",
    model: "glm-5-2",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "user",
    content: "Inspect the fixture again with DeepSeek Pro.",
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "DEEPSEEK_PRO_SIGNED_REASONING", thinkingSignature: "reasoning_content" },
      { type: "text", text: "Visible DeepSeek Pro tool preamble." },
      { type: "toolCall", id: "deepseek-pro-tool-call", name: "read", arguments: { path: path.join(tempDir, "reasoning-replay.txt") } }
    ],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: Date.now()
  });
  foreignHistorySession.appendMessage({
    role: "toolResult",
    toolCallId: "deepseek-pro-tool-call",
    toolName: "read",
    content: [{ type: "text", text: "deepseek pro tool result" }],
    isError: false,
    timestamp: Date.now()
  });
  const foreignHistoryCaptureStart = captures.length;
  const foreignHistoryReply = await runPiCodingAgentChat({
    provider: {
      providerName: "deepseek",
      apiKey: "test-key",
      baseUrl,
      modelId: "deepseek-v4-flash",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: true,
        embedding: false
      }
    },
    messages: [{ role: "user", content: "foreign reasoning history regression" }],
    content: "foreign reasoning history regression",
    attachments: [],
    jasminePromptAppend: "Answer the regression prompt.",
    cwd: tempDir,
    agentDir,
    toolsEnabled: true,
    reasoningEffort: "high",
    sessionManager: foreignHistorySession
  });
  assert.equal(foreignHistoryReply.content, "foreign reasoning history passed");
  assert.equal(foreignHistoryReply.timeline.some((item) => item.kind === "thinking" && item.text === "native deepseek reasoning remains separate"), true);
  const foreignHistoryPayloads = captures.slice(foreignHistoryCaptureStart);
  assert.equal(foreignHistoryPayloads.length, 1);
  const foreignHistoryPayloadText = JSON.stringify(foreignHistoryPayloads[0].messages);
  // Jasmine deliberately delegates cross-model history conversion to Pi.
  // Pi converts foreign thinking to assistant content and preserves the
  // associated tool protocol instead of applying an app-specific filter.
  assert.match(foreignHistoryPayloadText, /FOREIGN_GLM_PRIVATE_REASONING_MUST_NOT_BECOME_CONTENT/);
  assert.match(foreignHistoryPayloadText, /Visible GLM tool preamble remains available/);
  assert.match(foreignHistoryPayloadText, /foreign-glm-tool-call|foreign tool result/);
  assert.match(foreignHistoryPayloadText, /Visible GLM final answer remains available/);
  const crossModelDeepSeekAssistant = foreignHistoryPayloads[0].messages.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "deepseek-pro-tool-call");
  assert.match(crossModelDeepSeekAssistant.content, /DEEPSEEK_PRO_SIGNED_REASONING/);
  assert.equal(crossModelDeepSeekAssistant.reasoning_content, "");
  assert.equal(foreignHistoryPayloads[0].messages.some((message) => message.role === "tool" && message.tool_call_id === "deepseek-pro-tool-call"), true);
  const canonicalForeignAssistant = foreignHistorySession.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.model === "glm-5-2");
  assert.equal(canonicalForeignAssistant.message.content.some((block) => block.type === "thinking" && block.thinking === "FOREIGN_GLM_PRIVATE_REASONING_MUST_NOT_BECOME_CONTENT"), true);
  const canonicalDeepSeekProAssistant = foreignHistorySession.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.model === "deepseek-v4-pro");
  assert.equal(canonicalDeepSeekProAssistant.message.content.some((block) => block.type === "thinking" && block.thinking === "DEEPSEEK_PRO_SIGNED_REASONING"), true);

  const contentOnlyCaptureStart = captures.length;
  const contentOnlyReply = await runPiCodingAgentChat({
    provider: {
      providerName: "deepseek",
      apiKey: "test-key",
      baseUrl,
      modelId: "deepseek-v4-flash",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: true,
        embedding: false
      }
    },
    messages: [{ role: "user", content: "deepseek content-only thinking fallback" }],
    content: "deepseek content-only thinking fallback",
    attachments: [],
    jasminePromptAppend: "Use the read tool and then answer.",
    cwd: tempDir,
    agentDir,
    toolsEnabled: true,
    reasoningEffort: "high"
  });
  assert.equal(contentOnlyReply.content, "The user asked me to inspect the fixture first, so I need to read it before I can produce the final answer.\ncontent-only fallback passed");
  assert.equal(contentOnlyReply.timeline.some((item) => item.kind === "thinking" && item.text.includes("need to read it")), false);
  assert.equal(contentOnlyReply.timeline.some((item) => item.kind === "assistant_text" && item.text.includes("need to read it")), true);
  const contentOnlyPayloads = captures.slice(contentOnlyCaptureStart);
  assert.equal(contentOnlyPayloads.length, 2);
  const contentOnlyAssistant = contentOnlyPayloads[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
  assert.match(contentOnlyAssistant.content, /need to read it/);
  assert.equal(contentOnlyAssistant.reasoning_content, "");

  const totallyEmptyReply = await generateAssistantReply({
    threadId: "totally-empty-thread",
    messages: [{ role: "user", content: "totally empty response" }],
    content: "totally empty response",
    attachments: [],
    piAgentDir: agentDir,
    toolsEnabled: true,
    reasoningEffort: "high"
  }, {
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: true,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  });
  assert.match(totallyEmptyReply.content, /completed without final assistant text or visible activity/);
  assert.equal(totallyEmptyReply.timeline.some((item) => item.kind === "assistant_text" && item.text === totallyEmptyReply.content), true);
  const providerFailureConfig = {
    providerName: "third-party-openai-compatible",
    apiKey: fakeProviderSecret,
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: true,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  };
  const authFailureReply = await generateAssistantReply({
      threadId: "provider-auth-failure-thread",
      messages: [{ role: "user", content: "provider auth failure regression" }],
      content: "provider auth failure regression",
      attachments: [],
      piAgentDir: agentDir,
      toolsEnabled: true,
      reasoningEffort: "high"
    }, providerFailureConfig);
  assert.match(authFailureReply.providerError, /third-party-openai-compatible authentication failed \(401\)/);
  assert.match(authFailureReply.providerError, /Invalid API key/);
  assert.match(authFailureReply.providerError, /Check or replace the API key/);
  assert.doesNotMatch(authFailureReply.providerError, new RegExp(fakeProviderSecret));
  assert.doesNotMatch(authFailureReply.providerError, new RegExp(unrelatedAccessToken));
  assert.doesNotMatch(authFailureReply.providerError, new RegExp(unrelatedJwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(authFailureReply.providerError, /completed without final assistant text/);
  assert.equal(authFailureReply.generatedMessages.length, 0);

  const baseUrlFailureReply = await generateAssistantReply({
      threadId: "provider-base-url-failure-thread",
      messages: [{ role: "user", content: "provider base url failure regression" }],
      content: "provider base url failure regression",
      attachments: [],
      piAgentDir: agentDir,
      toolsEnabled: true,
      reasoningEffort: "high"
    }, providerFailureConfig);
  assert.match(baseUrlFailureReply.providerError, /request failed \(404 Not Found\)/);
  assert.match(baseUrlFailureReply.providerError, /Base URL/);
  assert.match(baseUrlFailureReply.providerError, /\/v1/);
  assert.doesNotMatch(baseUrlFailureReply.providerError, /<!DOCTYPE|<html>/i);
  assert.doesNotMatch(baseUrlFailureReply.providerError, /completed without final assistant text/);

  const queuedProviderFailureCaptureStart = captures.length;
  const queuedProviderFailureSession = SessionManager.inMemory(tempDir);
  const queuedProviderFailureReply = await generateAssistantReply({
      threadId: "queued-provider-failure-thread",
      messages: [{ role: "user", content: "queued provider error then success regression" }],
      content: "queued provider error then success regression",
      attachments: [],
      piAgentDir: agentDir,
      sessionManager: queuedProviderFailureSession,
      toolsEnabled: true,
      reasoningEffort: "high"
    }, providerFailureConfig, {
      onQueueReady(controls) {
        void controls.queueMessage({
          mode: "followUp",
          content: "queued provider recovery success",
          attachments: []
        });
      }
  });
  assert.match(queuedProviderFailureReply.providerError, /authentication failed \(401\)/);
  assert.deepEqual(
    queuedProviderFailureSession.getEntries()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
      .map((entry) => entry.message.stopReason),
    ["error"]
  );
  const queuedProviderFailurePayloads = captures.slice(queuedProviderFailureCaptureStart);
  assert.equal(queuedProviderFailurePayloads.length, 1);
  assert.equal(JSON.stringify(queuedProviderFailureSession.getEntries()).includes("queued provider recovery success"), false);

  const laterQueuedFailureCaptureStart = captures.length;
  const laterQueuedFailureSession = SessionManager.inMemory(tempDir);
  const laterQueuedFailureReply = await generateAssistantReply({
    threadId: "later-queued-provider-failure-thread",
    messages: [{ role: "user", content: "queued provider initial success" }],
    content: "queued provider initial success",
    attachments: [],
    piAgentDir: agentDir,
    sessionManager: laterQueuedFailureSession,
    toolsEnabled: true,
    reasoningEffort: "high"
  }, providerFailureConfig, {
    onQueueReady(controls) {
      void controls.queueMessage({
        mode: "followUp",
        content: "queued provider later failure regression",
        attachments: []
      });
    }
  });
  assert.match(laterQueuedFailureReply.providerError, /authentication failed \(401\)/);
  assert.deepEqual(laterQueuedFailureReply.generatedMessages.map((message) => message.role), ["assistant", "user"]);
  assert.equal(laterQueuedFailureReply.generatedMessages[0].content, "ok");
  assert.equal(laterQueuedFailureReply.generatedMessages[1].content, "queued provider later failure regression");
  assert.deepEqual(
    laterQueuedFailureSession.getEntries()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
      .map((entry) => entry.message.stopReason),
    ["stop", "error"]
  );
  assert.equal(captures.slice(laterQueuedFailureCaptureStart).length, 2);

  const activeSteerFailureCaptureStart = captures.length;
  const activeSteerUnhandledRejections = [];
  const captureActiveSteerRejection = (error) => activeSteerUnhandledRejections.push(error);
  process.on("unhandledRejection", captureActiveSteerRejection);
  let activeSteerFailureReply;
  let activeSteerControls;
  try {
    activeSteerFailureReply = await generateAssistantReply({
      threadId: "initial-provider-error-active-steer-thread",
      messages: [{ role: "user", content: "initial provider error with active steer regression" }],
      content: "initial provider error with active steer regression",
      attachments: [],
      piAgentDir: agentDir,
      sessionManager: SessionManager.inMemory(tempDir),
      toolsEnabled: true,
      reasoningEffort: "high"
    }, providerFailureConfig, {
      onQueueReady(controls) {
        activeSteerControls = controls;
        setTimeout(() => {
          void controls.queueMessage({
            mode: "steer",
            content: "active steer failure after initial error",
            attachments: []
          });
        }, 30);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", captureActiveSteerRejection);
  }
  assert.match(activeSteerFailureReply.providerError, /request failed/);
  assert.equal(activeSteerUnhandledRejections.length, 0);
  assert.equal(captures.slice(activeSteerFailureCaptureStart).length, 2);
  await assert.rejects(
    () => activeSteerControls.queueMessage({ mode: "followUp", content: "must not queue after failure", attachments: [] }),
    /no longer accepting queued messages/
  );

  const failedSteerAttachmentCaptureStart = captures.length;
  const failedSteerAttachment = {
    kind: "file",
    name: "steer-notes.txt",
    path: path.join(tempDir, "reasoning-replay.txt"),
    isImage: false
  };
  const failedSteerAttachmentSession = SessionManager.inMemory(tempDir);
  const failedSteerAttachmentReply = await generateAssistantReply({
    threadId: "failed-steer-attachment-thread",
    messages: [{ role: "user", content: "steer attachment initial success" }],
    content: "steer attachment initial success",
    attachments: [],
    piAgentDir: agentDir,
    sessionManager: failedSteerAttachmentSession,
    toolsEnabled: true,
    reasoningEffort: "high"
  }, providerFailureConfig, {
    onQueueReady(controls) {
      setTimeout(() => {
        void controls.queueMessage({
          mode: "steer",
          content: "failed steer attachment regression",
          attachments: [failedSteerAttachment]
        });
      }, 30);
    }
  });
  assert.match(failedSteerAttachmentReply.providerError, /authentication failed \(401\)/);
  const failedSteerPiUserText = failedSteerAttachmentSession.getEntries()
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => typeof entry.message.content === "string" ? entry.message.content : JSON.stringify(entry.message.content))
    .join("\n");
  assert.match(failedSteerPiUserText, /Attached local paths/);
  const persistedFailedSteerUser = failedSteerAttachmentReply.generatedMessages.find((message) => message.role === "user");
  assert.equal(persistedFailedSteerUser.content, "failed steer attachment regression");
  assert.deepEqual(persistedFailedSteerUser.attachments, [failedSteerAttachment]);
  assert.doesNotMatch(persistedFailedSteerUser.content, /Attached local paths/);
  assert.equal(captures.slice(failedSteerAttachmentCaptureStart).length, 2);
  assert.equal(fallbackTitle("来玩成语接龙"), "来玩成语接龙");
  assert.equal(fallbackTitle("  你好，告诉我拿破仑说过什么精彩的palindrome  "), "你好，告诉我拿破仑说过什么精彩的palindrome");
  assert.equal(Array.from(fallbackTitle("很长的首条消息".repeat(20))).length, 48);
  assert.doesNotMatch(fallbackTitle("😀".repeat(60)), /\uD83D$/u);
  const generatedTitle = await generateTitleWithProvider({
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: false,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: JSON.stringify({ temperature: 0.1 })
  }, "quarterly planning title for the launch meeting", "quarterly planning title");
  assert.equal(generatedTitle, "Quarterly planning");
  const titlePayload = captures.at(-1);
  assert.equal(titlePayload.model, "jasmine-test");
  assert.equal(titlePayload.stream, false);
  assert.equal(titlePayload.temperature, 0.1);
  assert.equal(titlePayload.reasoning_effort, "low");
  assert.equal(titlePayload.max_tokens, 96);
  assert.equal(titlePayload.tools, undefined);
  assert.equal(titlePayload.messages.length, 2);
  assert.equal(titlePayload.messages[0].role, "system");
  assert.match(titlePayload.messages[0].content, /never answer it/);
  assert.match(titlePayload.messages[1].content, /"quarterly planning title for the launch meeting"/);
  assert.match(titlePayload.messages[0].content, /not a conversational assistant/);
  const directReplyCaptureStart = captures.length;
  const recoveredDirectReplyTitle = await generateTitleWithProviderResult({
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: false,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  }, "你好，帮我看看我最近的钉钉消息是说明把 direct reply title regression", "你好，帮我看看我最近的钉钉消息是说明把");
  assert.equal(recoveredDirectReplyTitle.title, "钉钉近期消息查看");
  assert.equal(recoveredDirectReplyTitle.usedFallback, false);
  assert.match(recoveredDirectReplyTitle.debugSummary, /primary validation=unstructured response/);
  assert.equal(captures.slice(directReplyCaptureStart).length, 2);
  const rejectedShortReplyTitle = await generateTitleWithProviderResult({
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: { vision: false, imageOutput: false, toolCalling: true, reasoning: false, embedding: false },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  }, "你好吗 short conversational title regression", "你好吗");
  assert.equal(rejectedShortReplyTitle.title, "你好吗");
  assert.equal(rejectedShortReplyTitle.usedFallback, true);
  assert.equal(rejectedShortReplyTitle.fallbackReason, "conversational punctuation");
  retryableTitleRequestCount = 0;
  const recoveredTimedOutTitle = await generateTitleWithProviderResult({
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: { vision: false, imageOutput: false, toolCalling: true, reasoning: false, embedding: false },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  }, "retryable title request regression", "retryable title request regression");
  assert.equal(recoveredTimedOutTitle.title, "超时后的标题重试");
  assert.equal(recoveredTimedOutTitle.usedFallback, false);
  assert.equal(retryableTitleRequestCount, 2);
  assert.match(recoveredTimedOutTitle.debugSummary, /Tool title request failed: 408/);
  const titleProvider = (providerName, modelId) => ({
    providerName,
    apiKey: "test-key",
    baseUrl,
    modelId,
    capabilities: { vision: false, imageOutput: false, toolCalling: true, reasoning: true, embedding: false },
    providerOptionsJson: "{}"
  });
  await generateTitleWithProvider(titleProvider("deepseek", "deepseek-v4-flash"), "quarterly planning title deepseek", "fallback", "off");
  const deepSeekTitlePayload = captures.at(-1);
  assert.deepEqual(deepSeekTitlePayload.thinking, { type: "disabled" });
  assert.equal(deepSeekTitlePayload.temperature, undefined);
  assert.equal(deepSeekTitlePayload.reasoning_effort, undefined);
  await generateTitleWithProvider(titleProvider("moonshot", "kimi-k2.6"), "quarterly planning title kimi 2.6", "fallback", "off");
  const kimi26TitlePayload = captures.at(-1);
  assert.deepEqual(kimi26TitlePayload.thinking, { type: "disabled" });
  assert.equal(kimi26TitlePayload.temperature, undefined);
  assert.equal(kimi26TitlePayload.reasoning_effort, undefined);
  await generateTitleWithProvider(titleProvider("moonshot", "kimi-k2.7-code"), "quarterly planning title kimi 2.7", "fallback", "off");
  const kimi27TitlePayload = captures.at(-1);
  assert.equal(kimi27TitlePayload.thinking, undefined);
  assert.equal(kimi27TitlePayload.temperature, undefined);
  assert.equal(kimi27TitlePayload.reasoning_effort, undefined);
  await generateTitleWithProvider(titleProvider("moonshot", "kimi-k3"), "quarterly planning title kimi 3", "fallback", "off");
  const kimi3TitlePayload = captures.at(-1);
  assert.equal(kimi3TitlePayload.thinking, undefined);
  assert.equal(kimi3TitlePayload.temperature, undefined);
  assert.equal(kimi3TitlePayload.reasoning_effort, "low");
  const emptyTitle = await generateTitleWithProviderResult({
    providerName: "jasmine-mock",
    apiKey: "test-key",
    baseUrl,
    modelId: "jasmine-test",
    capabilities: {
      vision: false,
      imageOutput: false,
      toolCalling: true,
      reasoning: false,
      embedding: false
    },
    contextWindow: 128000,
    maxOutputTokens: 1200,
    providerOptionsJson: "{}"
  }, "empty title request", "empty title request");
  assert.equal(emptyTitle.title, "empty title request");
  assert.equal(emptyTitle.usedFallback, true);
  assert.equal(emptyTitle.fallbackReason, "empty title");

  const selectedSkillDir = path.join(tempDir, "selected-skills", "technical-writer");
  await mkdir(selectedSkillDir, { recursive: true });
  const selectedSkillPath = path.join(selectedSkillDir, "SKILL.md");
  await writeFile(selectedSkillPath, [
    "---",
    "name: technical-writer",
    "description: Tightens explanations for technical readers.",
    "---",
    "",
    "# Technical Writer",
    "",
    "Use concise headings and remove vague filler."
  ].join("\n"));

  const discoverableSkillDir = path.join(tempDir, "configured-skills", "release-notes");
  const discoverableSkillPath = path.join(discoverableSkillDir, "SKILL.md");
  const discoverableSkillBodyMarker = "DISCOVERABLE_SKILL_BODY_MUST_NOT_BE_PRELOADED";
  await mkdir(discoverableSkillDir, { recursive: true });
  await writeFile(discoverableSkillPath, [
    "---",
    "name: release-notes",
    "description: Produces focused release notes when a task asks for them.",
    "---",
    "",
    "# Release notes",
    "",
    discoverableSkillBodyMarker
  ].join("\n"));
  const disabledSkillDir = path.join(tempDir, "configured-skills", "disabled-private-skill");
  const disabledSkillPath = path.join(disabledSkillDir, "SKILL.md");
  await mkdir(disabledSkillDir, { recursive: true });
  await writeFile(disabledSkillPath, [
    "---",
    "name: disabled-private-skill",
    "description: This disabled skill must not be discoverable.",
    "---",
    "",
    "DISABLED_SKILL_BODY_MUST_NOT_APPEAR"
  ].join("\n"));

  const enabledSkillManifests = await prepareEnabledSkillManifests([{
    id: "release-notes",
    name: "release-notes",
    description: "Produces focused release notes when a task asks for them.",
    instructions: discoverableSkillBodyMarker,
    enabled: true,
    source: "external",
    skillFilePath: discoverableSkillPath,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  }, {
    id: "disabled-private-skill",
    name: "disabled-private-skill",
    description: "This disabled skill must not be discoverable.",
    instructions: "DISABLED_SKILL_BODY_MUST_NOT_APPEAR",
    enabled: false,
    source: "external",
    skillFilePath: disabledSkillPath,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  }], userDataDir);
  assert.deepEqual(enabledSkillManifests.map((skill) => skill.skillFilePath), [discoverableSkillPath]);

  const captureCountBeforeDiscoverableSkill = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "write ordinary prose" }],
    content: "write ordinary prose",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    availableSkillPaths: enabledSkillManifests.map((skill) => skill.skillFilePath)
  });
  assert.equal(captures.length, captureCountBeforeDiscoverableSkill + 1);
  const discoverableSkillPayloadText = JSON.stringify(captures.at(-1));
  assert.match(discoverableSkillPayloadText, /release-notes/);
  assert.match(discoverableSkillPayloadText, /Produces focused release notes when a task asks for them/);
  assert.match(discoverableSkillPayloadText, /SKILL\.md/);
  assert.doesNotMatch(discoverableSkillPayloadText, new RegExp(discoverableSkillBodyMarker));
  assert.doesNotMatch(discoverableSkillPayloadText, /disabled-private-skill|DISABLED_SKILL_BODY_MUST_NOT_APPEAR/);

  const explicitSkillContent = modelContentForMessage({
    role: "user",
    content: "prepare the release notes",
    skillsUsed: [{
      id: "release-notes",
      name: "release-notes",
      description: "Produces focused release notes when a task asks for them.",
      instructions: discoverableSkillBodyMarker
    }]
  });
  assert.match(explicitSkillContent, /<explicit_user_selected_skills>/);
  assert.match(explicitSkillContent, new RegExp(discoverableSkillBodyMarker));
  assert.equal(modelContentForMessage({ role: "user", content: "prepare the release notes" }), "prepare the release notes");

  const captureCountBeforeSelectedSkill = captures.length;
  const taxonomyCaptures = [];
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "use the selected skill" }],
    content: "use the selected skill",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    skillContext: [{
      id: "technical-writer",
      name: "technical-writer",
      description: "Tightens explanations for technical readers.",
      source: "external",
      skillFilePath: selectedSkillPath
    }],
    onContextTaxonomy: (taxonomy) => taxonomyCaptures.push(taxonomy)
  });
  assert.equal(captures.length, captureCountBeforeSelectedSkill + 1);
  assert.equal(taxonomyCaptures.length, 1);
  const selectedSkillPayload = captures.at(-1);
  const selectedSkillPayloadText = JSON.stringify(selectedSkillPayload);
  const capturedRawProviderPayload = JSON.parse(taxonomyCaptures[0].rawPayload);
  assert.deepEqual(capturedRawProviderPayload, normalizePayload(selectedSkillPayload));
  assert.equal(taxonomyCaptures[0].payloadSchemaVersion, 7);
  assert.equal(
    taxonomyCaptures[0].payloadHash,
    createHash("sha256").update(taxonomyCaptures[0].rawPayload).digest("hex")
  );
  assert.equal(taxonomyCaptures[0].payloadShape.topLevelOrder.includes("messages"), true);
  assert.equal(taxonomyCaptures[0].payloadShape.topLevelOrder.includes("tools"), true);
  assert.equal(taxonomyCaptures[0].payloadShape.messagesBeforeTools, true);
  assert.equal(taxonomyCaptures[0].cacheMetrics.cacheHitTokens, 6);
  assert.equal(taxonomyCaptures[0].cacheMetrics.cacheMissTokens, 4);
  assert.equal(taxonomyCaptures[0].cacheMetrics.status, "hit");
  assert.equal(taxonomyCaptures[0].items.some((item) => item.kind === "system_prompt" && item.segments.some((segment) => segment.kind === "project_context")), true);
  assert.equal(taxonomyCaptures[0].items.some((item) => item.kind === "current_user_prompt" && item.payloadPath?.startsWith("$.messages[")), true);
  assert.doesNotMatch(selectedSkillPayloadText, /Active user-selected skill manifests/);
  assert.doesNotMatch(selectedSkillPayloadText, /Use concise headings and remove vague filler/);
  assert.match(selectedSkillPayloadText, /technical-writer/);
  assert.match(selectedSkillPayloadText, /Tightens explanations for technical readers/);
  assert.match(selectedSkillPayloadText, /SKILL\.md/);
  assert.deepEqual(
    taxonomyToolNames(taxonomyCaptures[0]).sort(),
    payloadToolNames(selectedSkillPayload).sort()
  );
  assert.equal(taxonomyToolNames(taxonomyCaptures[0]).includes("read"), true);
  assert.equal(taxonomyCaptures[0].items.some((item) => item.source === "provider.payload.options" && item.text.includes("jasmine-test")), true);

  const captureCountBeforeNoTools = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello without tools" }],
    content: "hello without tools",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: false
  });
  assert.equal(captures.length, captureCountBeforeNoTools + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("read"), true);

  const builtinPluginRecords = await listPluginPackages({ userDataDir });
  const builtinRuntimeRecords = builtinPluginRecords.filter((plugin) => normalizePath(plugin.source).includes("/plugins/"));
  const builtinChromeRecords = builtinRuntimeRecords.filter((plugin) => plugin.displayName === "Chrome");
  assert.equal(builtinRuntimeRecords.length, 0);
  assert.equal(builtinChromeRecords.length, 0);
  const builtinSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal((builtinSettings.packages ?? []).filter((source) =>
    typeof source === "object" && normalizePath(source.source).includes("/plugins/")
  ).length, 0);

  const fixturePackageDir = path.join(tempDir, "fixture-pi-package");
  await mkdir(path.join(fixturePackageDir, "skills", "jasmine-fixture"), { recursive: true });
  await writeFile(path.join(fixturePackageDir, "package.json"), JSON.stringify({
    name: "jasmine-fixture-plugin",
    version: "1.0.0",
    type: "module",
    pi: {
      extensions: ["./extension.js"],
      skills: ["./skills"]
    }
  }, null, 2));
  await writeFile(path.join(fixturePackageDir, "extension.js"), [
    "import { Type } from '@earendil-works/pi-ai';",
    "export default function fixturePlugin(pi) {",
    "  pi.registerTool({",
    "    name: 'jasmine_fixture_tool',",
    "    label: 'Jasmine fixture tool',",
    "    description: 'Fixture tool provided by a Jasmine plugin package.',",
    "    parameters: Type.Object({}),",
    "    async execute() { return { content: [{ type: 'text', text: 'fixture result' }] }; }",
    "  });",
    "}"
  ].join("\n"));
  await writeFile(path.join(fixturePackageDir, "skills", "jasmine-fixture", "SKILL.md"), [
    "---",
    "name: jasmine-fixture",
    "description: Fixture skill from a plugin package.",
    "---",
    "",
    "# Jasmine Fixture",
    "",
    "Mention the fixture package when it is relevant."
  ].join("\n"));

  const fileChangesPackageDir = path.join(tempDir, "file-changes-pi-package");
  const fileChangesExtensionPath = path.join(fileChangesPackageDir, "extension.js");
  const undeclaredFileChangesPath = path.join(fileChangesPackageDir, "undeclared.js");
  await mkdir(fileChangesPackageDir, { recursive: true });
  await writeFile(path.join(fileChangesPackageDir, "package.json"), JSON.stringify({
    name: "@jasmine-ai/pi-file-changes",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extension.js"] }
  }, null, 2));
  await writeFile(fileChangesExtensionPath, [
    "import { Type } from '@earendil-works/pi-ai';",
    "export default function duplicateFileChangesPackage(pi) {",
    "  pi.registerTool({",
    "    name: 'duplicate_file_changes_marker',",
    "    label: 'Duplicate file changes marker',",
    "    description: 'Must be absent when Jasmine owns file-change tracking.',",
    "    parameters: Type.Object({}),",
    "    async execute() { return { content: [{ type: 'text', text: 'duplicate tracker loaded' }] }; }",
    "  });",
    "}"
  ].join("\n"));
  await writeFile(undeclaredFileChangesPath, "export default function undeclared() {}\n");

  const lookalikeFileChangesPackageDir = path.join(tempDir, "file-changes-lookalike-package");
  const lookalikeFileChangesExtensionPath = path.join(lookalikeFileChangesPackageDir, "extension.js");
  await mkdir(lookalikeFileChangesPackageDir, { recursive: true });
  await writeFile(path.join(lookalikeFileChangesPackageDir, "package.json"), JSON.stringify({
    name: "@jasmine-ai/pi-file-changes-extra",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extension.js"] }
  }, null, 2));
  await writeFile(lookalikeFileChangesExtensionPath, "export default function lookalike() {}\n");

  assert.equal(isJasmineFileChangesPackageSourcePath(fileChangesPackageDir), true);
  assert.equal(isJasmineFileChangesPackageExtensionPath(fileChangesExtensionPath), true);
  assert.equal(isJasmineFileChangesPackageExtensionPath(undeclaredFileChangesPath), false);
  assert.equal(isJasmineFileChangesPackageSourcePath(lookalikeFileChangesPackageDir), false);
  assert.equal(isJasmineFileChangesPackageExtensionPath(lookalikeFileChangesExtensionPath), false);

  let pluginRecords = await setPluginPackageEnabled({ userDataDir }, fixturePackageDir, true);
  const enabledFixtureRecord = pluginRecords.find((plugin) => samePath(plugin.installedPath ?? plugin.source, fixturePackageDir));
  assert.equal(Boolean(enabledFixtureRecord?.enabled), true);
  const pluginSkills = await listPluginSkills({ userDataDir });
  const fixturePluginSkill = pluginSkills.find((skill) => skill.name === "jasmine-fixture");
  assert.match(fixturePluginSkill?.id ?? "", /^plugin:/);
  assert.equal(fixturePluginSkill?.source, "plugin");
  assert.equal(fixturePluginSkill?.pluginPackageId, enabledFixtureRecord?.id);
  assert.equal(fixturePluginSkill?.pluginPackageName, "fixture-pi-package");
  let packageSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(packageSettings.packages.some((source) => typeof source === "string" && samePackageSourcePath(source, fixturePackageDir, agentDir)), true);
  let packageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir });
  assert.equal(packageSkillPaths.some((skillPath) => skillPath.endsWith("SKILL.md")), true);
  const captureCountBeforeFixturePlugin = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello with fixture plugin" }],
    content: "hello with fixture plugin",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforeFixturePlugin + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), true);
  assert.match(JSON.stringify(captures.at(-1)), /Fixture skill from a plugin package/);

  pluginRecords = await setPluginPackageEnabled({ userDataDir }, fileChangesPackageDir, true);
  const enabledFileChangesRecord = pluginRecords.find((plugin) => samePath(plugin.installedPath ?? plugin.source, fileChangesPackageDir));
  assert.equal(Boolean(enabledFileChangesRecord?.enabled), true);
  const fileChangesDedupeCwd = path.join(tempDir, "file-changes-dedupe-cwd");
  await mkdir(fileChangesDedupeCwd, { recursive: true });
  await writeFile(path.join(fileChangesDedupeCwd, "baseline.txt"), "unchanged\n");
  const settingsFileChangeCaptures = [];
  const captureCountBeforeSettingsFileChangesDedupe = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "verify settings file-change package dedupe" }],
    content: "verify settings file-change package dedupe",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    cwd: fileChangesDedupeCwd,
    agentDir,
    toolsEnabled: true,
    fileChangeTrackingMode: "watcher",
    onFileChanges: (capture) => settingsFileChangeCaptures.push(capture)
  });
  assert.equal(captures.length, captureCountBeforeSettingsFileChangesDedupe + 1);
  assert.equal(settingsFileChangeCaptures.length, 1, "Jasmine must retain exactly one inline file-change tracker");
  assert.equal(settingsFileChangeCaptures[0].coverage.trackingMode, "watcher");
  assert.equal(payloadToolNames(captures.at(-1)).includes("duplicate_file_changes_marker"), false);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), true, "unrelated packages must remain loaded");

  pluginRecords = await setPluginPackageEnabled({ userDataDir }, fileChangesPackageDir, false);
  const disabledFileChangesRecord = pluginRecords.find((plugin) => samePath(plugin.installedPath ?? plugin.source, fileChangesPackageDir));
  assert.equal(Boolean(disabledFileChangesRecord && !disabledFileChangesRecord.enabled), true);
  const temporaryFileChangesSources = await resolvePluginPackageRuntimeSources({ userDataDir }, [disabledFileChangesRecord.id]);
  assert.equal(temporaryFileChangesSources.some((source) => samePackageSourcePath(source, fileChangesPackageDir, agentDir)), true);
  const temporaryFileChangeCaptures = [];
  const captureCountBeforeTemporaryFileChangesDedupe = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "verify temporary file-change package dedupe" }],
    content: "verify temporary file-change package dedupe",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    cwd: fileChangesDedupeCwd,
    agentDir,
    toolsEnabled: true,
    packageExtensionPaths: temporaryFileChangesSources,
    onFileChanges: (capture) => temporaryFileChangeCaptures.push(capture)
  });
  assert.equal(captures.length, captureCountBeforeTemporaryFileChangesDedupe + 1);
  assert.equal(temporaryFileChangeCaptures.length, 1);
  assert.equal(temporaryFileChangeCaptures[0].coverage.trackingMode, "managed-tools-only");
  assert.equal(payloadToolNames(captures.at(-1)).includes("duplicate_file_changes_marker"), false);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), true);

  pluginRecords = await setPluginPackageEnabled({ userDataDir }, fixturePackageDir, false);
  const disabledFixtureRecord = pluginRecords.find((plugin) => samePath(plugin.installedPath ?? plugin.source, fixturePackageDir));
  assert.equal(Boolean(disabledFixtureRecord && !disabledFixtureRecord.enabled), true);
  packageSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  const disabledFixture = packageSettings.packages.find((source) => typeof source === "object" && samePackageSourcePath(source.source, fixturePackageDir, agentDir));
  assert.deepEqual(disabledFixture.extensions, []);
  assert.deepEqual(disabledFixture.skills, []);
  assert.deepEqual(disabledFixture.prompts, []);
  assert.deepEqual(disabledFixture.themes, []);
  packageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir });
  const captureCountBeforeDisabledFixture = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello after disabled fixture plugin" }],
    content: "hello after disabled fixture plugin",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforeDisabledFixture + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), false);
  assert.equal(payloadToolNames(captures.at(-1)).includes("read"), true);
  const temporaryFixtureRuntimeSources = await resolvePluginPackageRuntimeSources({ userDataDir }, [disabledFixtureRecord.id]);
  assert.equal(temporaryFixtureRuntimeSources.some((source) => samePackageSourcePath(source, fixturePackageDir, agentDir)), true);
  const captureCountBeforeTemporaryFixture = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello with temporary fixture plugin" }],
    content: "hello with temporary fixture plugin",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageExtensionPaths: temporaryFixtureRuntimeSources
  });
  assert.equal(captures.length, captureCountBeforeTemporaryFixture + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), true);
  assert.match(JSON.stringify(captures.at(-1)), /Fixture skill from a plugin package/);

  const piWebAccessRoot = resolvePiWebAccessPackageRoot();
  assert.equal(typeof piWebAccessRoot, "string");
  await setPluginPackageEnabled({ userDataDir }, piWebAccessRoot, true);
  packageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir });
  const captureCountBeforePiWebAccess = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello with pi web access" }],
    content: "hello with pi web access",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforePiWebAccess + 1);
  const piWebAccessToolNames = new Set((captures.at(-1).tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  assert.equal(piWebAccessToolNames.has("web_search"), true);
  assert.equal(piWebAccessToolNames.has("fetch_content"), true);
  assert.equal(piWebAccessToolNames.has("get_search_content"), true);
  assert.equal(piWebAccessToolNames.has("code_search"), true);
  assert.match(JSON.stringify(captures.at(-1)), /librarian/);

  const legacyPiWebAccessUserDataDir = path.join(tempDir, "legacy-pi-web-access-user-data");
  const legacyPiWebAccessAgentDir = path.join(legacyPiWebAccessUserDataDir, "pi-agent");
  await mkdir(legacyPiWebAccessAgentDir, { recursive: true });
  const legacyRelativePiWebAccessRoot = path.relative(legacyPiWebAccessAgentDir, piWebAccessRoot);
  const legacyLinkedPiWebAccessRoot = path.join(tempDir, "legacy-pi-web-access-link");
  let legacyAlternatePiWebAccessRoot = path.join(rootDir, "node_modules", "pi-web-access");
  try {
    await symlink(piWebAccessRoot, legacyLinkedPiWebAccessRoot, process.platform === "win32" ? "junction" : "dir");
    legacyAlternatePiWebAccessRoot = legacyLinkedPiWebAccessRoot;
  } catch {
    // Some environments disallow symlink creation; the workspace node_modules path
    // still exercises linked installs when dependencies are junctioned.
  }
  await writeFile(path.join(legacyPiWebAccessAgentDir, "settings.json"), JSON.stringify({
    packages: [
      { source: piWebAccessRoot, extensions: [], skills: [], prompts: [], themes: [] },
      legacyRelativePiWebAccessRoot,
      legacyAlternatePiWebAccessRoot
    ]
  }, null, 2));
  const legacyPluginRecords = await listPluginPackages({ userDataDir: legacyPiWebAccessUserDataDir });
  const legacyPiWebAccessRecords = legacyPluginRecords.filter((plugin) => plugin.displayName === "Pi Web Access");
  assert.equal(legacyPiWebAccessRecords.length, 1);
  assert.equal(legacyPiWebAccessRecords[0].enabled, true);
  assert.equal(legacyPiWebAccessRecords[0].resourceCounts.extensions.enabled >= 1, true);
  assert.equal(legacyPiWebAccessRecords[0].resourceCounts.skills.enabled >= 1, true);
  assert.equal(legacyPluginRecords.some((plugin) => plugin.displayName === "pi-web-access"), false);
  const legacyPackageSettings = JSON.parse(await readFile(path.join(legacyPiWebAccessAgentDir, "settings.json"), "utf8"));
  assert.equal(legacyPackageSettings.packages.length, 1);
  assert.equal(legacyPackageSettings.packages.some((source) => typeof source === "string" && samePath(source, piWebAccessRoot)), true);
  assert.equal(legacyPackageSettings.packages.filter((source) =>
    typeof source === "object" && normalizePath(source.source).includes("/plugins/")
  ).length, 0);
  const legacyPackageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir: legacyPiWebAccessUserDataDir });
  assert.equal(legacyPackageSkillPaths.some((skillPath) => skillPath.endsWith(path.join("skills", "librarian", "SKILL.md"))), true);
  const captureCountBeforeLegacyPiWebAccess = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "hello with legacy pi web access source" }],
    content: "hello with legacy pi web access source",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir: legacyPiWebAccessAgentDir,
    toolsEnabled: true,
    packageSkillPaths: legacyPackageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforeLegacyPiWebAccess + 1);
  const legacyPiWebAccessToolNames = new Set((captures.at(-1).tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  assert.equal(legacyPiWebAccessToolNames.has("web_search"), true);
  assert.equal(legacyPiWebAccessToolNames.has("fetch_content"), true);
  assert.equal(legacyPiWebAccessToolNames.has("get_search_content"), true);
  assert.equal(legacyPiWebAccessToolNames.has("code_search"), true);
  assert.match(JSON.stringify(captures.at(-1)), /librarian/);

  const promptTemplateDir = path.join(tempDir, "prompts");
  await mkdir(promptTemplateDir, { recursive: true });
  await writeFile(path.join(promptTemplateDir, "summarize.md"), [
    "---",
    "description: Summarize a topic",
    "argument-hint: <topic>",
    "---",
    "Summarize $ARGUMENTS in two concise bullets."
  ].join("\n"));
  const captureCountBeforePromptTemplate = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [{ role: "user", content: "/summarize jasmine docs" }],
    content: "/summarize jasmine docs",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true,
    promptTemplatePaths: [promptTemplateDir]
  });
  assert.equal(captures.length, captureCountBeforePromptTemplate + 1);
  const promptTemplatePayload = JSON.stringify(captures.at(-1));
  assert.match(promptTemplatePayload, /Summarize jasmine docs in two concise bullets/);
  assert.doesNotMatch(promptTemplatePayload, /\/summarize jasmine docs/);

  const captureCountBeforeRestoredHistory = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [
      { role: "user", content: "read the saved context" },
      {
        role: "assistant",
        content: "I read the file.",
        timeline: [
          { id: "debug-taxonomy", kind: "system", title: "Context taxonomy", text: "context-taxonomy-debug", customType: "context-taxonomy", data: { debug: true } },
          { id: "assistant-think-1", kind: "thinking", text: "Need the file before answering." },
          { id: "call_read_1", kind: "tool_call", toolName: "read", title: "read", argumentsJson: JSON.stringify({ path: "notes.md" }, null, 2) },
          { id: "result_read_1", kind: "tool_result", toolName: "read", title: "read", content: "Persisted tool result that must be replayed.", isError: false },
          { id: "assistant-text-1", kind: "assistant_text", text: "I read the file." }
        ]
      },
      { role: "user", content: "follow up after restored tool context" }
    ],
    content: "follow up after restored tool context",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, captureCountBeforeRestoredHistory + 1);
  const restoredHistoryPayload = JSON.stringify(captures.at(-1));
  assert.match(restoredHistoryPayload, /Persisted tool result that must be replayed/);
  assert.match(restoredHistoryPayload, /call_read_1/);
  assert.doesNotMatch(restoredHistoryPayload, /context-taxonomy-debug/);
  assert.equal(countSubstring(restoredHistoryPayload, "follow up after restored tool context"), 1);

  const captureCountBeforeStoppedReplay = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [
      { role: "user", content: "start a stoppable tool run" },
      {
        role: "assistant",
        content: "Response stopped.",
        timeline: [
          { id: "stopped-think-1", kind: "thinking", text: "Need to run a command before answering." },
          { id: "stopped_call_1", kind: "tool_call", toolName: "bash", title: "bash", argumentsJson: JSON.stringify({ command: "long-running command" }, null, 2) },
          { id: "stopped-output-1", kind: "assistant_text", text: "Response stopped." },
          { id: "stopped-system-1", kind: "system", title: "Stopped", text: "The response was stopped by the user." }
        ]
      },
      { role: "user", content: "continue after stopped tool run" }
    ],
    content: "continue after stopped tool run",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, captureCountBeforeStoppedReplay + 1);
  const stoppedReplayPayload = JSON.stringify(captures.at(-1));
  assert.match(stoppedReplayPayload, /stopped_call_1/);
  assert.match(stoppedReplayPayload, /Tool call was stopped by the user/);
  assert.equal(countSubstring(stoppedReplayPayload, "continue after stopped tool run"), 1);

  const historicalAttachmentPath = path.join(tempDir, "historical-notes.md");
  const captureCountBeforeRestoredAttachment = captures.length;
  await runPiCodingAgentChat({
    provider: {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    },
    messages: [
      {
        role: "user",
        content: "use my attached notes",
        attachments: [{
          kind: "file",
          name: "historical-notes.md",
          path: historicalAttachmentPath,
          isImage: false
        }]
      },
      { role: "assistant", content: "I can use those notes." },
      { role: "user", content: "follow up after restored attachment" }
    ],
    content: "follow up after restored attachment",
    attachments: [],
    jasminePromptAppend: systemPrompt,
    agentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, captureCountBeforeRestoredAttachment + 1);
  const restoredAttachmentPayload = JSON.stringify(captures.at(-1));
  assert.match(restoredAttachmentPayload, /Attached local paths/);
  assert.match(restoredAttachmentPayload, /historical-notes\.md/);
  assert.equal(countSubstring(restoredAttachmentPayload, "follow up after restored attachment"), 1);

  await assert.rejects(
    () => runPiCodingAgentChat({
      provider: {
        providerName: "jasmine-mock",
        apiKey: "test-key",
        baseUrl,
        modelId: "jasmine-test",
        capabilities: {
          vision: false,
          imageOutput: false,
          toolCalling: true,
          reasoning: false,
          embedding: false
        },
        contextWindow: 128000,
        maxOutputTokens: 1200,
        providerOptionsJson: "{}"
      },
      messages: [
        {
          role: "user",
          content: "look at this image",
          attachments: [{
            kind: "file",
            name: "historical-image.png",
            path: path.join(tempDir, "historical-image.png"),
            isImage: true,
            mediaType: "image/png"
          }]
        },
        { role: "assistant", content: "I saw it." },
        { role: "user", content: "follow up after restored image" }
      ],
      content: "follow up after restored image",
      attachments: [],
      jasminePromptAppend: systemPrompt,
      agentDir,
      toolsEnabled: true
    }),
    /does not support image input in this conversation/
  );
  assert.match(nonSecretError(new Error(`${fakeProviderSecret} does not support image input`)), /sk-\.\.\. does not support image input/);
  assert.doesNotMatch(nonSecretError(new Error(`${fakeProviderSecret} does not support image input`)), /test-fixture/);

  const previousMockFlag = process.env.JASMINE_E2E_MOCK_AI;
  process.env.JASMINE_E2E_MOCK_AI = "1";
  try {
    const scopedCwd = path.join(tempDir, "scoped-project");
    await mkdir(scopedCwd, { recursive: true });
    const mockReply = await generateAssistantReply({
      threadId: "taxonomy-duplicate-thread",
      messages: [{ role: "user", content: "taxonomy duplicate guard" }],
      content: "taxonomy duplicate guard",
      attachments: [],
      captureContextTaxonomy: true,
      cwd: scopedCwd,
      toolsEnabled: true
    }, {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    });
    const currentPromptItems = mockReply.contextTaxonomy.items.filter((item) =>
      item.source === "current.prompt" &&
      String(item.text ?? item.preview).includes("taxonomy duplicate guard")
    );
    assert.equal(currentPromptItems.length, 1);
    const systemPromptItem = mockReply.contextTaxonomy.items.find((item) => item.source === "jasmine.systemPrompt");
    assert.match(String(systemPromptItem?.text ?? ""), new RegExp(escapeRegExp(`Current working directory: ${scopedCwd.replace(/\\/g, "/")}`)));
    assert.equal((String(systemPromptItem?.text ?? "").match(/Current working directory:/g) ?? []).length, 1);

    const uncapturedReply = await generateAssistantReply({
      threadId: "taxonomy-disabled-thread",
      messages: [{ role: "user", content: "taxonomy stays disabled" }],
      content: "taxonomy stays disabled",
      attachments: [],
      cwd: scopedCwd,
      piAgentDir: agentDir,
      toolsEnabled: true
    }, {
      providerName: "mock-provider",
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1",
      modelId: "mock-model",
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    });
    assert.equal(uncapturedReply.contextTaxonomy, undefined);
    assert.equal(uncapturedReply.contextTaxonomies, undefined);

    const mockProvider = {
      providerName: "jasmine-mock",
      apiKey: "test-key",
      baseUrl,
      modelId: "jasmine-test",
      capabilities: {
        vision: false,
        imageOutput: false,
        toolCalling: true,
        reasoning: false,
        embedding: false
      },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      providerOptionsJson: "{}"
    };
    const successfulCaptures = [];
    const artifactReply = await generateAssistantReply({
      threadId: "artifact-callback-thread",
      messages: [{ role: "user", content: "show file changes" }],
      content: "show file changes",
      attachments: [],
      cwd: scopedCwd,
      toolsEnabled: true
    }, mockProvider, {
      onFileChangeCapture: (capture) => successfulCaptures.push(capture)
    });
    assert.equal(successfulCaptures.length, 1);
    assert.equal(successfulCaptures[0], artifactReply.fileChangeCaptures[0]);
    assert.deepEqual(successfulCaptures[0].changes.map((change) => change.status), ["added", "modified", "deleted"]);

    const failedCaptures = [];
    await assert.rejects(generateAssistantReply({
      threadId: "artifact-failure-callback-thread",
      messages: [{ role: "user", content: "show file changes working failure" }],
      content: "show file changes working failure",
      attachments: [],
      cwd: scopedCwd,
      toolsEnabled: true
    }, mockProvider, {
      onFileChangeCapture: (capture) => failedCaptures.push(capture)
    }), /Mock Working failure/);
    assert.equal(failedCaptures.length, 1, "file evidence must escape a failed run through the callback");
    assert.equal(failedCaptures[0].changes.length, 3);
  } finally {
    if (previousMockFlag === undefined) delete process.env.JASMINE_E2E_MOCK_AI;
    else process.env.JASMINE_E2E_MOCK_AI = previousMockFlag;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

function runPiCli({ agentDir, appendPrompt, message }) {
  const cliPath = path.join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "--mode",
        "json",
        "--no-session",
        "--no-skills",
        "--provider",
        "jasmine-mock",
        "--model",
        "jasmine-test",
        "--append-system-prompt",
        appendPrompt,
        message
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          JASMINE_MOCK_API_KEY: "test-key"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pi CLI exited with ${code}: ${stderr}`));
    });
  });
}

function normalizePayload(payload) {
  return JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (value === undefined) return undefined;
    return value;
  }));
}

function payloadToolNames(payload) {
  return (payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean);
}

function taxonomyToolNames(taxonomy) {
  return taxonomy.items
    .filter((item) => item.source === "provider.payload.tools")
    .map((item) => {
      const parsed = JSON.parse(item.text);
      return parsed.function?.name ?? parsed.name;
    })
    .filter(Boolean);
}

function countSubstring(value, needle) {
  return value.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").toLowerCase();
}

function samePackageSourcePath(source, target, baseDir) {
  return path.resolve(baseDir, source).toLowerCase() === path.resolve(target).toLowerCase();
}
