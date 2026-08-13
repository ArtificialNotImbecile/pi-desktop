import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const sourceFontPath = path.join(rootDir, "src", "renderer", "assets", "fonts", "InterVariable.woff2");
const licensePath = path.join(rootDir, "third_party", "inter", "LICENSE.txt");
const stylesheetPath = path.join(rootDir, "src", "renderer", "styles.css");
const expectedFontHash = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3";
const expectedLicenseHash = "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a";

assert.equal(await sha256(sourceFontPath), expectedFontHash, "bundled Inter must match the pinned v4.1 release file");
assert.equal(await sha256(licensePath), expectedLicenseHash, "Inter's upstream OFL-1.1 text must stay byte-identical");

const stylesheet = await readFile(stylesheetPath, "utf8");
const fontFace = /@font-face\s*\{[\s\S]*?\}/.exec(stylesheet)?.[0] ?? "";
assert.match(fontFace, /font-family:\s*"Jasmine Inter"/);
assert.match(fontFace, /font-style:\s*normal/);
assert.match(fontFace, /font-weight:\s*100 900/);
assert.match(fontFace, /url\("\.\/assets\/fonts\/InterVariable\.woff2"\)/);
assert.doesNotMatch(fontFace, /https?:|\/\//, "the renderer font face must never make a network request");
assert.match(stylesheet, /--font-ui:\s*"Jasmine Inter",\s*ui-sans-serif,\s*system-ui/,
  "the deterministic app family must retain platform fallbacks for CJK");
assert.match(stylesheet, /font-synthesis:\s*style/,
  "weight synthesis must stay disabled while the normal-only bundle may synthesize style");
assert.match(stylesheet, /\.markdown-message strong\s*\{\s*font-weight:\s*700;/,
  "Markdown strong must request a real weight inside Inter's supported variable range");

const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
assert.ok(manifest.build.extraResources.some((entry) => entry.from === "third_party" && entry.to === "third-party"),
  "packaged applications must carry the third-party license tree");
assert.ok(manifest.build.extraResources.some((entry) => entry.from === "THIRD_PARTY_LICENSES.md"),
  "packaged applications must carry the third-party notice");
assert.doesNotMatch(JSON.stringify(manifest.scripts), /InterVariable|Jasmine Inter|font.*(?:install|register)/i,
  "font bundling must not add an OS font installation or registration script");

const mainSources = await readTextTree(path.join(rootDir, "src", "main"));
assert.doesNotMatch(mainSources, /InterVariable|Jasmine Inter/,
  "font loading must remain renderer-owned and must not register a font from Electron main");

const distAssetsDir = path.join(rootDir, "dist", "renderer", "assets");
const distFontPaths = (await readdir(distAssetsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^InterVariable-[^.]+\.woff2$/.test(entry.name))
  .map((entry) => path.join(distAssetsDir, entry.name));
assert.equal(distFontPaths.length, 1, "Vite must emit exactly one normal Inter variable font asset");
assert.equal(await sha256(distFontPaths[0]), expectedFontHash, "Vite must emit the pinned font without modification");

const builtStyles = (await Promise.all(
  (await readdir(distAssetsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => readFile(path.join(distAssetsDir, entry.name), "utf8"))
)).join("\n");
assert.match(builtStyles, /Jasmine Inter/);
assert.match(builtStyles, /InterVariable-[^.]+\.woff2/);
assert.doesNotMatch(builtStyles, /@font-face\{[^}]*url\((?:https?:)?\/\//,
  "the production renderer must reference only its bundled font asset");

console.log("Renderer font assets match official Inter v4.1 and are bundled without OS registration or network loading.");

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function readTextTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readTextTree(entryPath);
    if (!/\.(?:cjs|js|mjs|ts|tsx)$/.test(entry.name)) return "";
    return readFile(entryPath, "utf8");
  }));
  return contents.join("\n");
}
