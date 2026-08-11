// resolvePreloadPath() prefers the checked-in src/main/preload.cjs over the
// compiled preload.js, and electron-builder packages that same .cjs, so the
// TypeScript bridge is never what actually runs. A method added to only one of
// the two therefore fails at runtime -- the renderer calls an undefined bridge
// member -- while typecheck, build, and any test that merely renders the
// control all stay green. This guard fails on the drift itself.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function bridgeMethodNames(source) {
  // Both bridges declare one method per line at a single level of indentation:
  //   methodName(args) {
  return [...source.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]);
}

const typescriptBridge = bridgeMethodNames(await readFile(path.join(rootDir, "src/main/preload.ts"), "utf8"));
const commonJsBridge = bridgeMethodNames(await readFile(path.join(rootDir, "src/main/preload.cjs"), "utf8"));

assert.ok(typescriptBridge.length > 100, `Expected a populated bridge, parsed ${typescriptBridge.length} methods from preload.ts`);
assert.ok(commonJsBridge.length > 100, `Expected a populated bridge, parsed ${commonJsBridge.length} methods from preload.cjs`);

const missingFromCommonJs = typescriptBridge.filter((name) => !commonJsBridge.includes(name));
const missingFromTypescript = commonJsBridge.filter((name) => !typescriptBridge.includes(name));

assert.deepEqual(
  missingFromCommonJs,
  [],
  `preload.cjs is the bridge that actually loads, and is missing: ${missingFromCommonJs.join(", ")}`
);
assert.deepEqual(
  missingFromTypescript,
  [],
  `preload.ts is missing methods that preload.cjs exposes: ${missingFromTypescript.join(", ")}`
);

console.log(`preload bridge parity: OK (${typescriptBridge.length} methods)`);
