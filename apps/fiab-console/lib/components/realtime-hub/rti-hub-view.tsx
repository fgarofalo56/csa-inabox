'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * RtiHubView — Real-Time Intelligence hub UNIFIED stream catalog.
 *
 * One-for-one with the Fabric Real-Time hub catalog, Azure-native by default
 * (no Fabric, per .claude/rules/no-fabric-dependency.md). Three tabs:
 *
 *   - Data streams : every real Event Hub / IoT Hub / ADX cluster discovered
 *     across subscriptions via Azure Resource Graph, plus the caller's Loom
 *     eventstream / KQL / Eventhouse items. Each row's "Subscribe" opens the
 *     ConnectSourceDialog PRE-FILLED with that source → creates a real Loom
 *     eventstream item. Loom items also offer "Open" + "Activator".
 *   - Azure events : Azure Event Grid connectors (Blob Storage events today).
 *   - Fabric events: Fabric-system event categories — shown only when the
 *     Fabric backend is opted in (LOOM_EVENTSTREAM_BACKEND=fabric).
 *
 * Every control calls a real BFF route. When no subscription is configured an
 * honest MessageBar infra-gate is shown AND the Loom-item rows still render.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Spinner, Badge, Button, Link as FluentLink, MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  TabList, Tab, Caption1, makeStyles, tokens,
  Toaster, Toast, ToastTitle, ToastBody, useToastController, useId,
} from '@fluentui/react-components';
import {
  MoreHorizontal20Regular, PlugConnected20Regular,
  ArrowSync20Regular, Pulse24Regular, Iot24Regular, DatabaseStack16Regular,
  Alert20Regular, DataUsage24Regular,
  Eye20Regular, Flow20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ConnectSourceDialog } from './connect-source-dialog';
import { SOURCE_CONNECTORS, sourceVisual, type SourceConnector } from './source-catalog';
import { StreamPreviewDrawer } from './stream-preview-drawer';
import { StreamEndpointsDrawer } from './stream-endpoints-drawer';
import { EventTestDrawer, type EventTestTarget } from './event-test-drawer';
import { streamRowActions, editorLabel } from './rti-hub-actions';

// ---- Response shapes (mirror app/api/rti-hub/route.ts) ----
interface SubscribePreFill { sourceType: string; sourceName: string; properties: Record<string, unknown>; }
interface RtiHubRow {
  id: string; name: string; kind: string; source: string;
  workspaceId?: string; workspace?: string; resourceGroup?: string;
  subscriptionId?: string; location?: string; description?: string; link?: string;
  subscribePreFill: SubscribePreFill;
}
interface RtiHubResponse {
  ok: boolean; code?: string; error?: string; hint?: string; bicep?: string;
  backend?: string; subscriptions?: string[]; workspaceCount?: number;
  counts?: { dataStreams: number; azureEvents: number; fabricEvents: number };
  tabs?: { dataStreams: RtiHubRow[]; azureEvents: RtiHubRow[]; fabricEvents: RtiHubRow[] };
  fabricEventsGated?: boolean; fabricGateReason?: string;
  eventhubsConfigured?: boolean; eventhubsConfigMissing?: string;
  warnings?: Array<{ source: string; error: string }>;
}

const KIND_LABEL: Record<string, string> = {
  eventstream: 'Eventstream', 'eventhub-entity': 'Event Hub', 'eventhub-namespace': 'EH namespace',
  iothub: 'IoT Hub', 'adx-cluster': 'ADX cluster', 'kql-database': 'KQL database',
  eventhouse: 'Eventhouse', 'azure-event': 'Azure event', 'fabric-event': 'Fabric event',
};

