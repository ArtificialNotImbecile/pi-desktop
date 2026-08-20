/** Extract every numeric GLIBC symbol version referenced by readelf output. */
export function referencedGlibcVersions(versionInfo) {
  return [...new Set([...String(versionInfo).matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)]
    .map((match) => match[1]))]
    .sort(compareVersion);
}

/**
 * Fail publication when a dynamically linked runtime payload requires a glibc
 * newer than the artifact contract. `readelf --version-info` is authoritative
 * for symbol-version requirements and works without executing the binary.
 */
export function assertGlibcBaseline(versionInfo, baseline, label = "runtime payload") {
  const versions = referencedGlibcVersions(versionInfo);
  const required = versions.at(-1);
  if (required && compareVersion(required, baseline) > 0) {
    throw new Error(`${label} requires GLIBC_${required}, newer than the declared glibc ${baseline} baseline.`);
  }
  return { baseline, required: required ?? null, versions };
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
