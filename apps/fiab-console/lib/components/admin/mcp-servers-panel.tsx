'use client';

/**
 * MCPServersPanel — admin tenant-wide "External MCP Tools" configuration.
 *
 * Mounted in the Copilot & Agents section of /admin/tenant-settings.
 * Lets a tenant admin manage external MCP server connections:
 *   • List all registered servers
 *   • Add a new server (name + endpoint + auth)
 *   • Test connection (real fetch to tools/list)
 *   • Enable/disable
 *   • Edit / delete
 *
 * Fluent v9 form-based UI, no JSON.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Dialog, DialogTrigger, DialogContent, DialogBody, DialogTitle,
  Dropdown, Option, Field, Input, Checkbox, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body1, Text, makeStyles, tokens, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { Add20Regular, Edit20Regular, Delete20Regular, ArrowClockwise20Regular, Checkmark20Regular, Sparkle20Regular, Search20Regular, PlugDisconnected24Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { McpCatalogBrowser } from '@/lib/components/admin/mcp-catalog-wizard';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';

interface BuiltinStatus {
  configured: boolean;
  endpoint?: string;
  healthEndpoint?: string;
  name?: string;
  description?: string;
  gate?: { message: string; envVar: string; deployModule: string; deploymentDoc: string };
}

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  testStatus: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXXS },
  tableWrap: { overflowX: 'auto' },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  inlineError: {
    display: 'block',
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorPaletteRedForeground1,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalS,
  },
  filter: { minWidth: '220px', marginLeft: 'auto' },
  count: { color: tokens.colorNeutralForeground3 },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  emptyIcon: { fontSize: '32px', color: tokens.colorNeutralForeground4 },
  nameCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  gateDetail: { display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  errLine: { marginTop: tokens.spacingVerticalXS, color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  endpointNote: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  toolList: { marginTop: tokens.spacingVerticalS, fontSize: tokens.fontSizeBase200 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  formActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalS,
  },
  dialogForm: { marginTop: tokens.spacingVerticalL },
  endpointCell: {
    display: 'block',
    maxWidth: '320px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

function McpServerForm({
  server,
  onSave,
  onCancel,
  isSaving,
}: {
  server?: McpServerConfigDoc | McpServerConfig;
  onSave: (config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const s = useStyles();
  const [form, setForm] = useState<McpServerConfig>(server ? {
    name: (server as any).name || '',
    endpoint: (server as any).endpoint || '',
    authMethod: (server as any).authMethod || 'header',
    authValue: (server as any).authValue || '',
    description: (server as any).description || '',
    enabled: (server as any).enabled !== false,
  } : {
    name: '',
    endpoint: '',
    authMethod: 'header',
    authValue: '',
    description: '',
    enabled: true,
  });
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ toolCount: number; tools?: Array<{ name: string; description?: string }> } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const testConnection = useCallback(async () => {
    setTesting(true); setTestError(null); setTestResult(null);
    try {
      const r = await fetch('/api/admin/mcp-servers/test-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: form }),
      });
      const j = await r.json();
      if (!j.ok) { setTestError(j.error || 'Test failed'); return; }
      setTestResult({ toolCount: j.toolCount, tools: j.tools });
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally { setTesting(false); }
  }, [form]);

  const handleSave = async () => {
    setSaveError(null);
    try {
      await onSave(form);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  };

  return (
    <div className={s.form}>
      <div className={s.formGrid}>
        <Field label="Name" hint="Display name for this MCP server (e.g., 'Acme Tools').">
          <Input
            value={form.name}
            onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))}
            placeholder="My MCP Server"
          />
        </Field>
        <Field label="Endpoint" hint="HTTPS URL of the MCP server.">
          <Input
            value={form.endpoint}
            onChange={(_, d) => setForm((f) => ({ ...f, endpoint: d.value }))}
            placeholder="https://api.example.com/mcp"
          />
        </Field>
      </div>

      <div className={s.formGrid}>
        <Field label="Auth method" hint="How to authenticate with the MCP server.">
          <Dropdown
            value={form.authMethod || 'header'}
            selectedOptions={[form.authMethod || 'header']}
            onOptionSelect={(_, d) => setForm((f) => ({ ...f, authMethod: d.optionValue as any }))}
          >
            <Option value="header">Authorization header</Option>
            <Option value="key-vault">Key Vault secret</Option>
          </Dropdown>
        </Field>
        <Field
          label={form.authMethod === 'key-vault' ? 'Key Vault secret name' : 'Auth header value'}
          hint={form.authMethod === 'key-vault'
            ? 'Name of the secret in LOOM_KEY_VAULT_URL.'
            : 'Bearer token or raw header value.'
          }
        >
          <Input
            value={form.authValue || ''}
            onChange={(_, d) => setForm((f) => ({ ...f, authValue: d.value }))}
            type={form.authMethod === 'key-vault' ? 'text' : 'password'}
            placeholder={form.authMethod === 'key-vault' ? 'secret-name' : 'Bearer ...'}
          />
        </Field>
      </div>

      <Field label="Description (optional)" hint="Usage notes or endpoint details.">
        <Input
          value={form.description || ''}
          onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))}
          placeholder="Customer-specific API toolkit..."
        />
      </Field>

      <Checkbox
        checked={form.enabled}
        onChange={(_, d) => setForm((f) => ({ ...f, enabled: d.checked === true }))}
        label="Enabled"
      />

      {testError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Test failed</MessageBarTitle>{testError}</MessageBarBody>
        </MessageBar>
      )}
      {testResult && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Connection successful</MessageBarTitle>
            Found {testResult.toolCount} tool{testResult.toolCount === 1 ? '' : 's'}
            {testResult.tools && testResult.tools.length > 0 && (
              <div className={s.toolList}>
                {testResult.tools.map((t) => <div key={t.name}>{t.name}</div>)}
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.formActions}>
        <Button
          onClick={() => void testConnection()}
          disabled={!form.endpoint || testing || isSaving}
          icon={<ArrowClockwise20Regular />}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <div className={s.spacer} />
        <Button appearance="secondary" onClick={onCancel} disabled={isSaving}>Cancel</Button>
        <Button appearance="primary" onClick={() => void handleSave()} disabled={!form.name || !form.endpoint || isSaving}>
          {isSaving ? 'Saving...' : 'Save Server'}
        </Button>
      </div>
    </div>
  );
}

/**
 * BuiltinMcpCard — surfaces the Loom built-in MCP tool server (the Azure
 * Functions app in azure-functions/mcp-server/). One-click register when
 * LOOM_BUILTIN_MCP_URL is wired in; honest gate (env var + bicep module) when
 * it isn't. Read from GET /api/admin/mcp-servers/builtin.
 */
