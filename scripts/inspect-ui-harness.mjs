import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, escapePipe, launchHarnessApp, resetDirectory, rootDir } from "./lib/uiHarness.mjs";

const outputDir = path.join(rootDir, "test-results", "ui-harness", "inspect");
const userDataDir = path.join(rootDir, ".tmp", "harness-inspect");
const snapshotPath = path.join(outputDir, "ui-harness-snapshot.json");
const reportPath = path.join(outputDir, "ui-harness-audit.md");

await resetDirectory(userDataDir);
await ensureDirectory(outputDir);

const app = await launchHarnessApp({
  userDataDir,
  env: {
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_MOCK_AI: "1",
    JASMINE_E2E_MANY_MODELS: "1"
  }
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell");
  await page.waitForFunction(() => Boolean(window.__jasmineHarness));

  const results = [];
  results.push(await inspect(page, "initial"));

  await page.evaluate(() => window.__jasmineHarness.actions.openModelMenu());
  await page.waitForSelector(".model-menu");
  results.push(await inspect(page, "model-menu"));

  await page.evaluate(() => window.__jasmineHarness.actions.openMoreMenu());
  await page.waitForSelector(".side-menu");
  results.push(await inspect(page, "more-menu"));

  await page.evaluate(() => window.__jasmineHarness.actions.openSearch());
  await page.waitForSelector(".search-backdrop");
  results.push(await inspect(page, "search"));

  await page.evaluate(() => window.__jasmineHarness.actions.openSettings());
  await page.waitForSelector(".settings-panel");
  results.push(await inspect(page, "settings"));

  const allIssues = results.flatMap((result) => result.audit.issues.map((issue) => ({ surface: result.surface, ...issue })));
  const errorCount = allIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = allIssues.filter((issue) => issue.severity === "warning").length;

  await writeFile(snapshotPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  await writeFile(reportPath, renderReport({ results, allIssues, errorCount, warningCount }), "utf8");

  if (errorCount > 0) {
    throw new Error(`UI harness audit found ${errorCount} error(s). See ${path.relative(rootDir, reportPath)}.`);
  }

  console.log(`UI harness bridge audit passed with ${warningCount} warning(s).`);
} finally {
  await app.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

async function inspect(page, surface) {
  const audit = await page.evaluate(() => window.__jasmineHarness.audit());
  return {
    surface,
    audit
  };
}

function renderReport({ results, allIssues, errorCount, warningCount }) {
  const summaryRows = results
    .map((result) => `| ${result.surface} | ${result.audit.snapshot.controls.length} | ${result.audit.errorCount} | ${result.audit.warningCount} | ${result.audit.snapshot.surfaces.join(", ") || "none"} |`)
    .join("\n");
  const issueRows = allIssues.length
    ? allIssues
        .map((issue) => `| ${issue.surface} | ${issue.severity} | ${issue.id} | ${escapePipe(issue.label ?? "")} | ${escapePipe(issue.selector ?? "")} | ${escapePipe(issue.summary)} |`)
        .join("\n")
    : "| none | pass | none |  |  | No audit issues found. |";

  return `# UI Harness Audit

Generated at: ${new Date().toISOString()}

Errors: ${errorCount}

Warnings: ${warningCount}

Snapshot JSON: \`test-results/ui-harness/inspect/ui-harness-snapshot.json\`

| Surface | Visible Controls | Errors | Warnings | Open Surfaces |
| --- | ---: | ---: | ---: | --- |
${summaryRows}

## Issues

| Surface | Severity | Rule | Label | Selector | Summary |
| --- | --- | --- | --- | --- | --- |
${issueRows}
`;
}
