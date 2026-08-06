import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const rootDir = path.resolve(__dirname, "../..");

export function* walkFiles(root, extensions) {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const file = path.join(root, entry);
    const stats = statSync(file);
    if (stats.isDirectory()) {
      yield* walkFiles(file, extensions);
    } else if (extensions.some((extension) => file.endsWith(extension))) {
      yield file;
    }
  }
}