function BuiltinMcpCard({
  servers,
  onRegister,
  busy,
}: {
  servers: McpServerConfigDoc[];
  onRegister: (config: McpServerConfig) => Promise<void>;
  busy: boolean;
}) {
  const s = useStyles();
  const [status, setStatus] = useState<BuiltinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/mcp-servers/builtin')
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setStatus(j.ok ? j : null); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading || !status) return null;

  // Not provisioned → honest gate.
  if (!status.configured) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Loom built-in MCP tools (optional, not provisioned)</MessageBarTitle>
          {status.gate?.message}
          <div className={s.gateDetail}>
            Set <code>{status.gate?.envVar}</code> on the console after deploying{' '}
            <code>{status.gate?.deployModule}</code> (see <code>{status.gate?.deploymentDoc}</code>).
          </div>
        </MessageBarBody>
      </MessageBar>
    );
  }

  const alreadyRegistered = servers.some((s) => s.endpoint === status.endpoint);

  const register = async () => {
    setRegistering(true); setError(null);
    try {
      await onRegister({
        name: status.name || 'Loom built-in tools',
        endpoint: status.endpoint!,
        authMethod: 'key-vault',
        authValue: 'loom-mcp-api-key',
        description: status.description || 'Vetted read-only Loom tools.',
        enabled: true,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setRegistering(false); }
  };

  return (
    <MessageBar intent={alreadyRegistered ? 'success' : 'info'} icon={<Sparkle20Regular />}>
      <MessageBarBody>
        <MessageBarTitle>{status.name || 'Loom built-in tools'}</MessageBarTitle>
        {status.description}{' '}
        <span className={s.endpointNote}>({status.endpoint})</span>
        {error && <div className={s.errLine}>{error}</div>}
      </MessageBarBody>
      {alreadyRegistered ? (
        <Badge appearance="tint" color="success">Registered</Badge>
      ) : (
        <Button
          appearance="primary"
          size="small"
          icon={<Add20Regular />}
          disabled={registering || busy}
          onClick={() => void register()}
        >
          {registering ? 'Registering…' : 'Register built-in tools'}
        </Button>
      )}
    </MessageBar>
  );
}

interface BridgeStatus {
  configured: boolean;
  reachable?: boolean;
  base?: string;
  error?: string;
  servers?: Array<{ id: string; name: string; description: string; launcher: string; package: string; endpoint: string }>;
  gate?: { message: string; envVar: string; deployModule: string; deploymentDoc: string };
}

/**
 * BridgeMcpCard — surfaces the stdio→HTTP/SSE bridge (apps/fiab-mcp-bridge).
 * Each bridged stdio server (npx/uvx) from the bridge catalog is offered for
 * one-click registration as a normal McpServerConfig (endpoint = bridge URL).
 * Honest gate (env var + deploy module) when LOOM_MCP_BRIDGE_URL is unset;
 * honest "unreachable" state when set but the bridge can't be reached.
 * Read from GET /api/admin/mcp-servers/bridge.
 */
function BridgeMcpCard({
  servers,
  onRegister,
  busy,
}: {
  servers: McpServerConfigDoc[];
  onRegister: (config: McpServerConfig) => Promise<void>;
  busy: boolean;
}) {
  const styles = useStyles();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/mcp-servers/bridge')
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setStatus(j.ok ? j : null); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading || !status) return null;

  // Not provisioned → honest gate.
  if (!status.configured) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>MCP stdio→HTTP/SSE bridge (optional, not provisioned)</MessageBarTitle>
          {status.gate?.message}
          <Caption1 className={styles.gateDetail}>
            Set <code>{status.gate?.envVar}</code> on the console after deploying{' '}
            <code>{status.gate?.deployModule}</code> (see <code>{status.gate?.deploymentDoc}</code>).
          </Caption1>
        </MessageBarBody>
      </MessageBar>
    );
  }

  // Configured but unreachable → honest error state.
  if (status.reachable === false) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>MCP bridge configured but unreachable</MessageBarTitle>
          Bridge at <code>{status.base}</code> did not respond: {status.error}. Confirm the
          <code> loom-mcp-bridge</code> Container App is running and reachable on the Loom vnet.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const bridged = status.servers || [];
  if (bridged.length === 0) {
    return (
      <MessageBar intent="info" icon={<Sparkle20Regular />}>
        <MessageBarBody>
          <MessageBarTitle>MCP bridge connected — no servers enabled</MessageBarTitle>
          The stdio→HTTP/SSE bridge is reachable at <code>{status.base}</code> but its catalog
          (<code>loom-mcp-bridge.json</code>) has no enabled servers for this cloud.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <Section title="Bridged stdio MCP servers (npx / uvx)">
      <Caption1 className={styles.meta}>
        These stdio MCP servers run on the Loom MCP bridge (<code>{status.base}</code>) and are
        exposed over HTTP. Register any one as a normal external MCP server with a single click.
      </Caption1>
      {error && <Caption1 className={styles.inlineError}>{error}</Caption1>}
      <div className={styles.cardGrid}>
        {bridged.map((b) => {
          const alreadyRegistered = servers.some((s) => s.endpoint === b.endpoint);
          const register = async () => {
            setRegisteringId(b.id); setError(null);
            try {
              await onRegister({
                name: b.name,
                endpoint: b.endpoint,
                authMethod: 'header',
                description: b.description || `Bridged stdio MCP server (${b.launcher} ${b.package}).`,
                enabled: true,
              });
            } catch (e: any) {
              setError(e?.message || String(e));
            } finally { setRegisteringId(null); }
          };
          return (
            <MessageBar key={b.id} intent={alreadyRegistered ? 'success' : 'info'} icon={<Sparkle20Regular />}>
              <MessageBarBody>
                <MessageBarTitle>{b.name}</MessageBarTitle>
                {b.description}{' '}
                <Caption1 className={styles.meta}>
                  ({b.launcher} {b.package})
                </Caption1>
              </MessageBarBody>
              {alreadyRegistered ? (
                <Badge appearance="tint" color="success">Registered</Badge>
              ) : (
                <Button
                  appearance="primary"
                  size="small"
                  icon={<Add20Regular />}
                  disabled={registeringId === b.id || busy}
                  onClick={() => void register()}
                >
                  {registeringId === b.id ? 'Registering…' : 'Register'}
                </Button>
              )}
            </MessageBar>
          );
        })}
      </div>
    </Section>
  );
}

