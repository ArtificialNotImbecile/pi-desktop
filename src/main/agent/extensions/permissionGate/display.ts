const DEFAULT_MAX_DISPLAY_LENGTH = 2_048;

const ESCAPE_BY_CODE_POINT = new Map<number, string>([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x1b, "\\x1b"],
  [0x7f, "\\x7f"],
  [0x202a, "\\u202a"],
  [0x202b, "\\u202b"],
  [0x202c, "\\u202c"],
  [0x202d, "\\u202d"],
  [0x202e, "\\u202e"],
  [0x2066, "\\u2066"],
  [0x2067, "\\u2067"],
  [0x2068, "\\u2068"],
  [0x2069, "\\u2069"]
]);

const NON_RENDERING_OR_LINE_SEPARATOR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Converts untrusted tool text to a single-line, terminal-safe preview.
 * The original value remains available separately to policy/audit code.
 */
export function sanitizePermissionDisplay(
  value: string,
  maxLength = DEFAULT_MAX_DISPLAY_LENGTH
): string {
  const safeLimit = Number.isSafeInteger(maxLength) && maxLength > 0
    ? maxLength
    : DEFAULT_MAX_DISPLAY_LENGTH;
  let escaped = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const namedEscape = ESCAPE_BY_CODE_POINT.get(codePoint);
    if (namedEscape) {
      escaped += namedEscape;
    } else if (NON_RENDERING_OR_LINE_SEPARATOR.test(character)) {
      escaped += escapeCodePoint(codePoint);
    } else {
      escaped += character;
    }
  }

  if (escaped.length <= safeLimit) return escaped;
  const suffix = `… [truncated; original ${value.length} chars]`;
  if (suffix.length >= safeLimit) return suffix.slice(0, safeLimit);
  const prefixLength = Math.max(0, safeLimit - suffix.length);
  return `${escaped.slice(0, prefixLength)}${suffix}`;
}

function escapeCodePoint(codePoint: number): string {
  if (codePoint <= 0xff) return `\\x${codePoint.toString(16).padStart(2, "0")}`;
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  return `\\u{${codePoint.toString(16)}}`;
}

export function bashApprovalSummary(command: string): string {
  return `Run shell command: ${sanitizePermissionDisplay(command)}`;
}

export function fileApprovalSummary(
  toolName: "write" | "edit",
  path: string,
  reason: "outside-project" | "no-project" | "canonicalization-failed"
): string {
  const verb = toolName === "write" ? "Write file" : "Edit file";
  const explanation = reason === "no-project"
    ? "no trusted project is open"
    : reason === "outside-project"
      ? "target is outside the trusted project"
      : "target scope could not be verified";
  return `${verb}: ${sanitizePermissionDisplay(path)} (${explanation})`;
}
