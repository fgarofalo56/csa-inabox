'use client';

/**
 * WarehouseAlerts — query-result alerting for warehouse-style items, with full
 * parity to the Databricks SQL "Alerts" surface (query + condition + schedule +
 * notification) themed to Fluent v9 + Loom tokens.
 *
 * The backend is Azure-native and split by sovereign boundary (the GET response
 * reports which one is live — the UI never hard-codes the cloud):
 *   - backend:'databricks'    → Databricks SQL Alerts (Commercial / GCC). A
 *     saved query + an alert with an op/column/threshold condition on a Quartz
 *     cron schedule. Notification subscribers are managed in the Databricks
 *     workspace destinations (honest note in the Destination tab).
 *   - backend:'azure-monitor' → Azure Monitor scheduled-query alert rule
 *     (GCC-High / IL5 / DoD, where Databricks is not authorized). KQL over the
 *     Loom Log Analytics workspace, an evaluation frequency + window, and a real
 *     Action Group destination (picked from /api/monitor/action-groups).
 *
 * Every control hits the real BFF (/api/items/<type>/<id>/alerts). No mocks. The
 * post-create receipt surfaces the server-assigned alert id from the live
 * response, per the no-vaporware rule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Field, Input, Dropdown, Option, Spinner, Badge,
  Tab, TabList, Divider, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Alert20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

type Backend = 'databricks' | 'azure-monitor';

interface AlertRow {
  id: string;
  name?: string;
  state?: string;
  op?: string;
  column?: string;
  threshold?: number;
  schedule?: string;
  window?: string;
  severity?: number;
  owner?: string;
}

interface ListResp {
  ok: boolean;
  backend?: Backend;
  alerts?: AlertRow[];
  gated?: boolean;
  error?: string;
  gate?: { reason?: string; remediation?: string };
}

interface ActionGroup { id: string; name: string; }

/** op enum + friendly label. Databricks supports all six; Azure Monitor drops NOT_EQUAL. */
const OPS: { value: string; label: string }[] = [
  { value: 'GREATER_THAN', label: 'is above ( > )' },
  { value: 'GREATER_THAN_OR_EQUAL', label: 'is above or equal ( ≥ )' },
  { value: 'LESS_THAN', label: 'is below ( < )' },
  { value: 'LESS_THAN_OR_EQUAL', label: 'is below or equal ( ≤ )' },
  { value: 'EQUAL', label: 'is equal ( = )' },
  { value: 'NOT_EQUAL', label: 'is not equal ( ≠ )' },
];

/** Quartz cron presets for the Databricks schedule (seconds-first 6-field cron). */
const CRON_PRESETS: { value: string; label: string }[] = [
  { value: '0 0/5 * * * ?', label: 'Every 5 minutes' },
  { value: '0 0/15 * * * ?', label: 'Every 15 minutes' },
  { value: '0 0/30 * * * ?', label: 'Every 30 minutes' },
  { value: '0 0 * * * ?', label: 'Every hour' },
  { value: '0 0 0/6 * * ?', label: 'Every 6 hours' },
  { value: '0 0 8 * * ?', label: 'Daily at 08:00' },
];

/** ISO-8601 evaluation cadences for the Azure Monitor scheduled query rule. */
const FREQUENCIES: { value: string; label: string }[] = [
  { value: 'PT5M', label: 'Every 5 minutes' },
  { value: 'PT15M', label: 'Every 15 minutes' },
  { value: 'PT30M', label: 'Every 30 minutes' },
  { value: 'PT1H', label: 'Every hour' },
  { value: 'PT6H', label: 'Every 6 hours' },
  { value: 'P1D', label: 'Daily' },
];

const SEVERITIES: { value: string; label: string }[] = [
  { value: '0', label: '0 — Critical' },
  { value: '1', label: '1 — Error' },
  { value: '2', label: '2 — Warning' },
  { value: '3', label: '3 — Informational' },
  { value: '4', label: '4 — Verbose' },
];

const TIMEZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '640px', maxWidth: '880px' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto' },
  editorPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: '300px' },
  fieldRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  fieldCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px', flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  tableWrap: { overflow: 'auto', maxHeight: '300px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
});

