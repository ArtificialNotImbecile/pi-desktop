import { useEffect, useMemo, useState } from "react";
import type { McpMarketplaceServer, McpServerCreateRequest, McpServerRecord } from "../../../shared/ipc";
import { CheckIcon, PlugIcon, PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from "../icons/Icons";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n } from "../../i18n";
import { Button, Dialog, EmptyState, IconButton, Select, Switch, Tabs, TextArea, TextInput } from "../ui";
import { SettingsPage, SettingsToolbar, StatePill } from "./SettingsLayout";

type McpTab = "marketplace" | "installed";

export function McpSettingsPage(props: {
  marketplace: McpMarketplaceServer[];
  servers: McpServerRecord[];
  installedMarketplaceIds: Set<string>;
  loadingMarketplace: boolean;
  loadingServers: boolean;
  savingServerId: string | null;
  onClose(): void;
  onMarketplaceOpened(): void;
  onRefreshMarketplace(request?: { query?: string; category?: string }): void;
  onRefreshServers(): void;
  onInstall(server: McpMarketplaceServer): void;
  onCreateServer(request: McpServerCreateRequest): Promise<McpServerRecord | null>;
  onUpdateServer(request: { id: string; enabled?: boolean }): void;
  onDeleteServer(id: string): void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<McpTab>("marketplace");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const categories = useMemo(() => ["all", ...Array.from(new Set(props.marketplace.map((server) => server.category))).sort()], [props.marketplace]);
  const visibleMarketplace = useMemo(() => filterMarketplace(props.marketplace, query, category), [props.marketplace, query, category]);

  // Marketplace data is fetched lazily on first open, not at app startup.
  const { onMarketplaceOpened } = props;
  useEffect(() => {
    onMarketplaceOpened();
  }, [onMarketplaceOpened]);

  function refreshMarketplace() {
    props.onRefreshMarketplace({ query, category });
  }

  return (
    <>
      <SettingsHeader title={t("settings.mcp.title")} />
      <SettingsPage className="mcp-settings-shell">
        <Tabs
          ariaLabel={t("settings.mcp.title")}
          className="mcp-tabbar"
          value={tab}
          onChange={(value) => setTab(value)}
          tabs={[
            { id: "marketplace", label: t("settings.mcp.marketplace") },
            { id: "installed", label: `${t("settings.mcp.installed")} ${props.servers.length}` }
          ]}
        />

        <SettingsToolbar className={`mcp-toolbar ${tab}`}>
          {tab === "marketplace" && (
            <>
              <TextInput
                aria-label={t("settings.mcp.search")}
                value={query}
                placeholder={t("settings.mcp.search")}
                leftIcon={<SearchIcon />}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") refreshMarketplace();
                }}
              />
              <Select aria-label={t("settings.mcp.allCategories")} value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => (
                  <option key={item} value={item}>{item === "all" ? t("settings.mcp.allCategories") : item}</option>
                ))}
              </Select>
              <IconButton label={t("settings.mcp.refresh")} size="sm" onClick={refreshMarketplace} disabled={props.loadingMarketplace}>
                <RefreshIcon />
              </IconButton>
              <Button size="sm" onClick={() => setEditorOpen(true)} leftIcon={<PlusIcon />}>
                {t("settings.mcp.addServer")}
              </Button>
            </>
          )}
          {tab === "installed" && (
            <>
              <span />
              <Button size="sm" onClick={() => setEditorOpen(true)} leftIcon={<PlusIcon />}>
                {t("settings.mcp.addServer")}
              </Button>
              <IconButton label={t("settings.mcp.refresh")} size="sm" onClick={props.onRefreshServers} disabled={props.loadingServers}>
                <RefreshIcon />
              </IconButton>
            </>
          )}
        </SettingsToolbar>

        {tab === "marketplace" ? (
          <div className="mcp-card-list" aria-label={t("settings.mcp.marketplace")}>
            {visibleMarketplace.length === 0 ? (
              <EmptyState icon={<PlugIcon />} title={t("settings.mcp.emptyMarketplace")} />
            ) : visibleMarketplace.map((server) => (
              <MarketplaceCard
                key={server.id}
                server={server}
                installed={props.installedMarketplaceIds.has(server.id)}
                saving={props.savingServerId === server.id}
                onInstall={() => props.onInstall(server)}
              />
            ))}
          </div>
        ) : (
          <div className="mcp-card-list" aria-label={t("settings.mcp.installed")}>
            {props.servers.length === 0 ? (
              <EmptyState icon={<PlugIcon />} title={t("settings.mcp.emptyInstalled")} />
            ) : props.servers.map((server) => (
              <InstalledServerRow
                key={server.id}
                server={server}
                saving={props.savingServerId === server.id}
                onToggle={() => props.onUpdateServer({ id: server.id, enabled: !server.enabled })}
                onDelete={() => props.onDeleteServer(server.id)}
              />
            ))}
          </div>
        )}
      </SettingsPage>

      {editorOpen && (
        <McpServerEditor
          saving={props.savingServerId === "new"}
          onCancel={() => setEditorOpen(false)}
          onSave={async (request) => {
            const server = await props.onCreateServer(request);
            if (server) setEditorOpen(false);
          }}
        />
      )}
    </>
  );
}

