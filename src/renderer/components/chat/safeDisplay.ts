const CREDENTIAL_MARKER = /(?:authorization|bearer|api[-_ ]?key|access[-_ ]?token|password|passwd|secret|x-amz-(?:signature|credential|security-token)|(?:^|[?&])sig(?:nature)?=)/i;

export function credentialSafeText(value: string): string {
  const trimmed = value.trim();
  return trimmed && !CREDENTIAL_MARKER.test(trimmed) ? trimmed : "";
}

export function sanitizedHttpUrl(value: string): string {
  if (!value.trim()) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // URL.origin excludes username/password; query and hash are deliberately
    // omitted because signed URLs commonly place credentials there.
    return credentialSafeText(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return "";
  }
}
