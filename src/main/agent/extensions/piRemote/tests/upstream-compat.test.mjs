import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PiClient } from "@earendil-works/pi-client";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { PiServer } from "@earendil-works/pi-server";
import { UPSTREAM_PI_REMOTE_BASELINE } from "../dist/index.js";

test("experimental upstream client/protocol/server stay exact-pinned behind the adapter boundary", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["@earendil-works/pi-client", "@earendil-works/pi-protocol", "@earendil-works/pi-server"]) {
    assert.equal(manifest.devDependencies[name], "0.84.2");
  }
  assert.equal(typeof PiClient, "function");
  assert.equal(typeof PiServer, "function");
  assert.equal(UPSTREAM_PI_REMOTE_BASELINE.protocolVersion, PROTOCOL_VERSION);
  assert.ok(UPSTREAM_PI_REMOTE_BASELINE.missingCapabilities.includes("extension-ui"));
  assert.ok(UPSTREAM_PI_REMOTE_BASELINE.missingCapabilities.includes("bootstrap"));
});
