import { app } from "electron";
import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type {
  TodoAddRequest,
  TodoFileKind,
  TodoOpenFileResponse,
  TodoSection,
  TodoSnapshot,
  WorkspaceProject
} from "../../shared/ipc.js";
import { openPathInEditor } from "./fileEditor.js";

const TODO_DIR = "todos";
const TODO_FILE = "todo.md";
const LOG_FILE = "log.md";
const SCHEMA_FILE = "schema.md";
const INBOX_SECTION = "Inbox";

export async function getTodoSnapshot(): Promise<TodoSnapshot> {
  const paths = await ensureTodoFiles();
  const [todoMarkdown, logMarkdown, schemaMarkdown] = await Promise.all([
    readFile(paths.todoPath, "utf8"),
    readFile(paths.logPath, "utf8"),
    readFile(paths.schemaPath, "utf8")
  ]);
  const [todoStats, logStats, schemaStats] = await Promise.all([
    stat(paths.todoPath),
    stat(paths.logPath),
    stat(paths.schemaPath)
  ]);
  return {
    ...paths,
    todoMarkdown,
    logMarkdown,
    schemaMarkdown,
    sections: parseTodoSections(todoMarkdown),
    updatedAt: new Date(Math.max(todoStats.mtimeMs, logStats.mtimeMs, schemaStats.mtimeMs)).toISOString()
  };
}

export async function addTodo(input: TodoAddRequest, projects: WorkspaceProject[]): Promise<TodoSnapshot> {
  const paths = await ensureTodoFiles();
  const rawText = normalizeRawTodoText(input.text);
  const itemText = normalizeTodoText(input.text);
  const category = inferCategory(itemText, input.projectId, projects);
  const now = new Date().toISOString();
  const item = `- [ ] ${itemText}`;

  const [todoMarkdown] = await Promise.all([
    readFile(paths.todoPath, "utf8"),
    appendFile(paths.logPath, formatLogEntry({ rawText, category, timestamp: now }), "utf8")
  ]);
  await writeFile(paths.todoPath, insertTodoItem(todoMarkdown, category, item), "utf8");
  return getTodoSnapshot();
}

export async function openTodoFile(input: {
  kind: TodoFileKind;
  currentEditorPath?: string;
  saveEditorPath(editorPath: string): void;
}): Promise<TodoOpenFileResponse> {
  const paths = await ensureTodoFiles();
  const filePath = pathForKind(paths, input.kind);
  const opened = await openPathInEditor({
    filePath,
    currentEditorPath: input.currentEditorPath,
    saveEditorPath: input.saveEditorPath,
    chooserTitle: "Choose a text editor for Jasmine TODO files"
  });
  return {
    kind: input.kind,
    path: opened.openedPath,
    editorPath: opened.editorPath
  };
}

async function ensureTodoFiles(): Promise<{
  rootPath: string;
  todoPath: string;
  logPath: string;
  schemaPath: string;
}> {
  const rootPath = path.join(app.getPath("userData"), TODO_DIR);
  const todoPath = path.join(rootPath, TODO_FILE);
  const logPath = path.join(rootPath, LOG_FILE);
  const schemaPath = path.join(rootPath, SCHEMA_FILE);
  await mkdir(rootPath, { recursive: true });
  await writeFileIfMissing(todoPath, defaultTodoMarkdown());
  await writeFileIfMissing(logPath, defaultLogMarkdown());
  await writeFileIfMissing(schemaPath, defaultSchemaMarkdown());
  return { rootPath, todoPath, logPath, schemaPath };
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  const existing = await stat(filePath).catch(() => null);
  if (existing?.isFile()) return;
  await writeFile(filePath, content, "utf8");
}

function defaultTodoMarkdown(): string {
  return [
    "# TODO",
    "",
    "## Inbox",
    "",
    ""
  ].join("\n");
}

function defaultLogMarkdown(): string {
  return [
    "# TODO Log",
    "",
    "Raw TODO captures are appended here in chronological order. Do not delete log entries when reorganizing `todo.md`.",
    ""
  ].join("\n");
}

