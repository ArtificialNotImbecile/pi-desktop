import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { rootDir, walkFiles } from "./lib/uiChecks.mjs";

const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g;
const allowlist = [
  "src/renderer/styles.css",
  "src/renderer/components/code/",
  "src/renderer/hooks/useThemeAppearance.ts",
  "src/shared/theme.ts"
];

const findings = [];

for (const file of walkFiles(join(rootDir, "src"), [".ts", ".tsx", ".css"])) {
  const rel = relative(rootDir, file).replaceAll("\\", "/");
  if (allowlist.some((entry) => rel.startsWith(entry) || rel === entry)) continue;
  const text = readFileSync(file, "utf8");
  const matches = [...text.matchAll(colorPattern)];
  if (matches.length > 0) {
    findings.push(`${rel}: ${matches.length} hard-coded color(s)`);
  }
}

if (findings.length > 0) {
  console.warn("Theme color guardrail warning: hard-coded colors remain outside token allowlist.");
  for (const finding of findings.slice(0, 20)) console.warn(`- ${finding}`);
  if (findings.length > 20) console.warn(`- ${findings.length - 20} more`);
  console.warn("Phase 1 keeps this non-blocking; new UI should use CSS variables from styles.css.");
} else {
  console.log("Theme color guardrail passed with no hard-coded colors outside allowlist.");
}
