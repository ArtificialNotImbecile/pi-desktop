import { createHash } from "node:crypto";
import path from "node:path";

export const SKILL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,63}$/u;

export type ParsedSkillMarkdown = {
  name: string;
  description: string;
  body: string;
};

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown | null {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = parseFlatYaml(match[1]);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description || !SKILL_NAME_PATTERN.test(name)) return null;
  return { name, description, body: match[2] };
}

export function skillIdForPath(source: string, skillPath: string): string {
  return `${source}:${createHash("sha256").update(path.resolve(skillPath).toLowerCase()).digest("hex").slice(0, 24)}`;
}

function parseFlatYaml(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();
    if (rawValue === ">") {
      const folded: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        folded.push(lines[index].trim());
      }
      result[key] = folded.join(" ").replace(/\s+/g, " ").trim();
    } else {
      result[key] = unquote(rawValue);
    }
  }
  return result;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