function defaultSchemaMarkdown(): string {
  return [
    "# Jasmine TODO Schema",
    "",
    "These files are the source of truth for Jasmine TODOs.",
    "",
    "## Files",
    "",
    "- `todo.md`: organized, user-facing ideas and tasks.",
    "- `log.md`: append-only chronological raw captures.",
    "- `schema.md`: rules for humans, agents, and Jasmine code that write TODO files.",
    "",
    "## `todo.md` Rules",
    "",
    "- Use `# TODO` as the document title.",
    "- Group work under `## <project-or-category>` headings.",
    "- Prefer existing Jasmine project names when the capture clearly belongs to a project.",
    "- Use `## Inbox` when no reliable project or category can be inferred.",
    "- Use Markdown task items: `- [ ]` for open work and `- [x]` for completed work.",
    "- Preserve the user's wording where possible. Clarify only enough to make the task understandable.",
    "- Do not remove completed tasks unless the user explicitly asks to archive or delete them.",
    "",
    "## `log.md` Rules",
    "",
    "- Append every raw capture with an ISO timestamp.",
    "- Keep raw wording and image/file references inspectable.",
    "- Do not rewrite or delete log history when reorganizing `todo.md`.",
    "",
    "## Agent Rules",
    "",
    "- Read this schema before programmatically editing TODO files.",
    "- Update both `log.md` and `todo.md` when adding a new capture.",
    "- If a capture includes images, preserve the local path or attachment reference in the log and summarize the actionable idea in `todo.md`.",
    "- If unsure about classification, put the item in `Inbox` rather than guessing.",
    ""
  ].join("\n");
}

function pathForKind(paths: { todoPath: string; logPath: string; schemaPath: string }, kind: TodoFileKind): string {
  if (kind === "log") return paths.logPath;
  if (kind === "schema") return paths.schemaPath;
  return paths.todoPath;
}

function normalizeTodoText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function normalizeRawTodoText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function inferCategory(text: string, projectId: string | null | undefined, projects: WorkspaceProject[]): string {
  const explicitProject = projectId ? projects.find((project) => project.id === projectId) : null;
  if (explicitProject) return explicitProject.name;

  const normalized = text.toLowerCase();
  const byName = projects.find((project) => normalized.includes(project.name.toLowerCase()));
  if (byName) return byName.name;
  const byRoot = projects.find((project) => {
    const basename = path.basename(project.rootPath).toLowerCase();
    return basename.length > 1 && normalized.includes(basename);
  });
  return byRoot?.name ?? INBOX_SECTION;
}

function formatLogEntry(input: { rawText: string; category: string; timestamp: string }): string {
  const quoted = input.rawText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "",
    `## ${input.timestamp}`,
    "",
    `- Category: ${input.category}`,
    "- Source: Jasmine TODO",
    "",
    quoted,
    ""
  ].join("\n");
}

function insertTodoItem(markdown: string, sectionTitle: string, item: string): string {
  const normalized = normalizeMarkdown(markdown);
  const lines = normalized.split("\n");
  const headingIndex = lines.findIndex((line) => sectionHeadingTitle(line)?.toLowerCase() === sectionTitle.toLowerCase());
  if (headingIndex === -1) {
    const suffix = normalized.endsWith("\n") ? "" : "\n";
    return `${normalized}${suffix}\n## ${sectionTitle}\n\n${item}\n`;
  }

  const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && /^##\s+/.test(line));
  let insertAt = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  while (insertAt > headingIndex + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, item);
  return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}

function normalizeMarkdown(markdown: string): string {
  const trimmed = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (trimmed.trim()) return trimmed;
  return defaultTodoMarkdown();
}

function parseTodoSections(markdown: string): TodoSection[] {
  const lines = normalizeMarkdown(markdown).split("\n");
  const sections: TodoSection[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const title = sectionHeadingTitle(line);
    if (title) {
      if (current) sections.push(buildSection(current.title, current.body));
      current = { title, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(buildSection(current.title, current.body));
  if (sections.length > 0) return sections;
  return [buildSection(INBOX_SECTION, lines)];
}

function sectionHeadingTitle(line: string): string | null {
  const match = line.match(/^##\s+(.+?)\s*$/);
  return match ? match[1].trim() : null;
}

function buildSection(title: string, body: string[]): TodoSection {
  const markdown = body.join("\n").trim();
  const counts = countTaskItems(body);
  return {
    id: slugForSection(title),
    title,
    markdown,
    openCount: counts.open,
    doneCount: counts.done
  };
}

function countTaskItems(lines: string[]): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+/);
    if (!match) continue;
    if (match[1].toLowerCase() === "x") done += 1;
    else open += 1;
  }
  return { open, done };
}

function slugForSection(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || Buffer.from(title).toString("hex").slice(0, 24);
}
