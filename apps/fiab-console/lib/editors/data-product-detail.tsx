'use client';

/**
 * Data product details page + Data Observability surfaces (F3 / F15 / F19 / F20).
 *
 * This module hosts TWO related surfaces for the data-product item type:
 *
 *  1. The DETAILS PAGE (DataProductDetailEditor / ConsumerDataProductDetail):
 *     Azure-native parity with the Microsoft Purview Unified Catalog "data
 *     product details" page. Reads a REAL product from the Cosmos `items` store
 *     (itemType 'data-product') via GET /api/data-products/[id] — no Fabric /
 *     Purview / Power BI dependency on the default path. Renders the owner (F3)
 *     surface or the consumer (F15) read-only surface from server-authoritative
 *     `isOwner`.
 *
 *  2. The OBSERVABILITY surfaces (useObservability / DqScoreGauge /
 *     ObservabilityTabContent), consumed by the full owner editor
 *     (apim-editors → DataProductEditor) for the F19/F20 Observability tab:
 *       useObservability(id)      — one live GET /api/data-products/[id]/observability
 *                                   feeding both the Overview gauge and the tab.
 *       DqScoreGauge              — data-quality score gauge (Overview toolbar).
 *       ObservabilityTabContent   — lineage graph (Purview classic Data Map) +
 *                                   health charts (ADX KQL) + health-action cards.
 *
 * Azure-native, NO Microsoft Fabric dependency. Honest gates: an ADX-unset or
 * Purview-unset deployment renders a Fluent MessageBar naming the exact env var
 * (LOOM_KUSTO_CLUSTER_URI / LOOM_PURVIEW_ACCOUNT) and the affected section is
 * NOT rendered with fake data — the rest of the surface still renders. Per
 * no-vaporware.md every control is wired to a real backend or shows an honest
 * Fluent MessageBar gate. No fabricated DQ scores, no mock subscribers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Avatar, Badge, Body1, Button, Caption1, Card, CardHeader, Divider, Dropdown, Field, Input, Label,
  MessageBar, MessageBarBody, MessageBarTitle, Option, ProgressBar, Spinner, Subtitle1, Subtitle2,
  Switch, Tab, TabList, Text,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowClockwise20Regular, BookRegular, BranchFork20Regular,
  CheckmarkCircle16Filled, CheckmarkCircleRegular, DatabaseRegular, DataTrending20Regular,
  DocumentText20Regular, Edit20Regular, KeyRegular, LockClosedRegular, Open16Regular,
  PersonRegular, Play20Regular, Pulse20Regular, ScanType20Regular, ShieldTask20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { RequestAccessDialog } from './components/request-access-dialog';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type {
  DataProductDoc, DataProductDetailResponse, DataProductOwner,
} from '@/lib/types/data-product';
import type { AccessRequest, AccessRequestStatus } from '@/lib/types/access-request';
import type { WorkspaceItem } from '@/lib/types/workspace';

// ============================================================================
// Data Observability surfaces (F19 / F20) — consumed by the full owner editor.
// Azure-native, NO Microsoft Fabric dependency.
// ============================================================================

const useObsStyles = makeStyles({
  col: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  gauge: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '180px' },
  gaugeHead: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingHorizontalM },
  actionGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM },
  card: { padding: tokens.spacingHorizontalM },
  kql: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    margin: 0, marginTop: tokens.spacingVerticalXS,
  },
  scroll: { overflowX: 'auto', maxHeight: '260px' },
});

// ------------------------------------------------------------------
// Shared data hook — one fetch feeds the gauge + the tab.
// ------------------------------------------------------------------
export interface ObservabilityData {
  ok: boolean;
  lineage?: { nodes: any[]; edges: any[]; baseEntityGuid: string } | null;
  healthCharts?: Array<{ title: string; kql: string; columns: string[]; rows: unknown[][]; visualization?: string; error?: string }> | null;
  dqScore?: {
    score: number | null; ruleCount: number; passingRules: number;
    breakdown: Array<{ ruleId: string; name: string; check: string; scope: string; percentage: number | null; passed: boolean; detail: string }>;
    computedAt: string;
  } | null;
  database?: string;
  tableName?: string | null;
  gate?: { adx?: { missing: string }; purview?: { missing: string } };
  error?: string;
}

export function useObservability(id: string) {
  const [data, setData] = useState<ObservabilityData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/observability`);
      const j = (await r.json()) as ObservabilityData;
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setData(j); return; }
      setData(j);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, err, refresh };
}

// ------------------------------------------------------------------
// DQ score gauge — Overview toolbar.
// ------------------------------------------------------------------
function scoreColor(score: number): 'success' | 'warning' | 'error' {
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'error';
}

export function DqScoreGauge({ obs, loading }: { obs: ObservabilityData | null; loading: boolean }) {
  const s = useObsStyles();
  if (loading && !obs) {
    return <div className={s.gauge}><Caption1>Data quality</Caption1><Spinner size="extra-tiny" label="Scoring…" /></div>;
  }
  if (obs?.gate?.adx) {
    return (
      <div className={s.gauge}>
        <Caption1>Data quality</Caption1>
        <Badge appearance="outline" color="warning">ADX not configured</Badge>
      </div>
    );
  }
  const dq = obs?.dqScore;
  if (!dq || dq.score == null) {
    return (
      <div className={s.gauge}>
        <Caption1>Data quality</Caption1>
        <Badge appearance="outline">No DQ rules</Badge>
      </div>
    );
  }
  const color = scoreColor(dq.score);
  return (
    <div className={s.gauge}>
      <div className={s.gaugeHead}>
        <Caption1>Data quality</Caption1>
        <Text weight="semibold" size={300} style={{ color: tokens.colorPaletteGreenForeground1 }}>
          <span style={{ color: color === 'success' ? tokens.colorPaletteGreenForeground1 : color === 'warning' ? tokens.colorPaletteYellowForeground1 : tokens.colorPaletteRedForeground1 }}>
            {dq.score}%
          </span>
        </Text>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{dq.passingRules}/{dq.ruleCount} rules</Caption1>
      </div>
      <ProgressBar value={dq.score / 100} color={color} thickness="large" aria-label={`Data quality score ${dq.score} percent`} />
    </div>
  );
}

// ------------------------------------------------------------------
// Compact KQL/lineage result table.
// ------------------------------------------------------------------
function ResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  const s = useObsStyles();
  if (!columns.length) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(no columns)</Caption1>;
  return (
    <div className={s.scroll}>
      <Table size="extra-small" aria-label="KQL result">
        <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, 50).map((row, i) => (
            <TableRow key={i}>
              {columns.map((_, j) => <TableCell key={j}><code style={{ fontSize: tokens.fontSizeBase100 }}>{String((row as any[])[j] ?? '')}</code></TableCell>)}
            </TableRow>
          ))}
          {rows.length === 0 && <TableRow><TableCell>(no rows)</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------
// Try it — live ADX sample preview of the product's backing data.
// Shared by the owner detail + the consumer marketplace view so
// "Try it" is present regardless of who is viewing the product.
// ------------------------------------------------------------------
function DataProductTryItPanel({ id }: { id: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ table?: string; kql?: string; columns: string[]; rows: unknown[][]; executionMs?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const run = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/preview`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j.ok) setResult({ table: j.table, kql: j.kql, columns: j.columns || [], rows: j.rows || [], executionMs: j.executionMs });
      else if (j.gate) setGate(j.gate);
      else setErr(j.error || `HTTP ${r.status}`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Preview this data product&rsquo;s live data — a read-only sample (top 25 rows) from its backing Azure Data Explorer table.
      </Caption1>
      {result?.kql && <pre style={{ fontSize: tokens.fontSizeBase200, backgroundColor: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, overflowX: 'auto' }}>{result.kql}</pre>}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' }}>
        <Button appearance="primary" icon={loading ? undefined : <Play20Regular />} disabled={loading} onClick={run}>
          {loading ? 'Running…' : result ? 'Run again' : 'Run sample query'}
        </Button>
        {loading && <Spinner size="tiny" label="Querying ADX…" />}
        {result && !loading && <Caption1>{result.rows.length} row{result.rows.length !== 1 ? 's' : ''} from <strong>{result.table}</strong>{result.executionMs !== undefined ? ` (${result.executionMs}ms)` : ''}</Caption1>}
      </div>
      {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Data preview not configured</MessageBarTitle>Set <code>{gate.missing}</code> (the ADX cluster URI) to enable live data preview on this deployment.</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {result && result.columns.length > 0 && <ResultTable columns={result.columns} rows={result.rows} />}
      {result && result.columns.length === 0 && !err && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rows returned.</Caption1>}
    </div>
  );
}

// ------------------------------------------------------------------
// Trigger-scan card — picks a real Purview source + scan.
// ------------------------------------------------------------------
function TriggerScanCard({ id }: { id: string }) {
  const s = useObsStyles();
  const [sources, setSources] = useState<string[] | null>(null);
  const [scans, setScans] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/governance/scans');
        const j = await r.json();
        if (j.ok) setSources((j.sources || []).map((x: any) => x.name).filter(Boolean));
        else { setSources([]); if (r.status === 503) setMsg({ intent: 'warning', text: 'Purview not provisioned — set LOOM_PURVIEW_ACCOUNT to enable on-demand scans.' }); }
      } catch { setSources([]); }
    })();
  }, []);

  const pickSource = useCallback(async (name: string) => {
    setSource(name); setScan(''); setScans([]);
    try {
      const r = await fetch(`/api/governance/scans?source=${encodeURIComponent(name)}`);
      const j = await r.json();
      if (j.ok) setScans((j.scans || []).map((x: any) => x.name).filter(Boolean));
    } catch { /* leave empty */ }
  }, []);

  const trigger = useCallback(async () => {
    if (!source || !scan) { setMsg({ intent: 'error', text: 'Pick a source and a scan.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/health-actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'trigger-scan', source, scan }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setMsg({ intent: 'success', text: j.result?.outcome || 'Scan triggered.' });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, source, scan]);

  return (
    <Card className={s.card}>
      <CardHeader header={<Body1><strong>Trigger Purview scan</strong></Body1>} description={<Caption1>Re-scan a registered data source to refresh classifications + lineage.</Caption1>} image={<ScanType20Regular />} />
      <div className={s.col} style={{ marginTop: tokens.spacingVerticalS }}>
        <Field label="Data source">
          <Dropdown placeholder={sources == null ? 'Loading…' : sources.length ? 'Select a source' : 'No registered sources'} value={source} selectedOptions={source ? [source] : []} disabled={!sources?.length} onOptionSelect={(_, d) => d.optionValue && pickSource(d.optionValue)}>
            {(sources || []).map((x) => <Option key={x} value={x}>{x}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Scan">
          <Dropdown placeholder={!source ? 'Pick a source first' : scans.length ? 'Select a scan' : 'No scans on source'} value={scan} selectedOptions={scan ? [scan] : []} disabled={!scans.length} onOptionSelect={(_, d) => d.optionValue && setScan(d.optionValue)}>
            {scans.map((x) => <Option key={x} value={x}>{x}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<ScanType20Regular />} onClick={trigger} disabled={busy || !source || !scan} style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Triggering…' : 'Trigger scan'}
        </Button>
        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------
// Single-action card (refresh-lineage / rerun-dq-check).
// ------------------------------------------------------------------
function ActionCard({
  id, action, title, desc, icon, onDone,
}: {
  id: string; action: 'refresh-lineage' | 'rerun-dq-check'; title: string; desc: string;
  icon: React.ReactElement; onDone?: () => void;
}) {
  const s = useObsStyles();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const run = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/health-actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) {
        const gate = j.gate?.missing ? ` Set ${j.gate.missing}.` : '';
        setMsg({ intent: r.status === 501 || r.status === 503 ? 'warning' : 'error', text: `${j.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setMsg({ intent: 'success', text: j.result?.outcome || 'Done.' });
      onDone?.();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, action, onDone]);

  return (
    <Card className={s.card}>
      <CardHeader header={<Body1><strong>{title}</strong></Body1>} description={<Caption1>{desc}</Caption1>} image={icon} />
      <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Button appearance="primary" icon={busy ? <Spinner size="extra-tiny" /> : icon} onClick={run} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Running…' : title}
        </Button>
        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------
// Observability tab.
// ------------------------------------------------------------------
export function ObservabilityTabContent({ id, obs, loading, err, refresh }: {
  id: string;
  obs: ObservabilityData | null;
  loading: boolean;
  err: string | null;
  refresh: () => void;
}) {
  const s = useObsStyles();
  const adxGate = obs?.gate?.adx;
  const purviewGate = obs?.gate?.purview;
  const lineage = obs?.lineage;
  const charts = obs?.healthCharts;

  return (
    <div className={s.col}>
      <div className={s.row}>
        <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh observability'}
        </Button>
        {obs?.database && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>ADX database <code>{obs.database}</code>{obs.tableName ? <> · table <code>{obs.tableName}</code></> : ''}</Caption1>}
      </div>
      {err && !adxGate && !purviewGate && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {loading && !obs && <Spinner size="tiny" label="Loading observability…" />}

      {/* ---- Health-action cards ---- */}
      <Subtitle2><Pulse20Regular style={{ verticalAlign: 'middle', marginRight: 6 }} />Health actions</Subtitle2>
      <div className={s.actionGrid}>
        <ActionCard id={id} action="rerun-dq-check" title="Re-run DQ checks" desc="Recompute the data-quality score from live ADX KQL against the product's tables." icon={<ArrowClockwise20Regular />} onDone={refresh} />
        <ActionCard id={id} action="refresh-lineage" title="Refresh lineage" desc="Re-pull the Purview classic Data Map Atlas lineage subgraph." icon={<BranchFork20Regular />} onDone={refresh} />
        <TriggerScanCard id={id} />
      </div>

      {/* ---- Data-health charts (ADX) ---- */}
      <Subtitle2><DataTrending20Regular style={{ verticalAlign: 'middle', marginRight: 6 }} />Data health (Azure Data Explorer)</Subtitle2>
      {adxGate ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>ADX cluster not configured</MessageBarTitle>
            Health charts and the data-quality score query Azure Data Explorer. Set <code>{adxGate.missing}</code> to the ADX cluster URI
            (e.g. <code>https://adx-csa-loom-shared.eastus2.kusto.windows.net</code>) in the loom-console container env. Bicep wires this from the
            <code> adx-cluster.bicep</code> module output (<code>platform/fiab/bicep/modules/admin-plane/main.bicep</code>). No charts are shown until ADX is reachable.
          </MessageBarBody>
        </MessageBar>
      ) : charts && charts.length ? (
        <div className={s.cardGrid}>
          {charts.map((c, i) => (
            <Card key={i} className={s.card}>
              <CardHeader
                header={<Body1><strong>{c.title}</strong></Body1>}
                description={c.visualization ? <Badge appearance="outline" size="small">{c.visualization}</Badge> : undefined}
              />
              {c.error ? (
                <MessageBar intent="warning"><MessageBarBody>{c.error}</MessageBarBody></MessageBar>
              ) : (
                <ResultTable columns={c.columns} rows={c.rows} />
              )}
              <pre className={s.kql}>{c.kql}</pre>
            </Card>
          ))}
        </div>
      ) : !loading ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No health charts yet — refresh to query ADX.</Caption1>
      ) : null}

      {/* ---- DQ breakdown ---- */}
      {obs?.dqScore && obs.dqScore.breakdown.length > 0 && (
        <>
          <Subtitle2>Data-quality rules ({obs.dqScore.passingRules}/{obs.dqScore.ruleCount} passing · score {obs.dqScore.score ?? '—'})</Subtitle2>
          <Table size="small" aria-label="DQ rule breakdown">
            <TableHeader><TableRow>
              <TableHeaderCell>Rule</TableHeaderCell><TableHeaderCell>Check</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell><TableHeaderCell>Result</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {obs.dqScore.breakdown.map((b) => (
                <TableRow key={b.ruleId}>
                  <TableCell><strong>{b.name}</strong></TableCell>
                  <TableCell><code>{b.check}</code></TableCell>
                  <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{b.scope}</code></TableCell>
                  <TableCell>{b.detail}</TableCell>
                  <TableCell><Badge appearance="filled" color={b.passed ? 'success' : 'danger'}>{b.passed ? 'pass' : 'fail'}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {/* ---- Lineage graph (Purview classic Data Map) ---- */}
      <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'middle', marginRight: 6 }} />Lineage (Microsoft Purview Data Map)</Subtitle2>
      {purviewGate ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Purview not configured</MessageBarTitle>
            Lineage comes from the Microsoft Purview classic Data Map Atlas API. Set <code>{purviewGate.missing}</code> to the Purview account name and grant the Loom
            UAMI the <code>Data Curator</code> role on the collection. No lineage graph is shown until Purview is reachable.
          </MessageBarBody>
        </MessageBar>
      ) : lineage ? (
        lineage.nodes.length === 0 ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No lineage yet — register a dataset (Datasets tab) or the data product with Purview, then refresh.</Caption1>
        ) : (
          <>
            <Body1>{lineage.nodes.length} nodes · {lineage.edges.length} edges (centered on <code>{lineage.baseEntityGuid.slice(0, 8)}…</code>)</Body1>
            <Table size="small" aria-label="Lineage nodes">
              <TableHeader><TableRow><TableHeaderCell>Asset</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>GUID</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {lineage.nodes.map((n: any) => (
                  <TableRow key={n.id}>
                    <TableCell>{n.label || n.id}</TableCell>
                    <TableCell><code>{n.type || '—'}</code></TableCell>
                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{String(n.id).slice(0, 12)}…</code></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {lineage.edges.length > 0 && (
              <>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Edges</Caption1>
                <div className={s.scroll}>
                  {lineage.edges.map((e: any, i: number) => (
                    <div key={i}><code style={{ fontSize: tokens.fontSizeBase100 }}>{String(e.from).slice(0, 8)}… → {String(e.to).slice(0, 8)}…{e.label ? ` (${e.label})` : ''}</code></div>
                  ))}
                </div>
              </>
            )}
          </>
        )
      ) : !loading ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No lineage data.</Caption1>
      ) : null}
    </div>
  );
}

// ============================================================================
// Data product details page — adaptive owner / consumer surface (F3 / F15).
// ============================================================================

// The full owner edit form (create/update, datasets, glossary, lineage, access
// policies) lives in DataProductEditor. The details page is the read-first
// landing surface; "Edit" / "Manage policies" switch to the working editor via
// the ?view=edit query param on the SAME route. Lazy-loaded so the heavy editor
// module stays out of the details bundle until the owner clicks Edit.
const DataProductEditForm = dynamic(
  () => import('./apim-editors').then((m) => m.DataProductEditor),
  { ssr: false, loading: () => <Spinner label="Opening editor…" /> },
);

const useStyles = makeStyles({
  // Sticky header pins to the scroll container provided by ItemEditorChrome.
  sticky: {
    position: 'sticky', top: 0, zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingBottom: 12, marginBottom: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  headerRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  headerSpacer: { flex: 1 },
  badges: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  avatars: { display: 'flex', alignItems: 'center', gap: 4 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: { padding: tokens.spacingHorizontalM },
  grid2: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS, alignItems: 'center' },
  attrGrid: { display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  contactRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' },
  contactName: { minWidth: 180 },
  links: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  link: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  muted: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  gaugeWrap: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL },
  healthCards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingHorizontalS },
  subsBar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
});

interface SubscriberRow {
  id: string;
  requesterUpn?: string;
  requesterDisplayName?: string;
  grantedAt?: string;
  purpose?: string;
}

function statusColor(status?: string): 'warning' | 'success' | 'danger' | 'subtle' {
  if (status === 'Published') return 'success';
  if (status === 'Draft') return 'warning';
  if (status === 'Expired') return 'danger';
  return 'subtle';
}

/** SVG semicircle gauge for the real DQ score. */
function DqGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const r = 52;
  const circ = Math.PI * r; // semicircle length
  const offset = circ * (1 - clamped / 100);
  const color = clamped >= 80 ? tokens.colorPaletteGreenForeground1
    : clamped >= 60 ? tokens.colorPaletteYellowForeground1
      : tokens.colorPaletteRedForeground1;
  return (
    <svg width={140} height={86} viewBox="0 0 140 86" role="img" aria-label={`Data quality score ${clamped} out of 100`}>
      <path d="M 14 76 A 52 52 0 0 1 126 76" fill="none" stroke={tokens.colorNeutralStroke2} strokeWidth={12} strokeLinecap="round" />
      <path
        d="M 14 76 A 52 52 0 0 1 126 76" fill="none" stroke={color} strokeWidth={12} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
      />
      <text x={70} y={68} textAnchor="middle" fontSize={26} fontWeight={600} fill={tokens.colorNeutralForeground1}>{clamped}</text>
    </svg>
  );
}

function LinkList({ items }: { items?: { label: string; url: string }[] }) {
  const s = useStyles();
  if (!items || items.length === 0) return <Caption1 className={s.muted}>None defined.</Caption1>;
  return (
    <div className={s.links}>
      {items.map((l, i) => (
        <a key={i} className={s.link} href={l.url} target="_blank" rel="noreferrer">
          <Open16Regular /> {l.label || l.url}
        </a>
      ))}
    </div>
  );
}

/**
 * DataProductDetailEditor — the registered `data-product` editor. Loads the
 * product once, then renders the OWNER (F3) surface or, when the caller does
 * not own the product, the CONSUMER (F15) read-only surface. Owner detection is
 * server-authoritative (`isOwner` from GET /api/data-products/[id]).
 */
export function DataProductDetailEditor({ item: itemProp, id }: { item?: FabricItemType; id: string }) {
  // The /data-products/[id] consumer page mounts this WITHOUT the item prop.
  // Default to the data-product catalog type so ItemEditorChrome + the owner
  // edit form (which read item.displayName/description/category/slug) render
  // instead of crashing the whole page.
  const item = itemProp ?? findItemType('data-product')!;
  const s = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ?view=edit switches the SAME route to the full owner edit form. Returning
  // (Back / "Done") drops the param and re-renders the read-first details view.
  const editView = searchParams?.get('view') === 'edit';
  const gotoEdit = useCallback((tab?: string) => {
    const base = pathname || `/items/${item?.slug ?? 'data-product'}/${id}`;
    router.push(`${base}?view=edit${tab ? `&tab=${tab}` : ''}`);
  }, [pathname, item?.slug, id, router]);

  const [product, setProduct] = useState<DataProductDoc | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [dqScore, setDqScore] = useState<number | null>(null);
  const [dqGate, setDqGate] = useState<string | null>(null);
  const [subscriberCount, setSubscriberCount] = useState(0);
  const [loading, setLoading] = useState(id !== 'new');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [tab, setTab] = useState<'details' | 'observability' | 'tryit'>('details');
  const [showEmpty, setShowEmpty] = useState(false);

  // Owner contact-label editing (persisted via PATCH).
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [labelMsg, setLabelMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Subscribers (lazy, paginated).
  const [subs, setSubs] = useState<SubscriberRow[] | null>(null);
  const [subPage, setSubPage] = useState(0);
  const [subBusy, setSubBusy] = useState(false);
  const SUB_PAGE_SIZE = 10;

  // F19/F20 — Data Observability: live GET feeds the Observability tab
  // (lineage + health charts + DQ breakdown + health actions).
  const observability = useObservability(id);

  const hydrate = useCallback((d: DataProductDetailResponse) => {
    setProduct(d.product ?? null);
    setIsOwner(d.isOwner ?? null);
    setDqScore(d.dqScore ?? null);
    setDqGate(d.dqGate ?? null);
    setSubscriberCount(d.subscriberCount ?? 0);
    const init: Record<string, string> = {};
    (d.product?.owners ?? []).forEach((o) => { init[o.id] = o.label ?? ''; });
    setLabels(init);
    setLabelsDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (id === 'new') {
      setLoadErr('Open an existing data product from the Marketplace to view its details. Use "New data product" to create one.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`);
      const j = (await r.json()) as DataProductDetailResponse;
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      hydrate(j);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id, hydrate]);

  useEffect(() => { void load(); }, [load]);

  const saveLabels = useCallback(async () => {
    setSavingLabels(true);
    setLabelMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerLabels: labels }),
      });
      const j = (await r.json()) as { ok: boolean; product?: DataProductDoc; error?: string };
      if (!j.ok || !j.product) { setLabelMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setProduct(j.product);
      const init: Record<string, string> = {};
      (j.product.owners ?? []).forEach((o) => { init[o.id] = o.label ?? ''; });
      setLabels(init);
      setLabelsDirty(false);
      setLabelMsg({ intent: 'success', text: 'Contact labels saved.' });
    } catch (e: any) {
      setLabelMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setSavingLabels(false);
    }
  }, [id, labels]);

  const loadSubscribers = useCallback(async (page: number) => {
    setSubBusy(true);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/subscribers?page=${page}&pageSize=${SUB_PAGE_SIZE}`);
      const j = (await r.json()) as { ok: boolean; subscribers?: SubscriberRow[] };
      if (j.ok) { setSubs(j.subscribers ?? []); setSubPage(page); }
    } catch {
      setSubs([]);
    } finally {
      setSubBusy(false);
    }
  }, [id]);

  const visibleAttrs = useMemo(() => {
    const all = product?.customAttributes ?? [];
    return showEmpty ? all : all.filter((a) => a.value != null && a.value !== '');
  }, [product?.customAttributes, showEmpty]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home', label: 'Home',
      groups: [
        {
          label: 'Actions',
          actions: [
            { label: loading ? 'Loading…' : 'Refresh', icon: <ArrowClockwise20Regular />, onClick: loading ? undefined : () => void load(), disabled: loading },
            { label: 'Edit', icon: <Edit20Regular />, onClick: product ? () => gotoEdit() : undefined, disabled: !product },
            { label: 'Manage policies', icon: <ShieldTask20Regular />, onClick: product ? () => gotoEdit('policies') : undefined, disabled: !product },
          ],
        },
      ],
    },
  ], [loading, load, product, gotoEdit]);

  const main = (() => {
    if (loading) return <Spinner label="Loading data product…" />;
    if (loadErr) {
      return (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Unable to load this data product</MessageBarTitle>
            {loadErr}
          </MessageBarBody>
        </MessageBar>
      );
    }
    if (!product) return <Body1>No data product to show.</Body1>;

    const owners: DataProductOwner[] = product.owners ?? [];

    return (
      <div>
        {/* Sticky header */}
        <div className={s.sticky}>
          <div className={s.headerRow}>
            <Subtitle1>{product.name}</Subtitle1>
            <div className={s.badges}>
              <Badge appearance="filled" color={statusColor(product.status)}>{product.status}</Badge>
              {product.endorsed && (
                <Badge appearance="outline" color="informative" icon={<CheckmarkCircle16Filled />}>Endorsed</Badge>
              )}
            </div>
            <div className={s.headerSpacer} />
            {owners.length > 0 && (
              <div className={s.avatars}>
                {owners.slice(0, 5).map((o) => (
                  <Avatar key={o.id} size={28} color="colorful" name={o.displayName || o.upn || o.id}
                    aria-label={o.displayName || o.upn || o.id} />
                ))}
                {owners.length > 5 && <Caption1>+{owners.length - 5}</Caption1>}
              </div>
            )}
            <div className={s.actions}>
              <Button appearance="primary" icon={<Edit20Regular />}
                onClick={() => gotoEdit()}>Edit</Button>
            </div>
          </div>
        </div>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'details' | 'observability' | 'tryit')}>
          <Tab value="details">Details</Tab>
          <Tab value="observability">Data Observability</Tab>
          <Tab value="tryit" icon={<Play20Regular />}>Try it</Tab>
        </TabList>

        {tab === 'details' && (
          <div className={s.body} style={{ marginTop: tokens.spacingVerticalM }}>
            {/* Description */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Description</Subtitle2>} />
              {product.description ? <Body1>{product.description}</Body1> : <Caption1 className={s.muted}>No description.</Caption1>}
            </Card>

            {/* Use case */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Use case</Subtitle2>} />
              {product.useCase ? <Body1>{product.useCase}</Body1> : <Caption1 className={s.muted}>No use case defined.</Caption1>}
            </Card>

            {/* Governance grid */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Governance</Subtitle2>} />
              <div className={s.grid2}>
                <Caption1>Governance domain</Caption1>
                <Body1>{product.governanceDomainName || product.governanceDomainId || '—'}</Body1>
                <Caption1>Update frequency</Caption1>
                <Body1>{product.updateFrequency || 'Not set'}</Body1>
                <Caption1>Status</Caption1>
                <Body1><Badge appearance="filled" color={statusColor(product.status)}>{product.status}</Badge></Body1>
                {product.type && (<><Caption1>Type</Caption1><Body1>{product.type}</Body1></>)}
              </div>
            </Card>

            {/* Owner contacts — editable labels (PATCH) */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Owner contacts</Subtitle2>} />
              {owners.length === 0 ? (
                <Caption1 className={s.muted}>No owners assigned.</Caption1>
              ) : (
                <>
                  {owners.map((o) => (
                    <div key={o.id} className={s.contactRow}>
                      <Avatar size={24} color="colorful" name={o.displayName || o.upn || o.id} aria-hidden />
                      <Body1 className={s.contactName}>{o.displayName || o.upn || o.id}</Body1>
                      <Field label="Contact label" orientation="horizontal">
                        <Input
                          value={labels[o.id] ?? ''}
                          placeholder="e.g. Primary contact"
                          onChange={(_, d) => { setLabels((p) => ({ ...p, [o.id]: d.value })); setLabelsDirty(true); }}
                        />
                      </Field>
                    </div>
                  ))}
                  <div className={s.actions}>
                    <Button appearance="primary" disabled={!labelsDirty || savingLabels} onClick={() => void saveLabels()}>
                      {savingLabels ? 'Saving…' : 'Save contact labels'}
                    </Button>
                  </div>
                  {labelMsg && (
                    <MessageBar intent={labelMsg.intent === 'success' ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS }}>
                      <MessageBarBody>{labelMsg.text}</MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </Card>

            {/* Subscribers — real, paginated */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Subscribers</Subtitle2>} />
              <Caption1>{subscriberCount} approved subscriber{subscriberCount === 1 ? '' : 's'}</Caption1>
              {subscriberCount > 0 && (
                <div className={s.subsBar}>
                  <Button size="small" disabled={subBusy} onClick={() => void loadSubscribers(0)}>
                    {subs === null ? 'Load subscribers' : 'Reload'}
                  </Button>
                  {subs !== null && (
                    <>
                      <Button size="small" disabled={subBusy || subPage === 0} onClick={() => void loadSubscribers(subPage - 1)}>Prev</Button>
                      <Caption1>Page {subPage + 1}</Caption1>
                      <Button size="small" disabled={subBusy || subs.length < SUB_PAGE_SIZE} onClick={() => void loadSubscribers(subPage + 1)}>Next</Button>
                    </>
                  )}
                </div>
              )}
              {subs !== null && subs.length > 0 && (
                <Table size="small" style={{ marginTop: tokens.spacingVerticalS }}>
                  <TableBody>
                    {subs.map((sub) => (
                      <TableRow key={sub.id}>
                        <TableCell>{sub.requesterDisplayName || sub.requesterUpn || sub.id}</TableCell>
                        <TableCell>{sub.purpose || '—'}</TableCell>
                        <TableCell>{sub.grantedAt ? new Date(sub.grantedAt).toLocaleDateString() : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {subs !== null && subs.length === 0 && <Caption1 className={s.muted}>No subscribers on this page.</Caption1>}
            </Card>

            {/* Terms of use + Documentation */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Terms of use</Subtitle2>} />
              <LinkList items={product.termsOfUse} />
            </Card>
            <Card className={s.card}>
              <CardHeader header={<div className={s.link}><DocumentText20Regular /><Subtitle2>Documentation</Subtitle2></div>} />
              <LinkList items={product.documentation} />
            </Card>

            {/* DQ score gauge or honest-gate */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Data quality</Subtitle2>} />
              {dqScore !== null ? (
                <div className={s.gaugeWrap}>
                  <DqGauge score={dqScore} />
                  <Body1>Score computed from this tenant&apos;s enabled data-quality rules.</Body1>
                </div>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No data-quality score yet</MessageBarTitle>
                    {dqGate || 'Configure data-quality rules to compute a real score.'}{' '}
                    <Button appearance="transparent" size="small" onClick={() => router.push('/admin/data-quality-rules')}>Open Data Quality Rules</Button>
                  </MessageBarBody>
                </MessageBar>
              )}
            </Card>

            {/* Health-action cards — derived from real DQ posture */}
            <div>
              <Subtitle2 className={s.sectionTitle}>Health actions</Subtitle2>
              <div className={s.healthCards} style={{ marginTop: tokens.spacingVerticalS }}>
                {dqScore === null ? (
                  <Card className={s.card}>
                    <CardHeader header={<Body1>Configure data-quality rules</Body1>}
                      description={<Caption1>No rules are defined for this tenant.</Caption1>} />
                    <Button size="small" onClick={() => router.push('/admin/data-quality-rules')}>Fix</Button>
                  </Card>
                ) : dqScore < 80 ? (
                  <Card className={s.card}>
                    <CardHeader header={<Body1>Improve data-quality coverage</Body1>}
                      description={<Caption1>Score is {dqScore}/100 — some rules are disabled.</Caption1>} />
                    <Button size="small" onClick={() => router.push('/admin/data-quality-rules')}>Review rules</Button>
                  </Card>
                ) : (
                  <Caption1 className={s.muted}>No health actions needed.</Caption1>
                )}
              </div>
            </div>

            {/* Custom Attributes — show-empty toggle */}
            <Card className={s.card}>
              <CardHeader
                header={<Subtitle2>Custom attributes</Subtitle2>}
                action={<Switch checked={showEmpty} onChange={(_, d) => setShowEmpty(d.checked)} label="Show attributes without a value" />}
              />
              {visibleAttrs.length === 0 ? (
                <Caption1 className={s.muted}>
                  {(product.customAttributes ?? []).length === 0 ? 'No custom attributes.' : 'All attributes are empty. Toggle "Show attributes without a value" to reveal them.'}
                </Caption1>
              ) : (
                <div className={s.attrGrid}>
                  {visibleAttrs.map((a, i) => (
                    <Field key={`${a.groupName}-${a.name}-${i}`}>
                      <Label weight="semibold">{a.groupName ? `${a.groupName} · ${a.name}` : a.name}</Label>
                      <Body1>{a.value != null && a.value !== '' ? String(a.value) : <span className={s.muted}>—</span>}</Body1>
                    </Field>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'observability' && (
          <div style={{ marginTop: tokens.spacingVerticalM }}>
            <ObservabilityTabContent
              id={id}
              obs={observability.data}
              loading={observability.loading}
              err={observability.err}
              refresh={observability.refresh}
            />
          </div>
        )}

        {tab === 'tryit' && <DataProductTryItPanel id={id} />}
      </div>
    );
  })();

  // ?view=edit → hand off to the full working owner editor on the same route.
  if (editView) return <DataProductEditForm item={item} id={id} />;

  // Non-owner: render the read-only consumer surface (server-authoritative).
  if (!loading && product && isOwner === false) {
    return <ConsumerDataProductDetail id={id} />;
  }

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

// ============================================================================
// Consumer (read-only) view — F15. A non-owner sees the same product details
// (overview / datasets / glossary) with NO owner-edit controls, plus a
// purpose-bound "Request access" CTA and their own access requests inline.
// Reads from /api/data-products/[id] (no ownership gate) — Cosmos-only, no
// Fabric / Power BI dependency.
// ============================================================================

interface DataProductDataset { name: string; typeName?: string; qualifiedName?: string; classifications?: string[]; guid?: string; }
interface DataProductGlossaryLink { name: string; guid?: string; }
interface DataProductState {
  displayName?: string;
  description?: string;
  domain?: string;
  owner?: string;
  certified?: boolean;
  sla?: string;
  bundle?: string[];
  datasets?: DataProductDataset[];
  glossaryLinks?: DataProductGlossaryLink[];
  purviewDataProductId?: string;
  lastRegisteredAt?: string;
}

const useConsumerStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXXL, maxWidth: '1100px' },
  header: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  ownerLine: { color: tokens.colorNeutralForeground3 },
  actions: { marginTop: tokens.spacingVerticalS },
  tabContent: { paddingTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  metaGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalXL, rowGap: tokens.spacingVerticalS, alignItems: 'baseline' },
  metaLabel: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  card: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  empty: { color: tokens.colorNeutralForeground3 },
  // Try it tab
  tryItCaption: { color: tokens.colorNeutralForeground3 },
  tryItKql: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    whiteSpace: 'pre' as const,
    overflowX: 'auto' as const,
    margin: 0,
  },
  tryItActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' as const },
  tryItScroll: { overflowX: 'auto', maxHeight: '360px', marginTop: tokens.spacingVerticalS },
});

const STATUS_COLOR: Record<AccessRequestStatus, 'warning' | 'success' | 'danger' | 'brand'> = {
  pending: 'warning', approved: 'success', rejected: 'danger', completed: 'brand',
};

export function ConsumerDataProductDetail({ id }: { id: string }) {
  const s = useConsumerStyles();
  const [item, setItem] = useState<WorkspaceItem | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [myRequests, setMyRequests] = useState<AccessRequest[]>([]);

  // Try it tab state
  const [tryItLoading, setTryItLoading] = useState(false);
  const [tryItResult, setTryItResult] = useState<{
    database: string; table: string; kql: string;
    columns: string[]; columnTypes: string[]; rows: unknown[][];
    executionMs?: number;
  } | null>(null);
  const [tryItError, setTryItError] = useState<string | null>(null);
  const [tryItGate, setTryItGate] = useState<{ missing: string } | null>(null);

  const loadMyRequests = useCallback(async () => {
    try {
      const r = await fetch(`/api/data-products/${id}/access-requests`);
      const j = await r.json();
      if (j.ok) setMyRequests(j.requests ?? []);
    } catch { /* non-fatal; the request panel just stays empty */ }
  }, [id]);

  const runPreview = useCallback(async () => {
    setTryItLoading(true);
    setTryItError(null);
    setTryItGate(null);
    setTryItResult(null);
    try {
      const r = await fetch(`/api/data-products/${id}/preview`, { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        setTryItResult(j);
      } else if (j.gate) {
        setTryItGate(j.gate);
      } else {
        setTryItError(j.error || 'Preview failed');
      }
    } catch (e: any) {
      setTryItError(e?.message || String(e));
    } finally {
      setTryItLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/data-products/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j.ok) { setItem(j.item); setIsOwner(j.isOwner ?? false); }
        else setError(j.error || 'Failed to load data product');
      })
      .catch((e) => { if (live) setError(e?.message || String(e)); })
      .finally(() => { if (live) setLoading(false); });
    loadMyRequests();
    return () => { live = false; };
  }, [id, loadMyRequests]);

  if (loading) return <Spinner label="Loading data product…" />;
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>;
  if (!item) return null;

  const state = (item.state ?? {}) as DataProductState;
  const name = state.displayName || item.displayName;

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.titleRow}>
          <LockClosedRegular aria-label="Read-only" />
          <Text size={600} weight="semibold">{name}</Text>
          <Badge appearance="outline" color="informative">Read-only</Badge>
          {state.certified && (
            <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>Certified</Badge>
          )}
          {state.domain && <Badge appearance="outline">{state.domain}</Badge>}
          {state.sla && <Badge appearance="tint" color="informative">SLA: {state.sla}</Badge>}
          {isOwner && <Badge appearance="tint" color="warning">You own this product</Badge>}
        </div>
        {state.owner && <Caption1 className={s.ownerLine}><PersonRegular style={{ verticalAlign: 'middle' }} /> Owner: {state.owner}</Caption1>}
        {item.description && <Body1>{item.description}</Body1>}
        <div className={s.actions}>
          <Button
            appearance="primary"
            icon={<KeyRegular />}
            disabled={isOwner}
            title={isOwner ? 'You own this product' : 'Request access to this data product'}
            onClick={() => setDialogOpen(true)}
          >
            Request access
          </Button>
        </div>
      </div>

      <Divider />

      <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as string)}>
        <Tab value="overview" icon={<BookRegular />}>Overview</Tab>
        <Tab value="datasets" icon={<DatabaseRegular />}>Datasets</Tab>
        <Tab value="glossary" icon={<BookRegular />}>Glossary</Tab>
        <Tab value="tryit" icon={<Play20Regular />}>Try it</Tab>
        <Tab value="access" icon={<KeyRegular />}>My data access</Tab>
      </TabList>

      <div className={s.tabContent}>
        {activeTab === 'overview' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}>Overview</Text>
            <div className={s.metaGrid}>
              <Caption1 className={s.metaLabel}>Description</Caption1>
              <Body1>{state.description || item.description || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Domain</Caption1>
              <Body1>{state.domain || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Owner</Caption1>
              <Body1>{state.owner || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>SLA</Caption1>
              <Body1>{state.sla || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Endorsement</Caption1>
              <Body1>{state.certified ? 'Certified' : <span className={s.empty}>None</span>}</Body1>
              <Caption1 className={s.metaLabel}>Catalog</Caption1>
              <Body1>{state.purviewDataProductId
                ? <>Registered <code>{state.purviewDataProductId}</code></>
                : <span className={s.empty}>Not registered with the unified catalog</span>}</Body1>
            </div>
          </Card>
        )}

        {activeTab === 'datasets' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><DatabaseRegular /> Datasets</Text>
            {(state.datasets ?? []).length === 0 ? (
              <Caption1 className={s.empty}>This data product has no published datasets.</Caption1>
            ) : (
              <Table size="small" aria-label="Datasets">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Classifications</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(state.datasets ?? []).map((d, i) => (
                    <TableRow key={d.guid || d.qualifiedName || `${d.name}-${i}`}>
                      <TableCell>{d.name}</TableCell>
                      <TableCell>{d.typeName || '—'}</TableCell>
                      <TableCell>
                        {(d.classifications ?? []).length
                          ? <div className={s.chips}>{(d.classifications ?? []).map((c) => <Badge key={c} appearance="outline" size="small">{c}</Badge>)}</div>
                          : <span className={s.empty}>—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        )}

        {activeTab === 'glossary' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><BookRegular /> Glossary terms</Text>
            {(state.glossaryLinks ?? []).length === 0 ? (
              <Caption1 className={s.empty}>No glossary terms are linked to this data product.</Caption1>
            ) : (
              <div className={s.chips}>
                {(state.glossaryLinks ?? []).map((g) => (
                  <Badge key={g.guid || g.name} appearance="tint" color="brand">{g.name}</Badge>
                ))}
              </div>
            )}
          </Card>
        )}

        {activeTab === 'tryit' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><Play20Regular /> Try it — sample data preview</Text>
            <Caption1 className={s.tryItCaption}>
              Run a live sample query against the backing Azure Data Explorer table for this data product.
              Returns up to 25 rows.
            </Caption1>
            {tryItResult && (
              <pre className={s.tryItKql}>{tryItResult.kql}</pre>
            )}
            <div className={s.tryItActions}>
              <Button
                appearance="primary"
                icon={tryItLoading ? undefined : <Play20Regular />}
                disabled={tryItLoading}
                onClick={runPreview}
              >
                {tryItLoading ? 'Running…' : tryItResult ? 'Run again' : 'Run sample query'}
              </Button>
              {tryItLoading && <Spinner size="tiny" label="Querying ADX…" />}
              {tryItResult && !tryItLoading && (
                <Caption1 className={s.tryItCaption}>
                  {tryItResult.rows.length} row{tryItResult.rows.length !== 1 ? 's' : ''} from{' '}
                  <strong>{tryItResult.table}</strong>
                  {tryItResult.executionMs !== undefined ? ` (${tryItResult.executionMs}ms)` : ''}
                </Caption1>
              )}
            </div>
            {tryItGate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>ADX not configured</MessageBarTitle>
                  Set the <code>{tryItGate.missing}</code> environment variable to enable live data preview on this deployment.
                </MessageBarBody>
              </MessageBar>
            )}
            {tryItError && (
              <MessageBar intent="error">
                <MessageBarBody>{tryItError}</MessageBarBody>
              </MessageBar>
            )}
            {tryItResult && tryItResult.rows.length === 0 && (
              <Caption1 className={s.empty}>
                The query returned no rows. The table may be empty.
              </Caption1>
            )}
            {tryItResult && tryItResult.rows.length > 0 && (
              <div className={s.tryItScroll}>
                <Table size="small" aria-label={`Sample data from ${tryItResult.table}`}>
                  <TableHeader>
                    <TableRow>
                      {tryItResult.columns.map((col) => (
                        <TableHeaderCell key={col}>{col}</TableHeaderCell>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tryItResult.rows.map((row, ri) => (
                      <TableRow key={ri}>
                        {(row as unknown[]).map((cell, ci) => (
                          <TableCell key={ci}>
                            {cell === null || cell === undefined
                              ? <span className={s.empty}>null</span>
                              : String(cell)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        )}

        {activeTab === 'access' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><KeyRegular /> My data access</Text>
            {myRequests.length === 0 ? (
              <Caption1 className={s.empty}>
                You have no access requests for this data product yet. Use{' '}
                <strong>Request access</strong> above to submit one.
              </Caption1>
            ) : (
              <Table size="small" aria-label="My access requests">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Purpose</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Requested</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myRequests.map((rq) => (
                    <TableRow key={rq.id}>
                      <TableCell>{rq.purposeName}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={STATUS_COLOR[rq.status]}>{rq.status}</Badge>
                      </TableCell>
                      <TableCell>{new Date(rq.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        )}
      </div>

      <RequestAccessDialog
        dataProductId={id}
        dataProductName={name}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={() => { setActiveTab('access'); loadMyRequests(); }}
      />
    </div>
  );
}
