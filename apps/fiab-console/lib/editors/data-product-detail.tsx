'use client';

/**
 * Data Observability surfaces for the data-product editor (F19 / F20).
 *
 *   useObservability(id)      — one live GET /api/data-products/[id]/observability
 *                               feeding both the Overview gauge and the tab.
 *   DqScoreGauge              — data-quality score gauge (Overview toolbar).
 *   ObservabilityTabContent   — lineage graph (Purview classic Data Map) +
 *                               health charts (ADX KQL) + health-action cards.
 *
 * Azure-native, NO Microsoft Fabric dependency. Honest gates: an ADX-unset or
 * Purview-unset deployment renders a Fluent MessageBar naming the exact env var
 * (LOOM_KUSTO_CLUSTER_URI / LOOM_PURVIEW_ACCOUNT) and the affected section is
 * NOT rendered with fake data — the rest of the tab still renders.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Spinner, ProgressBar, Text,
  Card, CardHeader, Dropdown, Option, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, BranchFork20Regular, Pulse20Regular,
  DataTrending20Regular, ArrowClockwise20Regular, ScanType20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  col: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  gauge: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '180px' },
  gaugeHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '12px' },
  actionGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' },
  card: { padding: '12px' },
  kql: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '11px',
    color: tokens.colorNeutralForeground3, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    margin: 0, marginTop: '4px',
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
  const s = useStyles();
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
  const s = useStyles();
  if (!columns.length) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(no columns)</Caption1>;
  return (
    <div className={s.scroll}>
      <Table size="extra-small" aria-label="KQL result">
        <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, 50).map((row, i) => (
            <TableRow key={i}>
              {columns.map((_, j) => <TableCell key={j}><code style={{ fontSize: 11 }}>{String((row as any[])[j] ?? '')}</code></TableCell>)}
            </TableRow>
          ))}
          {rows.length === 0 && <TableRow><TableCell>(no rows)</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------
// Trigger-scan card — picks a real Purview source + scan.
// ------------------------------------------------------------------
function TriggerScanCard({ id }: { id: string }) {
  const s = useStyles();
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
      <div className={s.col} style={{ marginTop: 8 }}>
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
  const s = useStyles();
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
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
  const s = useStyles();
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
                  <TableCell><code style={{ fontSize: 11 }}>{b.scope}</code></TableCell>
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
                    <TableCell><code style={{ fontSize: 11 }}>{String(n.id).slice(0, 12)}…</code></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {lineage.edges.length > 0 && (
              <>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Edges</Caption1>
                <div className={s.scroll}>
                  {lineage.edges.map((e: any, i: number) => (
                    <div key={i}><code style={{ fontSize: 11 }}>{String(e.from).slice(0, 8)}… → {String(e.to).slice(0, 8)}…{e.label ? ` (${e.label})` : ''}</code></div>
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
