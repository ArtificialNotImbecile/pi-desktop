import { randomUUID } from "node:crypto";
import type { McpServerCreateRequest, McpServerRecord, McpServerUpdateRequest, McpTransport } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type McpServerRow = {
  id: string;
  name: string;
  description: string;
  command: string;
  args_json: string;
  env_json: string;
  enabled: number;
  transport: McpTransport;
  url: string | null;
  source: "manual" | "marketplace";
  marketplace_id: string | null;
  package_name: string | null;
  homepage: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
};

const MCP_SERVER_COLUMNS = [
  "id",
  "name",
  "description",
  "command",
  "args_json",
  "env_json",
  "enabled",
  "transport",
  "url",
  "source",
  "marketplace_id",
  "package_name",
  "homepage",
  "category",
  "created_at",
  "updated_at"
].join(", ");

export function listMcpServers(db: SqlDatabase): McpServerRecord[] {
  return db
    .prepare(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers ORDER BY name ASC`)
    .all()
    .map((row) => mapMcpServer(row as McpServerRow));
}

export function getMcpServer(db: SqlDatabase, id: string): McpServerRecord | null {
  const row = db.prepare(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | undefined;
  return row ? mapMcpServer(row) : null;
}

export function createMcpServer(db: SqlDatabase, input: McpServerCreateRequest, timestamp: string): McpServerRecord {
  const existing = input.marketplaceId
    ? db.prepare(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers WHERE marketplace_id = ?`).get(input.marketplaceId) as McpServerRow | undefined
    : undefined;
  if (existing) return mapMcpServer(existing);

  const server: McpServerRecord = {
    id: randomUUID(),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    command: input.command.trim(),
    args: normalizeArgs(input.args),
    envJson: normalizeEnvJson(input.envJson),
    enabled: input.enabled ?? true,
    transport: input.transport ?? "stdio",
    url: input.url?.trim() || undefined,
    source: input.source ?? "manual",
    marketplaceId: input.marketplaceId?.trim() || undefined,
    packageName: input.packageName?.trim() || undefined,
    homepage: input.homepage?.trim() || undefined,
    category: input.category?.trim() || undefined,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (!server.name || !server.command) throw new Error("MCP server name and command are required.");

  db.prepare(
    `INSERT INTO mcp_servers (
      id,
      name,
      description,
      command,
      args_json,
      env_json,
      enabled,
      transport,
      url,
      source,
      marketplace_id,
      package_name,
      homepage,
      category,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    server.id,
    server.name,
    server.description,
    server.command,
    JSON.stringify(server.args),
    server.envJson,
    server.enabled ? 1 : 0,
    server.transport,
    server.url ?? null,
    server.source,
    server.marketplaceId ?? null,
    server.packageName ?? null,
    server.homepage ?? null,
    server.category ?? null,
    server.createdAt,
    server.updatedAt
  );

  return server;
}

export function updateMcpServer(db: SqlDatabase, existing: McpServerRecord, input: McpServerUpdateRequest, timestamp: string): void {
  const next = {
    name: input.name?.trim() ?? existing.name,
    description: input.description?.trim() ?? existing.description,
    command: input.command?.trim() ?? existing.command,
    args: input.args ? normalizeArgs(input.args) : existing.args,
    envJson: input.envJson !== undefined ? normalizeEnvJson(input.envJson) : existing.envJson,
    enabled: input.enabled ?? existing.enabled,
    transport: input.transport ?? existing.transport,
    url: input.url?.trim() ?? existing.url ?? null
  };
  if (!next.name || !next.command) throw new Error("MCP server name and command are required.");

  db.prepare(
    `UPDATE mcp_servers
      SET name = ?,
        description = ?,
        command = ?,
        args_json = ?,
        env_json = ?,
        enabled = ?,
        transport = ?,
        url = ?,
        updated_at = ?
      WHERE id = ?`
  ).run(next.name, next.description, next.command, JSON.stringify(next.args), next.envJson, next.enabled ? 1 : 0, next.transport, next.url, timestamp, input.id);
}

export function deleteMcpServer(db: SqlDatabase, id: string): void {
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
}

function mapMcpServer(row: McpServerRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    command: row.command,
    args: parseArgs(row.args_json),
    envJson: normalizeEnvJson(row.env_json),
    enabled: row.enabled === 1,
    transport: row.transport === "http" ? "http" : "stdio",
    url: row.url ?? undefined,
    source: row.source === "marketplace" ? "marketplace" : "manual",
    marketplaceId: row.marketplace_id ?? undefined,
    packageName: row.package_name ?? undefined,
    homepage: row.homepage ?? undefined,
    category: row.category ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeArgs(args: string[] | undefined): string[] {
  return (args ?? []).map((arg) => arg.trim()).filter(Boolean).slice(0, 40);
}

function parseArgs(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeEnvJson(value: string | undefined): string {
  if (!value?.trim()) return "{}";
  try {
    JSON.parse(value);
    return value.trim();
  } catch {
    throw new Error("MCP environment must be valid JSON.");
  }
}
