/** Extract every numeric GLIBC symbol version referenced by readelf output. */
export function referencedGlibcVersions(versionInfo) {
  return [...new Set([...String(versionInfo).matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)]
    .map((match) => match[1]))]
    .sort(compareVersion);
}

/** Nonnumeric GLIBC ABI tags cannot be ordered against a numeric baseline. */
export function referencedGlibcAbiTags(versionInfo) {
  return [...new Set([...String(versionInfo).matchAll(/\bGLIBC_([A-Z][A-Z0-9_]*)\b/gu)]
    .map((match) => match[1]))]
    .sort();
}

/**
 * Fail publication when a dynamically linked runtime payload requires a glibc
 * newer than the artifact contract. `readelf --version-info` is authoritative
 * for symbol-version requirements and works without executing the binary.
 */
export function assertGlibcBaseline(versionInfo, baseline, label = "runtime payload") {
  const abiTags = referencedGlibcAbiTags(versionInfo);
  if (abiTags.length > 0) {
    throw new Error(`${label} requires unsupported GLIBC ABI tag(s): ${abiTags.map((tag) => `GLIBC_${tag}`).join(", ")}.`);
  }
  const versions = referencedGlibcVersions(versionInfo);
  const required = versions.at(-1);
  if (required && compareVersion(required, baseline) > 0) {
    throw new Error(`${label} requires GLIBC_${required}, newer than the declared glibc ${baseline} baseline.`);
  }
  return { baseline, required: required ?? null, versions };
}

/** Host-native tmux copies are valid only when the builder itself is x86_64. */
export function assertLinuxX64BuildHost(machine, label = "Linux build host") {
  const normalized = String(machine).trim().toLowerCase();
  if (normalized !== "x86_64") {
    throw new Error(`${label} architecture ${normalized || "unknown"} cannot produce the linux-x64 runtime; use an x86_64 baseline environment.`);
  }
  return normalized;
}

function compareVersion(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