const useStyles = makeStyles({
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
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
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameChip: {
    flexShrink: 0, width: '28px', height: '28px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  tabs: { marginBottom: tokens.spacingVerticalM },
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingVerticalXXL, minHeight: '160px',
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center', lineHeight: 1.5,
    padding: tokens.spacingVerticalXXL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  emptyIcon: {
    width: '48px', height: '48px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalXS,
  },
  emptyText: { maxWidth: '440px' },
});

/** Resolve the catalog connector that matches a row's source type. */
function connectorFor(sourceType: string): SourceConnector | null {
  return SOURCE_CONNECTORS.find((c) => c.sourceType === sourceType) || null;
}

/** Stringify a pre-fill properties bag for the dialog's text fields. */
function preFillProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function RtiHubView() {
  const styles = useStyles();
  const toasterId = useId('rti-hub');
  const { dispatchToast } = useToastController(toasterId);

  const [data, setData] = useState<RtiHubResponse | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [gate, setGate] = useState<RtiHubResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'dataStreams' | 'azureEvents' | 'fabricEvents'>('dataStreams');

  const [loomWorkspaces, setLoomWorkspaces] = useState<Array<{ id: string; name: string }>>([]);

  // Subscribe dialog (pre-filled from a catalog row)
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<SourceConnector | null>(null);
  const [connectProps, setConnectProps] = useState<Record<string, string> | null>(null);
  const [connectName, setConnectName] = useState<string | null>(null);

  // Stream actions: preview (KQL), endpoints (eventstream), peek/send test events.
  const [previewTarget, setPreviewTarget] = useState<{ title: string; db?: string; table?: string; clusterUri?: string } | null>(null);
  const [endpointsTarget, setEndpointsTarget] = useState<{ name: string; workspaceId: string; id: string } | null>(null);
  const [eventTestTarget, setEventTestTarget] = useState<{ title: string; target: EventTestTarget } | null>(null);

  function load() {
    setData(null); setGate(null); setLoadErr(null);
    clientFetch('/api/rti-hub').then(async (r) => {
      if (r.status === 401) { setUnauth(true); setData({ ok: false }); return; }
      const j: RtiHubResponse = await r.json().catch(() => ({ ok: false, error: 'Bad response' }));
      if (r.status === 503 || j.code === 'not_configured') { setGate(j); setData(j); return; }
      if (!j.ok) { setLoadErr(j.error || 'Failed to load the RTI hub catalog.'); }
      setData(j);
    }).catch((e) => { setLoadErr(String(e?.message || e)); setData({ ok: false }); });
  }
  useEffect(load, []);

  useEffect(() => {
    clientFetch('/api/loom/workspaces').then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setLoomWorkspaces((j.workspaces || []).map((w: any) => ({ id: w.id, name: w.name })));
    }).catch(() => { /* dialog falls back to an empty workspace list */ });
  }, []);

  const tabs = data?.tabs;
  const rows = useMemo<RtiHubRow[]>(() => {
    if (!tabs) return [];
    return tab === 'dataStreams' ? tabs.dataStreams : tab === 'azureEvents' ? tabs.azureEvents : tabs.fabricEvents;
  }, [tabs, tab]);

  function subscribe(row: RtiHubRow) {
    const connector = connectorFor(row.subscribePreFill.sourceType);
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

  async function makeActivator(row: RtiHubRow) {
    const wsId = row.workspaceId || loomWorkspaces[0]?.id;
    if (!wsId) {
      dispatchToast(
        <Toast><ToastTitle>No workspace available</ToastTitle>
          <ToastBody>Create a Loom workspace first, then add an activator.</ToastBody></Toast>,
        { intent: 'error', timeout: 8000 },
      );
      return;
    }
    try {
      const res = await clientFetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`, {
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

  // Delete a Loom eventstream (audit B1). The Azure-native eventstream is the
  // Cosmos item; DELETE /api/items/eventstream/[id] now has its own handler.
  async function deleteEventstream(row: RtiHubRow) {
    if (typeof window !== 'undefined' &&
      !window.confirm(`Delete eventstream "${row.name}"? This removes the Loom eventstream item.`)) return;
    try {
      const res = await clientFetch(`/api/items/eventstream/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        dispatchToast(
          <Toast><ToastTitle>Could not delete eventstream</ToastTitle>
            <ToastBody>{j.error || `HTTP ${res.status}`}</ToastBody></Toast>,
          { intent: 'error', timeout: 10000 },
        );
        return;
      }
      dispatchToast(
        <Toast><ToastTitle>Eventstream deleted</ToastTitle>
          <ToastBody>Removed “{row.name}”.</ToastBody></Toast>,
        { intent: 'success', timeout: 7000 },
      );
      load();
    } catch (e: any) {
      dispatchToast(
        <Toast><ToastTitle>Could not delete eventstream</ToastTitle>
          <ToastBody>{e?.message || String(e)}</ToastBody></Toast>,
        { intent: 'error', timeout: 10000 },
      );
    }
  }

  function onSubscribed(result?: { link?: string }) {
    dispatchToast(
      <Toast><ToastTitle>Eventstream created</ToastTitle>
        <ToastBody>
          Subscribed the selected source — it now appears under Data streams.
          {result?.link ? <> <Link href={result.link}>Open eventstream editor</Link></> : null}
        </ToastBody></Toast>,
      { intent: 'success', timeout: 9000 },
    );
    load();
  }

  const loading = data === null;
  const counts = data?.counts;
  const fabricGated = data?.fabricEventsGated !== false; // default to gated

  // ---- Columns ----
  const baseCols: LoomColumn<RtiHubRow>[] = [
    {
      key: 'name', label: 'Name', sortable: true, filterable: true, width: 280,
      render: (r) => {
        const connector = connectorFor(r.subscribePreFill.sourceType);
        const v = connector ? sourceVisual(connector) : { icon: PlugConnected20Regular, color: '#6b7280' };
        const Icon = v.icon;
        return (
          <span className={styles.nameCell}>
            <span className={styles.nameChip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 18, height: 18, color: v.color }} />
            </span>
            <span className={styles.name} title={r.name}>{r.name}</span>
          </span>
        );
      },
    },
    {
      key: 'kind', label: 'Type', sortable: true, filterable: true, width: 130,
      render: (r) => <Badge appearance="tint" size="small">{KIND_LABEL[r.kind] || r.kind}</Badge>,
    },
    { key: 'source', label: 'Source', sortable: true, filterable: true, width: 200 },
  ];

  const dataStreamCols: LoomColumn<RtiHubRow>[] = [
    ...baseCols,
    { key: 'resourceGroup', label: 'Resource group', sortable: true, filterable: true, width: 180,
      render: (r) => r.resourceGroup || (r.workspace ? <em style={{ color: tokens.colorNeutralForeground3 }}>{r.workspace}</em> : '—') },
    { key: 'location', label: 'Location', sortable: true, filterable: true, width: 120, render: (r) => r.location || '—' },
    {
      key: 'actions', label: 'Actions', sortable: false, filterable: false, width: 120,
      render: (r) => {
        const a = streamRowActions(r.kind);
        // The Event Hub entity carries its hub name in the pre-fill (eventHubName)
        // — fall back to the row name for the data-plane peek/send target.
        const hubName = String((r.subscribePreFill.properties as any)?.eventHubName || r.name);
        return (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${r.name}`} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {/* Preview / test — what each kind actually supports. */}
                {a.previewTestEvents && (
                  <MenuItem icon={<Eye20Regular />}
                    onClick={() => setEventTestTarget({ title: r.name, target: { kind: 'eventstream', id: r.id } })}>
                    Preview / test events
                  </MenuItem>
                )}
                {a.peekSendEvents && (
                  <MenuItem icon={<Eye20Regular />}
                    onClick={() => setEventTestTarget({ title: r.name, target: { kind: 'eventhub', hub: hubName } })}>
                    Peek / send events
                  </MenuItem>
                )}
                {a.previewData && (
                  <MenuItem icon={<Eye20Regular />}
                    onClick={() => setPreviewTarget({ title: r.name, db: r.name, table: '' })}>
                    Preview data
                  </MenuItem>
                )}
                {a.previewClusterData && (
                  <MenuItem icon={<Eye20Regular />}
                    onClick={() => setPreviewTarget({
                      title: r.name,
                      db: '',
                      table: '',
                      clusterUri: String((r.subscribePreFill.properties as any)?.adxClusterUri || ''),
                    })}>
                    Preview table on this cluster
                  </MenuItem>
                )}
                {a.endpoints && r.workspaceId && (
                  <MenuItem icon={<PlugConnected20Regular />}
                    onClick={() => setEndpointsTarget({ name: r.name, workspaceId: r.workspaceId!, id: r.id })}>
                    Endpoints
                  </MenuItem>
                )}
                {a.openEditor && r.link && (
                  <Link href={r.link} style={{ textDecoration: 'none' }}>
                    <MenuItem icon={<Flow20Regular />}>
                      {a.previewData ? `Query / open ${editorLabel(r.kind)}` : `Open ${editorLabel(r.kind)} editor`}
                    </MenuItem>
                  </Link>
                )}
                <MenuDivider />
                <MenuItem icon={<PlugConnected20Regular />} onClick={() => subscribe(r)}>Subscribe</MenuItem>
                <MenuItem icon={<Alert20Regular />} onClick={() => makeActivator(r)}>Create activator</MenuItem>
                {a.deleteEventstream && (
                  <MenuItem icon={<Delete20Regular />} onClick={() => deleteEventstream(r)}>
                    Delete eventstream
                  </MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
        );
      },
    },
  ];

  const eventCols: LoomColumn<RtiHubRow>[] = [
    ...baseCols,
    { key: 'description', label: 'Description', sortable: false, filterable: true, width: 360,
      render: (r) => <span style={{ color: tokens.colorNeutralForeground2 }}>{r.description}</span> },
    {
      key: 'actions', label: 'Actions', sortable: false, filterable: false, width: 120,
      render: (r) => (
        <Button appearance="primary" size="small" icon={<PlugConnected20Regular />} onClick={() => subscribe(r)}>
          Connect
        </Button>
      ),
    },
  ];

  return (
    <>
      {unauth && <SignInRequired subject="Real-Time Intelligence hub" />}

      {/* Honest scope disclosure (by-design, not an infra-gate) — audit-T35.
          Loom's real-time path is an Azure-native ANALYTICS pipeline, not a
          Palantir Phonograph-style sub-100ms transactional ontology object
          store. Rendered unconditionally so no vaporware claim is implied.
          intent="info" (by-design out-of-scope) is deliberately distinct from
          the intent="warning" config infra-gate below. See
          docs/fiab/parity/rti-hub.md + docs/migrations/palantir-foundry. */}
      <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalL }}>
        <MessageBarBody>
          <MessageBarTitle>Real-time scope</MessageBarTitle>
          Loom&apos;s real-time path is an Azure-native <b>analytics</b> pipeline —
          Event Hubs → Azure Stream Analytics / Real-Time Intelligence (ADX),
          typically sub-second to low-second end-to-end. It is <b>not</b> a
          Palantir Phonograph-style sub-100&nbsp;ms transactional ontology object
          store, and it does <b>not</b> provide live object writeback — analyst
          edits use a separate Power&nbsp;Apps + SQL-endpoint path. IL6 /
          classified-SCI workloads are out of scope (sponsor-specific deploys
          only; see ADR-0001).
        </MessageBarBody>
      </MessageBar>

      {/* Summary stats */}
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#0078d41f', color: 'var(--loom-accent-blue)' }} aria-hidden>
            <DataUsage24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (counts?.dataStreams ?? 0)}</div>
            <div className={styles.statLabel}>Data streams</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#1a7f4e1f', color: '#1a7f4e' }} aria-hidden>
            <Pulse24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (data?.subscriptions?.length ?? 0)}</div>
            <div className={styles.statLabel}>Subscriptions</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#c2410c1f', color: '#c2410c' }} aria-hidden>
            <Iot24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (counts?.azureEvents ?? 0)}</div>
            <div className={styles.statLabel}>Azure events</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#4b1d8f1f', color: 'var(--loom-accent-purple)' }} aria-hidden>
            <DatabaseStack16Regular style={{ width: 24, height: 24 }} />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (data?.workspaceCount ?? 0)}</div>
            <div className={styles.statLabel}>Loom workspaces</div>
          </div>
        </div>
      </div>

      {/* Honest infra-gate: no subscription configured for Resource Graph */}
      {gate && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Cross-subscription discovery is not configured</MessageBarTitle>
            {gate.error}
            {gate.hint ? <><br />{gate.hint}</> : null}
            {gate.bicep ? <><br />Bicep: <code>{gate.bicep}</code></> : null}
          </MessageBarBody>
        </MessageBar>
      )}

      {loadErr && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>{loadErr}</MessageBarBody>
        </MessageBar>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            Partial results — some sources could not be enumerated:{' '}
            {data.warnings.map((w) => `${w.source} (${w.error})`).join('; ')}.
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Unified stream catalog"
        actions={<Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>}
      >
        <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
          Every streaming source across your subscriptions — Event Hubs, IoT Hub, ADX, and Loom eventstreams —
          discovered live via Azure Resource Graph. Click <b>Subscribe</b> on any source to create a real Loom
          eventstream pre-filled with that source. Already-deployed Loom items also offer <b>Preview / test</b>,{' '}
          <b>Endpoints</b>, <b>Query</b>, and <b>Open editor</b>.
          {' '}Looking for just your deployed eventstreams &amp; KQL tables?{' '}
          <FluentLink href="/realtime-hub">Open the Real-Time hub</FluentLink>.
        </Caption1>

        <div className={styles.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="dataStreams">
              Data streams{counts ? ` (${counts.dataStreams})` : ''}
            </Tab>
            <Tab value="azureEvents">
              Azure events{counts ? ` (${counts.azureEvents})` : ''}
            </Tab>
            {!fabricGated && (
              <Tab value="fabricEvents">
                Fabric events{counts ? ` (${counts.fabricEvents})` : ''}
              </Tab>
            )}
          </TabList>
        </div>

        {fabricGated && data?.fabricGateReason && tab === 'azureEvents' && (
          <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>{data.fabricGateReason}</MessageBarBody>
          </MessageBar>
        )}

        {tab === 'dataStreams' && !loading && rows.length > 0 && (
          <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>
              Rows tagged <b>Eventstream</b>, <b>KQL database</b>, or <b>Eventhouse</b> are deployed Loom items you can{' '}
              preview, test, query, and open. Rows tagged <b>Event Hub</b>, <b>EH namespace</b>, <b>IoT Hub</b>, or{' '}
              <b>ADX cluster</b> are discovered Azure resources you <b>Subscribe</b> to wire into a Loom eventstream.
            </MessageBarBody>
          </MessageBar>
        )}

        {tab === 'azureEvents' && !loading && (
          <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>
              Azure event categories you can <b>Subscribe</b> to — each creates a Loom eventstream whose
              Azure-native ingest endpoint (Event Hub) receives the events. <b>Blob Storage events</b> bind an
              Event Grid system topic; <b>business-event topics</b> deliver governed CloudEvents through a dedicated
              Event Hub.
            </MessageBarBody>
          </MessageBar>
        )}

        {loading ? (
          <div className={styles.loading}>
            <Spinner label="Discovering streams across subscriptions…" />
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden>
              <DataUsage24Regular />
            </span>
            <span className={styles.emptyText}>
              {tab === 'dataStreams'
                ? 'No streams discovered in scope yet. Provision an Event Hubs namespace, IoT Hub, or ADX cluster — or create a Loom eventstream — and it will appear here.'
                : 'No connectors in this tab.'}
            </span>
          </div>
        ) : (
          <LoomDataTable
            ariaLabel={`RTI hub — ${tab}`}
            columns={tab === 'dataStreams' ? dataStreamCols : eventCols}
            rows={rows}
            getRowId={(r) => `${r.kind}-${r.id}`}
            empty="No rows match the current filter."
          />
        )}
      </Section>

      {/* Subscribe → pre-filled Connect-source dialog (creates a Loom eventstream) */}
      <ConnectSourceDialog
        workspaces={loomWorkspaces}
        defaultWorkspaceId={loomWorkspaces[0]?.id}
        onConnected={onSubscribed}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialConnector={connectInitial}
        initialProps={connectProps}
        initialDisplayName={connectName}
      />

      {/* Preview data (KQL / Eventhouse rows + discovered ADX clusters) */}
      <StreamPreviewDrawer
        open={!!previewTarget}
        onClose={() => setPreviewTarget(null)}
        title={previewTarget?.title || ''}
        defaultDb={previewTarget?.db}
        defaultTable={previewTarget?.table}
        clusterUri={previewTarget?.clusterUri}
      />

      {/* Endpoints (Loom eventstream rows) */}
      <StreamEndpointsDrawer
        open={!!endpointsTarget}
        onClose={() => setEndpointsTarget(null)}
        name={endpointsTarget?.name || ''}
        workspaceId={endpointsTarget?.workspaceId || ''}
        eventstreamId={endpointsTarget?.id || ''}
      />

      {/* Preview / test live events (Loom eventstream + Event Hub entity rows) */}
      <EventTestDrawer
        open={!!eventTestTarget}
        onClose={() => setEventTestTarget(null)}
        title={eventTestTarget?.title || ''}
        target={eventTestTarget?.target || null}
      />

      <Toaster toasterId={toasterId} position="bottom-end" limit={4} />
    </>
  );
}
