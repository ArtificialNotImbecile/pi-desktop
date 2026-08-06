import type { McpMarketplaceListRequest, McpMarketplaceServer } from "../../shared/ipc.js";

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

const curatedMarketplace: McpMarketplaceServer[] = [
  {
    id: "jasmine:context7",
    name: "Context7",
    description: "Up-to-date, version-specific documentation and code examples for LLMs and AI code editors.",
    author: "Upstash",
    category: "documentation",
    tags: ["documentation", "code-examples", "library-docs", "api-reference"],
    verified: true,
    featured: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    envJson: "{}",
    packageName: "@upstash/context7-mcp",
    homepage: "https://github.com/upstash/context7"
  },
  {
    id: "jasmine:fetch",
    name: "Fetch",
    description: "Fetch web content and convert pages into model-friendly text or markdown.",
    author: "modelcontextprotocol",
    category: "web-scraping",
    tags: ["web-fetching", "html-to-markdown", "content-extraction", "automation"],
    verified: true,
    featured: true,
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    envJson: "{}",
    packageName: "mcp-server-fetch",
    homepage: "https://github.com/modelcontextprotocol/servers"
  },
  {
    id: "jasmine:firecrawl",
    name: "Firecrawl MCP Server",
    description: "Crawl, scrape, and search web pages through Firecrawl when a Firecrawl API key is configured.",
    author: "Firecrawl",
    category: "web-scraping",
    tags: ["web-scraping", "crawl", "search", "markdown"],
    verified: true,
    featured: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "firecrawl-mcp"],
    envJson: JSON.stringify({ FIRECRAWL_API_KEY: "" }, null, 2),
    packageName: "firecrawl-mcp",
    homepage: "https://github.com/mendableai/firecrawl-mcp-server"
  },
  {
    id: "jasmine:filesystem",
    name: "Filesystem",
    description: "Expose selected local folders to MCP-aware tools with explicit filesystem boundaries.",
    author: "modelcontextprotocol",
    category: "files",
    tags: ["files", "filesystem", "local-data"],
    verified: true,
    featured: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"],
    envJson: "{}",
    packageName: "@modelcontextprotocol/server-filesystem",
    homepage: "https://github.com/modelcontextprotocol/servers"
  }
];

export async function listMcpMarketplace(request: McpMarketplaceListRequest = {}): Promise<McpMarketplaceServer[]> {
  const query = request.query?.trim() ?? "";
  const registryItems = await fetchRegistryItems(query).catch(() => []);
  return filterMarketplace(mergeMarketplace([...curatedMarketplace, ...registryItems]), request);
}

async function fetchRegistryItems(query: string): Promise<McpMarketplaceServer[]> {
  if (process.env.JASMINE_E2E_MOCK_AI === "1") return [];
  const url = new URL(REGISTRY_URL);
  url.searchParams.set("limit", "24");
  if (query) url.searchParams.set("search", query);
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`MCP registry failed: ${response.status}`);
  const payload = await response.json() as { servers?: unknown[] };
  return (payload.servers ?? []).map(registryItemToMarketplace).filter((item): item is McpMarketplaceServer => Boolean(item));
}

function registryItemToMarketplace(item: unknown): McpMarketplaceServer | null {
  if (!item || typeof item !== "object") return null;
  const value = item as { server?: Record<string, unknown> };
  const server = value.server;
  if (!server) return null;
  const name = stringValue(server.title) || stringValue(server.name);
  const id = stringValue(server.name) || name;
  const description = stringValue(server.description);
  const repository = server.repository && typeof server.repository === "object" ? server.repository as Record<string, unknown> : null;
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npmPackage = packages.find((pkg) => pkg && typeof pkg === "object" && (pkg as Record<string, unknown>).registry_name === "npm") as Record<string, unknown> | undefined;
  const packageName = stringValue(npmPackage?.name);
  if (!id || !name || !description || !packageName) return null;
  const tags = tagsFromMeta(server);
  return {
    id: `registry:${id}`,
    name,
    description,
    author: stringValue(repository?.source) || "MCP Registry",
    category: tags[0] ?? "community",
    tags,
    verified: true,
    featured: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", packageName],
    envJson: "{}",
    packageName,
    homepage: stringValue((repository as Record<string, unknown> | null)?.url)
  };
}

function tagsFromMeta(server: Record<string, unknown>): string[] {
  const meta = server._meta && typeof server._meta === "object" ? server._meta as Record<string, unknown> : {};
  const publisher = meta["io.modelcontextprotocol.registry/publisher-provided"];
  const tags = publisher && typeof publisher === "object" ? (publisher as Record<string, unknown>).tags : null;
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6)
    : ["community"];
}

function mergeMarketplace(items: McpMarketplaceServer[]): McpMarketplaceServer[] {
  const seen = new Set<string>();
  const merged: McpMarketplaceServer[] = [];
  for (const item of items) {
    const key = item.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
}

function filterMarketplace(items: McpMarketplaceServer[], request: McpMarketplaceListRequest): McpMarketplaceServer[] {
  const query = request.query?.trim().toLowerCase() ?? "";
  const category = request.category?.trim().toLowerCase() ?? "";
  return items.filter((item) => {
    const categoryMatch = !category || category === "all" || item.category.toLowerCase() === category;
    const queryMatch = !query || [item.name, item.description, item.author, item.category, ...item.tags].some((value) => value.toLowerCase().includes(query));
    return categoryMatch && queryMatch;
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
