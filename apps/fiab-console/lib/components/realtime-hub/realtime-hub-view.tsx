'use client';

/**
 * RealTimeHubView — Fabric Real-Time Hub parity surface.
 *
 * One-for-one with the Fabric Real-Time hub page
 * (https://learn.microsoft.com/fabric/real-time-hub/get-started-real-time-hub):
 *
 *  - Task cards row: Get events (Connect source), Subscribe to Fabric/Azure
 *    events, Explore data in motion (preview).
 *  - "All data streams" table: every eventstream (stream) + KQL database
 *    (table) across all Fabric workspaces, with the documented columns
 *    (Data, Source item, Workspace, Type) and per-row actions
 *    (Preview data, Endpoints, Open eventstream/KQL DB).
 *  - Filters: data type + workspace + free-text search (Fabric's filters).
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
  Spinner, Input, Badge, Button, Dropdown, Option, MessageBar, MessageBarBody,
  MessageBarTitle, Table, TableHeader, TableRow, TableHeaderCell, TableBody,
  TableCell, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Drawer,
  DrawerHeader, DrawerHeaderTitle, DrawerBody, Caption1, Subtitle2, Body1,
  Field, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Search20Regular, MoreHorizontal20Regular, Eye20Regular,
  PlugConnected20Regular, Flow20Regular, Database20Regular, Dismiss20Regular,
  Alert20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ConnectSourceDialog } from './connect-source-dialog';

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

const useStyles = makeStyles({
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px', marginBottom: '20px' },
  card: {
    display: 'flex', flexDirection: 'column', gap: '6px', padding: '14px 16px',
    borderRadius: '10px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow4 },
  },
  cardTitle: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 },
  toolbar: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' },
  search: { flex: 1, minWidth: '220px', maxWidth: '360px' },
  sectionTitle: { margin: '8px 0 12px', display: 'flex', alignItems: 'center', gap: '8px' },
  empty: {
    padding: '28px', borderRadius: '12px', border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
  drawerSection: { marginBottom: '16px' },
  kv: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  resultTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
});

export function RealTimeHubView() {
  const styles = useStyles();
  const [data, setData] = useState<StreamsResponse | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [loadErr, setLoadErr] = useState<{ error: string; hint?: string } | null>(null);

  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'stream' | 'table'>('all');
  const [wsFilter, setWsFilter] = useState<string>('all');

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

  const workspaceOptions = useMemo(() => {
    const set = new Map<string, string>();
    (data?.streams || []).forEach((s) => set.set(s.workspaceId, s.workspace));
    return Array.from(set.entries()).map(([id, name]) => ({ id, name }));
  }, [data]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    return (data?.streams || []).filter((s) =>
      (typeFilter === 'all' || s.dataType === typeFilter) &&
      (wsFilter === 'all' || s.workspaceId === wsFilter) &&
      (!f || s.name.toLowerCase().includes(f) || s.workspace.toLowerCase().includes(f)));
  }, [data, q, typeFilter, wsFilter]);

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
      const res = await fetch(`/api/realtime-hub/endpoints?fabricWorkspaceId=${encodeURIComponent(row.workspaceId)}&eventstreamId=${encodeURIComponent(row.id)}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setEndpointsErr(j.error || `Failed (HTTP ${res.status}).`); return; }
      setEndpoints(j.endpoints || []);
    } catch (e: any) { setEndpointsErr(e?.message || String(e)); }
    finally { setEndpointsBusy(false); }
  }

  const loading = data === null;
  const streams = data?.streams || [];

  return (
    <>
      {unauth && <SignInRequired subject="Real-Time hub" />}

      {/* Task cards — Fabric Real-Time hub shortcuts */}
      <div className={styles.cards}>
        <ConnectSourceDialog
          workspaces={workspaceOptions}
          onConnected={load}
          trigger={
            <button type="button" className={styles.card}>
              <span className={styles.cardTitle}><PlugConnected20Regular /> Get events</span>
              <Caption1>Connect a Microsoft / Fabric / Azure / external source and create a real eventstream.</Caption1>
            </button>
          }
        />
        <ConnectSourceDialog
          workspaces={workspaceOptions}
          defaultWorkspaceId={workspaceOptions[0]?.id}
          onConnected={load}
          trigger={
            <button type="button" className={styles.card}>
              <span className={styles.cardTitle}><Alert20Regular /> Subscribe to Fabric / Azure events</span>
              <Caption1>Job events, workspace item events, OneLake events, Blob Storage events.</Caption1>
            </button>
          }
        />
        <button type="button" className={styles.card}
          onClick={() => { if (streams.length) openPreview(streams.find((s) => s.dataType === 'table') || streams[0]); }}>
          <span className={styles.cardTitle}><Eye20Regular /> Explore data in motion</span>
          <Caption1>Preview the most recent events on a stream or KQL table.</Caption1>
        </button>
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

      <div className={styles.sectionTitle}>
        <Subtitle2>All data streams</Subtitle2>
        {data?.workspaceCount != null && <Badge appearance="tint">{streams.length} across {data.workspaceCount} workspaces</Badge>}
      </div>

      <div className={styles.toolbar}>
        <Input className={styles.search} contentBefore={<Search20Regular />}
          placeholder="Search streams by name or workspace…" value={q} onChange={(_, d) => setQ(d.value)} />
        <Dropdown aria-label="Data type" value={typeFilter === 'all' ? 'All types' : typeFilter === 'stream' ? 'Stream' : 'Table'}
          selectedOptions={[typeFilter]} onOptionSelect={(_, d) => setTypeFilter((d.optionValue as any) || 'all')}>
          <Option value="all">All types</Option>
          <Option value="stream">Stream</Option>
          <Option value="table">Table</Option>
        </Dropdown>
        <Dropdown aria-label="Workspace"
          value={wsFilter === 'all' ? 'All workspaces' : (workspaceOptions.find((w) => w.id === wsFilter)?.name || wsFilter)}
          selectedOptions={[wsFilter]} onOptionSelect={(_, d) => setWsFilter((d.optionValue as string) || 'all')}>
          <Option value="all">All workspaces</Option>
          {workspaceOptions.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
        </Dropdown>
        <Button appearance="subtle" icon={<Add20Regular />} onClick={load}>Refresh</Button>
      </div>

      {loading && <Spinner label="Loading data streams from Fabric…" />}

      {!loading && streams.length === 0 && (
        <div className={styles.empty}>
          No data streams visible yet.<br />
          Use <b>Get events</b> above to connect a Microsoft source and create your first eventstream — it is created as a
          real Fabric Eventstream item and will then appear here.
        </div>
      )}

      {!loading && streams.length > 0 && (
        <Table aria-label="All data streams" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Data</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Source item</TableHeaderCell>
              <TableHeaderCell>Workspace</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((s) => (
              <TableRow key={`${s.dataType}-${s.workspaceId}-${s.id}`}>
                <TableCell>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {s.dataType === 'stream' ? <Flow20Regular /> : <Database20Regular />}
                    {s.name}
                  </span>
                </TableCell>
                <TableCell><Badge appearance="outline" size="small">{s.dataType}</Badge></TableCell>
                <TableCell>{s.sourceItem}</TableCell>
                <TableCell>{s.workspace}</TableCell>
                <TableCell>
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label="Stream actions" />
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
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={5}><Caption1>No streams match the current filters.</Caption1></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      )}

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
    </>
  );
}
