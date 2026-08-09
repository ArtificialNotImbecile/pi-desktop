import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const paths = {
  inventory: new URL("../docs/ui_inventory.md", import.meta.url),
  issues: new URL("../docs/ui_issue_register.md", import.meta.url),
  workflows: new URL("../docs/workflow_inventory.md", import.meta.url),
  harness: new URL("../docs/harness.md", import.meta.url),
  coverage: new URL("../docs/ui_coverage_matrix.md", import.meta.url)
};

const docs = Object.fromEntries(
  Object.entries(paths).map(([name, file]) => [name, readFileSync(file, "utf8")])
);
const combined = Object.values(docs).join("\n");

checkUniqueIds("inventory", docs.inventory, /\|\s*(?:\[[ x~!]\])\s*\|\s*([A-Z]+-\d{3})\s*\|/g);
checkUniqueIds("workflows", docs.workflows, /\|\s*(?:\[[ x~!]\])\s*\|\s*(WF-\d{3})\s*\|/g);
checkUniqueIds("coverage", docs.coverage, /\|\s*(RISK-\d{3}|GATE-\d{3})\s*\|/g);
checkUniqueIds("issues", docs.issues, /\|\s*(UI-OPEN-\d{3})\s*\|/g, true);

checkStatusRows("inventory", docs.inventory);
checkStatusRows("workflows", docs.workflows);

for (const issueId of new Set(docs.issues.match(/UI-OPEN-\d{3}/g) ?? [])) {
  if (!docs.inventory.includes(issueId) && !docs.workflows.includes(issueId) && !docs.coverage.includes(issueId)) {
    throw new Error(`Open issue ${issueId} is not linked from inventory, workflow, or coverage docs.`);
  }
}

for (const required of ["test-results/ui-harness", "npm run harness:accept", "npm run test:e2e", "tests/e2e/"]) {
  if (!combined.includes(required)) throw new Error(`Harness docs are missing required term: ${required}`);
}

for (const scriptName of ["test:e2e", "test:e2e:smoke"]) {
  const script = packageJson.scripts?.[scriptName] ?? "";
  if (!script.includes("JASMINE_E2E_OFFSCREEN=1")) {
    throw new Error(`${scriptName} must run Electron in background/off-screen mode by default.`);
  }
}
if ((packageJson.scripts?.["test:e2e:headed"] ?? "").includes("JASMINE_E2E_OFFSCREEN=1")) {
  throw new Error("test:e2e:headed must remain an explicit visible debugging command.");
}

console.log("UI harness docs are current, reproducible, and free of tracked visual artifacts.");

function checkUniqueIds(label, content, pattern, allowEmpty = false) {
  const seen = new Set();
  const duplicates = new Set();
  let match;
  while ((match = pattern.exec(content))) {
    if (seen.has(match[1])) duplicates.add(match[1]);
    seen.add(match[1]);
  }
  if (duplicates.size > 0) throw new Error(`${label} has duplicate IDs: ${Array.from(duplicates).join(", ")}`);
  if (!allowEmpty && seen.size === 0) throw new Error(`${label} has no IDs.`);
}

function checkStatusRows(label, content) {
  const rows = content.split(/\r?\n/).filter((line) => /^\|\s*\[[ x~!]\]\s*\|/.test(line));
  if (rows.length === 0) throw new Error(`${label} has no status rows.`);
  for (const line of rows) {
    const columns = line.split("|").slice(1, -1).map((value) => value.trim());
    const status = columns[0];
    const id = columns[1];
    const evidence = columns.at(-1) ?? "";
    if (status === "[x]") {
      if (!/(tests\/|npm run )/.test(evidence)) throw new Error(`${label} row ${id} needs reproducible test evidence.`);
    } else if (!/UI-OPEN-\d{3}/.test(evidence)) {
      throw new Error(`${label} row ${id} is incomplete and must link to an open issue.`);
    }
  }
}
