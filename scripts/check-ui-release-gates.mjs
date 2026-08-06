import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const issuePath = new URL("../docs/ui_issue_register.md", import.meta.url);
const acceptanceResultPath = new URL("../test-results/ui-harness/acceptance/acceptance-result.json", import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const issues = readFileSync(issuePath, "utf8");
const blockingIssues = issues
  .split(/\r?\n/)
  .filter((line) => /^\|\s*UI-OPEN-\d{3}\s*\|/.test(line))
  .filter((line) => /\|\s*open\s*\|\s*release-blocking\s*\|/i.test(line));

if (blockingIssues.length > 0) {
  throw new Error(`UI release gates have blocking open issues:\n${blockingIssues.join("\n")}`);
}
if (!existsSync(acceptanceResultPath)) {
  throw new Error("Run `npm run harness:accept` before checking release gates.");
}

const result = JSON.parse(readFileSync(acceptanceResultPath, "utf8"));
if (result.status !== "pass") throw new Error(`Acceptance result is not pass: ${result.status}`);

const stepIds = new Set(result.steps?.map((step) => step.id) ?? []);
for (const id of ["ACCEPT-001", "ACCEPT-002", "ACCEPT-003", "ACCEPT-004", "ACCEPT-005", "ACCEPT-006"]) {
  if (!stepIds.has(id)) throw new Error(`Acceptance result is missing ${id}.`);
}
for (const step of result.steps ?? []) {
  if (!step.file) continue;
  const absolutePath = path.resolve(repoRoot, step.file);
  if (!absolutePath.startsWith(path.join(repoRoot, "test-results", "ui-harness"))) {
    throw new Error(`Acceptance evidence is outside the ignored artifact directory: ${step.file}`);
  }
  if (!existsSync(absolutePath)) throw new Error(`Acceptance evidence is missing: ${step.file}`);
}

console.log("UI release gates are complete for the current generated acceptance run.");
