import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../../resources/chrome-extension/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

assert.equal(typeof manifest.key, "string");
assert.match(manifest.key, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const publicKeyDer = Buffer.from(manifest.key, "base64");
assert.ok(publicKeyDer.length > 0);
assert.equal(publicKeyDer.toString("base64"), manifest.key);

const {
  BUNDLED_CHROME_EXTENSION_ID,
  deriveExtensionIdFromKey
} = await import("../../dist/main/main/services/chromeBridge.js");

assert.equal(deriveExtensionIdFromKey(manifest.key), BUNDLED_CHROME_EXTENSION_ID);
assert.match(BUNDLED_CHROME_EXTENSION_ID, /^[a-p]{32}$/);

console.log("chrome-extension-id unit test passed");
