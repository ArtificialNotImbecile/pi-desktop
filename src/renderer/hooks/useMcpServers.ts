import { useEffect, useMemo, useRef, useState } from "react";
import type { McpMarketplaceListRequest, McpMarketplaceServer, McpServerCreateRequest, McpServerRecord, McpServerUpdateRequest } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useMcpServers(options: {
  onError(message: string | null): void;
  onToast(message: string): void;
}) {
  const [marketplace, setMarketplace] = useState<McpMarketplaceServer[]>([]);
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [loadingMarketplace, setLoadingMarketplace] = useState(false);
  const [loadingServers, setLoadingServers] = useState(false);
  const [savingServerId, setSavingServerId] = useState<string | null>(null);
  const marketplaceRequested = useRef(false);

  // Only installed servers (local DB) load at startup. The marketplace hits
  // the MCP registry over the network, so it is fetched lazily the first time
  // the MCP settings page opens instead of on every app launch.
  useEffect(() => {
    void refreshServers();
  }, []);

  function ensureMarketplace() {
    if (marketplaceRequested.current) return;
    marketplaceRequested.current = true;
    void refreshMarketplace();
  }

  const installedMarketplaceIds = useMemo(
    () => new Set(servers.flatMap((server) => server.marketplaceId ? [server.marketplaceId] : [])),
    [servers]
  );

  async function refreshMarketplace(request?: McpMarketplaceListRequest) {
    marketplaceRequested.current = true;
    setLoadingMarketplace(true);
    try {
      setMarketplace(await getBridge().listMcpMarketplace(request));
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load MCP marketplace."));
    } finally {
      setLoadingMarketplace(false);
    }
  }

  async function refreshServers() {
    setLoadingServers(true);
    try {
      setServers(await getBridge().listMcpServers());
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load MCP servers."));
    } finally {
      setLoadingServers(false);
    }
  }

  async function installMarketplaceServer(server: McpMarketplaceServer) {
    setSavingServerId(server.id);
    try {
      const installed = await getBridge().installMcpServer(server);
      setServers((current) => upsertServer(current, installed));
      options.onToast("MCP server installed");
      return installed;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to install MCP server."));
      return null;
    } finally {
      setSavingServerId(null);
    }
  }

  async function createServer(request: McpServerCreateRequest) {
    setSavingServerId("new");
    try {
      const server = await getBridge().createMcpServer(request);
      setServers((current) => upsertServer(current, server));
      options.onToast("MCP server added");
      return server;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to add MCP server."));
      return null;
    } finally {
      setSavingServerId(null);
    }
  }

  async function updateServer(request: McpServerUpdateRequest) {
    setSavingServerId(request.id);
    try {
      const server = await getBridge().updateMcpServer(request);
      setServers((current) => upsertServer(current, server));
      options.onToast("MCP server updated");
      return server;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update MCP server."));
      return null;
    } finally {
      setSavingServerId(null);
    }
  }

  async function deleteServer(id: string) {
    setSavingServerId(id);
    try {
      await getBridge().deleteMcpServer(id);
      setServers((current) => current.filter((server) => server.id !== id));
      options.onToast("MCP server removed");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to remove MCP server."));
    } finally {
      setSavingServerId(null);
    }
  }

  return {
    marketplace,
    servers,
    installedMarketplaceIds,
    loadingMarketplace,
    loadingServers,
    savingServerId,
    refreshMarketplace,
    ensureMarketplace,
    refreshServers,
    installMarketplaceServer,
    createServer,
    updateServer,
    deleteServer
  };
}

function upsertServer(current: McpServerRecord[], server: McpServerRecord): McpServerRecord[] {
  const next = current.some((item) => item.id === server.id)
    ? current.map((item) => item.id === server.id ? server : item)
    : [server, ...current];
  return next.sort((a, b) => a.name.localeCompare(b.name));
}