export interface WarehouseAlertsProps {
  /** Item type segment for the BFF route (e.g. 'databricks-sql-warehouse' | 'warehouse'). */
  engine: string;
  /** Item id. */
  id: string;
  /** The selected SQL warehouse id (Databricks path). */
  warehouseId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WarehouseAlerts({ engine, id, warehouseId, open, onOpenChange }: WarehouseAlertsProps) {
  const s = useStyles();
  const base = `/api/items/${encodeURIComponent(engine)}/${encodeURIComponent(id)}/alerts`;

  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<ListResp | null>(null);
  const backend: Backend = list?.backend || 'databricks';
  const isMonitor = backend === 'azure-monitor';

  // ── Editor (new alert) state ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [tab, setTab] = useState<'query' | 'condition' | 'schedule' | 'destination'>('query');
  const [name, setName] = useState('');
  const [sql, setSql] = useState('SELECT count(*) AS value\nFROM samples.nyctaxi.trips\nWHERE tpep_pickup_datetime >= current_date();');
  const [column, setColumn] = useState('value');
  const [op, setOp] = useState('GREATER_THAN');
  const [threshold, setThreshold] = useState('0');
  const [cron, setCron] = useState(CRON_PRESETS[0].value);
  const [timezone, setTimezone] = useState('UTC');
  const [frequency, setFrequency] = useState('PT5M');
  const [windowSize, setWindowSize] = useState('PT5M');
  const [severity, setSeverity] = useState('3');
  const [actionGroupId, setActionGroupId] = useState('');
  const [actionGroups, setActionGroups] = useState<ActionGroup[]>([]);
  const [agNote, setAgNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ alertId: string; backend: string } | null>(null);

  const ops = useMemo(() => (isMonitor ? OPS.filter((o) => o.value !== 'NOT_EQUAL') : OPS), [isMonitor]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(base);
      const j = (await r.json()) as ListResp;
      setList(j);
    } catch (e) {
      setList({ ok: false, error: (e as Error)?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  // Load action groups for the Azure Monitor destination picker (Gov path).
  const loadActionGroups = useCallback(async () => {
    setAgNote(null);
    try {
      const r = await fetch('/api/monitor/action-groups');
      const j = await r.json();
      if (j.ok && Array.isArray(j.actionGroups)) {
        setActionGroups(j.actionGroups.map((a: any) => ({ id: a.id, name: a.name })));
        if (j.actionGroups.length === 0) setAgNote('No action groups exist yet. Create one in Monitor → Action groups, then reopen this picker. The alert still fires; without a destination it only records to Azure Monitor.');
      } else {
        setAgNote(j.error || 'Action groups unavailable.');
      }
    } catch (e) {
      setAgNote((e as Error)?.message || String(e));
    }
  }, []);

  const openEditor = useCallback(() => {
    setReceipt(null);
    setSaveErr(null);
    setName('');
    setTab('query');
    setEditorOpen(true);
    if (isMonitor) void loadActionGroups();
  }, [isMonitor, loadActionGroups]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    setReceipt(null);
    try {
      const payload: Record<string, unknown> = {
        name,
        sql,
        column,
        op,
        threshold: Number(threshold),
        warehouseId,
      };
      if (isMonitor) {
        payload.frequency = frequency;
        payload.window = windowSize;
        payload.severity = Number(severity);
        if (actionGroupId) payload.actionGroupId = actionGroupId;
      } else {
        payload.cron = cron;
        payload.timezone = timezone;
      }
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setReceipt({ alertId: j.alertId, backend: j.backend });
      await refresh();
    } catch (e) {
      setSaveErr((e as Error)?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [name, sql, column, op, threshold, warehouseId, isMonitor, frequency, windowSize, severity, actionGroupId, cron, timezone, base, refresh]);

  const remove = useCallback(async (alertId: string) => {
    try {
      await fetch(`${base}?alertId=${encodeURIComponent(alertId)}`, { method: 'DELETE' });
      await refresh();
    } catch { /* surfaced on next refresh */ }
  }, [base, refresh]);

  const canSave = !!name.trim() && !!sql.trim() && Number.isFinite(Number(threshold))
    && (isMonitor || (!!column.trim() && !!warehouseId));

  const alerts = list?.alerts || [];

  return (
    <>
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '920px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Alert20Regular /> Alerts
              <Badge appearance="outline" color={isMonitor ? 'warning' : 'brand'}>
                {isMonitor ? 'Azure Monitor (scheduled query rule)' : 'Databricks SQL Alerts'}
              </Badge>
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.toolbar}>
                <Button appearance="primary" icon={<Add20Regular />} onClick={openEditor}>New alert</Button>
                <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void refresh()} disabled={loading}>Refresh</Button>
                <span className={s.spacer} />
                {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
              </div>

              {list?.gated && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Configuration required</MessageBarTitle>
                    {list.gate?.remediation || list.error}
                  </MessageBarBody>
                </MessageBar>
              )}
              {list && !list.ok && !list.gated && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Could not load alerts</MessageBarTitle>{list.error}</MessageBarBody>
                </MessageBar>
              )}

              {list?.ok && alerts.length === 0 && (
                <Caption1 className={s.hint}>No alerts yet. Click <b>New alert</b> to create one that runs a query, checks a condition on a schedule, and notifies a destination.</Caption1>
              )}

              {alerts.length > 0 && (
                <div className={s.tableWrap}>
                  <Table aria-label="Alerts" size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Condition</TableHeaderCell>
                        <TableHeaderCell>Schedule</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {alerts.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell>{a.name || a.id}</TableCell>
                          <TableCell>
                            <Badge appearance="filled" color={a.state === 'TRIGGERED' ? 'danger' : a.state === 'ERROR' ? 'warning' : 'success'}>
                              {a.state || 'OK'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Caption1>
                              {a.column ? `${a.column} ` : ''}{a.op || ''} {a.threshold ?? ''}
                            </Caption1>
                          </TableCell>
                          <TableCell><Caption1>{a.schedule || '—'}</Caption1></TableCell>
                          <TableCell>
                            <Tooltip content="Delete alert" relationship="label">
                              <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete ${a.name || a.id}`} onClick={() => void remove(a.id)} />
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>

    {/*
      * New-alert editor (Query / Condition / Schedule / Destination).
      * Rendered as a SIBLING of the list Dialog, never nested inside its
      * DialogSurface — a Fluent Dialog nested in another Dialog's surface
      * breaks the parent's open/close (the nested modal's focus-trap keeps the
      * parent surface mounted, so the list Dialog rendered open on mount and
      * Close failed to dismiss it).
      */}
      <Dialog open={editorOpen} onOpenChange={(_, d) => setEditorOpen(d.open)}>
        <DialogSurface style={{ maxWidth: '780px', width: '95vw' }}>
          <DialogBody>
            <DialogTitle>New alert</DialogTitle>
            <DialogContent>
              <div className={s.editorPane}>
                <Field label="Alert name" required>
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Daily trip count above threshold" />
                </Field>
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
                  <Tab value="query">Query</Tab>
                  <Tab value="condition">Condition</Tab>
                  <Tab value="schedule">Schedule</Tab>
                  <Tab value="destination">Destination</Tab>
                </TabList>

                {tab === 'query' && (
                  <>
                    <Caption1 className={s.hint}>
                      {isMonitor
                        ? 'KQL evaluated against the Loom Log Analytics workspace. The alert fires when the row count meets the condition.'
                        : 'SQL run on the selected Databricks SQL warehouse. Return a single value column to evaluate.'}
                    </Caption1>
                    <MonacoTextarea
                      value={sql}
                      onChange={setSql}
                      language={isMonitor ? 'kusto' : 'sql'}
                      height={200}
                      minHeight={160}
                      ariaLabel="Alert query"
                    />
                  </>
                )}

                {tab === 'condition' && (
                  <div className={s.fieldRow}>
                    {!isMonitor && (
                      <div className={s.fieldCol}>
                        <Field label="Value column" required hint="Column of the query result to evaluate">
                          <Input value={column} onChange={(_, d) => setColumn(d.value)} placeholder="value" />
                        </Field>
                      </div>
                    )}
                    <div className={s.fieldCol}>
                      <Field label="Operator">
                        <Dropdown
                          value={ops.find((o) => o.value === op)?.label || op}
                          selectedOptions={[op]}
                          onOptionSelect={(_, d) => d.optionValue && setOp(d.optionValue)}
                        >
                          {ops.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <div className={s.fieldCol}>
                      <Field label="Threshold" required>
                        <Input type="number" value={threshold} onChange={(_, d) => setThreshold(d.value)} />
                      </Field>
                    </div>
                    {isMonitor && (
                      <div className={s.fieldCol}>
                        <Caption1 className={s.hint}>Azure Monitor evaluates the row count of the KQL result against this threshold.</Caption1>
                      </div>
                    )}
                  </div>
                )}

                {tab === 'schedule' && (
                  <div className={s.fieldRow}>
                    {isMonitor ? (
                      <>
                        <div className={s.fieldCol}>
                          <Field label="Evaluation frequency">
                            <Dropdown value={FREQUENCIES.find((f) => f.value === frequency)?.label || frequency} selectedOptions={[frequency]} onOptionSelect={(_, d) => d.optionValue && setFrequency(d.optionValue)}>
                              {FREQUENCIES.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                        <div className={s.fieldCol}>
                          <Field label="Look-back window">
                            <Dropdown value={FREQUENCIES.find((f) => f.value === windowSize)?.label || windowSize} selectedOptions={[windowSize]} onOptionSelect={(_, d) => d.optionValue && setWindowSize(d.optionValue)}>
                              {FREQUENCIES.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                        <div className={s.fieldCol}>
                          <Field label="Severity">
                            <Dropdown value={SEVERITIES.find((x) => x.value === severity)?.label || severity} selectedOptions={[severity]} onOptionSelect={(_, d) => d.optionValue && setSeverity(d.optionValue)}>
                              {SEVERITIES.map((x) => <Option key={x.value} value={x.value}>{x.label}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className={s.fieldCol}>
                          <Field label="Run schedule">
                            <Dropdown value={CRON_PRESETS.find((c) => c.value === cron)?.label || cron} selectedOptions={[cron]} onOptionSelect={(_, d) => d.optionValue && setCron(d.optionValue)}>
                              {CRON_PRESETS.map((c) => <Option key={c.value} value={c.value}>{c.label}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                        <div className={s.fieldCol}>
                          <Field label="Time zone">
                            <Dropdown value={timezone} selectedOptions={[timezone]} onOptionSelect={(_, d) => d.optionValue && setTimezone(d.optionValue)}>
                              {TIMEZONES.map((tz) => <Option key={tz} value={tz}>{tz}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {tab === 'destination' && (
                  <>
                    {isMonitor ? (
                      <>
                        <Field label="Action group" hint="Real Microsoft.Insights/actionGroups — delivers email / SMS / webhook / Logic App when the rule fires">
                          <Dropdown
                            value={actionGroups.find((a) => a.id === actionGroupId)?.name || (actionGroupId ? actionGroupId : 'None — record to Azure Monitor only')}
                            selectedOptions={actionGroupId ? [actionGroupId] : []}
                            onOptionSelect={(_, d) => setActionGroupId(d.optionValue || '')}
                          >
                            <Option value="">None — record to Azure Monitor only</Option>
                            {actionGroups.map((a) => <Option key={a.id} value={a.id}>{a.name}</Option>)}
                          </Dropdown>
                        </Field>
                        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void loadActionGroups()}>Reload action groups</Button>
                        {agNote && (
                          <MessageBar intent="info"><MessageBarBody>{agNote}</MessageBarBody></MessageBar>
                        )}
                      </>
                    ) : (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>Notification destinations</MessageBarTitle>
                          This editor creates the alert and its condition. Notification subscribers (email / Slack / webhook destinations) are managed at the Databricks workspace level. After creating the alert, open it in the Databricks SQL portal to add subscribers, or have a workspace admin configure destinations under Settings → Notification destinations.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                )}

                <Divider />
                {!isMonitor && !warehouseId && (
                  <MessageBar intent="warning"><MessageBarBody>Pick a SQL warehouse in the editor first — the alert query runs on it.</MessageBarBody></MessageBar>
                )}
                {saveErr && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>
                )}
                {receipt && (
                  <MessageBar intent="success">
                    <MessageBarBody>
                      <MessageBarTitle>Alert created</MessageBarTitle>
                      ID: <code>{receipt.alertId}</code> · backend: {receipt.backend}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setEditorOpen(false)}>Close</Button>
              <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Alert20Regular />} disabled={!canSave || saving} onClick={() => void save()}>
                {saving ? 'Creating…' : 'Create alert'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
