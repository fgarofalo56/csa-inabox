'use client';

/**
 * DataQualityEditor — the standalone `data-quality` item type (W11).
 *
 * A first-class, workspace-scoped run configuration over the shared Data
 * Quality Rule Engine: pin a backend (ADX / Databricks / Synapse) + a target,
 * run the tenant's enabled DQ rules against it, and see a live composite
 * scorecard + per-rule breakdown + run history. Real backend on every run
 * (data-quality-client `runDqRules` via the item's run route) — Azure-native, no
 * Microsoft Fabric dependency (no-vaporware.md / no-fabric-dependency.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Field, Input, Dropdown, Option, Spinner, Divider, ProgressBar,
  Radio, RadioGroup, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Link,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldCheckmarkRegular, PlayRegular, HistoryRegular, DatabaseRegular,
  BeakerRegular, ArrowSyncRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { DqRunnerChecksPanel } from './components/dq-runner-checks-panel';
import { DqDataDiffPanel } from './components/dq-data-diff-panel';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useItemState } from './palantir/shared';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

type DqBackend = 'kusto' | 'databricks' | 'synapse';
interface DqRuleResultLite { ruleId: string; name: string; check: string; scope: string; percentage: number | null; passed: boolean; detail: string }
interface DqItemRunLite {
  id: string; ranAt: string; backend: string; target: string; score: number | null;
  ruleCount: number; passingRules: number; failingRules: number;
  status: 'passed' | 'failed' | 'no_rules' | 'errored'; breakdown: DqRuleResultLite[]; ranBy: string;
}
interface DqState extends Record<string, unknown> {
  backend?: DqBackend; database?: string; warehouseId?: string; catalog?: string; schema?: string;
  synapsePool?: 'serverless' | 'dedicated'; tableNames?: string[]; runs?: DqItemRunLite[];
}

const useStyles = makeStyles({
  tabBar: { paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1000px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacingHorizontalM },
  scoreRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  scoreBig: { fontSize: tokens.fontSizeHero900, fontWeight: tokens.fontWeightSemibold, lineHeight: '1' },
  gauge: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '240px', flex: 1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '46vh' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  hint: { color: tokens.colorNeutralForeground3 },
});

function scoreColor(score: number): 'success' | 'warning' | 'error' {
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'error';
}

export function DataQualityEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, save, dirty } =
    useItemState<DqState>('data-quality', id, { backend: 'kusto', tableNames: [] });

  const [tab, setTab] = useState<'run' | 'history' | 'checks' | 'diff'>('run');
  const [n7dEnabled, setN7dEnabled] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<DqItemRunLite | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const backend = (state.backend as DqBackend) || 'kusto';
  const runs = useMemo(() => Array.isArray(state.runs) ? state.runs : [], [state.runs]);

  useEffect(() => { if (runs[0]) setLastRun(runs[0]); }, [runs]);

  // Config-gate probe on load.
  useEffect(() => {
    if (!id || id === 'new') return;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/run`);
        const j = await r.json();
        if (j.ok) setGate(j.gate?.missing || null);
      } catch { /* honest: gate shown after run attempt */ }
    })();
  }, [id, backend]);

  // N7d FLAG0 probe — the "Runner checks" + "Data diff" tabs are gated by the
  // n7d-data-quality-diff runtime flag (default-ON). We read it from the checks
  // endpoint's `enabled` field so a kill-switch flip hides both tabs.
  useEffect(() => {
    if (!id || id === 'new') return;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/checks`);
        const j = await r.json();
        setN7dEnabled(!!(j.ok && j.enabled));
      } catch { setN7dEnabled(false); }
    })();
  }, [id]);

  const doRun = useCallback(async () => {
    setErr(null); setRunning(true);
    try {
      if (dirty) await save();
      const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); if (j.gated) setGate(null); return; }
      setLastRun(j.run);
      setState((p) => ({ ...p, runs: [j.run, ...runs] }));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [id, dirty, save, runs, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Quality', actions: [
        { label: running ? 'Running…' : 'Run checks', onClick: !running ? doRun : undefined, disabled: running },
      ]},
      { label: 'Item', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: dirty && !saving ? () => save() : undefined, disabled: !dirty || saving },
      ]},
    ]},
  ], [running, doRun, saving, dirty, save]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create data-quality check"
        intro="A data-quality check pins a backend (Azure Data Explorer, Databricks, or Synapse) and a target, runs your workspace's data-quality rules against it, and shows a live composite scorecard + per-rule breakdown + run history. Rules are managed in Governance → Data quality. Azure-native — no Microsoft Fabric required. Create it, then pick a target and run." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'run' | 'history' | 'checks' | 'diff')}>
            <Tab value="run" icon={<ShieldCheckmarkRegular />}>Run</Tab>
            <Tab value="history" icon={<HistoryRegular />}>History{runs.length ? ` (${runs.length})` : ''}</Tab>
            {n7dEnabled && <Tab value="checks" icon={<BeakerRegular />}>Runner checks</Tab>}
            {n7dEnabled && <Tab value="diff" icon={<ArrowSyncRegular />}>Data diff</Tab>}
          </TabList>
        </div>

        <div className={s.body}>
          <TeachingBanner
            surfaceKey="data-quality-editor"
            icon={ShieldCheckmarkRegular}
            title="Score your data quality"
            message="Pick a backend and target, then run your workspace's data-quality rules (not-null / unique / range / regex / freshness) against the live table — the pass rate feeds a composite score. Manage the rules in Governance → Data quality. Azure-native (ADX / Databricks / Synapse) — no Microsoft Fabric required."
            learnMoreHref="https://learn.microsoft.com/azure/data-explorer/"
          />
          {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Run failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
          {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
          {gate && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>{backend} backend not configured</MessageBarTitle>
              Data-quality checks run against your real Azure backend. Set <code>{gate}</code> on the loom-console env, or pick a different backend below.
            </MessageBarBody></MessageBar>
          )}

          {tab === 'run' && (loading ? <Spinner label="Loading…" /> : (
            <>
              {/* Target */}
              <div className={s.card}>
                <span className={s.sectionHeader}><DatabaseRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Backend &amp; target</Subtitle2></span>
                <RadioGroup layout="horizontal" value={backend} onChange={(_, d) => setState((p) => ({ ...p, backend: d.value as DqBackend }))}>
                  <Radio value="kusto" label="Azure Data Explorer" />
                  <Radio value="databricks" label="Databricks SQL" />
                  <Radio value="synapse" label="Synapse SQL" />
                </RadioGroup>
                <div className={s.grid}>
                  {backend === 'kusto' && (
                    <Field label="ADX database" hint="Defaults to the deployment's ADX database when blank">
                      <Input value={state.database || ''} onChange={(_, d) => setState((p) => ({ ...p, database: d.value }))} placeholder="loomdb" />
                    </Field>
                  )}
                  {backend === 'databricks' && (<>
                    <Field label="SQL warehouse id" hint="Defaults to LOOM_DATABRICKS_SQL_WAREHOUSE_ID">
                      <Input value={state.warehouseId || ''} onChange={(_, d) => setState((p) => ({ ...p, warehouseId: d.value }))} />
                    </Field>
                    <Field label="Catalog"><Input value={state.catalog || ''} onChange={(_, d) => setState((p) => ({ ...p, catalog: d.value }))} /></Field>
                    <Field label="Schema"><Input value={state.schema || ''} onChange={(_, d) => setState((p) => ({ ...p, schema: d.value }))} /></Field>
                  </>)}
                  {backend === 'synapse' && (<>
                    <Field label="Pool">
                      <Dropdown value={state.synapsePool || 'serverless'} selectedOptions={[state.synapsePool || 'serverless']} onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, synapsePool: d.optionValue as 'serverless' | 'dedicated' }))}>
                        <Option value="serverless">Serverless</Option><Option value="dedicated">Dedicated</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Database" hint="Serverless defaults to master"><Input value={state.database || ''} onChange={(_, d) => setState((p) => ({ ...p, database: d.value }))} /></Field>
                  </>)}
                  <Field label="Table filter" hint="Comma-separated; blank = all enabled rules">
                    <Input value={(state.tableNames || []).join(', ')} onChange={(_, d) => setState((p) => ({ ...p, tableNames: d.value.split(',').map((x) => x.trim()).filter(Boolean) }))} placeholder="orders, customers" />
                  </Field>
                </div>
                <div className={s.row}>
                  <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <PlayRegular />} disabled={running} onClick={doRun}>{running ? 'Running…' : 'Run quality checks'}</Button>
                  <Caption1 className={s.hint}>Rules are managed in <Link href="/governance/data-quality">Governance → Data quality</Link>.</Caption1>
                </div>
                {running && <ProgressBar />}
              </div>

              {/* Scorecard */}
              {lastRun && (
                <div className={s.card}>
                  <span className={s.sectionHeader}><ShieldCheckmarkRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Data-quality scorecard</Subtitle2>
                    <Badge appearance="tint" color={lastRun.status === 'passed' ? 'success' : lastRun.status === 'failed' ? 'danger' : 'warning'}>{lastRun.status.replace('_', ' ')}</Badge>
                  </span>
                  {lastRun.status === 'no_rules' ? (
                    <MessageBar intent="info"><MessageBarBody>No enabled rules matched this target. Add rules in Governance → Data quality, then run again.</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.scoreRow}>
                      <div className={s.scoreBig}>
                        {lastRun.score != null ? `${lastRun.score}%` : '—'}
                      </div>
                      <div className={s.gauge}>
                        {lastRun.score != null && <ProgressBar value={lastRun.score / 100} color={scoreColor(lastRun.score)} thickness="large" aria-label={`Data quality score ${lastRun.score} percent`} />}
                        <div className={s.row}>
                          <Badge appearance="tint" color="success">{lastRun.passingRules} passing</Badge>
                          {lastRun.failingRules > 0 && <Badge appearance="tint" color="danger">{lastRun.failingRules} failing</Badge>}
                          <Caption1 className={s.hint}>{lastRun.backend} · {lastRun.target} · {new Date(lastRun.ranAt).toLocaleString()}</Caption1>
                        </div>
                      </div>
                    </div>
                  )}
                  {lastRun.breakdown.length > 0 && (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Data quality breakdown">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Rule</TableHeaderCell><TableHeaderCell>Check</TableHeaderCell><TableHeaderCell>Scope</TableHeaderCell>
                          <TableHeaderCell>Measured</TableHeaderCell><TableHeaderCell>Detail</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {lastRun.breakdown.map((r) => (
                            <TableRow key={r.ruleId}>
                              <TableCell>{r.name}</TableCell>
                              <TableCell><span className={s.mono}>{r.check}</span></TableCell>
                              <TableCell><span className={s.mono}>{r.scope}</span></TableCell>
                              <TableCell>{r.percentage == null ? <span className={s.hint}>—</span> : `${r.percentage.toFixed(1)}%`}</TableCell>
                              <TableCell>{r.detail}</TableCell>
                              <TableCell><Badge appearance="filled" color={r.passed ? 'success' : r.percentage == null ? 'subtle' : 'danger'}>{r.passed ? 'pass' : r.percentage == null ? 'error' : 'fail'}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          ))}

          {tab === 'history' && (
            <div className={s.card}>
              <span className={s.sectionHeader}><HistoryRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Run history</Subtitle2></span>
              {!runs.length ? (
                <Caption1 className={s.hint}>No runs yet. Configure a target and run the quality checks.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Run history">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Ran</TableHeaderCell><TableHeaderCell>Backend</TableHeaderCell><TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell>Score</TableHeaderCell><TableHeaderCell>Rules</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.map((rn) => (
                        <TableRow key={rn.id}>
                          <TableCell>{new Date(rn.ranAt).toLocaleString()}</TableCell>
                          <TableCell>{rn.backend}</TableCell>
                          <TableCell><span className={s.mono}>{rn.target}</span></TableCell>
                          <TableCell>{rn.score != null ? `${rn.score}%` : '—'}</TableCell>
                          <TableCell>{rn.passingRules}/{rn.ruleCount}</TableCell>
                          <TableCell><Badge appearance="tint" color={rn.status === 'passed' ? 'success' : rn.status === 'failed' ? 'danger' : 'warning'}>{rn.status.replace('_', ' ')}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Divider />
              <Caption1 className={s.hint}>Runs are persisted with the item. Newest first; up to 50 retained.</Caption1>
            </div>
          )}

          {n7dEnabled && tab === 'checks' && <DqRunnerChecksPanel id={id} />}
          {n7dEnabled && tab === 'diff' && <DqDataDiffPanel id={id} />}
        </div>
      </div>
    } />
  );
}
