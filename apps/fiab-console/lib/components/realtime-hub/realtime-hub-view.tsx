'use client';

/**
 * RealTimeHubView — Fabric Real-Time Hub parity surface.
 *
 * One-for-one with the Fabric Real-Time hub page
 * (https://learn.microsoft.com/fabric/real-time-hub/get-started-real-time-hub):
 *
 *  - "Connect a source" gallery: every supported streaming source as a rich,
 *    colour-coded tile (Microsoft sources, Database CDC, External streams,
 *    Fabric events, Azure events, Sample). Clicking a tile opens the real
 *    ConnectSourceDialog pre-selected on that connector.
 *  - "Discovered Azure sources" table: every real Event Hubs namespace /
 *    Event Hub entity / IoT Hub / ADX cluster found across the configured
 *    subscriptions via Azure Resource Graph (GET /api/rti-hub). Each row's
 *    Subscribe action opens the ConnectSourceDialog PRE-FILLED with that
 *    source (e.g. the Event Hub name), and Create activator POSTs a real
 *    activator item watching it. An honest MessageBar infra-gate shows the
 *    exact env var to set when cross-subscription discovery isn't configured.
 *  - "All data streams" table: every eventstream (stream) + KQL database
 *    (table) across all Fabric workspaces, with the documented columns
 *    (Data, Type, Source item, Workspace) and per-row actions (Preview data,
 *    Endpoints, Open eventstream/KQL DB). Built on the shared LoomDataTable
 *    (sortable / resizable / per-column filter) with colour-coded type icons.
 *  - Preview flyout: recent events for a stream/table via the real Kusto
 *    query path (/api/realtime-hub/preview).
 *  - Endpoints flyout: live connection endpoints from the eventstream
 *    definition (/api/realtime-hub/endpoints).
 *
 * Every control calls a real BFF route backed by real Fabric/Kusto REST.
 * When the Console UAMI isn't authorized in the Fabric tenant, an honest
 * MessageBar infra-gate is shown AND the full UI still renders.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Spinner, Badge, Button, MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Drawer, DrawerHeader,
  DrawerHeaderTitle, DrawerBody, Caption1, Subtitle2, Body1, Field, Input,
  makeStyles, tokens,
  Toaster, Toast, ToastTitle, ToastBody, useToastController, useId,
} from '@fluentui/react-components';
import {
  Search20Regular, MoreHorizontal20Regular, Eye20Regular,
  PlugConnected20Regular, Flow20Regular, Dismiss20Regular, ArrowSync20Regular,
  Pulse24Regular, Flash24Regular, Alert20Regular, Open20Regular, DataUsage24Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { ConnectSourceDialog } from './connect-source-dialog';
import { SourceGallery } from './source-gallery';
import { SOURCE_CONNECTORS, sourceVisual, type SourceConnector } from './source-catalog';

interface DataStreamRow {
  id: string; name: string; dataType: 'stream' | 'table';
  sourceItem: string; workspaceId: string; workspace: string; description?: string;
}
interface StreamsResponse {
  ok: boolean; workspaceCount?: number; streams?: DataStreamRow[];
  warnings?: Array<{ workspace: string; error: string }>;
  error?: string; hint?: string;
}
interface EndpointRow { name: string; role: string; type?: string; properties?: Record<string, unknown>; }

// ---- Discovered Azure sources (mirror app/api/rti-hub/route.ts) ----
interface SubscribePreFill { sourceType: string; sourceName: string; properties: Record<string, unknown>; }
interface DiscoveredRow {
  id: string; name: string; kind: string; source: string;
  workspaceId?: string; resourceGroup?: string; subscriptionId?: string;
  location?: string; description?: string; link?: string;
  subscribePreFill: SubscribePreFill;
}
interface RtiHubResponse {
  ok: boolean; code?: string; error?: string; hint?: string; bicep?: string;
  subscriptions?: string[];
  counts?: { dataStreams: number; azureEvents: number; fabricEvents: number };
  tabs?: { dataStreams: DiscoveredRow[]; azureEvents: DiscoveredRow[]; fabricEvents: DiscoveredRow[] };
  warnings?: Array<{ source: string; error: string }>;
}

const DISCOVERED_KIND_LABEL: Record<string, string> = {
  'eventhub-entity': 'Event Hub', 'eventhub-namespace': 'EH namespace',
  iothub: 'IoT Hub', 'adx-cluster': 'ADX cluster',
  eventstream: 'Eventstream', 'kql-database': 'KQL database', eventhouse: 'Eventhouse',
};
const LOOM_DISCOVERED_KINDS = new Set(['eventstream', 'kql-database', 'eventhouse']);

function connectorForSourceType(sourceType: string): SourceConnector | null {
  return SOURCE_CONNECTORS.find((c) => c.sourceType === sourceType) || null;
}
function preFillProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

const useStyles = makeStyles({
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
  },
  statChip: {
    flexShrink: 0, width: '40px', height: '40px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
  },
  statNum: { fontSize: '22px', fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  statLabel: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap',
  },
  search: { flex: 1, minWidth: '220px', maxWidth: '320px' },
  dataCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  dataChip: {
    flexShrink: 0, width: '28px', height: '28px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
  },
  dataName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  drawerSection: { marginBottom: tokens.spacingVerticalM },
  kv: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  resultTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
});

export function RealTimeHubView() {
  const styles = useStyles();
  const toasterId = useId('rti-hub');
  const { dispatchToast } = useToastController(toasterId);
  const [data, setData] = useState<StreamsResponse | null>(null);
  const [loomWorkspaces, setLoomWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [unauth, setUnauth] = useState(false);
  const [loadErr, setLoadErr] = useState<{ error: string; hint?: string } | null>(null);

  const [q, setQ] = useState('');
  const [discQ, setDiscQ] = useState('');

  // Discovered Azure sources (cross-subscription Resource Graph) — GET /api/rti-hub
  const [disc, setDisc] = useState<RtiHubResponse | null>(null);
  const [discGate, setDiscGate] = useState<RtiHubResponse | null>(null);
  const [discErr, setDiscErr] = useState<string | null>(null);

  // Connect-source dialog (controlled by the on-page gallery / quick action)
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<SourceConnector | null>(null);
  const [connectProps, setConnectProps] = useState<Record<string, string> | null>(null);
  const [connectName, setConnectName] = useState<string | null>(null);

  // Preview drawer
  const [previewRow, setPreviewRow] = useState<DataStreamRow | null>(null);
  const [previewTable, setPreviewTable] = useState('');
  const [previewDb, setPreviewDb] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<{ columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number } | null>(null);

  // Endpoints drawer
  const [endpointsRow, setEndpointsRow] = useState<DataStreamRow | null>(null);
  const [endpointsBusy, setEndpointsBusy] = useState(false);
  const [endpointsErr, setEndpointsErr] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRow[] | null>(null);

  function load() {
    setData(null); setLoadErr(null);
    fetch('/api/realtime-hub/streams').then(async (r) => {
      if (r.status === 401 || r.status === 403) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 401 && !j?.hint) { setUnauth(true); setData({ ok: false, streams: [] }); return; }
        setLoadErr({ error: j.error || 'Not authorized for Fabric.', hint: j.hint });
        setData({ ok: false, streams: [] });
        return;
      }
      const j: StreamsResponse = await r.json().catch(() => ({ ok: false, error: 'Bad response' }));
      if (!j.ok) { setLoadErr({ error: j.error || 'Failed to load streams.', hint: j.hint }); }
      setData(j);
    }).catch((e) => { setLoadErr({ error: String(e?.message || e) }); setData({ ok: false, streams: [] }); });
  }

  // Live cross-subscription discovery of real Azure streaming resources.
  function loadDiscovered() {
    setDisc(null); setDiscGate(null); setDiscErr(null);
    fetch('/api/rti-hub').then(async (r) => {
      if (r.status === 401) { setDisc({ ok: false }); return; }
      const j: RtiHubResponse = await r.json().catch(() => ({ ok: false, error: 'Bad response' }));
      if (r.status === 503 || j.code === 'not_configured') { setDiscGate(j); setDisc(j); return; }
      if (!j.ok) { setDiscErr(j.error || 'Failed to discover Azure sources.'); }
      setDisc(j);
    }).catch((e) => { setDiscErr(String(e?.message || e)); setDisc({ ok: false }); });
  }

  useEffect(load, []);
  useEffect(loadDiscovered, []);

  // Loom workspaces for the Connect-source dialog (Azure-native default) — so a
  // source can be connected even before any eventstream exists.
  useEffect(() => {
    fetch('/api/loom/workspaces').then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setLoomWorkspaces((j.workspaces || []).map((w: any) => ({ id: w.id, name: w.name })));
    }).catch(() => { /* dialog falls back to stream-derived workspaces */ });
  }, []);

  const workspaceOptions = useMemo(() => {
    if (loomWorkspaces.length) return loomWorkspaces;
    const set = new Map<string, string>();
    (data?.streams || []).forEach((s) => set.set(s.workspaceId, s.workspace));
    return Array.from(set.entries()).map(([id, name]) => ({ id, name }));
  }, [data, loomWorkspaces]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    return (data?.streams || []).filter((s) =>
      !f || s.name.toLowerCase().includes(f) || s.workspace.toLowerCase().includes(f) ||
      s.sourceItem.toLowerCase().includes(f));
  }, [data, q]);

  // Discovered Azure data streams (from /api/rti-hub) — exclude Loom-item rows
  // (those already appear in "All data streams" below) so this section shows the
  // real cross-subscription Azure resources.
  const discoveredRows = useMemo<DiscoveredRow[]>(() => {
    const all = disc?.tabs?.dataStreams || [];
    return all.filter((r) => !LOOM_DISCOVERED_KINDS.has(r.kind));
  }, [disc]);
  const discoveredFiltered = useMemo(() => {
    const f = discQ.toLowerCase().trim();
    return discoveredRows.filter((r) =>
      !f || r.name.toLowerCase().includes(f) || r.source.toLowerCase().includes(f) ||
      (r.resourceGroup || '').toLowerCase().includes(f) || (r.location || '').toLowerCase().includes(f));
  }, [discoveredRows, discQ]);

  function openConnect(c: SourceConnector | null) {
    setConnectInitial(c);
    setConnectProps(null);
    setConnectName(null);
    setConnectOpen(true);
  }

  // Subscribe to a discovered Azure source → open the connect dialog pre-filled.
  function subscribeDiscovered(row: DiscoveredRow) {
    const connector = connectorForSourceType(row.subscribePreFill.sourceType);
    if (!connector) {
      dispatchToast(
        <Toast><ToastTitle>Source type not connectable</ToastTitle>
          <ToastBody>No connector for &quot;{row.subscribePreFill.sourceType}&quot;.</ToastBody></Toast>,
        { intent: 'error', timeout: 8000 },
      );
      return;
    }
    setConnectInitial(connector);
    setConnectProps(preFillProps(row.subscribePreFill.properties));
    setConnectName(`${row.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-stream`);
    setConnectOpen(true);
  }

  // Create a real activator item watching a discovered source.
  async function makeActivator(row: DiscoveredRow) {
    const wsId = row.workspaceId || loomWorkspaces[0]?.id || workspaceOptions[0]?.id;
    if (!wsId) {
      dispatchToast(
        <Toast><ToastTitle>No workspace available</ToastTitle>
          <ToastBody>Create a Loom workspace first, then add an activator.</ToastBody></Toast>,
        { intent: 'error', timeout: 8000 },
      );
      return;
    }
    try {
      const res = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: `${row.name}-activator`,
          description: `Activator watching ${row.source}: ${row.name}`,
          source: { name: row.name, kind: row.kind, sourceType: row.subscribePreFill.sourceType, ref: row.id },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        dispatchToast(
          <Toast><ToastTitle>Could not create activator</ToastTitle>
            <ToastBody>{j.error || `HTTP ${res.status}`}</ToastBody></Toast>,
          { intent: 'error', timeout: 10000 },
        );
        return;
      }
      dispatchToast(
        <Toast><ToastTitle>Activator created</ToastTitle>
          <ToastBody>
            “{j.activator?.displayName}” is watching {row.name}.{' '}
            <Link href={`/items/activator/${j.activator?.id}`}>Open</Link>
          </ToastBody></Toast>,
        { intent: 'success', timeout: 9000 },
      );
    } catch (e: any) {
      dispatchToast(
        <Toast><ToastTitle>Could not create activator</ToastTitle>
          <ToastBody>{e?.message || String(e)}</ToastBody></Toast>,
        { intent: 'error', timeout: 10000 },
      );
    }
  }

  function openPreview(row: DataStreamRow) {
    setPreviewRow(row);
    setPreviewTable('');
    setPreviewDb(row.dataType === 'table' ? row.name : '');
    setPreviewResult(null); setPreviewErr(null);
  }
  async function runPreview() {
    if (!previewRow) return;
    setPreviewBusy(true); setPreviewErr(null); setPreviewResult(null);
    try {
      const res = await fetch('/api/realtime-hub/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: previewDb || undefined, table: previewTable.trim(), limit: 50 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setPreviewErr(j.error || `Preview failed (HTTP ${res.status}).`); return; }
      setPreviewResult({ columns: j.columns, rows: j.rows, rowCount: j.rowCount, executionMs: j.executionMs });
    } catch (e: any) { setPreviewErr(e?.message || String(e)); }
    finally { setPreviewBusy(false); }
  }

  async function openEndpoints(row: DataStreamRow) {
    setEndpointsRow(row); setEndpoints(null); setEndpointsErr(null); setEndpointsBusy(true);
    try {
      const res = await fetch(`/api/realtime-hub/endpoints?workspaceId=${encodeURIComponent(row.workspaceId)}&eventstreamId=${encodeURIComponent(row.id)}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setEndpointsErr(j.error || `Failed (HTTP ${res.status}).`); return; }
      setEndpoints(j.endpoints || []);
    } catch (e: any) { setEndpointsErr(e?.message || String(e)); }
    finally { setEndpointsBusy(false); }
  }

  const loading = data === null;
  const discLoading = disc === null;
  const streams = data?.streams || [];
  const streamCount = streams.filter((s) => s.dataType === 'stream').length;
  const tableCount = streams.filter((s) => s.dataType === 'table').length;

  const streamVisual = (t: 'stream' | 'table') => itemVisual(t === 'stream' ? 'eventstream' : 'kql-database');

  // ---- Discovered Azure source columns ----
  const discoveredColumns: LoomColumn<DiscoveredRow>[] = [
    {
      key: 'name', label: 'Name', sortable: true, filterable: true, width: 280,
      render: (r) => {
        const connector = connectorForSourceType(r.subscribePreFill.sourceType);
        const v = connector ? sourceVisual(connector) : { icon: PlugConnected20Regular, color: '#6b7280' };
        const Icon = v.icon;
        return (
          <span className={styles.dataCell}>
            <span className={styles.dataChip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 18, height: 18, color: v.color }} />
            </span>
            <span className={styles.dataName} title={r.name}>{r.name}</span>
          </span>
        );
      },
    },
    {
      key: 'kind', label: 'Type', sortable: true, filterable: true, width: 130,
      render: (r) => <Badge appearance="tint" size="small">{DISCOVERED_KIND_LABEL[r.kind] || r.kind}</Badge>,
    },
    { key: 'source', label: 'Source', sortable: true, filterable: true, width: 200 },
    { key: 'resourceGroup', label: 'Resource group', sortable: true, filterable: true, width: 170, render: (r) => r.resourceGroup || '—' },
    { key: 'location', label: 'Location', sortable: true, filterable: true, width: 120, render: (r) => r.location || '—' },
    {
      key: 'actions', label: 'Actions', sortable: false, filterable: false, width: 110,
      render: (r) => (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${r.name}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<PlugConnected20Regular />} onClick={() => subscribeDiscovered(r)}>Subscribe</MenuItem>
              <MenuItem icon={<Alert20Regular />} onClick={() => makeActivator(r)}>Create activator</MenuItem>
              {LOOM_DISCOVERED_KINDS.has(r.kind) && r.link && (
                <Link href={r.link} style={{ textDecoration: 'none' }}>
                  <MenuItem icon={<Open20Regular />}>Open item</MenuItem>
                </Link>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      ),
    },
  ];

  const columns: LoomColumn<DataStreamRow>[] = [
    {
      key: 'name', label: 'Data', sortable: true, filterable: true, width: 300,
      render: (s) => {
        const v = streamVisual(s.dataType);
        const Icon = v.icon;
        return (
          <span className={styles.dataCell}>
            <span className={styles.dataChip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 18, height: 18, color: v.color }} />
            </span>
            <span className={styles.dataName} title={s.name}>{s.name}</span>
          </span>
        );
      },
    },
    {
      key: 'dataType', label: 'Type', sortable: true, filterable: true, width: 120,
      render: (s) => {
        const v = streamVisual(s.dataType);
        return (
          <Badge appearance="tint" size="small" style={{ backgroundColor: `${v.color}24`, color: v.color }}>
            {s.dataType === 'stream' ? 'Stream' : 'Table'}
          </Badge>
        );
      },
    },
    { key: 'sourceItem', label: 'Source item', sortable: true, filterable: true, width: 200 },
    { key: 'workspace', label: 'Workspace', sortable: true, filterable: true, width: 200 },
    {
      key: 'actions', label: 'Actions', sortable: false, filterable: false, width: 90,
      render: (s) => (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${s.name}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Eye20Regular />} onClick={() => openPreview(s)}>Preview data</MenuItem>
              {s.dataType === 'stream' && (
                <MenuItem icon={<PlugConnected20Regular />} onClick={() => openEndpoints(s)}>Endpoints</MenuItem>
              )}
              <Link href={`/items/${s.dataType === 'stream' ? 'eventstream' : 'kql-database'}/${s.id}`} style={{ textDecoration: 'none' }}>
                <MenuItem icon={<Flow20Regular />}>
                  Open {s.dataType === 'stream' ? 'eventstream' : 'KQL database'}
                </MenuItem>
              </Link>
            </MenuList>
          </MenuPopover>
        </Menu>
      ),
    },
  ];

  return (
    <>
      {unauth && <SignInRequired subject="Real-Time hub" />}

      {/* Summary stats */}
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: `${itemVisual('eventstream').color}1f`, color: itemVisual('eventstream').color }} aria-hidden>
            <Pulse24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : streamCount}</div>
            <div className={styles.statLabel}>Eventstreams</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: `${itemVisual('kql-database').color}1f`, color: itemVisual('kql-database').color }} aria-hidden>
            <Flash24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : tableCount}</div>
            <div className={styles.statLabel}>KQL tables</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#0078d41f', color: 'var(--loom-accent-blue)' }} aria-hidden>
            <PlugConnected20Regular style={{ width: 24, height: 24 }} />
          </span>
          <div>
            <div className={styles.statNum}>{SOURCE_CONNECTORS.length}</div>
            <div className={styles.statLabel}>Source connectors</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#4b1d8f1f', color: 'var(--loom-accent-purple)' }} aria-hidden>
            <Flow20Regular style={{ width: 24, height: 24 }} />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (data?.workspaceCount ?? workspaceOptions.length)}</div>
            <div className={styles.statLabel}>Workspaces</div>
          </div>
        </div>
      </div>

      {loadErr && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Real-Time hub is not fully connected to Fabric</MessageBarTitle>
            {loadErr.error}
            {loadErr.hint ? <><br />{loadErr.hint}</> : null}
            <br />
            Requirement: a Fabric admin must enable <b>“Service principals can use Fabric APIs”</b> and add the Console
            UAMI (<code>LOOM_UAMI_CLIENT_ID</code>) as Member/Contributor on the workspaces. The hub UI still renders so
            you can connect sources once authorized.
          </MessageBarBody>
        </MessageBar>
      )}

      {(data?.warnings && data.warnings.length > 0) && (
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            Some workspaces could not be enumerated: {data.warnings.slice(0, 3).map((w) => w.workspace).join(', ')}
            {data.warnings.length > 3 ? ` (+${data.warnings.length - 3} more)` : ''}.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Connect a source — the colour-coded connector gallery */}
      <Section
        title="Connect a source"
        actions={
          <Button appearance="primary" icon={<PlugConnected20Regular />} onClick={() => openConnect(null)}>
            Browse all sources
          </Button>
        }
      >
        <Caption1 style={{ display: 'block', marginBottom: 12, color: tokens.colorNeutralForeground3 }}>
          Connect Microsoft, Azure, database CDC, and external streaming sources. Each tile creates a real CSA Loom
          Eventstream item carrying the chosen source.
        </Caption1>
        <SourceGallery onPick={openConnect} />
      </Section>

      {/* Discovered Azure sources — live cross-subscription Resource Graph */}
      <Section
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Discovered Azure sources
            {disc?.subscriptions?.length ? (
              <Badge appearance="tint">{discoveredRows.length} across {disc.subscriptions.length} subscriptions</Badge>
            ) : null}
          </span>
        }
        actions={<Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadDiscovered}>Refresh</Button>}
      >
        <Caption1 style={{ display: 'block', marginBottom: 12, color: tokens.colorNeutralForeground3 }}>
          Real Event Hubs, IoT Hubs, and Azure Data Explorer clusters found across your subscriptions via Azure Resource
          Graph. Click <b>Subscribe</b> to create a Loom eventstream pre-filled with that source, or <b>Create activator</b>
          to react to its events.
        </Caption1>

        {discGate && (
          <MessageBar intent="warning" style={{ marginBottom: 12 }}>
            <MessageBarBody>
              <MessageBarTitle>Cross-subscription discovery is not configured</MessageBarTitle>
              {discGate.error}
              {discGate.hint ? <><br />{discGate.hint}</> : null}
              {discGate.bicep ? <><br />Bicep: <code>{discGate.bicep}</code></> : null}
            </MessageBarBody>
          </MessageBar>
        )}
        {discErr && (
          <MessageBar intent="error" style={{ marginBottom: 12 }}>
            <MessageBarBody>{discErr}</MessageBarBody>
          </MessageBar>
        )}
        {disc?.warnings && disc.warnings.length > 0 && (
          <MessageBar intent="info" style={{ marginBottom: 12 }}>
            <MessageBarBody>
              Partial results — some sources could not be enumerated:{' '}
              {disc.warnings.map((w) => `${w.source} (${w.error})`).join('; ')}.
            </MessageBarBody>
          </MessageBar>
        )}

        {!discGate && (
          <>
            <div className={styles.toolbar}>
              <Input className={styles.search} contentBefore={<Search20Regular />}
                placeholder="Search by name, source, resource group, or location…" value={discQ} onChange={(_, d) => setDiscQ(d.value)} />
            </div>
            {discLoading ? (
              <Spinner label="Discovering streams across subscriptions…" />
            ) : discoveredRows.length === 0 ? (
              <div style={{
                padding: 28, borderRadius: 12, border: `1px dashed ${tokens.colorNeutralStroke2}`,
                backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
                fontSize: 14, textAlign: 'center', lineHeight: 1.6,
              }}>
                <DataUsage24Regular style={{ display: 'block', margin: '0 auto 8px' }} />
                No Azure streaming resources discovered in scope yet.<br />
                Provision an Event Hubs namespace, IoT Hub, or ADX cluster — it will appear here automatically.
              </div>
            ) : (
              <LoomDataTable
                ariaLabel="Discovered Azure sources"
                columns={discoveredColumns}
                rows={discoveredFiltered}
                getRowId={(r) => `${r.kind}-${r.id}`}
                empty="No discovered sources match the current search."
              />
            )}
          </>
        )}
      </Section>

      {/* All data streams */}
      <Section
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            All data streams
            {data?.workspaceCount != null && (
              <Badge appearance="tint">{streams.length} across {data.workspaceCount} workspaces</Badge>
            )}
          </span>
        }
        actions={<Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>}
      >
        <div className={styles.toolbar}>
          <Input className={styles.search} contentBefore={<Search20Regular />}
            placeholder="Search streams by name, source, or workspace…" value={q} onChange={(_, d) => setQ(d.value)} />
        </div>

        {loading ? (
          <Spinner label="Loading data streams…" />
        ) : streams.length === 0 ? (
          <div style={{
            padding: 28, borderRadius: 12, border: `1px dashed ${tokens.colorNeutralStroke2}`,
            backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
            fontSize: 14, textAlign: 'center', lineHeight: 1.6,
          }}>
            No data streams visible yet.<br />
            Use <b>Connect a source</b> above to connect a Microsoft source and create your first eventstream — it is
            created as a real CSA Loom Eventstream item and will then appear here.
          </div>
        ) : (
          <LoomDataTable
            ariaLabel="All data streams"
            columns={columns}
            rows={filtered}
            getRowId={(s) => `${s.dataType}-${s.workspaceId}-${s.id}`}
            empty="No streams match the current search."
          />
        )}
      </Section>

      {/* Controlled connect-source dialog (opened from the gallery, a discovered
          source's Subscribe action, or the quick action) */}
      <ConnectSourceDialog
        workspaces={workspaceOptions}
        defaultWorkspaceId={workspaceOptions[0]?.id}
        onConnected={() => { load(); loadDiscovered(); }}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialConnector={connectInitial}
        initialProps={connectProps}
        initialDisplayName={connectName}
      />

      {/* Preview drawer */}
      <Drawer open={!!previewRow} position="end" size="medium" onOpenChange={(_, d) => { if (!d.open) setPreviewRow(null); }}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setPreviewRow(null)} />}>
            Preview — {previewRow?.name}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.drawerSection}>
            <Caption1>Preview reads recent rows from the backing Eventhouse / KQL table via the real Kusto query path.</Caption1>
          </div>
          <Field label="KQL database" className={styles.drawerSection}>
            <Input value={previewDb} placeholder="Eventhouse / KQL database name (defaults to loomdb-default)"
              onChange={(_, d) => setPreviewDb(d.value)} />
          </Field>
          <Field label="Table" required className={styles.drawerSection}>
            <Input value={previewTable} placeholder="KQL table to preview (e.g. Events)" onChange={(_, d) => setPreviewTable(d.value)} />
          </Field>
          <Button appearance="primary" icon={<Eye20Regular />} disabled={!previewTable.trim() || previewBusy} onClick={runPreview}>
            {previewBusy ? 'Reading…' : 'Preview recent events'}
          </Button>
          {previewErr && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{previewErr}</MessageBarBody></MessageBar>}
          {previewResult && (
            <div style={{ marginTop: 16 }}>
              <Caption1>{previewResult.rowCount} rows · {previewResult.executionMs} ms</Caption1>
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table className={styles.resultTable}>
                  <thead><tr>{previewResult.columns.map((c) => <th key={c} style={{ textAlign: 'left', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: 4 }}>{c}</th>)}</tr></thead>
                  <tbody>
                    {previewResult.rows.slice(0, 50).map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j} style={{ padding: 4, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` }}>{cell == null ? '' : String(cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DrawerBody>
      </Drawer>

      {/* Endpoints drawer */}
      <Drawer open={!!endpointsRow} position="end" size="medium" onOpenChange={(_, d) => { if (!d.open) setEndpointsRow(null); }}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setEndpointsRow(null)} />}>
            Endpoints — {endpointsRow?.name}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <Caption1>Live connection endpoints pulled from the eventstream definition (sources, destinations, streams).</Caption1>
          {endpointsBusy && <Spinner label="Pulling definition…" style={{ marginTop: 12 }} />}
          {endpointsErr && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{endpointsErr}</MessageBarBody></MessageBar>}
          {endpoints && endpoints.length === 0 && <Body1 style={{ marginTop: 12 }}>No endpoints in this eventstream yet.</Body1>}
          {endpoints && endpoints.map((ep, i) => (
            <div key={i} style={{ marginTop: 12, padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Subtitle2>{ep.name}</Subtitle2>
                <Badge appearance="outline" size="small">{ep.role}</Badge>
                {ep.type && <Badge appearance="tint" size="small">{ep.type}</Badge>}
              </div>
              {ep.properties && Object.keys(ep.properties).length > 0 && (
                <pre className={styles.kv} style={{ marginTop: 8 }}>{JSON.stringify(ep.properties, null, 2)}</pre>
              )}
            </div>
          ))}
        </DrawerBody>
      </Drawer>

      <Toaster toasterId={toasterId} position="bottom-end" limit={4} />
    </>
  );
}
