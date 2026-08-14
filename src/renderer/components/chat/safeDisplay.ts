const CREDENTIAL_MARKER = /(?:authorization|bearer|api[-_ ]?key|access[-_ ]?token|password|passwd|secret|private[-_ ]?key|x-amz-(?:signature|credential|security-token)|(?:^|[?&])sig(?:nature)?=)/i;
const STANDALONE_CREDENTIAL = /(?:\bgh[pousr]_[a-z0-9]{20,}\b|\bgithub_pat_[a-z0-9_]{20,}\b|\bglpat-[a-z0-9_-]{20,}\b|\bsk-(?:proj-)?[a-z0-9_-]{20,}\b|\b(?:sk|rk)_(?:live|test)_[a-z0-9]{16,}\b|\bnpm_[a-z0-9]{20,}\b|\bxox[baprs]-[a-z0-9-]{20,}\b|\bAIza[a-z0-9_-]{35,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b)/i;

export function credentialSafeText(value: string): string {
  const trimmed = value.trim();
  return trimmed && !CREDENTIAL_MARKER.test(trimmed) && !STANDALONE_CREDENTIAL.test(trimmed) ? trimmed : "";
}

export function sanitizedHttpUrl(value: string): string {
  if (!value.trim()) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // URL.origin excludes username/password; query and hash are deliberately
    // omitted because signed URLs commonly place credentials there. A path can
    // itself contain a provider token, including a percent-encoded one, so fall
    // back to the origin instead of exposing an unsafe path segment.
    let decodedPathname = parsed.pathname;
    try {
      decodedPathname = decodeURIComponent(parsed.pathname);
    } catch {
      // Keep the encoded path for the same credential scan when decoding fails.
    }
    const safePathname = credentialSafeText(decodedPathname) ? parsed.pathname : "";
    return `${parsed.origin}${safePathname}`;
  } catch {
    return "";
  }
}
