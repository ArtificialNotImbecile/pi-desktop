export type CodeBlockKind = "code" | "diff" | "ansi" | "json" | "stack" | "log";

const EXTENSION_LANGUAGES: Record<string, string> = {
  bat: "bat",
  batch: "bat",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  cmd: "bat",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  less: "less",
  log: "ansi",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  patch: "diff",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml"
};

const LANGUAGE_ALIASES: Record<string, string> = {
  console: "ansi",
  js: "javascript",
  md: "markdown",
  plaintext: "text",
  ps: "powershell",
  shell: "bash",
  terminal: "ansi",
  text: "text",
  ts: "typescript",
  yml: "yaml"
};

export function normalizeCodeLanguage(language: string | undefined, kind: CodeBlockKind = "code", code = ""): string {
  const requested = language?.trim().toLowerCase();
  if (requested) return LANGUAGE_ALIASES[requested] ?? requested;
  if (kind === "diff") return "diff";
  if (kind === "ansi" || kind === "log") return "ansi";
  if (kind === "json") return "json";
  if (kind === "stack") return stackTraceLanguage(code);
  if (looksLikeJson(code)) return "json";
  if (looksLikeDiff(code)) return "diff";
  return "text";
}

export function languageFromPath(path: string | undefined): string {
  const basename = (path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!basename) return "text";
  if (basename === "dockerfile") return "dockerfile";
  const extension = basename.includes(".") ? basename.split(".").pop() ?? "" : "";
  return EXTENSION_LANGUAGES[extension] ?? "text";
}

export function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

export function looksLikeDiff(value: string): boolean {
  return value.split("\n").some((line) => /^(\+\+\+|---|@@ |\+[^+]|-[^-])/.test(line));
}

function stackTraceLanguage(value: string): string {
  if (/^\s*at\s+.+\(.+\)$/m.test(value) || /Error:/m.test(value)) return "javascript";
  if (/Traceback \(most recent call last\):/m.test(value)) return "python";
  return "ansi";
}
