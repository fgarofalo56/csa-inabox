'use client';

/**
 * Governance → Data quality (run + results + monitors).
 *
 * Extends the Loom-native DQ rule store with the missing run/results surface and
 * always-on enforcement, all Azure-native (no Microsoft Fabric):
 *   - Rules    : author rules (shared store; same as /catalog/data-quality)
 *   - Run      : execute the rule set on Kusto / Databricks SQL / Synapse SQL
 *                (/api/dq/run) and see the composite score + per-rule breakdown
 *   - Results  : run history with pass% bars (/api/dq/results)
 *   - Monitors : Delta enforced constraints + Databricks Lakehouse Monitoring
 *                (/api/dq/monitors)
 *
 * Every control calls a real backend; an honest Fluent MessageBar surfaces the
 * exact missing env var when an engine isn't wired. No mock data.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Button, Badge, Body1, Caption1, Subtitle2, Text,
  TabList, Tab, Field, Input, Dropdown, Option, Textarea, Switch,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular, Edit20Regular, Play20Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

type CheckType = 'not-null' | 'unique' | 'range' | 'regex' | 'freshness';
interface DqRule {
  id: string; name: string; scope: string; check: CheckType; threshold: number;
  pattern?: string; min?: number; max?: number; enabled: boolean;
}
interface RuleResult { ruleId: string; name: string; check: CheckType; scope: string; percentage: number | null; passed: boolean; detail: string }
interface DqRun { id: string; backend: string; target: string; score: number | null; ruleCount: number; passingRules: number; breakdown: RuleResult[]; ranAt: string; ranBy: string; tables?: string[] }

const useStyles = makeStyles({
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL, maxWidth: '760px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap' },
  grow: { flex: 1 },
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, minWidth: '420px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  pctCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  bar: { flex: 1, minWidth: '60px', maxWidth: '140px', height: tokens.spacingVerticalSNudge, backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusCircular, overflow: 'hidden' },
  barFill: { height: '100%', display: 'block' },
  scoreBig: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold },
});

const CHECK_TYPES: { value: CheckType; label: string }[] = [
  { value: 'not-null', label: 'Not null' }, { value: 'unique', label: 'Unique' },
  { value: 'range', label: 'Range' }, { value: 'regex', label: 'Regex pattern' }, { value: 'freshness', label: 'Freshness' },
];
const BACKENDS = [
  { value: 'kusto', label: 'Azure Data Explorer (Kusto)' },
  { value: 'databricks', label: 'Databricks SQL' },
  { value: 'synapse', label: 'Synapse SQL' },
];

function pctColor(p: number): string {
  return p >= 90 ? 'var(--loom-accent-green)' : p >= 70 ? 'var(--loom-accent-amber)' : 'var(--loom-accent-orange)';
}

export default function GovernanceDataQualityPage() {
  const s = useStyles();
  const [tab, setTab] = useState<'rules' | 'run' | 'results' | 'monitors'>('rules');
  return (
    <GovernanceShell sectionTitle="Data quality" sectionBadge="Azure-native">
      <Caption1 className={s.intro}>
        Define data-quality rules, run them on your workspace engine (Kusto, Databricks SQL, or Synapse SQL), review results over time,
        and enforce always-on quality with Delta constraints + Databricks Lakehouse Monitoring. No Microsoft Fabric dependency.
      </Caption1>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)} style={{ marginBottom: 16 }}>
        <Tab value="rules">Rules</Tab>
        <Tab value="run">Run</Tab>
        <Tab value="results">Results</Tab>
        <Tab value="monitors">Monitors</Tab>
      </TabList>
      {tab === 'rules' && <RulesTab />}
      {tab === 'run' && <RunTab />}
      {tab === 'results' && <ResultsTab />}
      {tab === 'monitors' && <MonitorsTab />}
    </GovernanceShell>
  );
}

// ----------------------------- Rules -----------------------------
function RulesTab() {
  const s = useStyles();
  const [rules, setRules] = useState<DqRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DqRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlgErr, setDlgErr] = useState<string[] | null>(null);
  const [name, setName] = useState(''); const [scopeType, setScopeType] = useState<'table' | 'column'>('column');
  const [scopeName, setScopeName] = useState(''); const [check, setCheck] = useState<CheckType>('not-null');
  const [threshold, setThreshold] = useState('80'); const [pattern, setPattern] = useState('');
  const [min, setMin] = useState(''); const [max, setMax] = useState(''); const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/dq/rules'); const j = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to load'); return; }
      setRules(j.rules || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function reset() {
    setName(''); setScopeType('column'); setScopeName(''); setCheck('not-null'); setThreshold('80');
    setPattern(''); setMin(''); setMax(''); setEnabled(true); setDlgErr(null); setEditing(null);
  }
  function edit(r: DqRule) {
    setEditing(r); setName(r.name);
    const [t, n] = r.scope.split(':'); setScopeType((t as any) || 'column'); setScopeName(n || '');
    setCheck(r.check); setThreshold(String(r.threshold)); setPattern(r.pattern || '');
    setMin(r.min != null ? String(r.min) : ''); setMax(r.max != null ? String(r.max) : ''); setEnabled(r.enabled);
    setDlgErr(null); setOpen(true);
  }
  async function save() {
    setBusy(true); setDlgErr(null);
    const payload: any = { name: name.trim(), scope: `${scopeType}:${scopeName}`, check, threshold: parseInt(threshold, 10), enabled };
    if (check === 'regex' && pattern) payload.pattern = pattern;
    if (check === 'range') { payload.min = parseInt(min, 10); payload.max = parseInt(max, 10); }
    if (editing) payload.id = editing.id;
    try {
      const r = await fetch('/api/dq/rules', { method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!j.ok) { setDlgErr(Array.isArray(j.errors) ? j.errors : [j.error || 'Error']); return; }
      setRules(j.rules || []); setOpen(false); reset();
    } catch (e: any) { setDlgErr([e?.message || String(e)]); } finally { setBusy(false); }
  }
  async function del(id: string) {
    const r = await fetch(`/api/dq/rules?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json(); if (j.ok) setRules(j.rules || []); else setError(j.error || 'Delete failed');
  }

  const cols: LoomColumn<DqRule>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (r) => r.name, render: (r) => <Body1><strong>{r.name}</strong></Body1> },
    { key: 'scope', label: 'Scope', sortable: true, filterable: true, getValue: (r) => r.scope, render: (r) => <Caption1>{r.scope}</Caption1> },
    { key: 'check', label: 'Check', sortable: true, filterable: true, width: 130, getValue: (r) => r.check, render: (r) => <Badge appearance="tint" size="small">{r.check}</Badge> },
    { key: 'threshold', label: 'Threshold', sortable: true, width: 110, getValue: (r) => r.threshold, render: (r) => <Caption1>{r.threshold}{r.check === 'freshness' ? 'd' : '%'}</Caption1> },
    { key: 'enabled', label: 'Status', sortable: true, width: 110, getValue: (r) => (r.enabled ? 1 : 0), render: (r) => <Badge appearance="tint" color={r.enabled ? 'success' : 'warning'} size="small">{r.enabled ? 'Enabled' : 'Disabled'}</Badge> },
    { key: 'actions', label: 'Actions', sortable: false, width: 96, render: (r) => (
      <span style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
        <Button size="small" appearance="transparent" icon={<Edit20Regular />} onClick={() => edit(r)} aria-label="Edit" />
        <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => del(r.id)} aria-label="Delete" />
      </span>) },
  ];

  return (
    <Section title="Quality rules" actions={
      <span style={{ display: 'flex', gap: 8 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => { reset(); setOpen(true); }}>New rule</Button>
      </span>}>
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {!rules ? <Spinner label="Loading rules…" /> : (
        <LoomDataTable<DqRule> columns={cols} rows={rules} getRowId={(r) => r.id} empty="No rules yet. Create one to start monitoring data quality." />
      )}
      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) { setOpen(false); reset(); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? 'Edit rule' : 'New data-quality rule'}</DialogTitle>
            <DialogContent>
              {dlgErr && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{dlgErr.map((e, i) => <div key={i}>{e}</div>)}</MessageBarBody></MessageBar>}
              <div className={s.fields}>
                <Field label="Rule name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Customer ID not null" /></Field>
                <div className={s.row}>
                  <Field label="Scope type" style={{ flex: 1 }}>
                    <Dropdown selectedOptions={[scopeType]} value={scopeType === 'table' ? 'Table' : 'Column'} onOptionSelect={(_, d) => setScopeType((d.optionValue as any) || 'column')}>
                      <Option value="table">Table</Option><Option value="column">Column</Option>
                    </Dropdown>
                  </Field>
                  <Field label={scopeType === 'table' ? 'Table name' : 'Column (table.column)'} style={{ flex: 2 }}>
                    <Input value={scopeName} onChange={(_, d) => setScopeName(d.value)} placeholder={scopeType === 'table' ? 'customers' : 'customers.customer_id'} />
                  </Field>
                </div>
                <Field label="Check type" required>
                  <Dropdown selectedOptions={[check]} value={CHECK_TYPES.find((c) => c.value === check)?.label} onOptionSelect={(_, d) => setCheck((d.optionValue as any) || 'not-null')}>
                    {CHECK_TYPES.map((c) => <Option key={c.value} value={c.value}>{c.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label={`Threshold (${check === 'freshness' ? 'days' : '%'})`} required>
                  <Input type="number" value={threshold} onChange={(_, d) => setThreshold(d.value)} />
                </Field>
                {check === 'regex' && <Field label="Regex pattern" required><Textarea value={pattern} onChange={(_, d) => setPattern(d.value)} placeholder="^[A-Z]{2}\\d{4}$" /></Field>}
                {check === 'range' && (
                  <div className={s.row}>
                    <Field label="Min" style={{ flex: 1 }}><Input type="number" value={min} onChange={(_, d) => setMin(d.value)} /></Field>
                    <Field label="Max" style={{ flex: 1 }}><Input type="number" value={max} onChange={(_, d) => setMax(d.value)} /></Field>
                  </div>)}
                <Switch label="Enable this rule" checked={enabled} onChange={(_, d) => setEnabled(d.checked)} />
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setOpen(false); reset(); }} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={save} disabled={busy || !name.trim() || !scopeName.trim()}>{editing ? 'Update' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}

// ------------------------------ Run ------------------------------
function RunTab() {
  const s = useStyles();
  const [backend, setBackend] = useState('kusto');
  const [database, setDatabase] = useState(''); const [warehouseId, setWarehouseId] = useState('');
  const [catalog, setCatalog] = useState(''); const [schema, setSchema] = useState('');
  const [synapsePool, setSynapsePool] = useState<'serverless' | 'dedicated'>('serverless');
  const [tables, setTables] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<DqRun | null>(null);
  const [gate, setGate] = useState<{ missing: string; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doRun() {
    setBusy(true); setError(null); setGate(null); setRun(null);
    const body: any = { backend };
    if (database.trim()) body.database = database.trim();
    if (warehouseId.trim()) body.warehouseId = warehouseId.trim();
    if (catalog.trim()) body.catalog = catalog.trim();
    if (schema.trim()) body.schema = schema.trim();
    if (backend === 'synapse') body.synapsePool = synapsePool;
    const t = tables.split(',').map((x) => x.trim()).filter(Boolean);
    if (t.length) body.tableNames = t;
    try {
      const r = await fetch('/api/dq/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 503 && j.code === 'not_configured') { setGate({ missing: j.missing, error: j.error }); return; }
      if (!j.ok) { setError(j.error || 'Run failed'); return; }
      setRun(j.run);
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }

  const cols: LoomColumn<RuleResult>[] = [
    { key: 'name', label: 'Rule', sortable: true, filterable: true, getValue: (r) => r.name, render: (r) => <Body1>{r.name}</Body1> },
    { key: 'check', label: 'Check', sortable: true, width: 120, getValue: (r) => r.check, render: (r) => <Badge appearance="tint" size="small">{r.check}</Badge> },
    { key: 'pct', label: 'Pass %', sortable: true, width: 180, getValue: (r) => r.percentage ?? -1, render: (r) => r.percentage == null ? <Caption1>—</Caption1> : (
      <span className={s.pctCell}><span className={s.bar}><span className={s.barFill} style={{ width: `${r.percentage}%`, backgroundColor: pctColor(r.percentage) }} /></span><Text size={200}>{r.percentage.toFixed(1)}%</Text></span>) },
    { key: 'passed', label: 'Result', sortable: true, width: 100, getValue: (r) => (r.passed ? 1 : 0), render: (r) => <Badge appearance="tint" color={r.passed ? 'success' : 'danger'} size="small">{r.passed ? 'Pass' : 'Fail'}</Badge> },
    { key: 'detail', label: 'Detail', filterable: true, getValue: (r) => r.detail, render: (r) => <Caption1 style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{r.detail}</Caption1> },
  ];

  return (
    <Section title="Run rules" actions={<Button appearance="primary" icon={<Play20Regular />} onClick={doRun} disabled={busy}>{busy ? 'Running…' : 'Run rules'}</Button>}>
      <div className={s.row} style={{ marginBottom: 16 }}>
        <Field label="Engine" style={{ minWidth: 240 }}>
          <Dropdown selectedOptions={[backend]} value={BACKENDS.find((b) => b.value === backend)?.label} onOptionSelect={(_, d) => setBackend(d.optionValue || 'kusto')}>
            {BACKENDS.map((b) => <Option key={b.value} value={b.value}>{b.label}</Option>)}
          </Dropdown>
        </Field>
        {backend === 'kusto' && <Field label="ADX database" style={{ minWidth: 200 }}><Input value={database} onChange={(_, d) => setDatabase(d.value)} placeholder="(LOOM_KUSTO_DEFAULT_DB)" /></Field>}
        {backend === 'databricks' && <Field label="SQL Warehouse id" style={{ minWidth: 220 }}><Input value={warehouseId} onChange={(_, d) => setWarehouseId(d.value)} placeholder="(LOOM_DATABRICKS_SQL_WAREHOUSE_ID)" /></Field>}
        {backend === 'synapse' && (
          <Field label="Pool" style={{ minWidth: 180 }}>
            <Dropdown selectedOptions={[synapsePool]} value={synapsePool === 'dedicated' ? 'Dedicated' : 'Serverless'} onOptionSelect={(_, d) => setSynapsePool((d.optionValue as any) || 'serverless')}>
              <Option value="serverless">Serverless</Option><Option value="dedicated">Dedicated</Option>
            </Dropdown>
          </Field>)}
        {(backend === 'databricks' || backend === 'synapse') && <>
          <Field label="Catalog" style={{ minWidth: 160 }}><Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder="optional" /></Field>
          <Field label="Schema" style={{ minWidth: 160 }}><Input value={schema} onChange={(_, d) => setSchema(d.value)} placeholder="optional" /></Field>
        </>}
        <Field label="Tables (comma-sep, optional)" style={{ flex: 1, minWidth: 220 }}><Input value={tables} onChange={(_, d) => setTables(d.value)} placeholder="all enabled rules if blank" /></Field>
      </div>

      {gate && <MessageBar intent="warning" style={{ marginBottom: 12 }}><MessageBarBody><MessageBarTitle>Engine not configured</MessageBarTitle>{gate.error} Set the <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{gate.missing}</code> app setting on the Console (admin-plane bicep).</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {run && (<>
        <div className={s.toolbar}>
          <Text className={s.scoreBig} style={{ color: run.score == null ? tokens.colorNeutralForeground3 : pctColor(run.score) }}>{run.score == null ? '—' : `${run.score}%`}</Text>
          <span style={{ minWidth: 0 }}><Subtitle2>Composite score</Subtitle2><br /><Caption1 style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{run.passingRules}/{run.ruleCount} rules passed · {run.backend} · {run.target}</Caption1></span>
        </div>
        <LoomDataTable<RuleResult> columns={cols} rows={run.breakdown} getRowId={(r) => r.ruleId} empty="No applicable enabled rules for this target." />
      </>)}
    </Section>
  );
}

// ---------------------------- Results ----------------------------
function ResultsTab() {
  const s = useStyles();
  const [runs, setRuns] = useState<DqRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await fetch('/api/dq/results'); const j = await r.json(); if (!j.ok) { setError(j.error || 'Failed'); return; } setRuns(j.runs || []); }
    catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const cols: LoomColumn<DqRun>[] = [
    { key: 'ranAt', label: 'Run at', sortable: true, width: 200, getValue: (r) => r.ranAt, render: (r) => <Caption1>{new Date(r.ranAt).toLocaleString()}</Caption1> },
    { key: 'backend', label: 'Engine', sortable: true, filterable: true, width: 140, getValue: (r) => r.backend, render: (r) => <Badge appearance="tint" size="small">{r.backend}</Badge> },
    { key: 'score', label: 'Score', sortable: true, width: 180, getValue: (r) => r.score ?? -1, render: (r) => r.score == null ? <Caption1>—</Caption1> : (
      <span className={s.pctCell}><span className={s.bar}><span className={s.barFill} style={{ width: `${r.score}%`, backgroundColor: pctColor(r.score) }} /></span><Text size={200}>{r.score}%</Text></span>) },
    { key: 'passing', label: 'Rules passed', sortable: true, width: 130, getValue: (r) => r.passingRules, render: (r) => <Caption1>{r.passingRules}/{r.ruleCount}</Caption1> },
    { key: 'ranBy', label: 'Run by', sortable: true, filterable: true, getValue: (r) => r.ranBy, render: (r) => <Caption1>{r.ranBy}</Caption1> },
  ];
  return (
    <Section title="Run history" actions={<Button icon={<ArrowSync24Regular />} onClick={load}>Refresh</Button>}>
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {!runs ? <Spinner label="Loading run history…" /> : (
        <LoomDataTable<DqRun> columns={cols} rows={runs} getRowId={(r) => r.id} empty="No runs yet. Use the Run tab to execute your rule set." />
      )}
    </Section>
  );
}

// ---------------------------- Monitors ----------------------------
interface DeltaConstraint { name: string; expression: string }
function MonitorsTab() {
  const s = useStyles();
  const [table, setTable] = useState(''); const [catalog, setCatalog] = useState(''); const [schema, setSchema] = useState('');
  const [data, setData] = useState<any>(null); const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ missing: string; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<DqRule[]>([]);
  const [ruleId, setRuleId] = useState('');
  const [outputSchema, setOutputSchema] = useState(''); const [assetsDir, setAssetsDir] = useState('');

  useEffect(() => { fetch('/api/dq/rules').then((r) => r.json()).then((j) => { if (j.ok) setRules(j.rules || []); }).catch(() => {}); }, []);

  async function load() {
    if (!table.trim()) return;
    setBusy(true); setError(null); setGate(null);
    const qs = new URLSearchParams({ table: table.trim() });
    if (catalog.trim()) qs.set('catalog', catalog.trim());
    if (schema.trim()) qs.set('schema', schema.trim());
    try {
      const r = await fetch(`/api/dq/monitors?${qs}`); const j = await r.json();
      if (r.status === 503 && j.code === 'not_configured') { setGate({ missing: j.missing, error: j.error }); return; }
      if (!j.ok) { setError(j.error || 'Failed'); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }
  async function action(payload: any) {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/dq/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table: table.trim(), catalog: catalog.trim() || undefined, schema: schema.trim() || undefined, ...payload }) });
      const j = await r.json();
      if (!j.ok && j.error) setError(j.error);
      await load();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }

  const constraints: DeltaConstraint[] = Array.isArray(data?.constraints) ? data.constraints : [];
  const monitor = data?.monitor && !data.monitor.error ? data.monitor : null;
  const refreshes: any[] = Array.isArray(data?.refreshes) ? data.refreshes : [];

  return (
    <Section title="Always-on monitors" actions={<Badge appearance="tint" color="informative">Databricks · Delta + Lakehouse Monitoring</Badge>}>
      <Caption1 className={s.intro}>Enforce a rule as a Delta CHECK / NOT NULL constraint, or attach Databricks Lakehouse Monitoring for profiling + drift. Unity Catalog table on the workspace Databricks SQL Warehouse.</Caption1>
      <div className={s.row} style={{ marginBottom: 16 }}>
        <Field label="Catalog" style={{ minWidth: 160 }}><Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder="main" /></Field>
        <Field label="Schema" style={{ minWidth: 160 }}><Input value={schema} onChange={(_, d) => setSchema(d.value)} placeholder="sales" /></Field>
        <Field label="Table" style={{ minWidth: 200 }} required><Input value={table} onChange={(_, d) => setTable(d.value)} placeholder="customers" /></Field>
        <Button appearance="primary" onClick={load} disabled={busy || !table.trim()} style={{ alignSelf: 'flex-end' }}>Load</Button>
      </div>

      {gate && <MessageBar intent="warning" style={{ marginBottom: 12 }}><MessageBarBody><MessageBarTitle>Databricks not configured</MessageBarTitle>{gate.error} Set <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{gate.missing}</code> on the Console (admin-plane bicep).</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {data && <>
        <Subtitle2 style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>Delta enforced constraints</Subtitle2>
        <div className={s.row} style={{ marginBottom: 12 }}>
          <Field label="Apply rule as constraint" style={{ minWidth: 280 }}>
            <Dropdown selectedOptions={ruleId ? [ruleId] : []} value={rules.find((r) => r.id === ruleId)?.name || ''} onOptionSelect={(_, d) => setRuleId(d.optionValue || '')} placeholder="Pick a rule">
              {rules.filter((r) => r.check !== 'unique' && r.check !== 'freshness').map((r) => <Option key={r.id} value={r.id} text={`${r.name} (${r.check})`}>{`${r.name} (${r.check})`}</Option>)}
            </Dropdown>
          </Field>
          <Button onClick={() => ruleId && action({ action: 'apply-constraint', ruleId })} disabled={busy || !ruleId} style={{ alignSelf: 'flex-end' }}>Apply constraint</Button>
        </div>
        {constraints.length === 0 ? <Caption1>No Delta CHECK constraints on this table yet.</Caption1> : (
          <LoomDataTable<DeltaConstraint> columns={[
            { key: 'name', label: 'Constraint', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <Body1>{c.name}</Body1> },
            { key: 'expr', label: 'Expression', filterable: true, getValue: (c) => c.expression, render: (c) => <Caption1 style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.expression}</Caption1> },
            { key: 'drop', label: '', width: 80, render: (c) => <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => action({ action: 'drop-constraint', name: c.name })} aria-label="Drop" /> },
          ]} rows={constraints} getRowId={(c) => c.name} empty="No constraints." />
        )}

        <Subtitle2 style={{ display: 'block', marginTop: 24, marginBottom: 8 }}>Lakehouse Monitoring</Subtitle2>
        {monitor ? (<>
          <div className={s.toolbar}>
            <Badge appearance="tint" color="success">{monitor.status || 'active'}</Badge>
            {monitor.profileMetricsTableName && <Caption1 style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>Metrics: {monitor.profileMetricsTableName}</Caption1>}
            <Button onClick={() => action({ action: 'refresh-monitor' })} disabled={busy} icon={<ArrowSync24Regular />}>Refresh metrics</Button>
          </div>
          {refreshes.length > 0 && (
            <LoomDataTable<any> columns={[
              { key: 'refreshId', label: 'Refresh', sortable: true, getValue: (r) => r.refreshId, render: (r) => <Caption1>{r.refreshId}</Caption1> },
              { key: 'state', label: 'State', sortable: true, width: 140, getValue: (r) => r.state, render: (r) => <Badge appearance="tint" size="small">{r.state}</Badge> },
            ]} rows={refreshes} getRowId={(r) => r.refreshId} empty="No refreshes." />
          )}
        </>) : (
          <div className={s.row}>
            <Field label="Output schema" style={{ minWidth: 200 }}><Input value={outputSchema} onChange={(_, d) => setOutputSchema(d.value)} placeholder="main.monitoring" /></Field>
            <Field label="Assets dir" style={{ minWidth: 200 }}><Input value={assetsDir} onChange={(_, d) => setAssetsDir(d.value)} placeholder="/Shared/monitoring" /></Field>
            <Button appearance="primary" onClick={() => action({ action: 'create-monitor', outputSchema, assetsDir, profileType: 'snapshot' })} disabled={busy || !outputSchema.trim() || !assetsDir.trim()} style={{ alignSelf: 'flex-end' }}>Create snapshot monitor</Button>
          </div>
        )}
      </>}
    </Section>
  );
}
