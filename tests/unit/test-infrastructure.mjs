import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES,
  e2eUserDataDirName
} from "../e2e/userDataDir.mjs";

const rootDir = process.cwd();
const fixedUuid = "11111111-2222-4333-8444-555555555555";
const sharedPrefix = "running composer queue path boundary ".repeat(8);
const first = e2eUserDataDirName(`${sharedPrefix}alpha`, fixedUuid);
const second = e2eUserDataDirName(`${sharedPrefix}beta`, fixedUuid);
const multibyte = e2eUserDataDirName("渲染队列边界".repeat(80), fixedUuid);

assert.ok(Buffer.byteLength(first, "utf8") <= E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES);
assert.ok(Buffer.byteLength(multibyte, "utf8") <= E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES);
assert.notEqual(first, second);
assert.notEqual(e2eUserDataDirName(`${sharedPrefix}alpha`, randomUUID()), first);

const viteConfig = await readFile(path.join(rootDir, "vite.config.ts"), "utf8");
assert.match(viteConfig, /port:\s*5173/);
assert.match(viteConfig, /strictPort:\s*true/);

console.log("Test infrastructure paths and strict Vite port configuration are valid.");
