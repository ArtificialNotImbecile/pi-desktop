import os from "node:os";
import path from "node:path";

export function readmeLaunchOptions({ rootDir, userDataDir, demoProjectDir, extraEnv = {} }) {
  const installedExecutable = process.env.JASMINE_README_EXECUTABLE?.trim();
  return {
    executablePath: installedExecutable || path.join(rootDir, "node_modules", "electron", "dist", "electron.exe"),
    args: installedExecutable ? ["--disable-gpu"] : [".", "--disable-gpu"],
    cwd: installedExecutable ? demoProjectDir : rootDir,
    env: {
      ...process.env,
      JASMINE_E2E_HARNESS: "1",
      JASMINE_E2E_OFFSCREEN: "1",
      JASMINE_E2E_USER_DATA_DIR: userDataDir,
      JASMINE_DEFAULT_PROJECT_ROOT: demoProjectDir,
      ...extraEnv,
      JASMINE_E2E_MOCK_AI: "0"
    }
  };
}

export async function verifyCapturedVersion(app) {
  const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  const expected = process.env.JASMINE_README_EXPECTED_VERSION?.trim();
  if (expected && version !== expected) {
    throw new Error(`README capture expected Jasmine ${expected}, but launched ${version}.`);
  }
  return version;
}

export async function configureRealDeepSeek(page) {
  const baseUrl = process.env.JASMINE_README_DEEPSEEK_BASE_URL?.trim();
  const defaultModel = process.env.JASMINE_README_DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
  if (baseUrl) {
    await page.evaluate((requestedBaseUrl) =>
      window.jasmine.updateProvider({ id: "deepseek", baseUrl: requestedBaseUrl }), baseUrl);
  }

  const result = await page.evaluate(async (requestedModel) => {
    const discovery = await window.jasmine.fetchProviderModels("deepseek");
    if (discovery.provider.status !== "connected") {
      throw new Error("DeepSeek model discovery did not connect.");
    }
    if (!discovery.models.some((model) => model.id === requestedModel)) {
      throw new Error(`DeepSeek model discovery did not return ${requestedModel}.`);
    }
    await window.jasmine.updateProvider({ id: "deepseek", defaultModel: requestedModel });
    const providers = await window.jasmine.listProviders();
    const deepseek = providers.find((provider) => provider.id === "deepseek");
    if (!deepseek) throw new Error("DeepSeek provider is missing");
    const test = await window.jasmine.testProvider(deepseek.id);
    return { model: deepseek.defaultModel, status: test.status };
  }, defaultModel);
  if (result.status !== "connected") throw new Error(`DeepSeek provider test returned ${result.status}`);
  return result;
}

export async function sanitizeCapturePage(page, { rootDir, demoProjectDir }) {
  await page.evaluate(({ customBaseUrl, demoRoot, homeRoot, repositoryRoot }) => {
    const replacements = [
      [demoRoot, "C:\\Workspace\\Jasmine Demo Workspace"],
      [repositoryRoot, "C:\\Workspace\\Jasmine"],
      [homeRoot, "C:\\Workspace"]
    ].filter(([source]) => source);
    const sanitize = (value) => {
      let next = value;
      for (const [source, replacement] of replacements) {
        next = next.split(source).join(replacement).split(source.replaceAll("\\", "/")).join(replacement);
      }
      if (customBaseUrl) next = next.split(customBaseUrl).join("https://api.deepseek.com");
      return next
        .replace(/~[\\/][^\s\r\n]+/g, "C:\\Workspace\\Jasmine Demo Workspace")
        .replace(/\.jasmine[\\/][^\s\r\n]+/g, "JasmineData")
        .replace(/\bcodex\/[A-Za-z0-9._/-]+/g, "demo");
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent) node.textContent = sanitize(node.textContent);
    }
    for (const input of document.querySelectorAll("input, textarea")) {
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        input.value = sanitize(input.value);
      }
    }
  }, {
    customBaseUrl: process.env.JASMINE_README_DEEPSEEK_BASE_URL?.trim() || "",
    demoRoot: demoProjectDir,
    homeRoot: os.homedir(),
    repositoryRoot: rootDir
  });
}
