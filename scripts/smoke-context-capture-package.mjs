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
assert.equal(extensionModule.CONTEXT_TAXONOMY_SCHEMA_VERSION, 4);
assert.equal(typeof extensionModule.createContextCaptureExtension, "function");
assert.equal(typeof extensionModule.classifyTextSegments, "function");
assert.equal(typeof extensionModule.default, "function");

const captured = [];
const fakeProviderSecret = ["sk", "test-fixture-1234567890"].join("-");
const sdkBus = createFakePiBus();
await extensionModule.createContextCaptureExtension({
  provider: "deepseek",
  model: "fallback-model",
  onCapture: (taxonomy) => captured.push(taxonomy)
})(sdkBus.pi);

sdkBus.emit("before_provider_request", {
  payload: {
    model: "deepseek-v4-flash",
    apiKey: fakeProviderSecret,
    messages: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "hello" }
    ],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    stream: true
  }
});
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
assert.equal(captured[0].payloadSchemaVersion, 4);
assert.equal(captured[0].provider, "deepseek");
assert.equal(captured[0].model, "deepseek-v4-flash");
assert.deepEqual(captured[0].payloadShape.topLevelOrder, ["model", "apiKey", "messages", "tools", "stream"]);
assert.equal(captured[0].payloadShape.messagesBeforeTools, true);
assert.equal(captured[0].cacheMetrics.cacheHitTokens, 4096);
assert.equal(captured[0].cacheMetrics.cacheMissTokens, 137);
assert.equal(captured[0].cacheMetrics.status, "hit");
assert.equal(captured[0].rawPayload.includes(fakeProviderSecret), false);
assert.match(captured[0].rawPayload, /\[redacted\]/);

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
