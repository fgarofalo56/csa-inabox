'use client';

/**
 * /admin/finops — C4 FinOps cockpit (loom-next-level ws-copilot-cost.md).
 *
 * Real-data admin hub composing the existing cost stack into one surface:
 *   1. KPI tiles  — spend-to-date, period-end forecast (honest method badge),
 *                   anomaly count, budget burn (finops-view, pure).
 *   2. Forecast   — actual + forecast series (LoomChart) with the api/linear/
 *                   seasonal method labeled verbatim.
 *   3. Anomalies  — a live feed (C3 detector over the REAL daily series) beside
 *                   a rules editor (threshold / method / recipients), in a G3
 *                   resizable SplitPane. Every rule change is audited.
 *   4. Breakdown  — real Cost Management spend by service / RG / subscription /
 *                   resource type / cost-allocation tag.
 *   5. Budgets    — REAL Azure Budgets CRUD (create / update / delete), audited.
 *
 * All numbers come from real backends via the BFF (no-vaporware); honest gates
 * render a Fluent MessageBar with a Fix-it link. Fluent v9 + Loom tokens only.
 * Kill-switch: the c4-finops-hub runtime flag (OFF → the existing chargeback
 * pages). Azure-native (no Fabric dependency).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';
import { AdminShell } from '@/lib/components/admin-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import {
  makeStyles, tokens, Card, Title3, Subtitle2, Body1, Caption1, Badge, Spinner,
  Dropdown, Option, Button, Input, Field, Switch, Dialog, DialogSurface, DialogTitle,
  DialogBody, DialogContent, DialogActions, Table, TableHeader, TableRow, TableHeaderCell,
  TableBody, TableCell, MessageBar, MessageBarBody, MessageBarTitle, Tooltip, Spinner as FSpinner,
} from '@fluentui/react-components';
import {
  Money24Regular, Warning20Regular, Add20Regular, Delete20Regular, Edit20Regular,
  ArrowClockwise20Regular,
} from '@fluentui/react-icons';
import { assembleFinopsTiles, type FinopsTile, type TileIntent } from '@/lib/admin/finops-view';
import type { CostAnomaly } from '@/lib/azure/cost-anomaly-core';
import type { CostBudget } from '@/lib/azure/cost-client';
import type { CostAnomalyRuleDoc } from '@/lib/azure/cost-anomaly-rules-model';

const TIMEFRAMES = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'] as const;
const DIMENSIONS = ['service', 'resourceGroup', 'subscription', 'resourceType', 'tag'] as const;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  tile: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, minWidth: 0 },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1.1, overflowWrap: 'anywhere' },
  tileLabel: { color: tokens.colorNeutralForeground2 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  splitWrap: { height: '440px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' },
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, overflow: 'auto', height: '100%', minWidth: 0 },
  scroll: { overflowX: 'auto', minWidth: 0 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacingHorizontalM },
  right: { textAlign: 'right' },
});

const INTENT_COLOR: Record<TileIntent, 'brand' | 'success' | 'warning' | 'danger'> = {
  neutral: 'brand', success: 'success', warning: 'warning', error: 'danger',
};

async function getJson(url: string, timeout = 90_000): Promise<any> {
  const res = await clientFetch(url, { cache: 'no-store' }, timeout);
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

function GateBar({ gate }: { gate?: { message?: string } }) {
  if (!gate) return null;
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Configuration needed</MessageBarTitle>
        {gate.message || 'A backend is not configured.'}{' '}
        <Link href="/admin/gates">Open the gate registry to fix it →</Link>
      </MessageBarBody>
    </MessageBar>
  );
}

// ── Budgets dialog ───────────────────────────────────────────────────────────
interface BudgetForm {
  name: string; subscription: string; amount: string; timeGrain: 'Monthly' | 'Quarterly' | 'Annually';
  thresholds: string; contactEmails: string;
}
const emptyBudget = (sub: string): BudgetForm => ({ name: '', subscription: sub, amount: '', timeGrain: 'Monthly', thresholds: '80,100', contactEmails: '' });

function BudgetDialog({ open, onClose, subscriptions, onSaved, editing }:
  { open: boolean; onClose: () => void; subscriptions: string[]; onSaved: () => void; editing?: CostBudget | null }) {
  const styles = useStyles();
  const [form, setForm] = useState<BudgetForm>(emptyBudget(subscriptions[0] || ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useMemo(() => {
    if (open) {
      setErr(null);
      setForm(editing
        ? { name: editing.name, subscription: editing.subscription, amount: String(editing.amount), timeGrain: (editing.timeGrain as any) || 'Monthly', thresholds: '80,100', contactEmails: '' }
        : emptyBudget(subscriptions[0] || ''));
    }
  }, [open, editing, subscriptions]);

  async function save() {
    setBusy(true); setErr(null);
    const body = {
      name: form.name.trim(),
      subscription: form.subscription.trim(),
      amount: Number(form.amount),
      timeGrain: form.timeGrain,
      startDate: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(),
      thresholds: form.thresholds.split(',').map((t) => Number(t.trim())).filter((n) => n > 0),
      contactEmails: form.contactEmails.split(',').map((e) => e.trim()).filter(Boolean),
    };
    const res = await clientFetch('/api/admin/finops/budgets', {
      method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, 90_000);
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !j.ok) { setErr(j.error || `Request failed (${res.status})`); return; }
    onSaved(); onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{editing ? 'Edit budget' : 'Create budget'}</DialogTitle>
          <DialogContent>
            <div className={styles.formGrid}>
              <Field label="Name" required>
                <Input value={form.name} disabled={!!editing} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} placeholder="monthly-prod" />
              </Field>
              <Field label="Subscription" required>
                <Dropdown value={form.subscription} selectedOptions={[form.subscription]}
                  onOptionSelect={(_, d) => setForm((f) => ({ ...f, subscription: d.optionValue || '' }))}>
                  {subscriptions.map((s) => <Option key={s} value={s}>{s}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Amount (period)" required>
                <Input type="number" value={form.amount} onChange={(_, d) => setForm((f) => ({ ...f, amount: d.value }))} placeholder="5000" />
              </Field>
              <Field label="Time grain">
                <Dropdown value={form.timeGrain} selectedOptions={[form.timeGrain]}
                  onOptionSelect={(_, d) => setForm((f) => ({ ...f, timeGrain: (d.optionValue as any) || 'Monthly' }))}>
                  <Option value="Monthly">Monthly</Option>
                  <Option value="Quarterly">Quarterly</Option>
                  <Option value="Annually">Annually</Option>
                </Dropdown>
              </Field>
              <Field label="Alert thresholds (% of amount)">
                <Input value={form.thresholds} onChange={(_, d) => setForm((f) => ({ ...f, thresholds: d.value }))} placeholder="80,100" />
              </Field>
              <Field label="Contact emails (comma-sep)">
                <Input value={form.contactEmails} onChange={(_, d) => setForm((f) => ({ ...f, contactEmails: d.value }))} placeholder="finops@contoso.com" />
              </Field>
            </div>
            {err && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={busy || !form.name || !form.amount}>
              {busy ? <FSpinner size="tiny" /> : editing ? 'Save' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default function FinopsPage() {
  const styles = useStyles();
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('MonthToDate');
  const [dimension, setDimension] = useState<(typeof DIMENSIONS)[number]>('service');
  const [budgetDialog, setBudgetDialog] = useState<{ open: boolean; editing?: CostBudget | null }>({ open: false });

  const flagQ = useQuery({ queryKey: ['runtime-flags'], queryFn: () => getJson('/api/admin/runtime-flags') });
  const forecastQ = useQuery({ queryKey: ['finops-forecast', timeframe], queryFn: () => getJson(`/api/admin/finops/forecast?timeframe=${timeframe}`) });
  const budgetsQ = useQuery({ queryKey: ['finops-budgets'], queryFn: () => getJson('/api/admin/finops/budgets') });
  const anomaliesQ = useQuery({ queryKey: ['finops-anomalies'], queryFn: () => getJson('/api/admin/finops/anomalies') });
  const breakdownQ = useQuery({ queryKey: ['finops-breakdown', dimension, timeframe], queryFn: () => getJson(`/api/admin/finops/breakdown?dimension=${dimension}&timeframe=${timeframe}`) });

  const flagOff = useMemo(() => {
    const f = (flagQ.data?.flags || []).find((x: any) => x.id === 'c4-finops-hub');
    return f ? f.enabled === false : false;
  }, [flagQ.data]);

  const forecast = forecastQ.data?.data as
    | { method: string; currency: string; periodEnd: number; points: Array<{ date: string; cost: number; costStatus: string }> } | undefined;
  const budgets: CostBudget[] = budgetsQ.data?.budgets || [];
  const subscriptions: string[] = budgetsQ.data?.subscriptions || [];
  const feed = anomaliesQ.data?.feed || [];
  const rules: CostAnomalyRuleDoc[] = anomaliesQ.data?.rules || [];
  const breakdownTotal = Number(breakdownQ.data?.total || 0);
  const currency = forecast?.currency || breakdownQ.data?.currency || budgetsQ.data?.currency || 'USD';

  const tiles: FinopsTile[] = useMemo(() => assembleFinopsTiles({
    currency,
    monthToDate: breakdownTotal,
    forecast: Number(forecast?.periodEnd || 0),
    forecastMethod: (forecast?.method as any) || 'linear',
    trendPct: null,
    anomalies: feed as CostAnomaly[],
    budgets,
  }), [currency, breakdownTotal, forecast, feed, budgets]);

  if (flagOff) {
    return (
      <AdminShell sectionTitle="FinOps">
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>FinOps hub is turned off</MessageBarTitle>
            The c4-finops-hub runtime flag is OFF. Use{' '}
            <Link href="/admin/chargeback">Chargeback report</Link> and{' '}
            <Link href="/admin/usage-chargeback">Usage &amp; chargeback</Link>, or re-enable the hub on{' '}
            <Link href="/admin/runtime-flags">Runtime flags</Link>.
          </MessageBarBody>
        </MessageBar>
      </AdminShell>
    );
  }

  const forecastRows = (forecast?.points || []).map((p) => ({
    date: p.date,
    Actual: p.costStatus === 'Actual' ? p.cost : null,
    Forecast: p.costStatus === 'Forecast' ? p.cost : null,
  }));

  return (
    <AdminShell
      sectionTitle="FinOps"
      learn={{ title: 'FinOps cockpit', content: 'Real Cost Management forecast, cost-anomaly detection + alerting (the C3 monitor), per-scope breakdown, and real Azure Budgets CRUD — all Azure-native, no Fabric dependency.' }}
    >
      <div className={styles.root}>
        <div className={styles.toolbar}>
          <Money24Regular />
          <Dropdown value={timeframe} selectedOptions={[timeframe]} aria-label="Timeframe"
            onOptionSelect={(_, d) => setTimeframe((d.optionValue as any) || 'MonthToDate')}>
            {TIMEFRAMES.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
          <Button appearance="subtle" icon={<ArrowClockwise20Regular />}
            onClick={() => { forecastQ.refetch(); budgetsQ.refetch(); anomaliesQ.refetch(); breakdownQ.refetch(); }}>
            Refresh
          </Button>
        </div>

        {/* KPI tiles */}
        <TileGrid minTileWidth={240}>
          {tiles.map((t) => (
            <div key={t.key} className={styles.tile}>
              <Caption1 className={styles.tileLabel}>{t.label}</Caption1>
              <div className={styles.tileValue}>{t.value}</div>
              {t.caption && (
                <div className={styles.badgeRow}>
                  <Badge appearance="tint" color={INTENT_COLOR[t.intent]}>{t.caption}</Badge>
                </div>
              )}
            </div>
          ))}
        </TileGrid>

        {/* Forecast */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <Subtitle2>Forecast</Subtitle2>
            {forecast && (
              <Tooltip content="How the period-end number was produced. 'api' = real Cost Management Forecast API; 'linear'/'seasonal' = computed projection from the real daily series." relationship="description">
                <Badge appearance="tint" color={forecast.method === 'api' ? 'success' : 'warning'}>method: {forecast.method}</Badge>
              </Tooltip>
            )}
          </div>
          {forecastQ.isLoading ? <Spinner label="Loading forecast…" /> :
            forecastQ.data?.gate ? <GateBar gate={forecastQ.data.gate} /> :
            forecastRows.length ? (
              <LoomChart type="area" rows={forecastRows} title={`Daily spend + forecast (${currency})`} height={280} />
            ) : <Body1>No forecast data.</Body1>}
        </div>

        {/* Anomalies — feed + rules editor (G3 resizable) */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <Subtitle2>Cost anomalies</Subtitle2>
            <Link href="docs/fiab/runbooks/cost-anomaly.md">Runbook →</Link>
          </div>
          {anomaliesQ.data?.gate && <GateBar gate={anomaliesQ.data.gate} />}
          <div className={styles.splitWrap}>
            <SplitPane direction="horizontal" defaultSize="55%" minSize={280} storageKey="finops-anomalies" dividerLabel="Resize anomaly feed">
              <div className={styles.pane}>
                <Caption1 className={styles.tileLabel}>Live feed — detected against the real daily series</Caption1>
                {anomaliesQ.isLoading ? <Spinner size="tiny" /> :
                  feed.length ? (
                    <div className={styles.scroll}>
                      <Table size="small" aria-label="Anomaly feed">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Date</TableHeaderCell><TableHeaderCell>Scope</TableHeaderCell>
                          <TableHeaderCell>Cost</TableHeaderCell><TableHeaderCell>Deviation</TableHeaderCell>
                          <TableHeaderCell>Severity</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {feed.slice(0, 50).map((a: any, i: number) => (
                            <TableRow key={i}>
                              <TableCell>{a.date}</TableCell>
                              <TableCell>{a.scope}</TableCell>
                              <TableCell className={styles.right}>{a.cost}</TableCell>
                              <TableCell className={styles.right}>{a.deviationPct > 0 ? '+' : ''}{a.deviationPct}%</TableCell>
                              <TableCell><Badge appearance="tint" color={a.severity === 'high' ? 'danger' : 'warning'}>{a.severity}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <EmptyState icon={<Warning20Regular />} title="No anomalies detected" body="Every scope's daily spend is within its expected range for the current window." />
                  )}
              </div>
              <div className={styles.pane}>
                <RulesEditor rules={rules} onChanged={() => anomaliesQ.refetch()} />
              </div>
            </SplitPane>
          </div>
        </div>

        {/* Breakdown */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <Subtitle2>Spend breakdown</Subtitle2>
            <Dropdown value={dimension} selectedOptions={[dimension]} aria-label="Breakdown dimension"
              onOptionSelect={(_, d) => setDimension((d.optionValue as any) || 'service')}>
              {DIMENSIONS.map((x) => <Option key={x} value={x}>{x}</Option>)}
            </Dropdown>
          </div>
          {breakdownQ.isLoading ? <Spinner label="Loading breakdown…" /> :
            breakdownQ.data?.gate ? <GateBar gate={breakdownQ.data.gate} /> :
            (breakdownQ.data?.rows || []).length ? (
              <LoomChart type="bar" height={300}
                rows={(breakdownQ.data.rows as Array<{ key: string; cost: number }>).slice(0, 15).map((r) => ({ key: r.key, cost: Math.round(r.cost * 100) / 100 }))}
                title={`Spend by ${dimension} (${currency})`} />
            ) : <Body1>No breakdown data.</Body1>}
        </div>

        {/* Budgets */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <Subtitle2>Budgets</Subtitle2>
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => setBudgetDialog({ open: true, editing: null })}
              disabled={!subscriptions.length}>New budget</Button>
          </div>
          {budgetsQ.data?.gate && <GateBar gate={budgetsQ.data.gate} />}
          {budgetsQ.isLoading ? <Spinner label="Loading budgets…" /> :
            budgets.length ? (
              <div className={styles.scroll}>
                <Table aria-label="Budgets">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Subscription</TableHeaderCell>
                    <TableHeaderCell>Amount</TableHeaderCell><TableHeaderCell>Spent</TableHeaderCell>
                    <TableHeaderCell>Used</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {budgets.map((b) => (
                      <TableRow key={`${b.subscription}/${b.name}`}>
                        <TableCell>{b.name}</TableCell>
                        <TableCell>{b.subscription}</TableCell>
                        <TableCell className={styles.right}>{b.amount}</TableCell>
                        <TableCell className={styles.right}>{b.currentSpend}</TableCell>
                        <TableCell><Badge appearance="tint" color={b.percentUsed >= 100 ? 'danger' : b.percentUsed >= 80 ? 'warning' : 'success'}>{b.percentUsed}%</Badge></TableCell>
                        <TableCell>
                          <div className={styles.badgeRow}>
                            <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label={`Edit ${b.name}`}
                              onClick={() => setBudgetDialog({ open: true, editing: b })} />
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete ${b.name}`}
                              onClick={async () => {
                                if (!confirm(`Delete budget "${b.name}"?`)) return;
                                await clientFetch(`/api/admin/finops/budgets?name=${encodeURIComponent(b.name)}&subscription=${encodeURIComponent(b.subscription)}`, { method: 'DELETE' }, 90_000);
                                budgetsQ.refetch();
                              }} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState icon={<Money24Regular />} title="No budgets yet"
                body="Create an Azure Consumption budget to get alerted before spend crosses a threshold."
                primaryAction={subscriptions.length ? { children: 'New budget', onClick: () => setBudgetDialog({ open: true, editing: null }) } as any : undefined} />
            )}
        </div>
      </div>

      <BudgetDialog open={budgetDialog.open} editing={budgetDialog.editing} subscriptions={subscriptions}
        onClose={() => setBudgetDialog({ open: false })} onSaved={() => budgetsQ.refetch()} />
    </AdminShell>
  );
}

// ── Rules editor ─────────────────────────────────────────────────────────────
function RulesEditor({ rules, onChanged }: { rules: CostAnomalyRuleDoc[]; onChanged: () => void }) {
  const styles = useStyles();
  const [busy, setBusy] = useState<string | null>(null);

  async function save(rule: CostAnomalyRuleDoc, patch: Partial<CostAnomalyRuleDoc>) {
    setBusy(rule.id);
    await clientFetch('/api/admin/finops/anomalies', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...rule, ...patch }),
    }, 90_000);
    setBusy(null);
    onChanged();
  }

  return (
    <>
      <Caption1 className={styles.tileLabel}>Anomaly rules — thresholds &amp; alerting (audited)</Caption1>
      {rules.map((r) => (
        <Card key={r.id} style={{ padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
          <div className={styles.badgeRow}>
            <Subtitle2>{r.scope}</Subtitle2>
            <Badge appearance="tint">{r.method}</Badge>
            <Switch checked={r.enabled !== false} label={r.enabled !== false ? 'enabled' : 'disabled'}
              onChange={(_, d) => save(r, { enabled: d.checked })} disabled={busy === r.id} />
          </div>
          <div className={styles.formGrid}>
            <Field label={r.method === 'pct' ? 'Threshold (% over mean)' : 'Threshold (σ multiple)'}>
              <Input type="number" defaultValue={String(r.threshold)}
                onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== r.threshold) save(r, { threshold: v }); }} />
            </Field>
            <Field label="Min absolute delta">
              <Input type="number" defaultValue={String(r.minAbsDelta)}
                onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v !== r.minAbsDelta) save(r, { minAbsDelta: v }); }} />
            </Field>
            <Field label="Method">
              <Dropdown value={r.method} selectedOptions={[r.method]}
                onOptionSelect={(_, d) => { if (d.optionValue && d.optionValue !== r.method) save(r, { method: d.optionValue as any }); }}>
                <Option value="3sigma">3sigma</Option>
                <Option value="pct">pct</Option>
              </Dropdown>
            </Field>
            <Field label="Alert severity">
              <Dropdown value={r.alertSeverity} selectedOptions={[r.alertSeverity]}
                onOptionSelect={(_, d) => { if (d.optionValue && d.optionValue !== r.alertSeverity) save(r, { alertSeverity: d.optionValue as any }); }}>
                <Option value="P1">P1</Option>
                <Option value="P2">P2</Option>
                <Option value="P3">P3</Option>
              </Dropdown>
            </Field>
          </div>
          {busy === r.id && <Spinner size="tiny" />}
        </Card>
      ))}
    </>
  );
}
