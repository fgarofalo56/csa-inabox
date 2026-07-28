'use client';

/**
 * N7d — "Runner checks" panel for the data-quality editor (fold a).
 *
 * Rule-builder data-quality checks (dropdown-only, per loom_no_freeform_config)
 * executed on the **N4 transform runner** with anomaly baselines. The check
 * vocabulary is N6's contract vocabulary (`QUALITY_RULES`). Every run hits the
 * real runner (POST /api/items/data-quality/[id]/checks) — no fabricated
 * results — and its findings are emitted for N17's incident console.
 *
 * Props declared inline (no import of EditorProps — avoids the registry cycle).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Field, Input, Dropdown, Option, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip, ProgressBar,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BeakerRegular, PlayRegular, AddRegular, DeleteRegular, DataTrendingRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { QUALITY_RULES } from '@/lib/dataproducts/contract';

type Engine = 'synapse' | 'databricks' | 'duckdb' | 'fabric';
type Severity = 'error' | 'warning';

interface Check {
  id: string;
  table: string;
  column?: string;
  rule: string;
  value?: string;
  severity: Severity;
}
interface Target {
  engine: Engine;
  synapseServer?: string; databricksHost?: string; databricksHttpPath?: string;
  catalog?: string; database?: string; duckdbPath?: string; fabricEndpoint?: string; schema?: string;
}
interface CheckItem {
  checkId: string; table: string; status: 'pass' | 'fail' | 'error' | 'skipped';
  violations: number | null; message: string; rule: string; column?: string; severity: Severity;
  anomaly: { isAnomaly: boolean; detail: string; zScore: number | null; baseline: { mean: number; stddev: number; samples: number } } | null;
}
interface RunRecord {
  runId: string; ranAt: string; engine: string;
  summary: { total: number; passed: number; failed: number; errored: number; skipped: number; anomalies: number };
  items: CheckItem[]; findingsEmitted: number; ranBy: string;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1040px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2, flexWrap: 'wrap', minWidth: 0 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  checkRow: { display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,1.4fr) auto auto', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  tableWrap: { overflowX: 'auto' },
  hint: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
});

const ENGINES: Array<{ value: Engine; label: string }> = [
  { value: 'synapse', label: 'Synapse SQL' },
  { value: 'databricks', label: 'Databricks SQL' },
  { value: 'duckdb', label: 'DuckDB (sovereign / disconnected)' },
  { value: 'fabric', label: 'Fabric Warehouse (opt-in)' },
];

function statusColor(s: CheckItem['status']): 'success' | 'danger' | 'warning' | 'informative' {
  if (s === 'pass') return 'success';
  if (s === 'fail') return 'danger';
  if (s === 'error') return 'warning';
  return 'informative';
}

export function DqRunnerChecksPanel({ id }: { id: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [target, setTarget] = useState<Target>({ engine: 'synapse', schema: 'analytics' });
  const [lastRun, setLastRun] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id || id === 'new') { setLoading(false); return; }
    (async () => {
      try {
        const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/checks`);
        const j = await r.json();
        if (j.ok) {
          setGate(j.gate?.missing || null);
          setChecks(Array.isArray(j.checks) ? j.checks : []);
          if (j.target) setTarget({ engine: 'synapse', schema: 'analytics', ...j.target });
          setLastRun(j.lastRun || null);
        }
      } catch { /* honest: gate shows after a run attempt */ }
      finally { setLoading(false); }
    })();
  }, [id]);

  const addCheck = useCallback(() => {
    setChecks((p) => [...p, { id: crypto.randomUUID(), table: '', rule: 'not_null', severity: 'error' }]);
  }, []);
  const updateCheck = useCallback((idx: number, patch: Partial<Check>) => {
    setChecks((p) => p.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }, []);
  const removeCheck = useCallback((idx: number) => {
    setChecks((p) => p.filter((_, i) => i !== idx));
  }, []);

  const run = useCallback(async () => {
    setErr(null); setRunning(true);
    try {
      const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checks, target }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); if (j.missing) setGate(j.missing); return; }
      if (j.disabled) { setErr(j.note || 'Surface disabled.'); return; }
      setGate(null);
      setLastRun(j.run || null);
    } catch (e) { setErr((e as Error)?.message || String(e)); }
    finally { setRunning(false); }
  }, [id, checks, target]);

  const ruleNeedsValue = useCallback((rule: string) => {
    return QUALITY_RULES.find((q) => q.value === rule)?.needsValue ?? false;
  }, []);

  const anomalyItems = useMemo(() => (lastRun?.items || []).filter((i) => i.anomaly?.isAnomaly), [lastRun]);

  if (loading) return <Spinner label="Loading runner checks…" />;

  return (
    <div className={s.body}>
      {gate && (
        <MessageBar intent="warning" layout="multiline"><MessageBarBody>
          <MessageBarTitle>Transform runner not configured</MessageBarTitle>
          Runner checks execute on the N4 transform runner. Set <code>{gate}</code> on the loom-console env to enable it.
          Everything below still renders — pick a target and author checks now; runs light up once the runner is wired.
        </MessageBarBody></MessageBar>
      )}
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Run failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      {/* Engine target */}
      <div className={s.card}>
        <span className={s.sectionHeader}><BeakerRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Runner engine &amp; target</Subtitle2>
          <Badge appearance="tint" color="brand">N4 transform runner</Badge>
        </span>
        <div className={s.grid}>
          <Field label="Engine">
            <Dropdown value={ENGINES.find((e) => e.value === target.engine)?.label} selectedOptions={[target.engine]}
              onOptionSelect={(_, d) => d.optionValue && setTarget((p) => ({ ...p, engine: d.optionValue as Engine }))}>
              {ENGINES.map((e) => <Option key={e.value} value={e.value}>{e.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Schema"><Input value={target.schema || ''} onChange={(_, d) => setTarget((p) => ({ ...p, schema: d.value }))} placeholder="analytics" /></Field>
          {target.engine === 'synapse' && (<>
            <Field label="Synapse server" hint="Blank = DBT_SYNAPSE_SERVER env"><Input value={target.synapseServer || ''} onChange={(_, d) => setTarget((p) => ({ ...p, synapseServer: d.value }))} /></Field>
            <Field label="Database"><Input value={target.database || ''} onChange={(_, d) => setTarget((p) => ({ ...p, database: d.value }))} /></Field>
          </>)}
          {target.engine === 'databricks' && (<>
            <Field label="Databricks host"><Input value={target.databricksHost || ''} onChange={(_, d) => setTarget((p) => ({ ...p, databricksHost: d.value }))} /></Field>
            <Field label="HTTP path"><Input value={target.databricksHttpPath || ''} onChange={(_, d) => setTarget((p) => ({ ...p, databricksHttpPath: d.value }))} /></Field>
            <Field label="Catalog"><Input value={target.catalog || ''} onChange={(_, d) => setTarget((p) => ({ ...p, catalog: d.value }))} /></Field>
          </>)}
          {target.engine === 'duckdb' && (
            <Field label="DuckDB path" hint="Path under the mounted lake"><Input value={target.duckdbPath || ''} onChange={(_, d) => setTarget((p) => ({ ...p, duckdbPath: d.value }))} placeholder="loom.duckdb" /></Field>
          )}
          {target.engine === 'fabric' && (
            <Field label="Fabric endpoint" hint="Opt-in only"><Input value={target.fabricEndpoint || ''} onChange={(_, d) => setTarget((p) => ({ ...p, fabricEndpoint: d.value }))} /></Field>
          )}
        </div>
      </div>

      {/* Check builder */}
      <div className={s.card}>
        <span className={s.sectionHeader}><DataTrendingRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Rule-builder checks</Subtitle2>
          <Caption1 className={s.hint}>Dropdown-only — the N6 contract rule vocabulary.</Caption1>
        </span>

        {checks.length === 0 ? (
          <EmptyState
            icon={<DataTrendingRegular />}
            title="No checks yet"
            body="Add rule-builder checks (a rule + a table, and a column for most rules). They compile to dbt data tests and run on the N4 transform runner. Each check also tracks an anomaly baseline across runs — a violation spike trips even when it is under the hard threshold."
            primaryAction={{ label: 'Add a check', onClick: addCheck }}
          />
        ) : (
          <>
            {checks.map((c, i) => (
              <div key={c.id} className={s.checkRow}>
                <Field label={i === 0 ? 'Table' : undefined}><Input value={c.table} onChange={(_, d) => updateCheck(i, { table: d.value })} placeholder="orders" /></Field>
                <Field label={i === 0 ? 'Column' : undefined}><Input value={c.column || ''} onChange={(_, d) => updateCheck(i, { column: d.value })} placeholder="id" /></Field>
                <Field label={i === 0 ? 'Rule' : undefined}>
                  <Dropdown value={QUALITY_RULES.find((q) => q.value === c.rule)?.label} selectedOptions={[c.rule]}
                    onOptionSelect={(_, d) => d.optionValue && updateCheck(i, { rule: d.optionValue })}>
                    {QUALITY_RULES.map((q) => <Option key={q.value} value={q.value}>{q.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label={i === 0 ? 'Value' : undefined}>
                  <Input value={c.value || ''} disabled={!ruleNeedsValue(c.rule)} onChange={(_, d) => updateCheck(i, { value: d.value })}
                    placeholder={ruleNeedsValue(c.rule) ? 'e.g. 0..100 / 24h / a,b,c' : '—'} />
                </Field>
                <Field label={i === 0 ? 'Severity' : undefined}>
                  <Dropdown value={c.severity === 'error' ? 'Error' : 'Warning'} selectedOptions={[c.severity]}
                    onOptionSelect={(_, d) => d.optionValue && updateCheck(i, { severity: d.optionValue as Severity })}>
                    <Option value="error">Error</Option><Option value="warning">Warning</Option>
                  </Dropdown>
                </Field>
                <Tooltip content="Remove check" relationship="label">
                  <Button appearance="subtle" icon={<DeleteRegular />} onClick={() => removeCheck(i)} aria-label="Remove check" />
                </Tooltip>
              </div>
            ))}
            <div className={s.row}>
              <Button appearance="secondary" icon={<AddRegular />} onClick={addCheck}>Add check</Button>
            </div>
          </>
        )}

        <div className={s.row}>
          <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <PlayRegular />} disabled={running || checks.length === 0} onClick={run}>
            {running ? 'Running on runner…' : 'Run checks on N4 runner'}
          </Button>
          <Caption1 className={s.hint}>Runs the checks as dbt tests; findings are emitted for the incident console.</Caption1>
        </div>
        {running && <ProgressBar />}
      </div>

      {/* Anomaly callout */}
      {anomalyItems.length > 0 && (
        <MessageBar intent="warning" layout="multiline"><MessageBarBody>
          <MessageBarTitle>{anomalyItems.length} anomaly baseline outlier(s)</MessageBarTitle>
          {anomalyItems.map((a) => <div key={a.checkId} className={s.mono}>{a.rule} on {a.table}{a.column ? `.${a.column}` : ''}: {a.anomaly?.detail}</div>)}
        </MessageBarBody></MessageBar>
      )}

      {/* Results */}
      {lastRun && (
        <div className={s.card}>
          <span className={s.sectionHeader}><BeakerRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Last run</Subtitle2>
            <div className={s.badgeRow}>
              <Badge appearance="tint" color="success">{lastRun.summary.passed} passed</Badge>
              {lastRun.summary.failed > 0 && <Badge appearance="tint" color="danger">{lastRun.summary.failed} failed</Badge>}
              {lastRun.summary.anomalies > 0 && <Badge appearance="tint" color="warning" icon={<DataTrendingRegular />}>{lastRun.summary.anomalies} anomaly</Badge>}
              {lastRun.summary.errored > 0 && <Badge appearance="tint" color="warning">{lastRun.summary.errored} errored</Badge>}
              {lastRun.summary.skipped > 0 && <Badge appearance="tint" color="informative">{lastRun.summary.skipped} skipped</Badge>}
              <Badge appearance="outline">{lastRun.findingsEmitted} finding(s) → N17</Badge>
            </div>
          </span>
          <Caption1 className={s.hint}>{lastRun.engine} · {new Date(lastRun.ranAt).toLocaleString()} · {lastRun.ranBy}</Caption1>
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Check results">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Rule</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Violations</TableHeaderCell>
                  <TableHeaderCell>Baseline</TableHeaderCell>
                  <TableHeaderCell>Detail</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lastRun.items.map((it) => (
                  <TableRow key={it.checkId}>
                    <TableCell>{it.rule}{it.column ? `.${it.column}` : ''}</TableCell>
                    <TableCell>{it.table || '—'}</TableCell>
                    <TableCell><Badge appearance="tint" color={statusColor(it.status)}>{it.status}</Badge></TableCell>
                    <TableCell>{it.violations == null ? '—' : it.violations}</TableCell>
                    <TableCell>
                      {it.anomaly && it.anomaly.baseline.samples > 0
                        ? <span className={s.mono}>{it.anomaly.baseline.mean} ± {it.anomaly.baseline.stddev} (n={it.anomaly.baseline.samples}){it.anomaly.isAnomaly ? ' ⚠' : ''}</span>
                        : <Caption1 className={s.hint}>building…</Caption1>}
                    </TableCell>
                    <TableCell><span className={s.mono}>{it.message}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
