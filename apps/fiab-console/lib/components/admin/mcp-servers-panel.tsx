'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Button, Dialog, DialogTrigger, DialogContent, DialogBody, DialogTitle, DialogActions,
  Dropdown, Option, Field, Input, Checkbox, Switch, Spinner, Badge, Link,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body1, Text, makeStyles, tokens, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { Add20Regular, Edit20Regular, Delete20Regular, ArrowClockwise20Regular, Checkmark20Regular, Sparkle20Regular, Search20Regular, PlugDisconnected24Regular, DataPie24Regular, Open16Regular, BookGlobe24Regular, Cloud24Regular, BranchFork24Regular, PeopleTeam24Regular, Shield24Regular, Database24Regular, PlugConnected24Regular, Settings20Regular } from '@fluentui/react-icons';
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
  // ── Power BI (remote) opt-in card ──────────────────────────────────────────
  pbiCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  pbiHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  pbiIcon: { color: tokens.colorBrandForeground1, display: 'flex', alignItems: 'center', flexShrink: 0 },
  pbiTitleCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  pbiTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  pbiDesc: { color: tokens.colorNeutralForeground2 },
  kvRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'baseline', flexWrap: 'wrap' },
  kvKey: { color: tokens.colorNeutralForeground3, minWidth: '96px', flexShrink: 0 },
  kvVal: { color: tokens.colorNeutralForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word', fontFamily: tokens.fontFamilyMonospace },
  scopeWrap: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  pbiFoot: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  docsLink: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, fontSize: tokens.fontSizeBase200 },
  // ── Microsoft remote MCP family — card grid (reuses the pbiCard pattern) ─────
  msGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  // Same Web-3.0 card as pbiCard (shadow4 → shadow16 on hover, Loom tokens) but
  // height:100% so mixed configured/gated tiles line up in the grid, and no top
  // margin (the grid gap handles spacing).
  msCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    height: '100%',
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  msBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flexGrow: 1 },
  msSectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalM,
  },
  cfgForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, marginTop: tokens.spacingVerticalM },
  cfgSwitchRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
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
      const r = await clientFetch('/api/admin/mcp-servers/test-connection', {
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
    clientFetch('/api/admin/mcp-servers/builtin')
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
    clientFetch('/api/admin/mcp-servers/bridge')
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

/**
 * Status shape returned by GET /api/admin/mcp-servers/powerbi. Unconfigured =>
 * { configured:false, gate }; configured => the full opt-in descriptor + the
 * registered-row state + per-user OBO token readiness. Mirrors the route exactly.
 */
interface PowerBiGate {
  message: string;
  envVar: string;
  endpointEnv: string;
  tenantSetting: string;
  delegatedScopes: string[];
  resource: string;
  entraAppRegDoc: string;
  tenantSettingDoc: string;
}
interface PowerBiStatus {
  ok: boolean;
  configured: boolean;
  gate?: PowerBiGate;
  id?: string;
  name?: string;
  category?: string;
  endpoint?: string;
  transport?: string;
  auth?: string;
  resource?: string;
  clientId?: string;
  delegatedScopes?: string[];
  scopeUris?: string[];
  tenantSetting?: string;
  entraAppRegDoc?: string;
  tenantSettingDoc?: string;
  preview?: boolean;
  optIn?: boolean;
  registered?: boolean;
  serverId?: string;
  enabled?: boolean;
  lastTestResult?: { at: string; toolCount: number; error?: string };
  tokenReady?: boolean;
  tokenNote?: string;
}

/**
 * PowerBiRemoteMcpCard — the opt-in "Power BI (remote)" connect affordance.
 *
 * Surfaces the remote Power BI Model Context Protocol server (preview): an
 * already-hosted Microsoft Streamable-HTTP endpoint reached with a per-USER
 * Microsoft Entra OAuth On-Behalf-Of bearer (delegated, under the signed-in
 * user's Power BI RBAC). It is STRICTLY OPT-IN and config-gated — read from GET
 * /api/admin/mcp-servers/powerbi:
 *   • configured:false → honest Fluent MessageBar (intent="warning") naming the
 *     exact env var (LOOM_POWERBI_MCP_CLIENT_ID), the Power BI admin tenant
 *     setting, and links to the Entra app-reg + tenant-setting docs. No raw
 *     error, no empty stub (no-vaporware).
 *   • configured:true → a Web-3.0 card (Loom tokens, elevation, Preview badge)
 *     showing the endpoint, the three delegated scopes, the tenant-setting
 *     requirement, per-user token readiness, plus a real Test connection button
 *     (POST .../test-connection) and a Connect/Register button (POST .../powerbi).
 *
 * no-fabric-dependency: this is the ONLY Power BI / Fabric host the panel can
 * reach and it never appears on a default path — Loom's Azure-native
 * semantic-model + report authoring stays the day-one default.
 */
function PowerBiRemoteMcpCard({
  onChanged,
  busy,
}: {
  onChanged: () => void;
  busy: boolean;
}) {
  const s = useStyles();
  const [status, setStatus] = useState<PowerBiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ toolCount: number; tools?: Array<{ name: string; description?: string }> } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await clientFetch('/api/admin/mcp-servers/powerbi');
      const j = await r.json();
      setStatus(j && j.ok ? j : null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    clientFetch('/api/admin/mcp-servers/powerbi')
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setStatus(j && j.ok ? j : null); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // entra-obo McpServerConfig for the Test connection probe (no secret — the
  // per-user OBO token is resolved server-side from pbi-user-token-store).
  const testConnection = useCallback(async () => {
    if (!status?.configured || !status.endpoint) return;
    setTesting(true); setTestError(null); setTestResult(null);
    try {
      const config: McpServerConfig = {
        name: status.name || 'Power BI (remote)',
        endpoint: status.endpoint,
        authMethod: 'entra-obo',
        oboResource: status.resource,
        oboScopes: status.delegatedScopes,
        enabled: true,
        source: 'remote-builtin',
        catalogId: status.id,
      };
      const r = await clientFetch('/api/admin/mcp-servers/test-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (!j.ok) { setTestError(j.error || 'Test failed'); return; }
      setTestResult({ toolCount: j.toolCount, tools: j.tools });
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally { setTesting(false); }
  }, [status]);

  const connect = useCallback(async () => {
    setConnecting(true); setConnectError(null); setConnectNote(null);
    try {
      const r = await clientFetch('/api/admin/mcp-servers/powerbi', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        setConnectError(j.gate?.message || j.error || `HTTP ${r.status}`);
        return;
      }
      // Surface the server-side connectivity probe honestly (no-vaporware): a
      // 403 (tenant setting still off) or a not-yet-consented token reports here
      // rather than implying a fake "connected".
      const probe = j.probe || {};
      if (probe.reachable) {
        setConnectNote(`Connected — ${probe.toolCount ?? 0} Power BI tool${probe.toolCount === 1 ? '' : 's'} discovered.`);
      } else if (probe.skipped) {
        setConnectNote(probe.reason || 'Registered. Sign in again and consent the Power BI scopes to enable per-user access.');
      } else if (probe.error) {
        setConnectError(`Registered, but the live Power BI MCP probe failed: ${probe.error}`);
      }
      await refresh();
      onChanged();
    } catch (e: any) {
      setConnectError(e?.message || String(e));
    } finally { setConnecting(false); }
  }, [refresh, onChanged]);

  if (loading || !status) return null;

  // Not opted in → honest warning gate (no-fabric-dependency + no-vaporware).
  if (!status.configured) {
    const g = status.gate;
    return (
      <MessageBar intent="warning" icon={<DataPie24Regular />}>
        <MessageBarBody>
          <MessageBarTitle>Power BI (remote) MCP — opt-in, not configured</MessageBarTitle>
          {g?.message}
          <Caption1 className={s.gateDetail}>
            Set <code>{g?.envVar}</code> on the console to an Entra app (client) id whose registration
            requests the delegated Power BI scopes{g?.delegatedScopes?.length ? ` (${g.delegatedScopes.join(', ')})` : ''}
            {g?.resource ? <> on <code>{g.resource}</code></> : null}, and have a Power BI admin enable the tenant
            setting “{g?.tenantSetting}”. Optionally override the endpoint with <code>{g?.endpointEnv}</code>.
            {(g?.entraAppRegDoc || g?.tenantSettingDoc) && (
              <span className={s.scopeWrap}>
                {g?.entraAppRegDoc && (
                  <Link href={g.entraAppRegDoc} target="_blank" rel="noreferrer" className={s.docsLink}>
                    <Open16Regular /> Register an Entra app
                  </Link>
                )}
                {g?.tenantSettingDoc && (
                  <Link href={g.tenantSettingDoc} target="_blank" rel="noreferrer" className={s.docsLink}>
                    <Open16Regular /> Power BI tenant settings
                  </Link>
                )}
              </span>
            )}
          </Caption1>
        </MessageBarBody>
      </MessageBar>
    );
  }

  // Opted in → rich connect card.
  const lastErr = status.registered ? status.lastTestResult?.error : undefined;
  return (
    <div className={s.pbiCard}>
      <div className={s.pbiHead}>
        <span className={s.pbiIcon}><DataPie24Regular /></span>
        <div className={s.pbiTitleCol}>
          <div className={s.pbiTitleRow}>
            <Text weight="semibold">{status.name || 'Power BI (remote)'}</Text>
            {status.preview && <Badge appearance="tint" color="brand" size="small">Preview</Badge>}
            <Badge appearance="outline" color="informative" size="small">Opt-in</Badge>
            {status.registered && <Badge appearance="tint" color="success" size="small">Connected</Badge>}
          </div>
          <Caption1 className={s.meta}>{status.category || 'Power BI / Fabric'}</Caption1>
        </div>
      </div>

      <Body1 className={s.pbiDesc}>
        Schema-aware query of Power BI semantic models plus Copilot-powered DAX generation —
        read-only, under your own Power BI RBAC via Microsoft Entra On-Behalf-Of. Loom’s
        Azure-native semantic-model &amp; report authoring stays the default; this only augments it
        when explicitly connected.
      </Body1>

      <div className={s.kvRow}>
        <Caption1 className={s.kvKey}>Endpoint</Caption1>
        <Caption1 className={s.kvVal}>{status.endpoint}</Caption1>
      </div>
      <div className={s.kvRow}>
        <Caption1 className={s.kvKey}>Transport</Caption1>
        <Caption1 className={s.kvVal}>Streamable HTTP · {status.auth || 'entra-obo'} (per-user)</Caption1>
      </div>
      {status.clientId && (
        <div className={s.kvRow}>
          <Caption1 className={s.kvKey}>Entra client</Caption1>
          <Caption1 className={s.kvVal}>{status.clientId}</Caption1>
        </div>
      )}

      <div>
        <Caption1 className={s.kvKey}>Delegated scopes</Caption1>
        <div className={s.scopeWrap}>
          {(status.delegatedScopes || []).map((sc) => (
            <Badge key={sc} appearance="outline" color="brand" size="small">{sc}</Badge>
          ))}
        </div>
      </div>

      {/* Honest infra requirement — the PBI-admin tenant setting cannot be probed
          from the console, so it is surfaced as copy, not asserted. */}
      <MessageBar intent="info">
        <MessageBarBody>
          A Power BI admin must enable the tenant setting “{status.tenantSetting}” for this endpoint
          to respond; the first call returns a 403 until it is on.
        </MessageBarBody>
      </MessageBar>

      {/* Per-user OBO token readiness (captured at login when scopes were consented). */}
      {!status.tokenReady && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power BI sign-in required</MessageBarTitle>
            {status.tokenNote || 'Sign in again and consent the Power BI scopes to enable per-user access; no Power BI access token is cached for your account yet.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {lastErr && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Last connectivity check failed</MessageBarTitle>
            {lastErr}
          </MessageBarBody>
        </MessageBar>
      )}

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
      {connectError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Connect failed</MessageBarTitle>{connectError}</MessageBarBody>
        </MessageBar>
      )}
      {connectNote && !connectError && (
        <MessageBar intent="success">
          <MessageBarBody>{connectNote}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.pbiFoot}>
        {status.entraAppRegDoc && (
          <Link href={status.entraAppRegDoc} target="_blank" rel="noreferrer" className={s.docsLink}>
            <Open16Regular /> Entra app
          </Link>
        )}
        {status.tenantSettingDoc && (
          <Link href={status.tenantSettingDoc} target="_blank" rel="noreferrer" className={s.docsLink}>
            <Open16Regular /> Tenant setting
          </Link>
        )}
        <div className={s.spacer} />
        <Button
          icon={<ArrowClockwise20Regular />}
          onClick={() => void testConnection()}
          disabled={testing || connecting || busy}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          appearance="primary"
          icon={status.registered ? <Checkmark20Regular /> : <Add20Regular />}
          onClick={() => void connect()}
          disabled={connecting || testing || busy}
        >
          {connecting ? 'Connecting…' : status.registered ? 'Re-register' : 'Connect Power BI'}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft remote MCP family — generalizes the Power BI plumbing to the whole
// curated github.com/microsoft/mcp catalog (lib/mcp/catalog.ts
// REMOTE_BUILTIN_MCP_CATALOG) via GET/POST /api/admin/mcp-servers/ms-remote.
//
// This is NOT a parallel system: every server is the SAME McpServerConfig shape
// (source 'remote-builtin'), reached by the SAME mcp-client OBO/userToken path,
// rendered with the SAME pbiCard Web-3.0 styling. Microsoft Learn (auth 'none')
// is the SOLE default-on entry (no-fabric-dependency); every other server is
// strictly opt-in and inert behind an honest gate naming the exact env var /
// Key Vault secret / delegated scopes / tenant setting (no-vaporware).
// ─────────────────────────────────────────────────────────────────────────────

/** Honest opt-in gate for an unconfigured remote server (matches route gateFor). */
interface MsRemoteGate {
  message: string;
  enableEnv?: string;
  endpointEnv?: string;
  attribution?: string;
  docs?: string;
  scopes?: string[];
  oboResource?: string;
  oboClientEnv?: string;
  secretEnv?: string;
  tenantSetting?: string;
}

/** Live initialize→tools/list probe result (?probe=1 / POST .probe). */
interface MsRemoteProbe {
  reachable?: boolean;
  skipped?: boolean;
  reason?: string;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

/** Per-server status from GET /api/admin/mcp-servers/ms-remote — mirrors statusFor(). */
interface MsRemoteStatus {
  ok?: boolean;
  configured: boolean;
  id: string;
  name: string;
  category: string;
  desc?: string;
  transport?: string;
  auth?: 'none' | 'entra-obo' | 'key-vault';
  endpoint?: string;
  endpointEnv?: string;
  enableEnv?: string;
  defaultOn?: boolean;
  preview?: boolean;
  optIn?: boolean;
  attribution?: string;
  docs?: string;
  tenantSetting?: string;
  // configured:true extras
  scopeUris?: string[];
  oboResource?: string;
  oboClientEnv?: string;
  secretEnv?: string;
  registered?: boolean;
  serverId?: string;
  enabled?: boolean;
  lastTestResult?: { at: string; toolCount: number; error?: string };
  tokenReady?: boolean;
  tokenNote?: string;
  // configured:false
  gate?: MsRemoteGate;
  // Inline-config facets (both states) — drive the typed Configure dialog.
  config?: {
    supportsEndpoint: boolean;
    supportsSecret: boolean;
    secretEnv?: string;
    enabled: boolean;
    endpoint: string;
    secretName?: string;
    source: 'env' | 'admin';
    envForced: boolean;
    missing: string[];
  };
  override?: { enabled?: boolean; endpoint?: string; secretName?: string } | null;
}

/** Category → Fluent icon (web3-ui: every card carries a section icon). */
function iconForMsCategory(category?: string) {
  switch (category) {
    case 'Reference': return <BookGlobe24Regular />;
    case 'Azure': return <Cloud24Regular />;
    case 'Source Control': return <BranchFork24Regular />;
    case 'Productivity': return <PeopleTeam24Regular />;
    case 'Observability': return <Shield24Regular />;
    case 'Database': return <Database24Regular />;
    default: return <PlugConnected24Regular />;
  }
}

/**
 * MsRemoteConfigDialog — the INLINE configuration surface for one remote built-in
 * MCP server. Typed Fluent fields driven by the server's declared shape
 * (loom-no-freeform-config), NOT a JSON box:
 *   • Enabled — a Switch (disabled + explained when the deployment env force-on it).
 *   • Endpoint — an Input, only for servers whose descriptor exposes an endpoint
 *     env (the not-yet-GA Microsoft remote servers).
 *   • Key Vault secret name — an Input, only for the key-vault (GitHub PAT) server.
 * Saves to PUT /api/admin/mcp-servers/ms-remote/config (real Cosmos persistence);
 * on success the parent reloads so the card reflects the new effective state.
 */
function MsRemoteConfigDialog({
  status,
  open,
  onOpenChange,
  onSaved,
}: {
  status: MsRemoteStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const s = useStyles();
  const cfg = status.config;
  const [enabled, setEnabled] = useState<boolean>(status.override?.enabled ?? cfg?.enabled ?? false);
  const [endpoint, setEndpoint] = useState<string>(status.override?.endpoint ?? '');
  const [secretName, setSecretName] = useState<string>(status.override?.secretName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form from the latest persisted override each time it opens.
  useEffect(() => {
    if (open) {
      setEnabled(status.override?.enabled ?? cfg?.enabled ?? false);
      setEndpoint(status.override?.endpoint ?? '');
      setSecretName(status.override?.secretName ?? '');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const envForced = cfg?.envForced === true;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { id: status.id, enabled };
      if (cfg?.supportsEndpoint) payload.endpoint = endpoint.trim();
      if (cfg?.supportsSecret) payload.secretName = secretName.trim();
      const r = await clientFetch('/api/admin/mcp-servers/ms-remote/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [status.id, enabled, endpoint, secretName, cfg, onOpenChange, onSaved]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogContent>
        <DialogBody>
          <DialogTitle>Configure {status.name}</DialogTitle>
          <div className={s.cfgForm}>
            <div className={s.cfgSwitchRow}>
              <Switch
                checked={enabled}
                disabled={envForced || saving}
                onChange={(_, d) => setEnabled(d.checked)}
                label={enabled ? 'Enabled' : 'Disabled'}
              />
              {envForced ? (
                <Caption1 className={s.hint}>
                  Enabled by the deployment (<code>{status.enableEnv}</code>). Set it to{' '}
                  <code>false</code> in the app configuration to disable — it cannot be turned off
                  from here.
                </Caption1>
              ) : (
                <Caption1 className={s.hint}>
                  {status.auth === 'entra-obo'
                    ? 'Enable this opt-in server for your tenant. Sign in again afterward to consent the delegated scopes.'
                    : status.auth === 'key-vault'
                      ? 'Enable this opt-in server. It becomes callable once a Key Vault secret name is set below.'
                      : 'Enable this server for your tenant.'}
                </Caption1>
              )}
            </div>

            {cfg?.supportsEndpoint && (
              <Field
                label="Endpoint"
                hint={
                  <>
                    Streamable-HTTP endpoint (overrides <code>{status.endpointEnv}</code>). Required for
                    servers whose Microsoft-hosted endpoint is not yet GA.
                  </>
                }
              >
                <Input
                  value={endpoint}
                  onChange={(_, d) => setEndpoint(d.value)}
                  placeholder={status.endpoint || 'https://…'}
                  disabled={saving}
                />
              </Field>
            )}

            {cfg?.supportsSecret && (
              <Field
                label="Key Vault secret name"
                hint={
                  <>
                    Name of the Key Vault secret holding the bearer token / GitHub PAT (never the
                    value). Overrides <code>{cfg.secretEnv}</code>. The secret must already exist in
                    the console&apos;s Key Vault.
                  </>
                }
              >
                <Input
                  value={secretName}
                  onChange={(_, d) => setSecretName(d.value)}
                  placeholder={cfg.secretName || 'github-mcp-pat'}
                  disabled={saving}
                />
              </Field>
            )}

            {cfg?.missing && cfg.missing.length > 0 && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Still required to go live</MessageBarTitle>
                  Set the following on the console so this server becomes callable:{' '}
                  {cfg.missing.map((m, i) => (
                    <span key={m}>
                      {i > 0 ? ', ' : ''}
                      <code>{m}</code>
                    </span>
                  ))}
                  .
                </MessageBarBody>
              </MessageBar>
            )}

            {error && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Save failed</MessageBarTitle>
                  {error}
                </MessageBarBody>
              </MessageBar>
            )}
          </div>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save configuration'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MsRemoteMcpCard — one curated Microsoft remote MCP server, generalized from
 * PowerBiRemoteMcpCard. Always renders a Web-3.0 Loom card (icon + title +
 * Preview/Core/Opt-in/Connected badges, shadow4 → shadow16 on hover); the body
 * is either:
 *   • configured:false → an honest Fluent MessageBar gate naming the exact env
 *     toggle / Key Vault secret / delegated scopes / tenant setting + a docs link
 *     (no-vaporware, no fake "connected").
 *   • configured:true  → endpoint / transport / auth, the delegated scopes (OBO)
 *     or Key Vault secret name (GitHub) or "no authentication" note (Learn), the
 *     per-user OBO token-readiness state, and real Test connection (GET ?probe=1)
 *     + Connect/Register (POST) actions. Microsoft Learn auto-probes on mount to
 *     show a live tool count and skips Connect (it is on by default).
 */
function MsRemoteMcpCard({
  initial,
  onChanged,
  busy,
}: {
  initial: MsRemoteStatus;
  onChanged: () => void;
  busy: boolean;
}) {
  const s = useStyles();
  const [status, setStatus] = useState<MsRemoteStatus>(initial);
  const [probe, setProbe] = useState<MsRemoteProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => { setStatus(initial); }, [initial]);

  const refresh = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/admin/mcp-servers/ms-remote?id=${encodeURIComponent(initial.id)}`);
      const j = await r.json();
      if (j && j.id) setStatus(j as MsRemoteStatus);
    } catch { /* keep prior status — honest, no fake refresh */ }
  }, [initial.id]);

  // Real Streamable-HTTP handshake under the correct credential (resolved
  // server-side: none for Learn, per-user OBO bearer for entra-obo, the Key
  // Vault PAT for GitHub). No mock.
  const runProbe = useCallback(async () => {
    setTesting(true); setTestError(null); setProbe(null);
    try {
      const r = await clientFetch(`/api/admin/mcp-servers/ms-remote?id=${encodeURIComponent(initial.id)}&probe=1`);
      const j = await r.json();
      if (!j || j.ok === false) { setTestError(j?.error || `HTTP ${r.status}`); return; }
      const p: MsRemoteProbe = j.probe || {};
      setProbe(p);
      if (p.reachable === false && p.error) setTestError(p.error);
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally { setTesting(false); }
  }, [initial.id]);

  // Microsoft Learn (default-on, no auth) — surface a live tool count on mount.
  useEffect(() => {
    if (initial.configured && initial.auth === 'none') void runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true); setConnectError(null); setConnectNote(null);
    try {
      const r = await clientFetch('/api/admin/mcp-servers/ms-remote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: initial.id }),
      });
      const j = await r.json();
      if (!j.ok) { setConnectError(j.gate?.message || j.error || `HTTP ${r.status}`); return; }
      // Surface the server-side probe honestly: a 403 / not-yet-consented token
      // reports here rather than implying a fake "connected".
      const p: MsRemoteProbe = j.probe || {};
      if (p.reachable) {
        setConnectNote(`Connected — ${p.toolCount ?? 0} tool${p.toolCount === 1 ? '' : 's'} discovered.`);
      } else if (p.skipped) {
        setConnectNote(p.reason || 'Registered. Sign in again and consent the delegated scopes to enable per-user access.');
      } else if (p.error) {
        setConnectError(`Registered, but the live MCP probe failed: ${p.error}`);
      }
      await refresh();
      onChanged();
    } catch (e: any) {
      setConnectError(e?.message || String(e));
    } finally { setConnecting(false); }
  }, [initial.id, refresh, onChanged]);

  const g = status.gate;
  const isLearn = status.auth === 'none';
  const probeReachable = probe?.reachable === true;

  return (
    <div className={s.msCard}>
      <div className={s.pbiHead}>
        <span className={s.pbiIcon}>{iconForMsCategory(status.category)}</span>
        <div className={s.pbiTitleCol}>
          <div className={s.pbiTitleRow}>
            <Text weight="semibold">{status.name}</Text>
            {status.defaultOn && <Badge appearance="tint" color="success" size="small">Core</Badge>}
            {status.preview && <Badge appearance="tint" color="brand" size="small">Preview</Badge>}
            {!status.defaultOn && status.optIn && <Badge appearance="outline" color="informative" size="small">Opt-in</Badge>}
            {status.configured && status.registered && <Badge appearance="tint" color="success" size="small">Connected</Badge>}
          </div>
          <Caption1 className={s.meta}>{status.category}</Caption1>
        </div>
      </div>

      <div className={s.msBody}>
        {status.desc && <Body1 className={s.pbiDesc}>{status.desc}</Body1>}

        {/* Unconfigured → honest opt-in gate (no-vaporware + no-fabric-dependency). */}
        {!status.configured ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Opt-in — not configured</MessageBarTitle>
              {g?.message}
              <Caption1 className={s.gateDetail}>
                {g?.enableEnv && <>Set <code>{g.enableEnv}=true</code> to enable. </>}
                {g?.endpointEnv && <>Set <code>{g.endpointEnv}</code> to the published endpoint. </>}
                {g?.secretEnv && <>Provide the GitHub PAT as the Key Vault secret named in <code>{g.secretEnv}</code>. </>}
                {g?.oboResource && <>Delegated access is exchanged against <code>{g.oboResource}</code>. </>}
                {g?.scopes && g.scopes.length > 0 && (
                  <span className={s.scopeWrap}>
                    {g.scopes.map((sc) => <Badge key={sc} appearance="outline" color="brand" size="small">{sc}</Badge>)}
                  </span>
                )}
                {g?.oboClientEnv && <> Reuses the Loom confidential client <code>{g.oboClientEnv}</code> for the per-user On-Behalf-Of exchange — sign in and consent to enable access.</>}
                {g?.tenantSetting && <> A tenant admin must enable “{g.tenantSetting}”.</>}
              </Caption1>
              {g?.docs && (
                <span className={s.scopeWrap}>
                  <Link href={g.docs} target="_blank" rel="noreferrer" className={s.docsLink}>
                    <Open16Regular /> {g.attribution || 'Documentation'}
                  </Link>
                </span>
              )}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <>
            {/* Microsoft Learn — on by default, no authentication. */}
            {isLearn && (
              <MessageBar intent="success" icon={<Sparkle20Regular />}>
                <MessageBarBody>
                  <MessageBarTitle>Enabled by default — no authentication</MessageBarTitle>
                  Live and callable day-one; no env var, secret, or consent required.
                </MessageBarBody>
              </MessageBar>
            )}

            {status.endpoint ? (
              <div className={s.kvRow}>
                <Caption1 className={s.kvKey}>Endpoint</Caption1>
                <Caption1 className={s.kvVal}>{status.endpoint}</Caption1>
              </div>
            ) : (
              <MessageBar intent="info">
                <MessageBarBody>
                  No endpoint resolved yet — set <code>{status.endpointEnv}</code> to the published
                  Streamable-HTTP endpoint.
                </MessageBarBody>
              </MessageBar>
            )}
            <div className={s.kvRow}>
              <Caption1 className={s.kvKey}>Transport</Caption1>
              <Caption1 className={s.kvVal}>Streamable HTTP · {status.auth === 'entra-obo' ? 'entra-obo (per-user)' : status.auth === 'key-vault' ? 'key-vault (PAT)' : 'no auth'}</Caption1>
            </div>

            {/* entra-obo → delegated scopes + resource + per-user token readiness. */}
            {status.auth === 'entra-obo' && (status.scopeUris?.length ?? 0) > 0 && (
              <div>
                <Caption1 className={s.kvKey}>Delegated scopes</Caption1>
                <div className={s.scopeWrap}>
                  {(status.scopeUris || []).map((sc) => (
                    <Badge key={sc} appearance="outline" color="brand" size="small">{sc}</Badge>
                  ))}
                </div>
              </div>
            )}
            {status.auth === 'key-vault' && status.secretEnv && (
              <div className={s.kvRow}>
                <Caption1 className={s.kvKey}>Key Vault secret</Caption1>
                <Caption1 className={s.kvVal}>{status.secretEnv}</Caption1>
              </div>
            )}

            {status.tenantSetting && (
              <MessageBar intent="info">
                <MessageBarBody>
                  A tenant admin must enable “{status.tenantSetting}” for this endpoint to respond;
                  the first call returns a 403 until it is on.
                </MessageBarBody>
              </MessageBar>
            )}

            {status.auth === 'entra-obo' && !status.tokenReady && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Sign-in required</MessageBarTitle>
                  {status.tokenNote || 'Sign in again and consent the delegated scopes to enable per-user access; no delegated token is cached for your account yet.'}
                </MessageBarBody>
              </MessageBar>
            )}

            {testError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Test failed</MessageBarTitle>{testError}</MessageBarBody>
              </MessageBar>
            )}
            {probeReachable && (
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>Connection successful</MessageBarTitle>
                  Found {probe?.toolCount ?? 0} tool{probe?.toolCount === 1 ? '' : 's'}
                  {probe?.tools && probe.tools.length > 0 && (
                    <div className={s.toolList}>
                      {probe.tools.map((t) => <div key={t}>{t}</div>)}
                    </div>
                  )}
                </MessageBarBody>
              </MessageBar>
            )}
            {probe?.skipped && !testError && (
              <MessageBar intent="info">
                <MessageBarBody>{probe.reason}</MessageBarBody>
              </MessageBar>
            )}
            {connectError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Connect failed</MessageBarTitle>{connectError}</MessageBarBody>
              </MessageBar>
            )}
            {connectNote && !connectError && (
              <MessageBar intent="success">
                <MessageBarBody>{connectNote}</MessageBarBody>
              </MessageBar>
            )}
          </>
        )}
      </div>

      {/* Footer actions — only when configured (a gated server has nothing to call). */}
      {/* Footer — Configure is available in BOTH states (this is how an admin
          ENABLES an opted-out server inline); Test/Connect only once configured. */}
      <div className={s.pbiFoot}>
        {status.docs && (
          <Link href={status.docs} target="_blank" rel="noreferrer" className={s.docsLink}>
            <Open16Regular /> {status.attribution || 'Docs'}
          </Link>
        )}
        <div className={s.spacer} />
        <Button
          icon={<Settings20Regular />}
          size="small"
          onClick={() => setConfigOpen(true)}
          disabled={busy}
        >
          Configure
        </Button>
        {status.configured && (
          <>
            <Button
              icon={<ArrowClockwise20Regular />}
              size="small"
              onClick={() => void runProbe()}
              disabled={testing || connecting || busy || !status.endpoint}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {!status.defaultOn && (
              <Button
                appearance="primary"
                size="small"
                icon={status.registered ? <Checkmark20Regular /> : <Add20Regular />}
                onClick={() => void connect()}
                disabled={connecting || testing || busy}
              >
                {connecting ? 'Connecting…' : status.registered ? 'Re-register' : 'Connect'}
              </Button>
            )}
          </>
        )}
      </div>

      {status.config && (
        <MsRemoteConfigDialog
          status={status}
          open={configOpen}
          onOpenChange={setConfigOpen}
          onSaved={() => { void refresh(); onChanged(); }}
        />
      )}
    </div>
  );
}

/**
 * MicrosoftMcpServersSection — the "Microsoft MCP servers" admin surface. Lists
 * the curated remote built-in family (GET /api/admin/mcp-servers/ms-remote) as a
 * Web-3.0 card grid. The Power BI entry is excluded here — it keeps its dedicated
 * PowerBiRemoteMcpCard above — so it never renders twice. Deployable Microsoft
 * MCP servers (Azure MCP, SQL, Dataverse-as-image, etc.) surface separately in
 * the existing McpCatalogBrowser; this section is only the already-hosted remote
 * endpoints.
 */
function MicrosoftMcpServersSection({
  onChanged,
  busy,
}: {
  onChanged: () => void;
  busy: boolean;
}) {
  const s = useStyles();
  const [servers, setServers] = useState<MsRemoteStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enablingAll, setEnablingAll] = useState(false);
  const [enableAllMsg, setEnableAllMsg] = useState<{ intent: 'success' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/mcp-servers/ms-remote');
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setServers([]); return; }
      const list = (Array.isArray(j.servers) ? j.servers : []) as MsRemoteStatus[];
      // Power BI has its own dedicated card above — don't render it twice.
      setServers(list.filter((e) => e.id !== 'powerbi-remote'));
    } catch (e: any) {
      setError(e?.message || String(e)); setServers([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // "Enable all" — opt every configurable Microsoft remote MCP server IN for
  // this tenant in one action (loom "enable all + on by default"). We PUT
  // enabled:true to the per-tenant override store for each server that isn't
  // force-on'd by the deployment env, preserving any endpoint/secret already
  // set. This is HONEST, not vaporware: enabling flips the opt-in bit, but a
  // server only becomes a live Copilot tool when its effective state is
  // `configured` (real endpoint + satisfiable auth). The refresh + summary
  // below reports exactly how many are Copilot-ready now vs still need a
  // per-user Connect (entra-obo consent), a Key Vault secret, or a GA endpoint
  // — each card shows its own precise gate.
  const enableAll = useCallback(async () => {
    const current = servers;
    if (!current || current.length === 0) return;
    setEnablingAll(true);
    setEnableAllMsg(null);
    let enabled = 0;
    let failed = 0;
    for (const sv of current) {
      if (sv.config?.envForced) continue; // env force-on — already enabled, immutable from UI
      const payload: Record<string, unknown> = { id: sv.id, enabled: true };
      if (sv.config?.supportsEndpoint) payload.endpoint = (sv.override?.endpoint ?? sv.endpoint ?? '').trim();
      if (sv.config?.supportsSecret) payload.secretName = (sv.override?.secretName ?? '').trim();
      try {
        const r = await clientFetch('/api/admin/mcp-servers/ms-remote/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (j.ok) enabled++; else failed++;
      } catch { failed++; }
    }
    // Base summary from the enable loop — set FIRST so the confirmation always
    // shows, even if the (heavier) status refresh below is slow or fails.
    setEnableAllMsg({
      intent: failed ? 'warning' : 'success',
      text:
        `Enabled ${enabled} Microsoft MCP server${enabled === 1 ? '' : 's'} for this tenant.` +
        (failed ? ` ${failed} could not be enabled.` : '') +
        ' Each becomes a live Copilot tool once its endpoint / Key Vault secret is set and its delegated scopes are consented — see each card.',
    });
    // Re-read fresh status so the cards + the summary reflect the real effective
    // state (configured vs gated). The /ms-remote GET computes effective state
    // for every server and can exceed the default 6s client budget, so give it
    // a 30s budget; if it still fails, the base summary above stays.
    try {
      const j = await clientFetch('/api/admin/mcp-servers/ms-remote', undefined, 30_000).then((r) => r.json());
      const list = (Array.isArray(j.servers) ? j.servers : [])
        .filter((e: MsRemoteStatus) => e.id !== 'powerbi-remote') as MsRemoteStatus[];
      if (list.length) {
        setServers(list);
        const live = list.filter((e) => e.configured).length;
        const gated = list.length - live;
        setEnableAllMsg({
          intent: failed ? 'warning' : 'success',
          text:
            `Enabled ${enabled} Microsoft MCP server${enabled === 1 ? '' : 's'} for this tenant. ` +
            `${live} ${live === 1 ? 'is' : 'are'} ready for the Loom Copilot now; ` +
            `${gated} still need a per-user Connect (delegated consent), a Key Vault secret, or a GA endpoint — see each card.` +
            (failed ? ` ${failed} could not be enabled.` : ''),
        });
      }
    } catch { /* keep the base summary above; per-card status is still accurate */ }
    // NOTE: deliberately do NOT call the parent onChanged() here. It runs the
    // parent panel's load(), which flips the panel into its full-page Spinner
    // and UNMOUNTS this section — wiping the summary the admin just triggered.
    // Enabling Microsoft remotes doesn't change the parent's other lists, and
    // the inline setServers above already refreshes this section's own state.
    setEnablingAll(false);
  }, [servers]);

  // Nothing to show and no error (route returned an empty family) → render
  // nothing rather than an empty heading.
  if (!loading && !error && (!servers || servers.length === 0)) return null;

  return (
    <>
      <Divider />
      <div className={s.msSectionHead}>
        <Text weight="semibold">Microsoft MCP servers</Text>
        <Badge appearance="tint" color="brand" size="small">Preview</Badge>
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          appearance="primary"
          icon={<Checkmark20Regular />}
          disabled={busy || enablingAll || loading || !servers || servers.length === 0}
          onClick={() => { void enableAll(); }}
        >
          {enablingAll ? 'Enabling…' : 'Enable all'}
        </Button>
      </div>
      <Caption1 className={s.meta}>
        Curated Microsoft-hosted MCP servers (<Link href="https://github.com/microsoft/mcp" target="_blank" rel="noreferrer">github.com/microsoft/mcp</Link>).
        Microsoft Learn is on by default with no authentication; every other server is opt-in. Use <strong>Enable all</strong>
        {' '}to opt every server in for this tenant — each then becomes a live Copilot tool once its endpoint / Key Vault secret is set and its delegated scopes are consented.
      </Caption1>

      {enableAllMsg && (
        <MessageBar intent={enableAllMsg.intent}>
          <MessageBarBody>
            <MessageBarTitle>{enableAllMsg.intent === 'success' ? 'Servers enabled' : 'Enabled with follow-ups'}</MessageBarTitle>
            {enableAllMsg.text}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed to load Microsoft MCP servers</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner size="tiny" label="Loading Microsoft MCP servers…" />
      ) : (
        <div className={s.msGrid}>
          {(servers || []).map((sv) => (
            <MsRemoteMcpCard
              key={sv.id}
              initial={sv}
              onChanged={() => { void load(); onChanged(); }}
              busy={busy}
            />
          ))}
        </div>
      )}
    </>
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
      const r = await clientFetch('/api/admin/mcp-servers');
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
      const r = await clientFetch(`/api/admin/mcp-servers?id=${serverId}`, { method: 'DELETE' });
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

      {/* Power BI (remote) MCP — opt-in, config-gated (LOOM_POWERBI_MCP_CLIENT_ID
          + a Power BI admin tenant setting). Registers itself via its own
          /powerbi route (authMethod 'entra-obo', source 'remote-builtin'); on
          success we reload the list so the new row appears below. */}
      <PowerBiRemoteMcpCard onChanged={() => void load()} busy={saving} />

      {/* Microsoft MCP servers — the curated github.com/microsoft/mcp remote
          family (Microsoft Learn default-on no-auth; ARM / Foundry / Graph /
          M365 / Teams / OneDrive-SharePoint / Sentinel / Admin Center / Dataverse
          via Entra OBO; GitHub via a Key Vault PAT). Generalizes the Power BI
          plumbing through /api/admin/mcp-servers/ms-remote; connected rows appear
          in the Registered servers table below. */}
      <MicrosoftMcpServersSection onChanged={() => void load()} busy={saving} />

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
                      server.lastTestResult.error ? (
                        <div className={s.testStatus} title={server.lastTestResult.error}>
                          <PlugDisconnected24Regular style={{ fontSize: tokens.fontSizeBase300, color: tokens.colorPaletteRedForeground1 }} />
                          <Caption1>Unreachable {new Date(server.lastTestResult.at).toLocaleDateString()}</Caption1>
                        </div>
                      ) : (
                        <div className={s.testStatus}>
                          <Checkmark20Regular style={{ fontSize: tokens.fontSizeBase300, color: tokens.colorPaletteGreenForeground1 }} />
                          <Caption1>Tested {new Date(server.lastTestResult.at).toLocaleDateString()}</Caption1>
                        </div>
                      )
                    )}
                  </TableCell>
                  <TableCell>
                    {server.lastTestResult ? (
                      server.lastTestResult.error ? (
                        <Caption1 className={s.errLine} title={server.lastTestResult.error}>connection failed</Caption1>
                      ) : (
                        <Caption1>{server.lastTestResult.toolCount} tools</Caption1>
                      )
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
