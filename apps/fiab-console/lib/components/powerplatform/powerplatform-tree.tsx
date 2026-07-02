'use client';

/**
 * PowerPlatformTree — the Power Platform **environment navigator** (parity wave 11).
 *
 * The Power Platform Admin Center / make.powerapps.com equivalent of the ADF
 * Factory Resources / Synapse / Databricks / Power BI navigators. The left pane
 * becomes a typed Fluent v9 Tree rooted at **Environments**; expanding an
 * environment lazily loads its content groups — one per object type with a live
 * count and inline actions — collapsing the Power Platform left rail
 * (Environments / Apps / Cloud flows / Connections / Connectors / Tables) into
 * one tree.
 *
 * Every count comes from a real REST list call; every action hits real REST
 * through the env-scoped BFF route family:
 *   - Environments      → /api/powerplatform/environments  (BAP admin API)
 *   - Apps              → /api/powerplatform/apps           (list / open maker / open in editor / delete)
 *   - Cloud flows       → /api/powerplatform/flows          (list / start / stop / delete / open maker)
 *   - Connections       → /api/powerplatform/connections    (list / delete / open maker)
 *   - Connectors        → /api/powerplatform/connectors     (list / open maker; custom flagged)
 *   - Dataverse tables  → /api/powerplatform/tables         (list / open in editor / open maker)
 *
 * Authoring (new app / new flow / solution import / new custom connector /
 * environment provisioning) is **not faked** — it is honestly routed to the
 * maker / admin portal or the existing Loom editors. DLP data policies and
 * solutions render as honest ⚠️ rows naming the REST + admin role they need.
 * Never a mock list. No `return []` placeholders.
 *
 * Gates (honest, layered):
 *   - No LOOM_UAMI_CLIENT_ID → every route 503s; the whole tree shows one
 *     infra-gate MessageBar naming the env var + the "Service principals can
 *     use Power Platform APIs" allow group.
 *   - Dataverse tables additionally need LOOM_DATAVERSE_CLIENT_ID/_SECRET
 *     (UAMI tokens aren't valid Dataverse Application Users). When that's
 *     missing ONLY the Tables group shows a sub-gate row; everything else works.
 *   - Real 401/403 from a Power Platform API surfaces its remediation hint.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Apps20Regular, Flow20Regular, PlugConnected20Regular,
  PlugConnectedSettings20Regular, Table20Regular, Globe20Regular,
  Play16Regular, Stop16Regular, Open16Regular, Power20Regular,
  Search20Regular, Warning20Regular, ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '240px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
});

const ENV_ROUTE = '/api/powerplatform/environments';
const APPS_ROUTE = '/api/powerplatform/apps';
const FLOWS_ROUTE = '/api/powerplatform/flows';
const CONN_ROUTE = '/api/powerplatform/connections';
const CONNECTORS_ROUTE = '/api/powerplatform/connectors';
const TABLES_ROUTE = '/api/powerplatform/tables';

const MAKER_BASE = 'https://make.powerapps.com';
const FLOW_MAKER_BASE = 'https://make.powerautomate.com';
const ADMIN_BASE = 'https://admin.powerplatform.microsoft.com';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface EnvRow {
  name: string; displayName: string; environmentSku?: string;
  state?: string; isDefault?: boolean; organizationDomain?: string; instanceUrl?: string;
}
interface AppRow { name: string; displayName: string; appType?: string; owner?: { displayName?: string; email?: string } }
interface FlowRow { name: string; displayName: string; state?: string }
interface ConnRow { name: string; displayName: string; connectorId?: string; status?: string }
interface ConnectorRow { name: string; displayName: string; isCustomApi?: boolean; tier?: string }
interface TableRow { MetadataId: string; LogicalName: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; IsCustomEntity?: boolean }

/** Per-environment lazily-loaded content. */
interface EnvContent {
  loading: boolean;
  loaded: boolean;
  error?: string;
  hint?: string;
  apps: AppRow[];
  flows: FlowRow[];
  connections: ConnRow[];
  connectors: ConnectorRow[];
  tables: TableRow[];
  /** Set when the Dataverse SP isn't configured — Tables group renders a sub-gate. */
  tablesGate?: { missing: string };
}

function emptyContent(): EnvContent {
  return { loading: false, loaded: false, apps: [], flows: [], connections: [], connectors: [], tables: [] };
}

