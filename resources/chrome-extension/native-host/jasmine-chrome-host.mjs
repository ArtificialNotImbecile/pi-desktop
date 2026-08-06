#!/usr/bin/env node
// Jasmine Chrome native messaging host.
//
// Chrome launches this process and speaks the native messaging protocol over
// stdio (4-byte little-endian length prefix + UTF-8 JSON). The host relays each
// message to the Jasmine app over a localhost TCP bridge whose port and token
// the app publishes in a small JSON file, and relays the app's replies back to
// Chrome. The host holds no secrets and performs no browser logic itself.

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { encodeMessage, MessageParser } from "./framing.mjs";

function bridgeInfoPath() {
  if (process.env.JASMINE_CHROME_BRIDGE_FILE) return process.env.JASMINE_CHROME_BRIDGE_FILE;
  return path.join(homedir(), ".jasmine", "chrome-bridge.json");
}

function readBridgeInfo() {
  try {
    const raw = readFileSync(bridgeInfoPath(), "utf8");
    const info = JSON.parse(raw);
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
  } catch {
    // fall through
  }
  return null;
}

function writeToChrome(value) {
  process.stdout.write(encodeMessage(value));
}

function main() {
  const info = readBridgeInfo();
  if (!info) {
    writeToChrome({ type: "error", error: "Jasmine bridge is not running." });
    process.exit(0);
    return;
  }

  const socket = connect({ host: "127.0.0.1", port: info.port }, () => {
    socket.write(`${JSON.stringify({ type: "hello", token: info.token, role: "chrome-extension" })}\n`);
  });

  // App -> Chrome: the bridge speaks newline-delimited JSON.
  let appBuffer = "";
  socket.on("data", (chunk) => {
    appBuffer += chunk.toString("utf8");
    let newlineIndex = appBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = appBuffer.slice(0, newlineIndex).trim();
      appBuffer = appBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          writeToChrome(JSON.parse(line));
        } catch {
          // ignore malformed bridge line
        }
      }
      newlineIndex = appBuffer.indexOf("\n");
    }
  });
  socket.on("error", () => {
    writeToChrome({ type: "error", error: "Jasmine bridge connection failed." });
    process.exit(0);
  });
  socket.on("close", () => process.exit(0));

  // Chrome -> App: forward each decoded native message as one JSON line.
  const parser = new MessageParser((message) => {
    if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
  });
  process.stdin.on("data", (chunk) => parser.push(chunk));
  process.stdin.on("end", () => process.exit(0));
}

main();
