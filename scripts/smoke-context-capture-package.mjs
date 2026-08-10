import assert from "node:assert/strict";
import { readdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const packageDir = path.join(rootDir, "src", "main", "agent", "extensions", "contextCapture");
const packageJsonPath = path.join(packageDir, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

assert.equal(packageJson.name, "@jasmine-ai/pi-context-capture");
assert.equal(packageJson.private, true);
assert.equal(packageJson.license, "MIT");
assert.equal(packageJson.type, "module");
assert.equal(packageJson.main, "./dist/index.js");
assert.equal(packageJson.types, "./dist/index.d.ts");

for (const target of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/classifier.js",
  "dist/classifier.d.ts",
  "dist/segments.js",
  "dist/segments.d.ts",
  "dist/schema.js",
  "dist/schema.d.ts"
]) {
  assert.equal(existsSync(path.join(packageDir, target)), true, `${target} should exist after package build`);
}

const extensionModule = await import(pathToFileURL(path.join(packageDir, "dist", "index.js")).href);
assert.equal(extensionModule.CONTEXT_TAXONOMY_SCHEMA_VERSION, 7);
assert.equal(typeof extensionModule.createContextCaptureExtension, "function");
assert.equal(typeof extensionModule.classifyTextSegments, "function");
assert.equal(typeof extensionModule.default, "function");

const captured = [];
const fakeProviderSecret = ["sk", "test-fixture-1234567890"].join("-");
const sdkBus = createFakePiBus();
await extensionModule.createContextCaptureExtension({
  provider: "deepseek",
  model: "fallback-model",
  getCanonicalMessages: () => [{ role: "user", content: "hello" }],
  onCapture: (taxonomy) => captured.push(taxonomy)
})(sdkBus.pi);

const observedPayload = {
    model: "deepseek-v4-flash",
    apiKey: fakeProviderSecret,
    messages: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "hello" }
    ],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    stream: true
};
const returnedPayload = sdkBus.emit("before_provider_request", { payload: observedPayload });
assert.equal(returnedPayload, observedPayload, "capture must remain a read-only observer of the provider payload");
sdkBus.emit("message_end", {
  message: {
    role: "assistant",
    usage: {
      input: 137,
      output: 18,
      cacheRead: 4096,
      cacheWrite: 0,
      totalTokens: 4251
    }
  }
});

assert.equal(captured.length, 1);
assert.equal(captured[0].payloadSchemaVersion, 7);
assert.equal(captured[0].provider, "deepseek");
assert.equal(captured[0].model, "deepseek-v4-flash");
assert.deepEqual(captured[0].payloadShape.topLevelOrder, ["model", "apiKey", "messages", "tools", "stream"]);
assert.deepEqual(Object.keys(JSON.parse(captured[0].rawPayload)), captured[0].payloadShape.topLevelOrder);
assert.equal(captured[0].payloadShape.messagesBeforeTools, true);
assert.deepEqual(captured[0].items.map((item) => item.payloadPath), [
  "$.messages[0]", "$.messages[1]", "$.tools[0]", "$", "$"
]);
const requestOptions = captured[0].items.filter((item) => item.role === "request_options");
assert.equal(requestOptions.length, 1);
assert.deepEqual(requestOptions[0].parts.map((part) => part.payloadPath), ["$.model", "$.stream"]);
const unclassified = captured[0].items.find((item) => item.kind === "unclassified");
assert.deepEqual(unclassified.parts.map((part) => part.payloadPath), ["$.apiKey"]);
assert.equal(captured[0].cacheMetrics.cacheHitTokens, 4096);
assert.equal(captured[0].cacheMetrics.cacheMissTokens, 137);
assert.equal(captured[0].cacheMetrics.status, "hit");
assert.equal(captured[0].reasoningValidation.status, "not_applicable");
assert.equal(captured[0].rawPayload.includes(fakeProviderSecret), false);
assert.match(captured[0].rawPayload, /\[redacted\]/);

const groupedTaxonomy = extensionModule.providerPayloadToContextTaxonomy({
  stream: true,
  future_before_tools: { retained: 1 },
  tools: [{ type: "function", function: { name: "write", parameters: { type: "object" } } }],
  temperature: 0.2,
  messages: [{ role: "user", content: "semantic grouping" }],
  model: "tools-first-model",
  future_after_messages: { retained: 2 }
}, { provider: "future-provider", model: "tools-first-model" });
assert.deepEqual(groupedTaxonomy.payloadShape.topLevelOrder, [
  "stream", "future_before_tools", "tools", "temperature", "messages", "model", "future_after_messages"
]);
assert.deepEqual(Object.keys(JSON.parse(groupedTaxonomy.rawPayload)), groupedTaxonomy.payloadShape.topLevelOrder);
assert.deepEqual(groupedTaxonomy.items.map((item) => item.payloadPath), ["$.messages[0]", "$.tools[0]", "$", "$"]);
assert.equal(groupedTaxonomy.items.filter((item) => item.role === "request_options").length, 1);
assert.deepEqual(
  groupedTaxonomy.items.find((item) => item.role === "request_options").parts.map((part) => part.payloadPath),
  ["$.stream", "$.temperature", "$.model"]
);
assert.equal(groupedTaxonomy.items.filter((item) => item.kind === "unclassified").length, 1);
const groupedUnclassified = groupedTaxonomy.items.find((item) => item.kind === "unclassified");
assert.deepEqual(
  groupedUnclassified.parts.map((part) => part.payloadPath),
  ["$.future_before_tools", "$.future_after_messages"]
);
assert.match(groupedUnclassified.text, /"retained": 1/);
assert.match(groupedUnclassified.text, /"retained": 2/);

const outputDir = await mkdtemp(path.join(tmpdir(), "pi-context-capture-package-"));
const previousEnv = {
  PI_CONTEXT_CAPTURE_DIR: process.env.PI_CONTEXT_CAPTURE_DIR,
  PI_CONTEXT_CAPTURE_PROVIDER: process.env.PI_CONTEXT_CAPTURE_PROVIDER,
  PI_CONTEXT_CAPTURE_MODEL: process.env.PI_CONTEXT_CAPTURE_MODEL
};

try {
  process.env.PI_CONTEXT_CAPTURE_DIR = outputDir;
  process.env.PI_CONTEXT_CAPTURE_PROVIDER = "env-provider";
  process.env.PI_CONTEXT_CAPTURE_MODEL = "env-model";

  const defaultBus = createFakePiBus();
  extensionModule.default(defaultBus.pi);
  defaultBus.emit("before_provider_request", {
    payload: {
      messages: [{ role: "user", content: "file output fallback" }]
    }
  });
  defaultBus.emit("agent_end", {});

  const files = await readdir(outputDir);
  assert.equal(files.length, 1);
  const fileCapture = JSON.parse(await readFile(path.join(outputDir, files[0]), "utf8"));
  assert.equal(fileCapture.provider, "env-provider");
  assert.equal(fileCapture.model, "env-model");
  assert.equal(fileCapture.items.some((item) => item.kind === "current_user_prompt"), true);
} finally {
  restoreEnv(previousEnv);
  await rm(outputDir, { recursive: true, force: true });
}

function createFakePiBus() {
  const handlers = new Map();
  return {
    pi: {
      on(name, handler) {
        handlers.set(name, handler);
      }
    },
    emit(name, event) {
      const handler = handlers.get(name);
      assert.equal(typeof handler, "function", `${name} handler should be registered`);
      return handler(event);
    }
  };
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
