import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { rootDir, walkFiles } from "./lib/uiChecks.mjs";

const rawControlPattern = /<(button|input|select|textarea)\b/g;
const allowlist = [
  "src/renderer/components/ui/",
  "src/renderer/components/chat/Composer.tsx",
  "src/renderer/components/chat/MessageTimeline.tsx",
  "src/renderer/components/shell/",
  "src/renderer/components/settings/ModelOptionsDialog.tsx",
  "src/renderer/components/settings/ProviderSettingsPanel.tsx",
  "src/renderer/components/settings/SkillsSettingsPage.tsx"
];

const findings = [];

for (const file of walkFiles(join(rootDir, "src", "renderer"), [".tsx"])) {
  const rel = relative(rootDir, file).replaceAll("\\", "/");
  if (allowlist.some((entry) => rel.startsWith(entry) || rel === entry)) continue;
  const text = readFileSync(file, "utf8");
  const matches = [...text.matchAll(rawControlPattern)];
  if (matches.length > 0) {
    findings.push(`${rel}: ${matches.length} raw control(s)`);
  }
}

if (findings.length > 0) {
  console.warn("UI primitive guardrail warning: raw controls remain outside primitives/settings allowlist.");
  for (const finding of findings.slice(0, 20)) console.warn(`- ${finding}`);
  if (findings.length > 20) console.warn(`- ${findings.length - 20} more`);
  console.warn("Phase 1 keeps this non-blocking; new UI should prefer src/renderer/components/ui primitives.");
} else {
  console.log("UI primitive guardrail passed with no raw controls outside allowlist.");
}
