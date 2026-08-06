import { useEffect, useMemo, useState } from "react";
import type {
  RemoteConnectionCreateRequest,
  RemoteConnectionRecord,
  RemoteConnectionUpdateRequest
} from "../../shared/ipc";
import { getBridge } from "../desktopApi";

export function useRemoteConnections(options: {
  onError(error: string | null): void;
  onToast(message: string): void;
}) {
  const [connections, setConnections] = useState<RemoteConnectionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const activeConnection = useMemo(() => connections.find((connection) => connection.active) ?? null, [connections]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setConnections(await getBridge().listRemoteConnections());
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function importFromConfig() {
    setSavingId("import");
    try {
      const result = await getBridge().importRemoteConnections();
      setConnections(await getBridge().listRemoteConnections());
      options.onToast(result.imported.length > 0 ? `Imported ${result.imported.length} remote connection${result.imported.length === 1 ? "" : "s"}` : "No SSH hosts found");
      return result;
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSavingId(null);
    }
  }

  async function createConnection(request: RemoteConnectionCreateRequest) {
    setSavingId("new");
    try {
      const connection = await getBridge().createRemoteConnection(request);
      setConnections(await getBridge().listRemoteConnections());
      options.onToast("Remote connection saved");
      return connection;
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSavingId(null);
    }
  }

  async function updateConnection(request: RemoteConnectionUpdateRequest) {
    setSavingId(request.id);
    try {
      const connection = await getBridge().updateRemoteConnection(request);
      setConnections(await getBridge().listRemoteConnections());
      return connection;
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSavingId(null);
    }
  }

  async function deleteConnection(id: string) {
    setSavingId(id);
    try {
      await getBridge().deleteRemoteConnection(id);
      setConnections((current) => current.filter((connection) => connection.id !== id));
      options.onToast("Remote connection removed");
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingId(null);
    }
  }

  async function testConnection(id: string) {
    setSavingId(id);
    try {
      const result = await getBridge().testRemoteConnection(id);
      setConnections(await getBridge().listRemoteConnections());
      options.onToast(result.ok ? `Connected to ${result.remotePath}` : "Remote connection failed");
      return result;
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSavingId(null);
    }
  }

  return {
    connections,
    activeConnection,
    loading,
    savingId,
    refresh,
    importFromConfig,
    createConnection,
    updateConnection,
    deleteConnection,
    testConnection
  };
}
