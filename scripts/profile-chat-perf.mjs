// Repeatable profiler for long-thread rendering and chat runtime performance.
// (Phase 3.3 virtualization and Phase 5.4 sqlite-worker gates).
//
// Seeds a 1,000-message thread plus 500 sidebar threads into a scratch user data
// dir, then measures with the mock AI provider:
//   - cold app-shell time with 500 threads
//   - threads:list IPC latency
//   - open-thread time for the 1,000-message thread (first page render)
//   - long tasks while scrolling ~480 mounted rows
//   - send latency on the 1,000-message thread (full history replay path)
//
// Usage: node scripts/profile-chat-perf.mjs   (requires a current `npm run build`)

import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = path.join(rootDir, ".tmp", "perf", `chat-perf-${randomUUID()}`);
const MESSAGES = 1000;
const THREADS = 500;

function launchEnv() {
  return {
    ...process.env,
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_MOCK_AI: "1",
    DEEPSEEK_API_KEY: "perf-mock-key",
    KIMI_API_KEY: "perf-mock-key"
  };
}

function electronExecutable() {
  return path.join(rootDir, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
}

async function launch() {
  const startedAt = Date.now();
  const app = await electron.launch({
    executablePath: electronExecutable(),
    args: [".", "--disable-gpu"],
    cwd: rootDir,
    env: launchEnv()
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 60_000 });
  return { app, page, shellMs: Date.now() - startedAt };
}

function seedDatabase(threadId) {
  const db = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"));
  try {
    const insertMessage = db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, role, content, attachments_json, created_at, elapsed_ms,
        model_id, status, memory_used_json, skills_used_json, web_search_used_json, timeline_json
      ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, 'sent', '[]', '[]', '[]', ?)
    `);
    for (let index = 0; index < MESSAGES; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index * 500)).toISOString();
      const content = `perf message ${index + 1} ${"lorem ipsum dolor sit amet ".repeat(8)}`;
      const timeline = role === "assistant"
        ? JSON.stringify([
            { id: `perf-model-${index}`, kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
            { id: `perf-output-${index}`, kind: "assistant_text", text: content }
          ])
        : "[]";
      insertMessage.run(
        `perf-${String(index).padStart(5, "0")}`,
        threadId,
        role,
        content,
        createdAt,
        role === "assistant" ? 12 : null,
        role === "assistant" ? "deepseek-v4-flash" : null,
        timeline
      );
    }
    // Seeding bypasses the repositories, so maintain the denormalized count here.
    db.prepare("UPDATE chat_threads SET updated_at = ?, message_count = message_count + ? WHERE id = ?")
      .run(new Date().toISOString(), MESSAGES, threadId);

    const insertThread = db.prepare(
      "INSERT INTO chat_threads (id, title, active_plugin_ids_json, created_at, updated_at, message_count) VALUES (?, ?, '[]', ?, ?, 2)"
    );
    const insertSmall = db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, role, content, attachments_json, created_at, elapsed_ms,
        model_id, status, memory_used_json, skills_used_json, web_search_used_json, timeline_json
      ) VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, 'sent', '[]', '[]', '[]', '[]')
    `);
    for (let index = 0; index < THREADS; index += 1) {
      const id = `perf-thread-${String(index).padStart(4, "0")}`;
      const stamp = new Date(Date.UTC(2025, 11, 1, 0, 0, index)).toISOString();
      insertThread.run(id, `Perf sidebar thread ${index + 1}`, stamp, stamp);
      insertSmall.run(`${id}-m0`, id, "user", `hello from ${id}`, stamp);
      insertSmall.run(`${id}-m1`, id, "assistant", `reply for ${id}`, stamp);
    }
  } finally {
    db.close();
  }
}

async function main() {
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const results = { messages: MESSAGES, threads: THREADS };

  // Pass 1: create schema + target thread, then seed offline.
  let session = await launch();
  const thread = await session.page.evaluate(() => window.jasmine.createThread({ title: "Perf mega thread" }));
  await session.app.close();
  seedDatabase(thread.id);

  // Pass 2: measurements.
  session = await launch();
  const { app, page } = session;
  results.coldShellMsWith500Threads = session.shellMs;

  results.threadsListMs = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 7; i += 1) {
      const start = performance.now();
      await window.jasmine.listThreads();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { min: samples[0], median: samples[3], max: samples[6] };
  });

  results.listMessagesPageMs = await page.evaluate(async (threadId) => {
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      await window.jasmine.listMessages({ threadId, limit: 160 });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { min: samples[0], median: samples[2], max: samples[4] };
  }, thread.id);

  const openStart = Date.now();
  await page.getByRole("button", { name: /Perf mega thread/ }).first().click();
  await page.waitForSelector(".load-older-messages", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".user-bubble, .assistant-block").length >= 160, undefined, { timeout: 30_000 });
  results.openThreadFirstPageMs = Date.now() - openStart;

  // Mount ~480 rows (two extra pages) to stress scrolling.
  for (let i = 0; i < 2; i += 1) {
    const growStart = Date.now();
    const before = await page.evaluate(() => document.querySelectorAll(".user-bubble, .assistant-block").length);
    await page.locator(".load-older-messages").click();
    await page.waitForFunction(
      (prev) => document.querySelectorAll(".user-bubble, .assistant-block").length > prev,
      before,
      { timeout: 30_000 }
    );
    results[`loadOlderPage${i + 2}Ms`] = Date.now() - growStart;
  }
  results.mountedRows = await page.evaluate(() => document.querySelectorAll(".user-bubble, .assistant-block").length);

  results.scroll = await page.evaluate(async () => {
    const scroll = document.querySelector(".message-scroll");
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ["longtask"] });
    const frames = [];
    let last = performance.now();
    let raf = true;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (raf) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const steps = 40;
    for (let i = 0; i <= steps; i += 1) {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (1 - i / steps);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    raf = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    observer.disconnect();
    frames.sort((a, b) => a - b);
    return {
      longTaskCount: longTasks.length,
      longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0,
      frameP95Ms: frames[Math.floor(frames.length * 0.95)] ?? 0,
      frameMaxMs: frames.at(-1) ?? 0
    };
  });

  // Send on the 1,000-message thread: time to first live render and to completion.
  await page.evaluate(() => {
    const scroll = document.querySelector(".message-scroll");
    scroll.scrollTop = scroll.scrollHeight;
  });
  await page.locator(".rich-composer-editor").fill("perf probe reply");
  const sendStart = Date.now();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForSelector(".assistant-block.live-message", { timeout: 30_000 });
  results.sendToFirstLiveRenderMs = Date.now() - sendStart;
  await page.waitForFunction(() => {
    const blocks = document.querySelectorAll(".assistant-block");
    return blocks.length > 0 && blocks[blocks.length - 1].textContent.includes("Mock reply from Jasmine.");
  }, undefined, { timeout: 30_000 });
  results.sendToCompleteMs = Date.now() - sendStart;

  await app.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
