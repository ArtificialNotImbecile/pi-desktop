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

const { buildSystemPrompt, generateAssistantReply, resolvePiShellRuntime } = await import("../../dist/main/main/agent/runtime.js");
const { createAskUserQuestionTool, createWebSearchTool, runPiCodingAgentChat } = await import("../../dist/main/main/agent/providers/piCodingAgent.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { classifyTextSegments, providerPayloadToContextTaxonomy, withContextCacheMetrics, withMissingContextTaxonomySegments } = await import("../../dist/main/main/agent/extensions/contextCapture/classifier.js");
const { nonSecretError } = await import("../../dist/main/main/ipc/chatSupport.js");
const { listExecutableDiscovery, resolveConfiguredExecutable } = await import("../../dist/main/main/services/executables.js");
const { fallbackTitle, generateTitleWithProvider, generateTitleWithProviderResult } = await import("../../dist/main/main/services/threadTitles.js");
const { parseBingResults } = await import("../../dist/main/main/services/webSearch.js");
const {
  listPluginPackages,
  listPluginSkills,
  resolveEnabledPackageSkillPaths,
  resolvePluginPackageRuntimeSources,
  resolveChromePackageRoot,
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

assert.throws(() => pluginPackageInstallSchema.parse({ source: "" }), /Package source is required/);
assert.throws(() => pluginPackageInstallSchema.parse({ source: `npm:bad\nsource` }), /control characters/);

const webSearchTool = createWebSearchTool(async (query) => [{
  title: `Result for ${query}`,
  url: "https://example.com/web-search-tool",
  snippet: "Custom web search result"
}]);
assert.equal(webSearchTool.name, "web_search");
assert.match(webSearchTool.promptSnippet, /current|external/i);
const webSearchToolResult = await webSearchTool.execute("tool-call-1", { query: "current jasmine" });
assert.match(webSearchToolResult.content[0].text, /https:\/\/example\.com\/web-search-tool/);
assert.equal(webSearchToolResult.details.results.length, 1);

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
assert.equal(classifierTaxonomy.payloadSchemaVersion, 4);
assert.deepEqual(classifierTaxonomy.payloadShape.topLevelOrder, ["model", "apiKey", "messages", "tools", "stream"]);
assert.equal(classifierTaxonomy.payloadShape.messagesBeforeTools, true);
assert.equal(classifierTaxonomy.rawPayload.includes(fakeProviderSecret), false);
assert.match(classifierTaxonomy.rawPayload, /\[redacted\]/);
assert.equal(classifierTaxonomy.items[0].kind, "system_prompt");
assert.equal(classifierTaxonomy.items[0].segments.some((segment) => segment.kind === "project_context"), true);
assert.equal(classifierTaxonomy.items[0].segments.some((segment) => segment.kind === "skill_instructions"), true);
assert.equal(classifierTaxonomy.items.find((item) => item.kind === "current_user_prompt")?.text, "current turn");
assert.equal(classifierTaxonomy.items.at(-2).kind, "tool_definition");
assert.equal(classifierTaxonomy.items.at(-1).kind, "provider_options");
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
  toolsFirstTaxonomy.items.findIndex((item) => item.kind === "tool_definition")
    < toolsFirstTaxonomy.items.findIndex((item) => item.payloadPath === "$.messages[0]"),
  "tools-first payloads should present tool rows before message rows"
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
assert.equal(syntheticCurrentItems[0].text, "Please open the page by URL.");
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
assert.equal(taxonomyWithAttachmentAnchor.items.find((item) => item.kind === "current_user_prompt")?.text, "Describe this image.");

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

const skillManifestPrompt = buildSystemPrompt([], [{
  id: "skill-technical-writer",
  name: "Technical Writer",
  description: "Tightens explanations for technical readers.",
  source: "local",
  skillFilePath: path.join(tempDir, "skills", "local", "skill-technical-writer", "SKILL.md")
}], [], true);
assert.doesNotMatch(skillManifestPrompt, /Active user-selected skill manifests/);
assert.doesNotMatch(skillManifestPrompt, /Technical Writer/);
assert.doesNotMatch(skillManifestPrompt, /SKILL\.md/);
if (process.platform === "win32") {
  const systemBashPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "bash.exe");
  const gitBashPath = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  assert.match(skillManifestPrompt, /Git Bash or another bash\.exe/);
  assert.match(skillManifestPrompt, /not PowerShell/);
  assert.match(skillManifestPrompt, /Do not assume `python3` or `py` exists/);
  assert.match(skillManifestPrompt, /Do not assume Unix paths like `\/tmp` exist/);
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
  const powerShellPrompt = buildSystemPrompt([], [], [], true, {
    piShell: resolvePiShellRuntime(fakePowerShellPath)
  });
  assert.match(powerShellPrompt, /configured to run through the app Terminal shell/);
  assert.match(powerShellPrompt, /Write commands for PowerShell/);
  assert.match(powerShellPrompt, /Get-Command python/);
  assert.match(powerShellPrompt, /\$env:TEMP/);
  const unsupportedShellPrompt = buildSystemPrompt([], [], [], true, {
    piShell: resolvePiShellRuntime(fakeCmdPath)
  });
  assert.match(unsupportedShellPrompt, /not passed to Pi/);
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
      const wslFallbackPrompt = buildSystemPrompt([], [], [], true, { piShell: wslPiShell });
      assert.match(wslFallbackPrompt, /WSL bash launcher/);
      assert.match(wslFallbackPrompt, /uses Git Bash instead/);
      assert.match(wslFallbackPrompt, /\/c\/\.\.\./);
      assert.doesNotMatch(wslFallbackPrompt, /configured to run through the app Terminal shell/);
    }
    const terminalDiscovery = await listExecutableDiscovery("terminal");
    assert.notEqual(terminalDiscovery.auto?.command, systemBashPath);
    assert.equal(terminalDiscovery.candidates.some((candidate) => candidate.command === systemBashPath && candidate.label === "Git Bash"), false);
  }
}

