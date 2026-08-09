import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import {
  launchJasmine,
  openSettings,
  quitElectron,
  rootDir,
  startEmptyThread,
  waitForStableAssistant,
  type HarnessApp
} from "./helpers";

test.describe("Chrome takeover", () => {
  let harness: HarnessApp;
  let extension: ControlledExtension | undefined;

  test.afterEach(async () => {
    extension?.close();
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("@Chrome routes status, list, and open through a responsive real-extension fixture", async () => {
    const userDataDir = path.join(rootDir, ".tmp", "e2e", `chrome-takeover-${randomUUID()}`);
    const bridgeFile = path.join(userDataDir, "chrome-bridge.json");
    harness = await launchJasmine("chrome-takeover", userDataDir, {
      JASMINE_CHROME_BRIDGE_FILE: bridgeFile,
      JASMINE_E2E_CHROME_TAKEOVER_FLOW: "1",
      CHROME_CDP_URL: "http://127.0.0.1:1"
    });
    const { page } = harness;

    await openSettings(page, "Chrome Control");
    extension = await connectControlledExtension(bridgeFile);
    await page.getByRole("button", { name: "Refresh" }).click();
    const extensionStatus = page.locator(".chrome-status-item", { hasText: "Extension" });
    await expect(extensionStatus).toContainText("Connected");

    await page.getByRole("button", { name: "Register / Enable" }).click();
    await expect(page.getByText("Chrome control enabled", { exact: true })).toBeVisible();
    await expect(extensionStatus).toContainText("Connected");

    await page.locator(".settings-nav").getByRole("button", { name: "Plugins" }).click();
    const chromeRow = page.locator(".plugin-row", { hasText: "Chrome" });
    await expect(chromeRow).toContainText("Disabled");
    await chromeRow.getByRole("switch", { name: "Enable Chrome" }).click();
    await expect(chromeRow).toContainText("Enabled");
    await page.getByRole("button", { name: "Close settings" }).click();

    await startEmptyThread(page);
    const editor = page.locator(".rich-composer-editor");
    await editor.fill("@Chrome");
    const chromeMention = page.locator(".mention-row", { hasText: "@Chrome" });
    await expect(chromeMention).toBeVisible();
    await chromeMention.click();
    await expect(page.locator(".inline-plugin-row")).toContainText("Chrome");
    await editor.fill("Run the e2e Chrome takeover flow.");
    await page.getByRole("button", { name: "Send" }).click();

    const assistant = await waitForStableAssistant(page, "chrome_open_url:", 15_000);
    await expect(assistant).toContainText("takeover bridge");
    await expect(assistant).toContainText("Real Chrome tab");
    await expect(assistant).toContainText("https://e2e.example/opened");
    await expect(page.locator(".user-bubble").last().getByLabel("Active plugins")).toContainText("Chrome");
    await expect(page.locator(".assistant-block").last().getByLabel("Plugins used")).toContainText("Chrome");
    expect(extension.protocolErrors).toEqual([]);
    expect(extension.requests.map((request) => request.method)).toEqual(expect.arrayContaining([
      "status",
      "list_tabs",
      "new_tab"
    ]));

    extension.setResponsive(false);
    await openSettings(page, "Chrome Control");
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".chrome-status-item", { hasText: "Extension" })).toContainText("Degraded");
  });
});

type ExtensionRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  __bridgeId?: unknown;
};

type ControlledExtension = {
  requests: ExtensionRequest[];
  protocolErrors: string[];
  setResponsive(value: boolean): void;
  close(): void;
};

async function connectControlledExtension(bridgeFile: string): Promise<ControlledExtension> {
  const info = await waitForBridgeInfo(bridgeFile);
  const socket = await connectSocket(info.port);
  const requests: ExtensionRequest[] = [];
  const protocolErrors: string[] = [];
  let responsive = true;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as ExtensionRequest;
          if (!Number.isInteger(message.id) || message.__bridgeId !== undefined) {
            protocolErrors.push(`Unexpected bridge request shape: ${line}`);
          } else {
            requests.push(message);
            if (responsive) socket.write(`${JSON.stringify(extensionReply(message))}\n`);
          }
        } catch (error) {
          protocolErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  socket.write(`${JSON.stringify({ type: "hello", token: info.token, role: "chrome-extension" })}\n`);
  return {
    requests,
    protocolErrors,
    setResponsive(value) { responsive = value; },
    close() { socket.destroy(); }
  };
}

function extensionReply(request: ExtensionRequest): Record<string, unknown> {
  if (request.method === "status") {
    return { id: request.id, ok: true, result: { connected: true, tabCount: 1 } };
  }
  if (request.method === "list_tabs") {
    return {
      id: request.id,
      ok: true,
      result: { tabs: [{ id: "101", title: "Real Chrome tab", url: "https://e2e.example/", active: true }] }
    };
  }
  if (request.method === "new_tab") {
    return {
      id: request.id,
      ok: true,
      result: { id: "102", title: "Opened", url: request.params?.url ?? "about:blank", active: true }
    };
  }
  return { id: request.id, ok: false, error: `Unexpected method: ${request.method}` };
}

async function waitForBridgeInfo(file: string): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { port?: unknown; token?: unknown };
      if (Number.isInteger(parsed.port) && typeof parsed.token === "string" && parsed.token) {
        return { port: parsed.port as number, token: parsed.token };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chrome bridge info was not published: ${String(lastError ?? file)}`);
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}
