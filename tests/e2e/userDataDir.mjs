import { createHash, randomUUID } from "node:crypto";

export const E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES = 96;

export function e2eUserDataDirName(label, uniqueId = randomUUID()) {
  // Pi's session directory includes an encoded copy of the workspace cwd. A
  // full Playwright title here can therefore make that later component exceed
  // macOS's 255-byte limit. Keep a readable prefix, retain title identity in a
  // stable hash, and retain per-launch uniqueness in the UUID.
  const readableLabel = label
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40) || "jasmine-e2e";
  const labelHash = createHash("sha256").update(label).digest("hex").slice(0, 12);
  const name = `${readableLabel}-${labelHash}-${uniqueId}`;
  if (Buffer.byteLength(name, "utf8") > E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES) {
    throw new Error("E2E user data directory component exceeded its portable byte limit.");
  }
  return name;
}