function MarketplaceCard(props: {
  server: McpMarketplaceServer;
  installed: boolean;
  saving: boolean;
  onInstall(): void;
}) {
  const { t } = useI18n();
  return (
    <article className="mcp-card">
      <span className="mcp-card-icon"><PlugIcon /></span>
      <div className="mcp-card-main">
        <header>
          <strong>{props.server.name}</strong>
          <span className="mcp-badges">
            {props.server.verified && <b><CheckIcon />{t("settings.mcp.verified")}</b>}
            {props.server.featured && <b>{t("settings.mcp.featured")}</b>}
          </span>
        </header>
        <small>{t("settings.mcp.by", { author: props.server.author })} · {props.server.category}</small>
        <p>{props.server.description}</p>
        <div className="mcp-tags">
          {props.server.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      </div>
      <Button variant={props.installed ? "primary" : "default"} size="sm" disabled={props.installed || props.saving} loading={props.saving} onClick={props.onInstall}>
        {props.installed ? t("settings.mcp.installedButton") : t("settings.mcp.install")}
      </Button>
    </article>
  );
}

function InstalledServerRow(props: {
  server: McpServerRecord;
  saving: boolean;
  onToggle(): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const command = [props.server.command, ...props.server.args].join(" ");
  return (
    <article className={`mcp-card installed ${props.server.enabled ? "selected" : ""}`}>
      <span className="mcp-card-icon"><PlugIcon /></span>
      <div className="mcp-card-main">
        <header>
          <strong>{props.server.name}</strong>
          <StatePill>{props.server.source === "marketplace" ? t("settings.mcp.marketplace") : t("settings.mcp.manual")}</StatePill>
        </header>
        <p>{props.server.description || command}</p>
        <dl className="mcp-installed-meta">
          <div><dt>{t("settings.mcp.command")}</dt><dd>{command}</dd></div>
          <div><dt>{t("settings.mcp.environment")}</dt><dd>{maskEnvJson(props.server.envJson)}</dd></div>
        </dl>
      </div>
      <div className="mcp-row-actions">
        <Switch
          checked={props.server.enabled}
          disabled={props.saving}
          onLabel={t("app.on")}
          offLabel={t("app.off")}
          aria-label={`${props.server.enabled ? t("settings.mcp.disable") : t("settings.mcp.enable")} ${props.server.name}`}
          onChange={props.onToggle}
        />
        <IconButton label={t("settings.mcp.remove")} variant="danger" size="sm" onClick={props.onDelete} disabled={props.saving}>
          <TrashIcon />
        </IconButton>
      </div>
    </article>
  );
}

function McpServerEditor(props: {
  saving: boolean;
  onCancel(): void;
  onSave(request: McpServerCreateRequest): Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ name: "", description: "", command: "", args: "", envJson: "{}" });
  const [error, setError] = useState("");

  async function save() {
    if (!draft.name.trim() || !draft.command.trim()) {
      setError(t("settings.mcp.required"));
      return;
    }
    try {
      JSON.parse(draft.envJson || "{}");
    } catch {
      setError(t("settings.mcp.envInvalid"));
      return;
    }
    await props.onSave({
      name: draft.name,
      description: draft.description,
      command: draft.command,
      args: splitArgs(draft.args),
      envJson: draft.envJson || "{}",
      enabled: true,
      source: "manual",
      transport: "stdio"
    });
  }

  return (
    <Dialog
      open
      title={t("settings.mcp.manualTitle")}
      className="mcp-editor"
      closeLabel={t("app.close")}
      onClose={props.onCancel}
      actions={
        <>
          <span className={`save-state ${error ? "failed" : ""}`}>{error}</span>
          <Button variant="ghost" onClick={props.onCancel}>{t("app.cancel")}</Button>
          <Button variant="primary" disabled={props.saving} loading={props.saving} onClick={() => void save()}>
            {props.saving ? t("app.savingDots") : t("settings.mcp.save")}
          </Button>
        </>
      }
    >
      <div className="ui-form-grid" aria-label={t("settings.mcp.manualTitle")}>
        <label>
          <span>{t("settings.mcp.name")}</span>
          <TextInput aria-label={t("settings.mcp.name")} value={draft.name} onChange={(event) => { setError(""); setDraft((current) => ({ ...current, name: event.target.value })); }} />
        </label>
        <label>
          <span>{t("settings.mcp.descriptionField")}</span>
          <TextInput aria-label={t("settings.mcp.descriptionField")} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
        </label>
        <label>
          <span>{t("settings.mcp.command")}</span>
          <TextInput aria-label={t("settings.mcp.command")} value={draft.command} onChange={(event) => { setError(""); setDraft((current) => ({ ...current, command: event.target.value })); }} />
        </label>
        <label>
          <span>{t("settings.mcp.args")}</span>
          <TextInput aria-label={t("settings.mcp.args")} value={draft.args} placeholder="-y @scope/package" onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} />
        </label>
        <label>
          <span>{t("settings.mcp.envJson")}</span>
          <TextArea aria-label={t("settings.mcp.envJson")} value={draft.envJson} onChange={(event) => { setError(""); setDraft((current) => ({ ...current, envJson: event.target.value })); }} />
        </label>
      </div>
    </Dialog>
  );
}

function filterMarketplace(items: McpMarketplaceServer[], query: string, category: string): McpMarketplaceServer[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter((item) => {
    const categoryMatches = category === "all" || item.category === category;
    const queryMatches = !normalizedQuery || [item.name, item.description, item.author, item.category, ...item.tags].some((value) => value.toLowerCase().includes(normalizedQuery));
    return categoryMatches && queryMatches;
  });
}

function splitArgs(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

function maskEnvJson(value: string): string {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return "{}";
    return keys.map((key) => `${key}=****`).join(", ");
  } catch {
    return "****";
  }
}
