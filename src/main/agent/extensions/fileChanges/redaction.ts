import path from "node:path";

export interface FileRedactionContext {
  root: string;
  path: string;
  absolutePath: string;
}

export interface FileContentRedactionContext extends FileRedactionContext {
  content: Buffer;
  contentTruncated: boolean;
}

export type FileRedactionPredicate = (
  file: FileRedactionContext
) => boolean | Promise<boolean>;

export type FileContentRedactionPredicate = (
  file: FileContentRedactionContext
) => boolean | Promise<boolean>;

/**
 * Fail-safe defaults for filenames that commonly carry credentials or private
 * keys. Matching is case-insensitive and applies to the basename.
 */
export function isDefaultSensitivePath(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename.startsWith(".env")
    || basename === ".npmrc"
    || basename === ".pypirc"
    || basename === ".netrc"
    || basename === "auth.json"
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename.endsWith(".p12")
    || basename.endsWith(".pfx")
    || basename.startsWith("id_rsa")
    || basename.startsWith("id_ed25519")
    || basename.startsWith("id_ecdsa")
    || basename.startsWith("id_dsa")
    || sensitiveNameBoundary(basename, "credentials")
    || sensitiveNameBoundary(basename, "credential")
    || sensitiveNameBoundary(basename, "secrets")
    || sensitiveNameBoundary(basename, "secret")
    || sensitiveNameBoundary(basename, "token");
}


/** Deterministic, high-confidence content patterns that must never be previewed. */
export function containsHighConfidenceSecret(content: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return false;
  }
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text)) return true;
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)) return true;
  if (/\bghp_[A-Za-z0-9]{30,}\b/.test(text)) return true;
  if (/\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text)) return true;
  if (/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/i.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\bAIza[0-9A-Za-z_-]{30,}\b/.test(text)) return true;
  if (/\bnpm_[A-Za-z0-9]{20,}\b/.test(text)) return true;
  if (/\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{10,}/i.test(text)) return true;

  const assignment = /(?:^|[\r\n,{]\s*)(?:export\s+)?["']?(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*([^\r\n,}]+)/gim;
  for (const match of text.matchAll(assignment)) {
    const value = normalizeAssignedValue(match[2] ?? "");
    if (isConcreteSecretValue(value)) return true;
  }
  return false;
}

function sensitiveNameBoundary(basename: string, word: string): boolean {
  return basename.split(/[._-]+/).includes(word);
}

function normalizeAssignedValue(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, "").trim();
  if ((withoutComment.startsWith('"') && withoutComment.endsWith('"'))
    || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
    return withoutComment.slice(1, -1).trim();
  }
  return withoutComment;
}

function isConcreteSecretValue(value: string): boolean {
  if (value.length < 8 || value.length > 16 * 1024) return false;
  const normalized = value.toLowerCase();
  if (/^(?:null|undefined|true|false|none|redacted|masked|changeme|change_me|placeholder|example|sample|dummy|test|testing|password|secret|token|x+|\*+)$/.test(normalized)) return false;
  if (/^(?:\$\{[^}]+\}|\$[a-z_][a-z0-9_]*|<[^>]+>|\{\{[^}]+\}\}|process\.env\.[a-z_][a-z0-9_]*|env\([^)]+\))$/i.test(value)) return false;
  if (/^(?:your|replace|insert|set)[-_ ]/.test(normalized)) return false;
  if (/[()]/.test(value) && !/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  return true;
}
