import { readFile } from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const expectedTag = `v${manifest.version}`;
const releaseTag = (process.env.RELEASE_TAG || process.argv[2] || "").trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error(`package.json contains an unsupported release version: ${manifest.version}`);
}

if (!releaseTag) {
  console.log(`Manual release build for package version ${manifest.version}; no tag validation required.`);
} else if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${manifest.version}; expected ${expectedTag}.`);
} else {
  console.log(`Release tag ${releaseTag} matches package version ${manifest.version}.`);
}