function flowColor(state?: string) {
  if (state === 'Started') return 'success' as const;
  if (state === 'Suspended') return 'danger' as const;
  return 'informative' as const;
}
function connColor(status?: string) {
  if (status === 'Connected') return 'success' as const;
  if (status === 'Error') return 'danger' as const;
  return 'informative' as const;
}

export interface PowerPlatformTreeProps {
  /** Currently selected environment (highlighted + auto-expanded). */
  selectedEnvId?: string | null;
  /** Notify the host editor when an environment is picked. */
  onSelectEnv?: (envId: string) => void;
  /** Open a Dataverse table in the host editor (DataverseTableEditor). */
  onOpenTable?: (envId: string, logicalName: string) => void;
  /** Open a Power App in the host editor (PowerAppEditor). Falls back to maker. */
  onOpenApp?: (envId: string, appId: string, appType?: string) => void;
  /** Open a cloud flow in the host editor (PowerAutomateFlowEditor). Falls back to maker. */
  onOpenFlow?: (envId: string, flowId: string) => void;
  /** Increment to force a refresh from the parent. */
  refreshKey?: number;
}

/**
 * A typed, Power-Platform-faithful environment navigator.
 */
export function PowerPlatformTree({
  selectedEnvId = null,
  onSelectEnv,
  onOpenTable,
  onOpenApp,
  onOpenFlow,
  refreshKey = 0,
}: PowerPlatformTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [content, setContent] = useState<Record<string, EnvContent>>({});
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  // ---- environments (root) ----------------------------------------------
  const loadEnvs = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const body = await fetch(ENV_ROUTE).then(readJson);
      if (applyGate(body)) { setLoading(false); return; }
      setGate(null);
      if (!body.ok) { setError(body.error || 'failed to list environments'); setHint(body.hint || null); setLoading(false); return; }
      setEnvs(body.environments || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadEnvs(); }, [loadEnvs, refreshKey]);

  // Auto-expand the selected env once envs load.
  useEffect(() => {
    if (selectedEnvId && envs.some((e) => e.name === selectedEnvId)) {
      setOpenItems((prev) => {
        if (prev.has(`env-${selectedEnvId}`)) return prev;
        const next = new Set(prev); next.add(`env-${selectedEnvId}`); return next;
      });
    }
  }, [selectedEnvId, envs]);

  // ---- lazy per-environment content -------------------------------------
  const loadContent = useCallback(async (envId: string) => {
    setContent((prev) => ({ ...prev, [envId]: { ...(prev[envId] || emptyContent()), loading: true, error: undefined } }));
    const q = `?envId=${encodeURIComponent(envId)}`;
    try {
      const [ar, fr, cr, kr, tr] = await Promise.all([
        fetch(`${APPS_ROUTE}${q}`).then(readJson),
        fetch(`${FLOWS_ROUTE}${q}`).then(readJson),
        fetch(`${CONN_ROUTE}${q}`).then(readJson),
        fetch(`${CONNECTORS_ROUTE}${q}`).then(readJson),
        fetch(`${TABLES_ROUTE}${q}`).then(readJson),
      ]);
      // A control-plane gate on any route gates the whole tree.
      for (const b of [ar, fr, cr, kr, tr]) { if (applyGate(b)) return; }
      // Tables get a dedicated sub-gate (Dataverse SP) that does NOT gate the tree.
      const tablesGate = tr?.code === 'dataverse_not_configured' && tr?.missing ? { missing: tr.missing } : undefined;
      // Surface the first hard error (e.g. 403 SP-not-authorized) once.
      const firstErr = [ar, fr, cr, kr].find((b) => b && b.ok === false);
      setContent((prev) => ({
        ...prev,
        [envId]: {
          loading: false,
          loaded: true,
          error: firstErr ? (firstErr.error || 'request failed') : undefined,
          hint: firstErr?.hint,
          apps: ar.ok ? (ar.apps || []) : [],
          flows: fr.ok ? (fr.flows || []) : [],
          connections: cr.ok ? (cr.connections || []) : [],
          connectors: kr.ok ? (kr.connectors || []) : [],
          tables: tr.ok ? (tr.tables || []) : [],
          tablesGate,
        },
      }));
    } catch (e: any) {
      setContent((prev) => ({ ...prev, [envId]: { ...(prev[envId] || emptyContent()), loading: false, error: e?.message || String(e) } }));
    }
  }, []);

  const onOpenChange = useCallback((_: unknown, data: { open: boolean; value: unknown }) => {
    const value = String(data.value);
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (data.open) next.add(value); else next.delete(value);
      return next;
    });
    if (data.open && value.startsWith('env-')) {
      const envId = value.slice('env-'.length);
      const c = content[envId];
      if (!c || (!c.loaded && !c.loading)) void loadContent(envId);
    }
  }, [content, loadContent]);

  // ---- actions (real REST) ----------------------------------------------
  const del = useCallback(async (url: string, label: string, envId: string) => {
    setBusy(true); setActionMsg(null);
    try {
      const res = await fetch(url, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setActionMsg({ ok: false, text: `${body.error || 'delete failed'}${body.hint ? ` — ${body.hint}` : ''}` }); setBusy(false); return; }
      setActionMsg({ ok: true, text: `Deleted "${label}".` });
      await loadContent(envId);
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [loadContent]);

  const setFlow = useCallback(async (envId: string, id: string, name: string, on: boolean) => {
    setBusy(true); setActionMsg(null);
    try {
      const res = await fetch(FLOWS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, id, action: on ? 'start' : 'stop' }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setActionMsg({ ok: false, text: `${body.error || 'action failed'}${body.hint ? ` — ${body.hint}` : ''}` }); setBusy(false); return; }
      setActionMsg({ ok: true, text: `Flow "${name}" ${on ? 'turned on' : 'turned off'}.` });
      await loadContent(envId);
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [loadContent]);

  function openMaker(href: string) {
    try { window.open(href, '_blank', 'noreferrer'); } catch { /* popup blocked */ }
  }

  // ---- filtering ---------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fEnvs = useMemo(() => envs.filter((e) => match(e.displayName) || match(e.name)), [envs, f]);

  // ---- render helpers ----------------------------------------------------
  const groupHeader = (
    label: string, icon: React.ReactElement, count: number,
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  const emptyLeaf = (key: string, text: string) => (
    <TreeItem itemType="leaf" value={key}><TreeItemLayout><Caption1>{text}</Caption1></TreeItemLayout></TreeItem>
  );

  // ---- whole-tree config gate -------------------------------------------
  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Environments</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power Platform not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App so the Loom console can
            authenticate to the Power Platform control plane (BAP / Power Apps / Power Automate).
            The service principal it identifies must be added to the{' '}
            <strong>&quot;Service principals can use Power Platform APIs&quot;</strong> allow group in the
            Power Platform admin centre (Tenant settings). For Dataverse tables it must additionally
            be registered as an <strong>Application User</strong> on each environment
            (<code>LOOM_DATAVERSE_CLIENT_ID</code>/<code>_SECRET</code>). Tenant bootstrap:{' '}
            <code>docs/fiab/v3-tenant-bootstrap.md</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  // ---- content sub-tree for one environment -----------------------------
  function envContentTree(env: EnvRow) {
    const c = content[env.name];
    if (!c || c.loading) {
      return <TreeItem itemType="leaf" value={`${env.name}-loading`}><TreeItemLayout><Spinner size="tiny" label="Loading…" /></TreeItemLayout></TreeItem>;
    }
    const fApps = c.apps.filter((a) => match(a.displayName));
    const fFlows = c.flows.filter((x) => match(x.displayName));
    const fConns = c.connections.filter((x) => match(x.displayName));
    const fConnectors = c.connectors.filter((x) => match(x.displayName));
    const fTables = c.tables.filter((t) => match(t.LogicalName) || match(t.DisplayName?.UserLocalizedLabel?.Label || ''));
    const customConnectors = c.connectors.filter((x) => x.isCustomApi).length;

    return (
      <Tree aria-label={`${env.displayName} content`}>
        {c.error && (
          <TreeItem itemType="leaf" value={`${env.name}-err`}>
            <TreeItemLayout iconBefore={<Warning20Regular />}>
              <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{c.error}{c.hint ? ` — ${c.hint}` : ''}</Caption1>
            </TreeItemLayout>
          </TreeItem>
        )}

        {/* Apps */}
        <TreeItem itemType="branch" value={`${env.name}-apps`}>
          {groupHeader('Apps', <Apps20Regular />, c.apps.length,
            () => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/apps`), 'New app (maker portal)')}
          <Tree>
            {fApps.length === 0 && emptyLeaf(`${env.name}-apps-empty`, f ? 'No matches' : 'No apps')}
            {fApps.map((a) => (
              <TreeItem key={a.name} itemType="leaf" value={`${env.name}-app-${a.name}`}>
                <TreeItemLayout iconBefore={<Apps20Regular />}>
                  <span className={s.leafRow}>
                    <span
                      role="button" tabIndex={0}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onOpenApp ? onOpenApp(env.name, a.name, a.appType) : openMaker(`${MAKER_BASE}/e/${encodeURIComponent(env.name)}/studio/${encodeURIComponent(a.name)}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenApp ? onOpenApp(env.name, a.name, a.appType) : openMaker(`${MAKER_BASE}/e/${encodeURIComponent(env.name)}/studio/${encodeURIComponent(a.name)}`); } }}
                    >{a.displayName}</span>
                    <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                      {a.appType && <Badge size="small" appearance="tint">{a.appType.includes('Model') ? 'Model' : 'Canvas'}</Badge>}
                      {onOpenApp && <Tooltip content="Open in editor" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenApp(env.name, a.name, a.appType)} aria-label={`Open ${a.displayName}`} /></Tooltip>}
                      <Tooltip content="Open in maker" relationship="label"><Button size="small" appearance="subtle" icon={<Globe20Regular />} onClick={() => openMaker(`${MAKER_BASE}/e/${encodeURIComponent(env.name)}/studio/${encodeURIComponent(a.name)}`)} aria-label={`Open ${a.displayName} in maker`} /></Tooltip>
                      <Tooltip content="Delete app" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(`${APPS_ROUTE}?envId=${encodeURIComponent(env.name)}&id=${encodeURIComponent(a.name)}`, a.displayName, env.name)} aria-label={`Delete ${a.displayName}`} /></Tooltip>
                    </span>
                  </span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* Cloud flows */}
        <TreeItem itemType="branch" value={`${env.name}-flows`}>
          {groupHeader('Cloud flows', <Flow20Regular />, c.flows.length,
            () => openMaker(`${FLOW_MAKER_BASE}/environments/${encodeURIComponent(env.name)}/flows`), 'New flow (maker portal)')}
          <Tree>
            {fFlows.length === 0 && emptyLeaf(`${env.name}-flows-empty`, f ? 'No matches' : 'No cloud flows')}
            {fFlows.map((x) => {
              const on = x.state === 'Started';
              return (
                <TreeItem key={x.name} itemType="leaf" value={`${env.name}-flow-${x.name}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: 'pointer' }}
                        onClick={() => onOpenFlow ? onOpenFlow(env.name, x.name) : openMaker(`${FLOW_MAKER_BASE}/environments/${encodeURIComponent(env.name)}/flows/${encodeURIComponent(x.name)}/details`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenFlow ? onOpenFlow(env.name, x.name) : openMaker(`${FLOW_MAKER_BASE}/environments/${encodeURIComponent(env.name)}/flows/${encodeURIComponent(x.name)}/details`); } }}
                      >{x.displayName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Badge size="small" appearance="filled" color={flowColor(x.state)}>{x.state || '—'}</Badge>
                        {on
                          ? <Tooltip content="Turn off" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy} onClick={() => setFlow(env.name, x.name, x.displayName, false)} aria-label={`Turn off ${x.displayName}`} /></Tooltip>
                          : <Tooltip content="Turn on" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => setFlow(env.name, x.name, x.displayName, true)} aria-label={`Turn on ${x.displayName}`} /></Tooltip>}
                        {onOpenFlow && <Tooltip content="Open in editor" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenFlow(env.name, x.name)} aria-label={`Open ${x.displayName}`} /></Tooltip>}
                        <Tooltip content="Delete flow" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(`${FLOWS_ROUTE}?envId=${encodeURIComponent(env.name)}&id=${encodeURIComponent(x.name)}`, x.displayName, env.name)} aria-label={`Delete ${x.displayName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              );
            })}
          </Tree>
        </TreeItem>

        {/* Connections */}
        <TreeItem itemType="branch" value={`${env.name}-connections`}>
          {groupHeader('Connections', <PlugConnected20Regular />, c.connections.length,
            () => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/connections`), 'New connection (maker portal)')}
          <Tree>
            {fConns.length === 0 && emptyLeaf(`${env.name}-conn-empty`, f ? 'No matches' : 'No connections')}
            {fConns.map((x) => (
              <TreeItem key={x.name} itemType="leaf" value={`${env.name}-conn-${x.name}`}>
                <TreeItemLayout iconBefore={<PlugConnected20Regular />}>
                  <span className={s.leafRow}>
                    <span>{x.displayName}</span>
                    <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                      <Badge size="small" appearance="filled" color={connColor(x.status)}>{x.status || '—'}</Badge>
                      <Tooltip content="Manage in maker" relationship="label"><Button size="small" appearance="subtle" icon={<Globe20Regular />} onClick={() => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/connections`)} aria-label={`Manage ${x.displayName}`} /></Tooltip>
                      {x.connectorId && <Tooltip content="Delete connection" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(`${CONN_ROUTE}?envId=${encodeURIComponent(env.name)}&connectorId=${encodeURIComponent(x.connectorId!)}&id=${encodeURIComponent(x.name)}`, x.displayName, env.name)} aria-label={`Delete ${x.displayName}`} /></Tooltip>}
                    </span>
                  </span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* Connectors (custom flagged) */}
        <TreeItem itemType="branch" value={`${env.name}-connectors`}>
          {groupHeader(`Connectors${customConnectors ? ` · ${customConnectors} custom` : ''}`, <PlugConnectedSettings20Regular />, c.connectors.length,
            () => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/customconnectors`), 'New custom connector (maker portal)')}
          <Tree>
            {fConnectors.length === 0 && emptyLeaf(`${env.name}-cx-empty`, f ? 'No matches' : 'No connectors')}
            {fConnectors.slice(0, 300).map((x) => (
              <TreeItem key={x.name} itemType="leaf" value={`${env.name}-cx-${x.name}`}>
                <TreeItemLayout iconBefore={<PlugConnectedSettings20Regular />}>
                  <span className={s.leafRow}>
                    <span>{x.displayName}</span>
                    <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                      {x.isCustomApi && <Badge size="small" appearance="tint" color="brand">Custom</Badge>}
                      {x.tier && <Caption1>{x.tier}</Caption1>}
                      <Tooltip content="Manage in maker" relationship="label"><Button size="small" appearance="subtle" icon={<Globe20Regular />} onClick={() => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/customconnectors`)} aria-label={`Manage ${x.displayName}`} /></Tooltip>
                    </span>
                  </span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* Dataverse tables (honest sub-gate when SP missing) */}
        <TreeItem itemType="branch" value={`${env.name}-tables`}>
          {groupHeader('Dataverse tables', <Table20Regular />, c.tables.length,
            () => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/tables`), 'New table (maker portal)')}
          <Tree>
            {c.tablesGate ? (
              <TreeItem itemType="leaf" value={`${env.name}-tables-gate`}>
                <Tooltip
                  content={`UAMI tokens aren't valid Dataverse Application Users. Set ${c.tablesGate.missing} (+ _SECRET, _TENANT_ID) to a SP registered as an Application User on this environment with the System Administrator security role.`}
                  relationship="description"
                >
                  <TreeItemLayout iconBefore={<Warning20Regular />}>
                    <span style={{ color: tokens.colorNeutralForeground3 }}>Dataverse SP not configured</span>{' '}
                    <Badge size="small" appearance="tint" color="warning">set {c.tablesGate.missing}</Badge>
                  </TreeItemLayout>
                </Tooltip>
              </TreeItem>
            ) : (
              <>
                {fTables.length === 0 && emptyLeaf(`${env.name}-tables-empty`, f ? 'No matches' : (c.tables.length === 0 ? 'No Dataverse (env has no instance)' : 'No tables'))}
                {fTables.slice(0, 300).map((t) => (
                  <TreeItem key={t.MetadataId} itemType="leaf" value={`${env.name}-table-${t.LogicalName}`}>
                    <TreeItemLayout iconBefore={<Table20Regular />}>
                      <span className={s.leafRow}>
                        <span
                          role="button" tabIndex={0}
                          style={{ cursor: 'pointer' }}
                          onClick={() => onOpenTable ? onOpenTable(env.name, t.LogicalName) : openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/entities/${encodeURIComponent(t.LogicalName)}`)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTable ? onOpenTable(env.name, t.LogicalName) : openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/entities/${encodeURIComponent(t.LogicalName)}`); } }}
                        >{t.DisplayName?.UserLocalizedLabel?.Label || t.LogicalName}</span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {t.IsCustomEntity && <Badge size="small" appearance="tint" color="brand">Custom</Badge>}
                          {onOpenTable && <Tooltip content="Open in editor" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenTable(env.name, t.LogicalName)} aria-label={`Open ${t.LogicalName}`} /></Tooltip>}
                        </span>
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </>
            )}
          </Tree>
        </TreeItem>

        {/* Honest gate rows — Power Platform exposes these; authoring/governance
            is honestly routed to the maker/admin portal (real surfaces), or
            needs an admin role the navigator doesn't yet wire. Never faked. */}
        <TreeItem itemType="branch" value={`${env.name}-more`}>
          <TreeItemLayout iconBefore={<Warning20Regular />}>More in Power Platform</TreeItemLayout>
          <Tree>
            <TreeItem itemType="leaf" value={`${env.name}-more-solutions`}>
              <Tooltip content="Solutions (managed/unmanaged ALM) — Dataverse /api/data/v9.2/solutions is wired in the DataverseTableEditor backend; a dedicated Solutions navigator group + import is tracked for a follow-up. Open the maker portal to import/export now." relationship="description">
                <TreeItemLayout iconBefore={<Globe20Regular />}>
                  <span
                    role="button" tabIndex={0} style={{ cursor: 'pointer', color: tokens.colorNeutralForeground3 }}
                    onClick={() => openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/solutions`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMaker(`${MAKER_BASE}/environments/${encodeURIComponent(env.name)}/solutions`); } }}
                  >Solutions / import</span>{' '}
                  <Badge size="small" appearance="tint" color="informative">maker portal</Badge>
                </TreeItemLayout>
              </Tooltip>
            </TreeItem>
            <TreeItem itemType="leaf" value={`${env.name}-more-dlp`}>
              <Tooltip content="DLP data policies are tenant/governance objects (BAP providers/PowerPlatform.Governance policies) that require the Power Platform Administrator role — distinct from the 'use Power Platform APIs' allow group the navigator authenticates with. Manage them in the admin centre; a governance navigator is tracked for a follow-up." relationship="description">
                <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                  <span
                    role="button" tabIndex={0} style={{ cursor: 'pointer', color: tokens.colorNeutralForeground3 }}
                    onClick={() => openMaker(`${ADMIN_BASE}/policies/dlp`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMaker(`${ADMIN_BASE}/policies/dlp`); } }}
                  >DLP data policies</span>{' '}
                  <Badge size="small" appearance="tint" color="warning">needs admin role</Badge>
                </TreeItemLayout>
              </Tooltip>
            </TreeItem>
          </Tree>
        </TreeItem>
      </Tree>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Environments</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Tooltip content="New environment (admin centre)" relationship="label">
            <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={() => openMaker(`${ADMIN_BASE}/environments`)} aria-label="New environment" />
          </Tooltip>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadEnvs} disabled={loading} aria-label="Refresh environments" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading environments…" /></div>}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Power Platform not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {actionMsg && (
        <MessageBar intent={actionMsg.ok ? 'success' : 'error'}>
          <MessageBarBody>{actionMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree
          aria-label="Power Platform environments"
          openItems={Array.from(openItems)}
          onOpenChange={onOpenChange}
        >
          {!loading && fEnvs.length === 0 && !error && emptyLeaf('env-empty', f ? 'No matches' : 'No environments visible to this service principal')}
          {fEnvs.map((env) => (
            <TreeItem key={env.name} itemType="branch" value={`env-${env.name}`}>
              <TreeItemLayout iconBefore={<Power20Regular />}>
                <span className={s.groupLayout}>
                  <span
                    role="button" tabIndex={0}
                    style={{ fontWeight: selectedEnvId === env.name ? tokens.fontWeightSemibold : undefined, cursor: onSelectEnv ? 'pointer' : undefined }}
                    onClick={(e) => { e.stopPropagation(); onSelectEnv?.(env.name); }}
                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onSelectEnv) { e.preventDefault(); e.stopPropagation(); onSelectEnv(env.name); } }}
                  >
                    {env.displayName}
                  </span>
                  <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                    {env.isDefault && <Badge size="small" appearance="tint">Default</Badge>}
                    {env.environmentSku && <Caption1>{env.environmentSku}</Caption1>}
                    <Tooltip content="Open in admin centre" relationship="label"><Button size="small" appearance="subtle" icon={<Globe20Regular />} onClick={() => openMaker(`${ADMIN_BASE}/environments/${encodeURIComponent(env.name)}/hub`)} aria-label={`Open ${env.displayName} in admin centre`} /></Tooltip>
                  </span>
                </span>
              </TreeItemLayout>
              {envContentTree(env)}
            </TreeItem>
          ))}
        </Tree>
      </div>
    </div>
  );
}
