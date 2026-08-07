import os from "node:os";
import path from "node:path";
import { discoverPiSessionFiles, importPiSessions, parsePiSessionFile } from "./lib/pi-session-import.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (Boolean(args.session) === Boolean(args.all)) {
  console.error("Choose exactly one of --session <file> or --all.");
  printHelp();
  process.exit(1);
}

const sourceRoot = path.resolve(args.sourceRoot ?? path.join(os.homedir(), ".pi", "agent", "sessions"));
const databasePath = path.resolve(args.database ?? path.join(os.homedir(), ".jasmine", "data", "jasmine.sqlite"));
const assetRoot = path.resolve(args.assetRoot ?? path.join(path.dirname(databasePath), "pi-import-assets"));
const files = args.session ? [path.resolve(args.session)] : discoverPiSessionFiles(sourceRoot);
const sessions = files.map((filePath) => parsePiSessionFile(filePath, { assetRoot }));
const result = await importPiSessions({
  databasePath,
  sessions,
  write: args.write,
  replace: args.replace,
  backupDirectory: args.backupDirectory,
  sessionRoot: args.sessionRoot
});

if (args.json) {
  console.log(JSON.stringify({ mode: args.write ? "write" : "dry-run", databasePath, sourceRoot, assetRoot, ...result }, null, 2));
} else {
  console.log(`${args.write ? "WRITE" : "DRY RUN"}: ${result.importableSessions}/${result.discoveredSessions} session(s) to import, ${result.skippedSessions} already present, ${result.replacedSessions} to replace.`);
  console.log(`Projects: ${result.projects}; messages: ${result.messages}; image assets: ${result.assets}; excluded inactive branch entries: ${result.excludedBranchEntries}.`);
  for (const session of result.imported) {
    console.log(`- ${session.title} (${session.id}) - ${session.messages} messages - ${session.cwd}`);
  }
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (!args.write) console.log("No data was changed. Add --write after reviewing this dry run.");
}

function parseArgs(values) {
  const result = { write: false, replace: false, all: false, json: false, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--write") result.write = true;
    else if (value === "--replace") result.replace = true;
    else if (value === "--all") result.all = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (["--session", "--source-root", "--database", "--asset-root", "--backup-directory", "--session-root"].includes(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      const key = value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      result[key] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return result;
}

function printHelp() {
  console.log(`Import Pi JSONL sessions into Jasmine.

Usage:
  npm.cmd run import:pi-sessions -- --session <file> [--write]
  npm.cmd run import:pi-sessions -- --all [--write]

Options:
  --write                  Apply the import. Without this flag, only report a dry run.
  --replace                Reimport selected session UUIDs that already exist (requires --write to change data).
  --source-root <folder>   Pi sessions root (default: ~/.pi/agent/sessions).
  --database <file>        Jasmine SQLite file (default: ~/.jasmine/data/jasmine.sqlite).
  --asset-root <folder>    Folder for imported tool images.
  --session-root <folder>  Jasmine Pi JSONL root (default: <userData>/pi-agent/sessions).
  --backup-directory <dir> Folder for the automatic pre-import SQLite backup.
  --json                   Print machine-readable output.
  --help                   Show this help.

The Pi session UUID becomes the Jasmine thread UUID, so reruns safely skip sessions already imported.`);
}