const bingResults = parseBingResults(`
  <ol id="b_results">
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="https://weathernews.jp/onebox/tenki/tokyo/13100/"><h2><strong>東京</strong>の<strong>天気</strong>予報</h2></a>
      </div>
      <div class="b_caption"><p>東京都心の今日と明日の天気、気温、降水確率。</p></div>
    </li>
    <li class="b_algo">
      <h2><a href="https://weather.yahoo.co.jp/weather/jp/13/4410.html">東京都の天気 - Yahoo!天気</a></h2>
      <div class="b_caption"><p>東京地方の週間天気と警報情報。</p></div>
    </li>
  </ol>
`);
assert.equal(bingResults.length, 2);
assert.equal(bingResults[0].url, "https://weathernews.jp/onebox/tenki/tokyo/13100/");
assert.match(bingResults[0].title, /東京.*天気/);
assert.match(bingResults[1].snippet, /週間天気/);

const captures = [];
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  captures.push(body);

  const requestText = JSON.stringify(body.messages ?? body.input ?? []);
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
          delta: { tool_calls: [{ index: 0, id: "replay-tool-call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: path.join(tempDir, "reasoning-replay.txt") }) } }] },
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
  if (requestText.includes("quarterly planning title")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-title",
      object: "chat.completion",
      created: 0,
      model: "jasmine-test",
      choices: [{ index: 0, message: { role: "assistant", content: "Quarterly planning" }, finish_reason: "stop" }]
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
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }]
    }));
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
    systemPrompt,
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
    systemPrompt,
    agentDir,
    toolsEnabled: true
  });
  assert.equal(captures.length, 2);
  const sdkPayload = normalizePayload(captures[1]);

  assert.deepEqual(sdkPayload, cliPayload);

  const captureThinkingPayload = async (provider, reasoningEffort, content) => {
    const captureCount = captures.length;
    await runPiCodingAgentChat({
      provider,
      messages: [{ role: "user", content }],
      content,
      attachments: [],
      systemPrompt,
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
    systemPrompt,
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
    systemPrompt,
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
  for (const provider of [
    { providerName: "deepseek", modelId: "deepseek-v4-flash" },
    { providerName: "moonshot", modelId: "kimi-k2.6" }
  ]) {
    const captureStart = captures.length;
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
      systemPrompt: "Use the read tool and then answer.",
      cwd: tempDir,
      agentDir,
      toolsEnabled: true,
      reasoningEffort: "high"
    });
    assert.equal(replayReply.content, "reasoning replay passed");
    const replayPayloads = captures.slice(captureStart);
    assert.equal(replayPayloads.length, 2, `${provider.providerName} should perform exactly one tool loop`);
    const replayAssistant = replayPayloads[1].messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    assert.equal(replayAssistant.reasoning_content, "exact reasoning chain for tool replay");
    assert.equal(replayAssistant.tool_calls[0].id, "replay-tool-call");
    assert.equal(replayPayloads[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "replay-tool-call"), true);
    assert.equal(replayPayloads[1].temperature, undefined);
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
    systemPrompt: "Answer the regression prompt.",
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
    systemPrompt: "Use the read tool and then answer.",
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
  assert.equal(fallbackTitle("来玩成语接龙"), "来玩成语接龙");
  assert.equal(fallbackTitle("  你好，告诉我拿破仑说过什么精彩的palindrome  "), "你好，告诉我拿破仑说过什么精彩的palindrome");
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
  assert.equal(titlePayload.max_tokens, 512);
  assert.equal(titlePayload.tools, undefined);
  assert.equal(titlePayload.messages.length, 2);
  assert.equal(titlePayload.messages[0].role, "system");
  assert.match(titlePayload.messages[0].content, /Do not answer/);
  assert.equal(titlePayload.messages[1].content, "quarterly planning title for the launch meeting");
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
    systemPrompt,
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
  assert.equal(taxonomyCaptures[0].payloadSchemaVersion, 4);
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
    systemPrompt,
    agentDir,
    toolsEnabled: false
  });
  assert.equal(captures.length, captureCountBeforeNoTools + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("read"), true);

  const builtinPluginRecords = await listPluginPackages({ userDataDir });
  const builtinRuntimeRecords = builtinPluginRecords.filter((plugin) => normalizePath(plugin.source).includes("/plugins/"));
  const builtinChromeRecords = builtinRuntimeRecords.filter((plugin) => plugin.displayName === "Chrome");
  assert.equal(builtinRuntimeRecords.length, 1);
  assert.equal(builtinChromeRecords.length, 1);
  assert.equal(builtinRuntimeRecords.every((plugin) => plugin.builtin && plugin.recommended && !plugin.removable), true);
  assert.equal(builtinRuntimeRecords.every((plugin) => plugin.enabled === false), true);
  const builtinSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(builtinSettings.packages.filter((source) =>
    typeof source === "object" && normalizePath(source.source).includes("/plugins/")
  ).length, 1);
  for (const record of builtinRuntimeRecords) {
    assert.equal(await fileExists(path.join(record.source, "package.json")), true);
  }

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
    systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforeFixturePlugin + 1);
  assert.equal(payloadToolNames(captures.at(-1)).includes("jasmine_fixture_tool"), true);
  assert.match(JSON.stringify(captures.at(-1)), /Fixture skill from a plugin package/);

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
    systemPrompt,
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
    systemPrompt,
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
    systemPrompt,
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
  assert.equal(legacyPackageSettings.packages.length, 2);
  assert.equal(legacyPackageSettings.packages.some((source) => typeof source === "string" && samePath(source, piWebAccessRoot)), true);
  assert.equal(legacyPackageSettings.packages.filter((source) =>
    typeof source === "object" && normalizePath(source.source).includes("/plugins/")
  ).length, 1);
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
    systemPrompt,
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

  const chromeRoot = resolveChromePackageRoot();
  assert.equal(typeof chromeRoot, "string");
  await setPluginPackageEnabled({ userDataDir }, "chrome", true);
  const chromePluginRecords = await listPluginPackages({ userDataDir });
  const chromeRecords = chromePluginRecords.filter((plugin) => plugin.displayName === "Chrome");
  assert.equal(chromeRecords.length, 1);
  assert.equal(chromeRecords[0].enabled, true);
  assert.equal(chromeRecords[0].resourceCounts.extensions.enabled, 1);
  assert.equal(chromeRecords[0].resourceCounts.skills.enabled, 1);
  packageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir });
  const captureCountBeforeChrome = captures.length;
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
    messages: [{ role: "user", content: "hello with chrome" }],
    content: "hello with chrome",
    attachments: [],
    systemPrompt,
    agentDir,
    toolsEnabled: true,
    packageSkillPaths
  });
  assert.equal(captures.length, captureCountBeforeChrome + 1);
  const chromeToolNames = new Set((captures.at(-1).tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  assert.equal(chromeToolNames.has("chrome_status"), true);
  assert.equal(chromeToolNames.has("chrome_list_tabs"), true);
  assert.equal(chromeToolNames.has("chrome_open_url"), true);
  assert.equal(chromeToolNames.has("chrome_open_path"), true);
  assert.equal(chromeToolNames.has("chrome_read_page"), true);
  assert.equal(chromeToolNames.has("chrome_click"), true);
  assert.equal(chromeToolNames.has("chrome_type"), true);
  assert.equal(chromeToolNames.has("chrome_screenshot"), true);
  assert.match(JSON.stringify(captures.at(-1)), /chrome/);

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
    systemPrompt,
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
    systemPrompt,
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
    systemPrompt,
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
    systemPrompt,
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
      systemPrompt,
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
    assert.match(String(systemPromptItem?.text ?? ""), new RegExp(escapeRegExp(`Current working directory: ${scopedCwd}`)));
  } finally {
    if (previousMockFlag === undefined) delete process.env.JASMINE_E2E_MOCK_AI;
    else process.env.JASMINE_E2E_MOCK_AI = previousMockFlag;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

function runPiCli({ agentDir, systemPrompt, message }) {
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
        "--system-prompt",
        systemPrompt,
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