export function McpServersPanel() {
  const s = useStyles();
  const [servers, setServers] = useState<McpServerConfigDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ column: 'name' | 'endpoint' | 'status'; dir: 'ascending' | 'descending' }>({ column: 'name', dir: 'ascending' });

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch('/api/admin/mcp-servers');
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setServers(Array.isArray(j.servers) ? j.servers : []);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (serverId: string | undefined, config: McpServerConfig) => {
    setSaving(true);
    try {
      const method = serverId ? 'PUT' : 'POST';
      const url = serverId ? `/api/admin/mcp-servers?id=${serverId}` : '/api/admin/mcp-servers';
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServers((prev) => {
        if (serverId) {
          return prev.map((s) => s.serverId === serverId ? j.server : s);
        } else {
          return [...prev, j.server];
        }
      });
      setShowAdd(false);
      setEditingId(null);
    } finally { setSaving(false); }
  }, []);

  const deleteServer = useCallback(async (serverId: string) => {
    if (!confirm(`Delete MCP server? This cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/admin/mcp-servers?id=${serverId}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServers((prev) => prev.filter((s) => s.serverId !== serverId));
    } catch (e: any) {
      alert(`Delete failed: ${e?.message}`);
    }
  }, []);

  // NOTE: all hooks must run unconditionally BEFORE any early return.
  // This useMemo previously sat after the `if (loading) return <Spinner/>`
  // below, so the hook count went 10 -> 11 on the loading->loaded transition
  // and React threw minified error #310 ("Rendered more hooks than during the
  // previous render"). Keep it above every early return.
  const q = filter.trim().toLowerCase();
  const filteredServers = useMemo(
    () =>
      q
        ? servers.filter((srv) =>
            srv.name.toLowerCase().includes(q) ||
            srv.endpoint.toLowerCase().includes(q) ||
            (srv.description || '').toLowerCase().includes(q))
        : servers,
    [servers, q],
  );

  // Sort the filtered list by the active column. Like filteredServers above,
  // this hook MUST stay ABOVE the `if (loading) return` early return so the
  // hook count is stable across the loading->loaded transition (React #310).
  const sortedServers = useMemo(() => {
    const dirMul = sort.dir === 'ascending' ? 1 : -1;
    const keyFor = (srv: McpServerConfigDoc) =>
      sort.column === 'name' ? srv.name
        : sort.column === 'endpoint' ? srv.endpoint
        : srv.enabled ? 'enabled' : 'disabled';
    return [...filteredServers].sort((a, b) =>
      keyFor(a).localeCompare(keyFor(b), undefined, { sensitivity: 'base' }) * dirMul,
    );
  }, [filteredServers, sort]);

  const toggleSort = useCallback((column: 'name' | 'endpoint' | 'status') => {
    setSort((prev) =>
      prev.column === column
        ? { column, dir: prev.dir === 'ascending' ? 'descending' : 'ascending' }
        : { column, dir: 'ascending' },
    );
  }, []);

  if (loading) {
    return (
      <Section title="External MCP Tools">
        <Spinner label="Loading MCP servers..." />
      </Section>
    );
  }

  const editingServer = servers.find((s) => s.serverId === editingId);

  return (
    <Section title="External MCP Tools">
      <Body1 className={s.hint}>
        Register external MCP (Model Context Protocol) servers so Loom Copilot can call their tools.
        Each server's tools are discovered at orchestrate time and registered as Loom tools.
      </Body1>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      <BuiltinMcpCard servers={servers} onRegister={(config) => save(undefined, config)} busy={saving} />

      <BridgeMcpCard servers={servers} onRegister={(config) => save(undefined, config)} busy={saving} />

      <Divider />
      <Text weight="semibold">Browse library</Text>
      <McpCatalogBrowser
        onDeployed={(server) => setServers((prev) => (prev.some((p) => p.serverId === server.serverId) ? prev : [...prev, server]))}
        deployedServers={servers}
        onChanged={() => void load()}
      />

      <Divider />
      <div className={s.sectionHead}>
        <Text weight="semibold">Registered servers</Text>
        {servers.length > 0 && (
          <Caption1 className={s.count}>
            {q ? `${filteredServers.length} of ${servers.length}` : `${servers.length} server${servers.length === 1 ? '' : 's'}`}
          </Caption1>
        )}
        {servers.length > 0 && (
          <Input
            className={s.filter}
            size="small"
            value={filter}
            onChange={(_, d) => setFilter(d.value)}
            contentBefore={<Search20Regular />}
            placeholder="Filter by name, endpoint…"
            aria-label="Filter registered MCP servers"
          />
        )}
      </div>

      {servers.length === 0 ? (
        <div className={s.emptyState}>
          <PlugDisconnected24Regular className={s.emptyIcon} />
          <Text weight="semibold">No MCP servers registered yet</Text>
          <Caption1>Deploy one from the library above, or add an external server manually.</Caption1>
        </div>
      ) : filteredServers.length === 0 ? (
        <div className={s.emptyState}>
          <Search20Regular className={s.emptyIcon} />
          <Text weight="semibold">No servers match “{filter}”</Text>
          <Button appearance="subtle" size="small" onClick={() => setFilter('')}>Clear filter</Button>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Registered MCP servers">
            <TableHeader>
              <TableRow>
                <TableHeaderCell
                  sortable
                  sortDirection={sort.column === 'name' ? sort.dir : undefined}
                  onClick={() => toggleSort('name')}
                >Name</TableHeaderCell>
                <TableHeaderCell
                  sortable
                  sortDirection={sort.column === 'endpoint' ? sort.dir : undefined}
                  onClick={() => toggleSort('endpoint')}
                >Endpoint</TableHeaderCell>
                <TableHeaderCell
                  sortable
                  sortDirection={sort.column === 'status' ? sort.dir : undefined}
                  onClick={() => toggleSort('status')}
                >Status</TableHeaderCell>
                <TableHeaderCell>Tools</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedServers.map((server) => (
                <TableRow key={server.serverId}>
                  <TableCell>
                    <div className={s.nameCell}>
                      <Text weight="semibold">{server.name}</Text>
                      {server.description && <Caption1>{server.description}</Caption1>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Caption1 className={s.endpointCell} title={server.endpoint}>
                      {server.endpoint.replace(/^https:\/\//, '')}
                    </Caption1>
                  </TableCell>
                  <TableCell>
                    {server.enabled ? (
                      <Badge appearance="outline" color="success" size="small">Enabled</Badge>
                    ) : (
                      <Badge appearance="outline" color="warning" size="small">Disabled</Badge>
                    )}
                    {server.lastTestResult && (
                      <div className={s.testStatus}>
                        <Checkmark20Regular style={{ fontSize: 14, color: tokens.colorPaletteGreenForeground1 }} />
                        <Caption1>Tested {new Date(server.lastTestResult.at).toLocaleDateString()}</Caption1>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {server.lastTestResult ? (
                      <Caption1>{server.lastTestResult.toolCount} tools</Caption1>
                    ) : (
                      <Caption1>—</Caption1>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className={s.actions}>
                      <Button
                        icon={<Edit20Regular />}
                        size="small"
                        onClick={() => setEditingId(server.serverId)}
                        disabled={saving}
                      >Edit</Button>
                      <Button
                        icon={<Delete20Regular />}
                        size="small"
                        onClick={() => void deleteServer(server.serverId)}
                        disabled={saving}
                      >Delete</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className={s.bar}>
        <div className={s.spacer} />
        <Button icon={<Add20Regular />} appearance="primary" onClick={() => setShowAdd(true)}>
          Add MCP Server
        </Button>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={showAdd || !!editingId} onOpenChange={(_, state) => { if (!state.open) { setShowAdd(false); setEditingId(null); } }}>
        <DialogTrigger />
        <DialogContent>
          <DialogBody>
            <DialogTitle>{editingId ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
            <div className={s.dialogForm}>
              <McpServerForm
                server={editingServer}
                onSave={(config) => save(editingId ?? undefined, config)}
                onCancel={() => { setShowAdd(false); setEditingId(null); }}
                isSaving={saving}
              />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
