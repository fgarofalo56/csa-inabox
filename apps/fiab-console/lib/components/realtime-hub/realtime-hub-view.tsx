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
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, MoreHorizontal20Regular, Eye20Regular,
  PlugConnected20Regular, Flow20Regular, Dismiss20Regular, ArrowSync20Regular,
  Pulse24Regular, Flash24Regular, PlugConnected24Regular, Flow24Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ConnectSourceDialog } from './connect-source-dialog';
import { SourceGallery } from './source-gallery';
import { SOURCE_CONNECTORS, type SourceConnector } from './source-catalog';

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

const LS_REALTIME_STREAMS_VIEW = 'loom.realtime-hub.streams.viewMode.v1';

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
  // Section-actions row holding the view toggle + refresh.
  sectionActions: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
  },
  // Inline-flex wrapper for a Section title with a trailing count badge.
  sectionTitleRow: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
  },
  // Caption above the source gallery.
  introCaption: {
    display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3,
  },
  // Strip the default anchor underline on Link-wrapped menu items.
  linkReset: { textDecoration: 'none' },
  // Top-level infra-gate / warning message bars.
  msgBar: { marginBottom: tokens.spacingVerticalL },
  // Empty-state card for the "All data streams" section.
  emptyState: {
    padding: tokens.spacingVerticalXXL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
  // Spacing helpers inside the drawers (replace inline marginTop styles).
  drawerSpacerS: { marginTop: tokens.spacingVerticalS },
  drawerSpacerM: { marginTop: tokens.spacingVerticalM },
  resultWrap: {
    overflowX: 'auto', maxHeight: '420px', overflowY: 'auto',
    marginTop: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  // Endpoint card in the Endpoints drawer.
  endpointCard: {
    marginTop: tokens.spacingVerticalM, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
  },
  endpointHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  resultTable: {
    width: '100%', borderCollapse: 'collapse', fontSize: '12px',
    '& th': {
      position: 'sticky', top: 0, zIndex: 1,
      textAlign: 'left', padding: '6px 8px',
      backgroundColor: tokens.colorNeutralBackground2,
      fontWeight: tokens.fontWeightSemibold,
      borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
      whiteSpace: 'nowrap',
    },
    '& td': {
      padding: '6px 8px',
      borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
      whiteSpace: 'nowrap',
    },
    '& tbody tr:hover td': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

export function RealTimeHubView() {
  const styles = useStyles();
  const [data, setData] = useState<StreamsResponse | null>(null);
  const [loomWorkspaces, setLoomWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [unauth, setUnauth] = useState(false);
  const [loadErr, setLoadErr] = useState<{ error: string; hint?: string } | null>(null);

  const [q, setQ] = useState('');

  // Tile | List view for the "All data streams" collection (persisted).
  const [view, setView] = useState<LoomView>('list');

  // Connect-source dialog (controlled by the on-page gallery / quick action)
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<SourceConnector | null>(null);

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

  useEffect(load, []);

  // Hydrate the persisted streams view mode (SSR-safe).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_REALTIME_STREAMS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch {
      /* ignore (quota / private mode) */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_REALTIME_STREAMS_VIEW, view);
    } catch {
      /* ignore */
    }
  }, [view]);

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

  function openConnect(c: SourceConnector | null) {
    setConnectInitial(c);
    setConnectOpen(true);
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
  const streams = data?.streams || [];
  const streamCount = streams.filter((s) => s.dataType === 'stream').length;
  const tableCount = streams.filter((s) => s.dataType === 'table').length;

  const streamVisual = (t: 'stream' | 'table') => itemVisual(t === 'stream' ? 'eventstream' : 'kql-database');

  // Per-row action menu — reused by the list-view Actions column and the
  // tile-view overflow kebab so both stay in lockstep (DRY).
  const rowMenu = (s: DataStreamRow) => (
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
          <Link href={`/items/${s.dataType === 'stream' ? 'eventstream' : 'kql-database'}/${s.id}`} className={styles.linkReset}>
            <MenuItem icon={<Flow20Regular />}>
              Open {s.dataType === 'stream' ? 'eventstream' : 'KQL database'}
            </MenuItem>
          </Link>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

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
      render: (s) => rowMenu(s),
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
            <PlugConnected24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{SOURCE_CONNECTORS.length}</div>
            <div className={styles.statLabel}>Source connectors</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statChip} style={{ backgroundColor: '#4b1d8f1f', color: 'var(--loom-accent-purple)' }} aria-hidden>
            <Flow24Regular />
          </span>
          <div>
            <div className={styles.statNum}>{loading ? '—' : (data?.workspaceCount ?? workspaceOptions.length)}</div>
            <div className={styles.statLabel}>Workspaces</div>
          </div>
        </div>
      </div>

      {loadErr && (
        <MessageBar intent="warning" className={styles.msgBar}>
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
        <MessageBar intent="info" className={styles.msgBar}>
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
        <Caption1 className={styles.introCaption}>
          Connect Microsoft, Azure, database CDC, and external streaming sources. Each tile creates a real CSA Loom
          Eventstream item carrying the chosen source.
        </Caption1>
        <SourceGallery onPick={openConnect} />
      </Section>

      {/* All data streams */}
      <Section
        title={
          <span className={styles.sectionTitleRow}>
            All data streams
            {data?.workspaceCount != null && (
              <Badge appearance="tint">{streams.length} across {data.workspaceCount} workspaces</Badge>
            )}
          </span>
        }
        actions={
          <span className={styles.sectionActions}>
            <ViewToggle value={view} onChange={setView} ariaLabel="Stream view" />
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          </span>
        }
      >
        <div className={styles.toolbar}>
          <Input className={styles.search} contentBefore={<Search20Regular />}
            placeholder="Search streams by name, source, or workspace…" value={q} onChange={(_, d) => setQ(d.value)} />
        </div>

        {loading ? (
          <Spinner label="Loading data streams…" />
        ) : streams.length === 0 ? (
          <div className={styles.emptyState}>
            No data streams visible yet.<br />
            Use <b>Connect a source</b> above to connect a Microsoft source and create your first eventstream — it is
            created as a real CSA Loom Eventstream item and will then appear here.
          </div>
        ) : view === 'tile' ? (
          filtered.length === 0 ? (
            <div className={styles.emptyState}>No streams match the current search.</div>
          ) : (
            <TileGrid minTileWidth={280}>
              {filtered.map((s) => (
                <ItemTile
                  key={`${s.dataType}-${s.workspaceId}-${s.id}`}
                  type={s.dataType === 'stream' ? 'eventstream' : 'kql-database'}
                  title={s.name}
                  subtitle={s.sourceItem}
                  meta={s.workspace}
                  badge={
                    <Badge appearance="tint" size="small">
                      {s.dataType === 'stream' ? 'Stream' : 'Table'}
                    </Badge>
                  }
                  overflowMenu={rowMenu(s)}
                />
              ))}
            </TileGrid>
          )
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

      {/* Controlled connect-source dialog (opened from the gallery / quick action) */}
      <ConnectSourceDialog
        workspaces={workspaceOptions}
        defaultWorkspaceId={workspaceOptions[0]?.id}
        onConnected={load}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialConnector={connectInitial}
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
          {previewErr && <MessageBar intent="error" className={styles.drawerSpacerM}><MessageBarBody>{previewErr}</MessageBarBody></MessageBar>}
          {previewResult && (
            <div className={styles.drawerSpacerM}>
              <Caption1>{previewResult.rowCount} rows · {previewResult.executionMs} ms</Caption1>
              <div className={styles.resultWrap}>
                <table className={styles.resultTable}>
                  <thead><tr>{previewResult.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {previewResult.rows.slice(0, 50).map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j}>{cell == null ? '' : String(cell)}</td>)}</tr>
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
          {endpointsBusy && <Spinner label="Pulling definition…" className={styles.drawerSpacerM} />}
          {endpointsErr && <MessageBar intent="error" className={styles.drawerSpacerM}><MessageBarBody>{endpointsErr}</MessageBarBody></MessageBar>}
          {endpoints && endpoints.length === 0 && <Body1 className={styles.drawerSpacerM}>No endpoints in this eventstream yet.</Body1>}
          {endpoints && endpoints.map((ep, i) => (
            <div key={i} className={styles.endpointCard}>
              <div className={styles.endpointHead}>
                <Subtitle2>{ep.name}</Subtitle2>
                <Badge appearance="outline" size="small">{ep.role}</Badge>
                {ep.type && <Badge appearance="tint" size="small">{ep.type}</Badge>}
              </div>
              {ep.properties && Object.keys(ep.properties).length > 0 && (
                <pre className={mergeClasses(styles.kv, styles.drawerSpacerS)}>{JSON.stringify(ep.properties, null, 2)}</pre>
              )}
            </div>
          ))}
        </DrawerBody>
      </Drawer>
    </>
  );
}
