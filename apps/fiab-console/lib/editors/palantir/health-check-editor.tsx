'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * HealthCheckEditor (Checks) — Azure Monitor scheduledQueryRules + notifications.
 *
 * Extracted verbatim from palantir-editors.tsx (behavior-preserving split —
 * zero logic change). Shared helpers/types/styles live in ./shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import {
  Title2, Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner, Switch, Divider,
  Tab, TabList, Field, Dropdown, Option, Checkbox, SearchBox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Link20Regular, Code20Regular,
  Flash20Regular, Rocket20Regular, Play20Regular, Database20Regular,
  Copy16Regular, Checkmark16Regular, BrainCircuit20Regular,
  History20Regular, Bug20Regular,
  ArrowSwap20Regular, People20Regular, Tag20Regular, ChevronRight20Regular,
  CheckmarkCircle20Regular, DismissCircle20Regular, Cloud20Regular, Branch20Regular,
  Settings20Regular, Warning20Regular, Pulse20Regular, Alert20Regular,
  ArrowUp16Regular, ArrowDown16Regular, Wrench20Regular, Braces20Regular,
  Clock20Regular, DataHistogram20Regular, TextField20Regular, Beaker20Regular,
  Globe20Regular, CloudArrowUp20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { SlateAppBuilder, type SlateQueryDef, type SlateWidgetDef, type SlateVariable } from '../slate/slate-app-builder';
import { WorkshopAppBuilder, type WorkshopWidget, type WorkshopVariable } from '../workshop/workshop-app-builder';
import { deriveObjectProperties } from '../_palantir-codegen';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import {
  CHECK_TYPE_LIBRARY, CHECK_FAMILY_META, COMPARISON_OPERATORS, AGGREGATIONS,
  buildCheckQuery, type CheckTypeDef, type CheckFamily, type CheckField,
} from '@/app/api/items/health-check/_lib/check-types';
import type { OntologyEntityBinding } from '../_family-utils';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useStyles, CodeBlock, useItemState, SaveStrip, SectionHead, useOntologyBinding, type ItemDoc, type OntologySummary, type OntologyClassLite, type OntologyActionLite, type OntologySurface } from './shared';

// ───────────────────────── Health check (Checks) ─────────────────────────
interface MonitorRule { id: string; name: string; query: string; azureRuleName?: string; evaluationFrequency?: string; windowSize?: string; state?: string; checkType?: string; severity?: number; updatedAt?: string; note?: string }
interface HistoryEvent { id: string; alertRule: string; monitorCondition?: string; alertState?: string; severity?: string; startDateTime?: string; monitorConditionResolvedDateTime?: string; targetResourceName?: string; payload?: { matchingRowsCount?: number; operator?: string; threshold?: string } }
interface RunResult { ruleId: string; ruleName: string; fired: boolean; count: number; columns: string[]; rows: unknown[][] }
type RuleStatus = 'Healthy' | 'Firing' | 'Disabled';
const HC_SEVERITY_OPTS: { v: number; label: string }[] = [
  { v: 0, label: 'Sev 0 · Critical' },
  { v: 1, label: 'Sev 1 · Error' },
  { v: 2, label: 'Sev 2 · Warning' },
  { v: 3, label: 'Sev 3 · Informational' },
  { v: 4, label: 'Sev 4 · Verbose' },
];
function hcSeverityColor(sev?: number): 'danger' | 'warning' | 'informative' {
  if (sev == null) return 'informative';
  if (sev <= 1) return 'danger';
  if (sev === 2) return 'warning';
  return 'informative';
}
function hcSeverityLabel(sev?: number): string {
  return (HC_SEVERITY_OPTS.find((o) => o.v === sev) || HC_SEVERITY_OPTS[3]).label;
}
interface HealthState { rules?: MonitorRule[]; [k: string]: unknown }

// ── check-type gallery + typed wizard (Palantir Foundry check-type library) ──
const HC_FAMILY_ICON: Record<CheckFamily, ReactNode> = {
  time: <Clock20Regular />, size: <DataHistogram20Regular />, content: <TextField20Regular />, schema: <Braces20Regular />, status: <Pulse20Regular />,
};

/** Build the current KQL for a wizard config, client-side (instant preview). */
function hcParamsFor(def: CheckTypeDef, params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of def.fields) out[f.id] = params[f.id] ?? f.default ?? '';
  return out;
}

function CheckTypeGallery({ onPick }: { onPick: (def: CheckTypeDef) => void }) {
  const s = useStyles();
  const families = Object.keys(CHECK_FAMILY_META) as CheckFamily[];
  return (
    <div className={s.section}>
      <SectionHead icon={<Flash20Regular />} title="Check-type library" hint="Pick a check type to open a typed wizard. Every type compiles to a real Azure Monitor scheduled-query condition over Log Analytics." />
      {families.map((fam) => {
        const defs = CHECK_TYPE_LIBRARY.filter((d) => d.family === fam);
        if (defs.length === 0) return null;
        return (
          <div key={fam} className={s.galleryFamily}>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon}>{HC_FAMILY_ICON[fam]}</span>
              <div><Subtitle2>{CHECK_FAMILY_META[fam].label}</Subtitle2><Caption1 as="p" block className={s.hint}>{CHECK_FAMILY_META[fam].description}</Caption1></div>
            </div>
            <TileGrid minTileWidth={240}>
              {defs.map((def) => (
                <div key={def.id} className={s.checkTile} role="button" tabIndex={0}
                  onClick={() => onPick(def)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(def); } }}
                  aria-label={`Add ${def.label} check`}>
                  <div className={s.checkTileHead}>
                    <span className={s.checkTileIcon}>{HC_FAMILY_ICON[fam]}</span>
                    <Body1><strong>{def.label}</strong></Body1>
                  </div>
                  <Caption1 className={s.hint}>{def.description}</Caption1>
                </div>
              ))}
            </TileGrid>
          </div>
        );
      })}
    </div>
  );
}

interface HcWizardConfig {
  checkType: string; params: Record<string, string>; name: string;
  evaluationFrequency: string; windowSize: string; severity: number; email?: string;
}

function CheckWizardField({ field, value, onChange }: { field: CheckField; value: string; onChange: (v: string) => void }) {
  if (field.kind === 'operator') {
    const cur = COMPARISON_OPERATORS.find((o) => o.id === value) || COMPARISON_OPERATORS[0];
    return (
      <Field label={field.label} hint={field.hint}>
        <Dropdown value={cur.label} selectedOptions={[cur.id]} onOptionSelect={(_, d) => onChange(d.optionValue || 'gt')}>
          {COMPARISON_OPERATORS.map((o) => <Option key={o.id} value={o.id} text={o.label}>{`${o.label} (${o.symbol})`}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  if (field.kind === 'aggregation') {
    const cur = AGGREGATIONS.find((a) => a.id === value) || AGGREGATIONS[0];
    return (
      <Field label={field.label} hint={field.hint}>
        <Dropdown value={cur.label} selectedOptions={[cur.id]} onOptionSelect={(_, d) => onChange(d.optionValue || 'sum')}>
          {AGGREGATIONS.map((a) => <Option key={a.id} value={a.id} text={a.label}>{a.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  if (field.kind === 'kql') {
    return <Field label={field.label} hint={field.hint}><Textarea value={value} onChange={(_, d) => onChange(d.value)} rows={5} resize="vertical" placeholder={field.placeholder} /></Field>;
  }
  const inputType = field.kind === 'number' || field.kind === 'minutes' ? 'number' : 'text';
  return <Field label={field.label} hint={field.hint}><Input type={inputType} value={value} onChange={(_, d) => onChange(d.value)} placeholder={field.placeholder} /></Field>;
}

function HealthCheckWizard({ id, def, onClose, onCreate }: {
  id: string; def: CheckTypeDef | null; onClose: () => void; onCreate: (cfg: HcWizardConfig) => Promise<boolean>;
}) {
  const s = useStyles();
  const [params, setParams] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [windowSize, setWindowSize] = useState('PT15M');
  const [severity, setSeverity] = useState('3');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState<{ busy?: boolean; fired?: boolean; count?: number; columns?: string[]; rows?: unknown[][]; gate?: { reason: string; remediation: string }; error?: string } | null>(null);

  // Seed field defaults + a friendly default name whenever the type changes.
  useEffect(() => {
    if (!def) return;
    const seed: Record<string, string> = {};
    for (const f of def.fields) seed[f.id] = f.default ?? '';
    setParams(seed); setName(`${def.id}-check`); setSample(null);
  }, [def]);

  const kql = useMemo(() => (def ? buildCheckQuery(def.id, hcParamsFor(def, params)) : null), [def, params]);

  const runSample = useCallback(async () => {
    if (!def) return;
    setSample({ busy: true });
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkType: def.id, params: hcParamsFor(def, params) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSample({ error: j?.error || `HTTP ${r.status}`, gate: j?.gate }); return; }
      if (j.runGate) { setSample({ gate: j.runGate }); return; }
      setSample({ fired: j.run?.fired, count: j.run?.count, columns: j.run?.columns || [], rows: j.run?.rows || [] });
    } catch (e: any) { setSample({ error: e?.message || String(e) }); }
  }, [id, def, params]);

  const create = useCallback(async () => {
    if (!def) return;
    setBusy(true);
    const ok = await onCreate({
      checkType: def.id, params: hcParamsFor(def, params), name: name.trim() || `${def.id}-check`,
      evaluationFrequency: evalFreq, windowSize, severity: Number(severity), email: email.trim() || undefined,
    });
    setBusy(false);
    if (ok) onClose();
  }, [def, params, name, evalFreq, windowSize, severity, email, onCreate, onClose]);

  return (
    <Dialog open={!!def} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{def ? `New ${def.label} check` : 'New check'}</DialogTitle>
          <DialogContent>
            {def && (
              <div className={s.dialogForm}>
                <Caption1 className={s.hint}>{def.description}</Caption1>
                <div className={s.dialogScroll}>
                  <div className={s.grid2}>
                    <Field label="Rule name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder={`${def.id}-check`} /></Field>
                    {def.fields.map((f) => (
                      <CheckWizardField key={f.id} field={f} value={params[f.id] ?? f.default ?? ''} onChange={(v) => setParams((p) => ({ ...p, [f.id]: v }))} />
                    ))}
                  </div>
                  <Divider />
                  <div className={s.grid2}>
                    <Field label="Evaluate every"><Dropdown value={evalFreq} selectedOptions={[evalFreq]} onOptionSelect={(_, d) => setEvalFreq(d.optionValue || 'PT5M')}>
                      <Option value="PT5M">5 minutes</Option><Option value="PT15M">15 minutes</Option><Option value="PT1H">1 hour</Option>
                    </Dropdown></Field>
                    <Field label="Look-back window"><Dropdown value={windowSize} selectedOptions={[windowSize]} onOptionSelect={(_, d) => setWindowSize(d.optionValue || 'PT15M')}>
                      <Option value="PT15M">15 minutes</Option><Option value="PT1H">1 hour</Option><Option value="P1D">1 day</Option>
                    </Dropdown></Field>
                    <Field label="Severity"><Dropdown value={hcSeverityLabel(Number(severity))} selectedOptions={[severity]} onOptionSelect={(_, d) => setSeverity(d.optionValue || '3')}>
                      {HC_SEVERITY_OPTS.map((o) => <Option key={o.v} value={String(o.v)} text={o.label}>{o.label}</Option>)}
                    </Dropdown></Field>
                    <Field label="Notify email (optional)"><Input value={email} onChange={(_, d) => setEmail(d.value)} placeholder="oncall@contoso.com" /></Field>
                  </div>

                  <SectionHead icon={<Code20Regular />} title="KQL preview" hint="The exact condition this check's scheduledQueryRule will evaluate. Fires when the query returns rows." />
                  {kql ? <CodeBlock ariaLabel="Compiled KQL" content={kql} /> : <MessageBar intent="warning"><MessageBarBody>Fill in the required fields (table / column / KQL) to compile the condition.</MessageBarBody></MessageBar>}
                  <div className={s.addBar}>
                    <Button appearance="outline" icon={sample?.busy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={!kql || sample?.busy} onClick={runSample}>
                      {sample?.busy ? 'Running…' : 'Run live sample'}
                    </Button>
                    {sample && !sample.busy && !sample.gate && !sample.error && (
                      <Badge appearance="tint" color={sample.fired ? 'danger' : 'success'}>{sample.fired ? 'Would fire' : 'Pass'} · {sample.count ?? 0} row(s)</Badge>
                    )}
                  </div>
                  {sample?.gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Live sample unavailable</MessageBarTitle>{sample.gate.reason} {sample.gate.remediation}</MessageBarBody></MessageBar>}
                  {sample?.error && !sample.gate && <MessageBar intent="error"><MessageBarBody>{sample.error}</MessageBarBody></MessageBar>}
                  {sample && !sample.busy && (sample.columns?.length || 0) > 0 && (sample.rows?.length || 0) > 0 && (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Sample rows">
                        <TableHeader><TableRow>{(sample.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                        <TableBody>
                          {(sample.rows || []).slice(0, 10).map((row, ri) => (
                            <TableRow key={ri}>{(sample.columns || []).map((_, ci) => <TableCell key={ci}>{(row as unknown[])[ci] === null || (row as unknown[])[ci] === undefined ? '' : String((row as unknown[])[ci])}</TableCell>)}</TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Flash20Regular />} disabled={busy || !kql} onClick={create}>
              {busy ? 'Creating…' : 'Create rule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function HealthCheckEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { loading } = useItemState<HealthState>('health-check', id, { rules: [] });
  const [tab, setTab] = useState<'checks' | 'status' | 'history' | 'notifications' | 'settings'>('checks');
  const [rules, setRules] = useState<MonitorRule[]>([]);
  // Check-type wizard: the selected library type (null = closed).
  const [wizardDef, setWizardDef] = useState<CheckTypeDef | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Per-rule lifecycle (Run / Enable / Disable / Delete).
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  // Fired-alert history (Azure Monitor AlertsManagement).
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMsg, setHistoryMsg] = useState<{ intent: 'warning' | 'error'; text: string } | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setRules(Array.isArray(j.rules) ? j.rules : []);
    } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { void loadRules(); }, [loadRules]);

  const loadHistory = useCallback(async () => {
    setHistoryBusy(true); setHistoryMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/history?days=14`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setHistoryMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setHistory(Array.isArray(j.events) ? j.events : []);
    } catch (e: any) { setHistoryMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setHistoryBusy(false); setHistoryLoaded(true); }
  }, [id]);
  useEffect(() => {
    if ((tab === 'status' || tab === 'history') && !historyLoaded && rules.length > 0) void loadHistory();
  }, [tab, historyLoaded, rules.length, loadHistory]);

  const createRule = useCallback(async (cfg: HcWizardConfig): Promise<boolean> => {
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          checkType: cfg.checkType, params: cfg.params, name: cfg.name || undefined,
          evaluationFrequency: cfg.evaluationFrequency, windowSize: cfg.windowSize,
          severity: cfg.severity, email: cfg.email,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return false;
      }
      setMsg({ intent: 'success', text: `Created Azure Monitor rule "${j.rule?.name}" (${j.rule?.azureRuleName}).` });
      setHistoryLoaded(false);
      void loadRules();
      return true;
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); return false; }
  }, [id, loadRules]);

  const toggleRule = useCallback(async (rl: MonitorRule, enabled: boolean) => {
    setRowBusy(rl.id); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule/${encodeURIComponent(rl.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setMsg({ intent: 'success', text: `Check "${rl.name}" ${enabled ? 'enabled' : 'disabled'}.` });
      void loadRules();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRowBusy(null); }
  }, [id, loadRules]);

  const deleteRule = useCallback(async (rl: MonitorRule) => {
    setRowBusy(rl.id); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule/${encodeURIComponent(rl.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setMsg({ intent: 'success', text: `Deleted check "${rl.name}".` });
      setRun((p) => (p?.ruleId === rl.id ? null : p));
      void loadRules();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRowBusy(null); }
  }, [id, loadRules]);

  const runRule = useCallback(async (rl: MonitorRule) => {
    setRowBusy(rl.id); setMsg(null); setRun(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/rule/${encodeURIComponent(rl.id)}/run`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setRun({ ruleId: rl.id, ruleName: rl.name, fired: !!j.fired, count: Number(j.count) || 0, columns: Array.isArray(j.columns) ? j.columns : [], rows: Array.isArray(j.rows) ? j.rows : [] });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRowBusy(null); }
  }, [id]);

  // Derived status — a rule is Firing when it has a fired, unresolved Azure
  // Monitor alert; Disabled when paused; otherwise Healthy.
  const firingByRule = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of history) {
      if (e.monitorCondition === 'Fired' && e.alertState !== 'Closed') m.set(e.alertRule, (m.get(e.alertRule) || 0) + 1);
    }
    return m;
  }, [history]);
  const ruleStatus = useCallback((rl: MonitorRule): RuleStatus => {
    if ((rl.state || 'Active') === 'Disabled') return 'Disabled';
    return (firingByRule.get(rl.azureRuleName || '') || 0) > 0 ? 'Firing' : 'Healthy';
  }, [firingByRule]);
  const counts = useMemo(() => {
    let healthy = 0, firing = 0, disabled = 0;
    for (const rl of rules) { const st = ruleStatus(rl); if (st === 'Disabled') disabled++; else if (st === 'Firing') firing++; else healthy++; }
    return { total: rules.length, healthy, firing, disabled };
  }, [rules, ruleStatus]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Check', actions: [
        { label: 'Custom KQL check', onClick: () => { setTab('checks'); setWizardDef(CHECK_TYPE_LIBRARY.find((d) => d.id === 'custom') || null); }, disabled: false },
      ]},
      { label: 'View', actions: [
        { label: historyBusy ? 'Refreshing…' : 'Refresh', onClick: () => { void loadRules(); setHistoryLoaded(false); void loadHistory(); }, disabled: historyBusy },
      ]},
    ]},
  ], [loadRules, loadHistory, historyBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create health check" intro="Data-freshness / SLA monitoring backed by real Azure Monitor scheduled-query alert rules. Azure-native default — no Fabric required." />;

  const statusBadge = (st: RuleStatus) => <Badge appearance="tint" color={st === 'Firing' ? 'danger' : st === 'Disabled' ? 'warning' : 'success'}>{st}</Badge>;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Health check (Palantir Foundry Health Checks · Azure Monitor)</MessageBarTitle>
          Define checks (data freshness, row-count, or a custom KQL condition) over Log Analytics, run them on demand or on a schedule, watch status &amp; fired-alert history, and alert via action groups. Every check is a real Azure Monitor scheduledQueryRule — Azure-native default (Fabric Reflex is opt-in via LOOM_ACTIVATOR_BACKEND=fabric).
        </MessageBarBody></MessageBar>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)} className={s.tabStrip}>
          <Tab value="checks" icon={<Flash20Regular />}>Checks{rules.length ? ` (${rules.length})` : ''}</Tab>
          <Tab value="status" icon={<Pulse20Regular />}>Status</Tab>
          <Tab value="history" icon={<History20Regular />}>History</Tab>
          <Tab value="notifications" icon={<Alert20Regular />}>Notifications</Tab>
          <Tab value="settings" icon={<Settings20Regular />}>Settings</Tab>
        </TabList>

        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

        {/* ───────── Checks ───────── */}
        {tab === 'checks' && <>
          <CheckTypeGallery onPick={(def) => setWizardDef(def)} />

          <div className={s.section}>
            <SectionHead icon={<Database20Regular />} title="Active checks" hint="Each row is a real scheduledQueryRule. Run now, enable/disable, or delete — all hit Azure Monitor." />
            {rules.length === 0 ? <div className={s.empty}><Caption1>No checks yet — pick a check type above to open the wizard.</Caption1></div> : (
              <div className={s.tableWrap}>
              <Table size="small" aria-label="Checks">
                <TableHeader><TableRow>
                  <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Severity</TableHeaderCell><TableHeaderCell>Frequency</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {rules.map((rl) => { const st = ruleStatus(rl); const isDisabled = (rl.state || 'Active') === 'Disabled'; const rb = rowBusy === rl.id; return (
                    <TableRow key={rl.id}>
                      <TableCell>{rl.name}</TableCell>
                      <TableCell>{rl.checkType || '—'}</TableCell>
                      <TableCell><Badge appearance="tint" color={hcSeverityColor(rl.severity)}>{hcSeverityLabel(rl.severity)}</Badge></TableCell>
                      <TableCell>{rl.evaluationFrequency || '—'}</TableCell>
                      <TableCell>{statusBadge(st)}</TableCell>
                      <TableCell>
                        <div className={s.rowActions}>
                          <Button size="small" appearance="subtle" icon={<Play20Regular />} disabled={rb} onClick={() => runRule(rl)}>Run</Button>
                          {isDisabled
                            ? <Button size="small" appearance="subtle" icon={<CheckmarkCircle20Regular />} disabled={rb} onClick={() => toggleRule(rl, true)}>Enable</Button>
                            : <Button size="small" appearance="subtle" icon={<Warning20Regular />} disabled={rb} onClick={() => toggleRule(rl, false)}>Disable</Button>}
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} disabled={rb} onClick={() => deleteRule(rl)}>Delete</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ); })}
                </TableBody>
              </Table>
              </div>
            )}
            {run && (
              <div className={s.runPanel}>
                <div className={s.cardHead}>
                  {run.fired ? <DismissCircle20Regular className={s.cFiring} /> : <CheckmarkCircle20Regular className={s.cHealthy} />}
                  <Subtitle2>Run “{run.ruleName}”</Subtitle2>
                  <Badge appearance="tint" color={run.fired ? 'danger' : 'success'}>{run.fired ? 'Would fire' : 'Pass'}</Badge>
                  <span className={s.spacer} />
                  <Caption1 className={s.hint}>{run.count} matching row{run.count === 1 ? '' : 's'} in the last hour</Caption1>
                </div>
                {run.columns.length > 0 && <CodeBlock ariaLabel="Run result" content={JSON.stringify({ columns: run.columns, rows: run.rows }, null, 2)} />}
              </div>
            )}
          </div>
        </>}

        {/* ───────── Status ───────── */}
        {tab === 'status' && (
          <div className={s.section}>
            <SectionHead icon={<Pulse20Regular />} title="Status dashboard" hint="Live health of every check — derived from rule state and fired/unresolved Azure Monitor alerts." />
            {historyBusy && <Spinner size="tiny" label="Loading status…" labelPosition="after" />}
            {historyMsg && <MessageBar intent={historyMsg.intent}><MessageBarBody>{historyMsg.text}</MessageBarBody></MessageBar>}
            {rules.length === 0 ? <div className={s.empty}><Caption1>No checks to report on yet.</Caption1></div> : <>
              <div className={s.statGrid}>
                <div className={s.statTile}><div className={s.statHead}><Database20Regular /><Caption1>Total checks</Caption1></div><Title2 className={s.cTotal}>{counts.total}</Title2></div>
                <div className={s.statTile}><div className={s.statHead}><CheckmarkCircle20Regular /><Caption1>Healthy</Caption1></div><Title2 className={s.cHealthy}>{counts.healthy}</Title2></div>
                <div className={s.statTile}><div className={s.statHead}><DismissCircle20Regular /><Caption1>Firing</Caption1></div><Title2 className={s.cFiring}>{counts.firing}</Title2></div>
                <div className={s.statTile}><div className={s.statHead}><Warning20Regular /><Caption1>Disabled</Caption1></div><Title2 className={s.cDisabled}>{counts.disabled}</Title2></div>
              </div>
              <div className={s.tableWrap}>
              <Table size="small" aria-label="Status">
                <TableHeader><TableRow>
                  <TableHeaderCell>Check</TableHeaderCell><TableHeaderCell>Severity</TableHeaderCell>
                  <TableHeaderCell>Open alerts</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {rules.map((rl) => (
                    <TableRow key={rl.id}>
                      <TableCell>{rl.name}</TableCell>
                      <TableCell><Badge appearance="tint" color={hcSeverityColor(rl.severity)}>{hcSeverityLabel(rl.severity)}</Badge></TableCell>
                      <TableCell>{firingByRule.get(rl.azureRuleName || '') || 0}</TableCell>
                      <TableCell>{statusBadge(ruleStatus(rl))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </>}
          </div>
        )}

        {/* ───────── History ───────── */}
        {tab === 'history' && (
          <div className={s.section}>
            <SectionHead icon={<History20Regular />} title="Fired-alert history" hint="Fired / resolved alert instances from Azure Monitor (Microsoft.AlertsManagement) for this check's rules — last 14 days." />
            {historyBusy && <Spinner size="tiny" label="Loading history…" labelPosition="after" />}
            {historyMsg && <MessageBar intent={historyMsg.intent}><MessageBarBody>{historyMsg.text}</MessageBarBody></MessageBar>}
            {!historyBusy && history.length === 0 ? <div className={s.empty}><Caption1>{rules.length ? 'No alerts fired in the window.' : 'Add a check to start collecting history.'}</Caption1></div> : (
              <div className={s.tableWrap}>
              <Table size="small" aria-label="History">
                <TableHeader><TableRow>
                  <TableHeaderCell>Fired</TableHeaderCell><TableHeaderCell>Rule</TableHeaderCell>
                  <TableHeaderCell>Condition</TableHeaderCell><TableHeaderCell>Severity</TableHeaderCell>
                  <TableHeaderCell>Matched rows</TableHeaderCell><TableHeaderCell>Resolved</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {history.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.startDateTime ? new Date(e.startDateTime).toLocaleString() : '—'}</TableCell>
                      <TableCell>{e.alertRule || '—'}</TableCell>
                      <TableCell><Badge appearance="tint" color={e.monitorCondition === 'Resolved' ? 'success' : 'danger'}>{e.monitorCondition || '—'}</Badge></TableCell>
                      <TableCell>{e.severity || '—'}</TableCell>
                      <TableCell>{e.payload?.matchingRowsCount ?? '—'}</TableCell>
                      <TableCell>{e.monitorConditionResolvedDateTime ? new Date(e.monitorConditionResolvedDateTime).toLocaleString() : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </div>
        )}

        {/* ───────── Notifications ───────── */}
        {tab === 'notifications' && <HealthCheckNotifications id={id} itemName={item.displayName || id} />}

        {/* ───────── Settings ───────── */}
        {tab === 'settings' && (
          <div className={s.section}>
            <SectionHead icon={<Settings20Regular />} title="Backend & infrastructure" hint="What this health check runs on, and the Azure prerequisites." />
            <MessageBar intent="info"><MessageBarBody>
              <MessageBarTitle>Azure-native default — no Microsoft Fabric</MessageBarTitle>
              Checks are real Azure Monitor scheduled-query alert rules over Log Analytics. Creating / running / scheduling requires <b>LOOM_LOG_ANALYTICS_WORKSPACE_ID</b> (run KQL), <b>LOOM_LOG_ANALYTICS_RESOURCE_ID</b> + <b>LOOM_ALERT_RG</b> (create rules), and the Console UAMI granted <b>Monitoring Contributor</b> on the alert resource group (plus <b>Monitoring Reader</b> at subscription scope for fired-alert history). A Fabric Reflex backend is opt-in only via LOOM_ACTIVATOR_BACKEND=fabric.
            </MessageBarBody></MessageBar>
            <MessageBar intent="success"><MessageBarBody>
              <MessageBarTitle>Check-type library available</MessageBarTitle>
              The full check-type library is built: {CHECK_TYPE_LIBRARY.length} check types across Time / Size / Content / Schema / Status families, each a typed wizard with operator + threshold controls and a live KQL preview + sample run. Also available: on-demand run, enable / disable / delete, a status dashboard, fired-alert history, and action-group channel management with test-fire (see the <b>Notifications</b> tab). Still planned: Monitoring Views and incident/issue management (tracked in docs/fiab/parity/health-check.md).
            </MessageBarBody></MessageBar>
          </div>
        )}

        <HealthCheckWizard id={id} def={wizardDef} onClose={() => setWizardDef(null)} onCreate={createRule} />
      </div>
    } />
  );
}

// ─────────── HealthCheck → Notifications (Azure Monitor action groups) ───────────
// Real channel management for the check's alerts. Every channel is a live
// action-group receiver (email / SMS / webhook / Azure Function / Logic App)
// upserted via Microsoft.Insights/actionGroups; "Send test" fires a real
// createNotifications through every receiver. Azure-native default — no Fabric.
// Backed by /api/items/health-check/[id]/action-group (GET list + PUT upsert +
// POST test). New check rules created afterward bind to this action group.
type AgSms = { countryCode: string; phoneNumber: string };
type AgWebhook = { name?: string; serviceUri: string; useCommonAlertSchema?: boolean };
type AgFunction = { name?: string; functionUrl: string; useCommonAlertSchema?: boolean };
type AgLogicApp = { name?: string; resourceId: string; useCommonAlertSchema?: boolean };
interface HcActionGroup {
  name: string; id?: string; shortName: string;
  emails: string[]; sms: AgSms[]; webhooks: AgWebhook[]; functions: AgFunction[]; logicApps: AgLogicApp[];
}
interface AgSummaryRow {
  name: string; id: string; shortName?: string;
  emailCount: number; smsCount: number; webhookCount: number; logicAppCount: number;
}

function HealthCheckNotifications({ id, itemName }: { id: string; itemName: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [groups, setGroups] = useState<AgSummaryRow[]>([]);
  const [savedId, setSavedId] = useState<string | undefined>(undefined);

  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [emails, setEmails] = useState<string[]>([]);
  const [sms, setSms] = useState<AgSms[]>([]);
  const [webhooks, setWebhooks] = useState<AgWebhook[]>([]);
  const [functions, setFunctions] = useState<AgFunction[]>([]);
  const [logicApps, setLogicApps] = useState<AgLogicApp[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/action-group`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
      } else {
        setGroups(Array.isArray(j.groups) ? j.groups : []);
        setMsg(null);
      }
      const cur = (j?.current || null) as HcActionGroup | null;
      if (cur && cur.name) {
        setName(cur.name); setShortName(cur.shortName || ''); setSavedId(cur.id);
        setEmails(Array.isArray(cur.emails) ? cur.emails : []);
        setSms(Array.isArray(cur.sms) ? cur.sms : []);
        setWebhooks(Array.isArray(cur.webhooks) ? cur.webhooks : []);
        setFunctions(Array.isArray(cur.functions) ? cur.functions : []);
        setLogicApps(Array.isArray(cur.logicApps) ? cur.logicApps : []);
      } else {
        const base = (itemName || 'health-check').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'health-check';
        setName((n) => n || `${base}-ag`);
        setShortName((n) => n || ((itemName || 'loom').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom'));
      }
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, itemName]);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/action-group`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), shortName: shortName.trim() || undefined, emails, sms, webhooks, functions, logicApps }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setSavedId(j.id);
      setMsg({ intent: 'success', text: `Saved action group “${j.current?.name || name}”. New checks created from here on notify these channels.` });
      void load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }, [id, name, shortName, emails, sms, webhooks, functions, logicApps, load]);

  const test = useCallback(async () => {
    setTesting(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/health-check/${encodeURIComponent(id)}/action-group`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionGroupId: savedId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      const rc = j.result?.receivers || {};
      setMsg({ intent: 'success', text: `Test notification sent (HTTP ${j.result?.status ?? '—'}) to ${rc.emails || 0} email · ${rc.sms || 0} SMS · ${rc.webhooks || 0} webhook/function · ${rc.logicApps || 0} Logic App receiver(s).` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setTesting(false); }
  }, [id, savedId]);

  const channelCount = emails.length + sms.length + webhooks.length + functions.length + logicApps.length;
  const rowStyle: CSSProperties = { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' };
  const chanHead = (icon: ReactNode, title: string) => (
    <div className={s.sectionHead}><span className={s.sectionIcon}>{icon}</span><Subtitle2>{title}</Subtitle2></div>
  );

  return (
    <div className={s.section}>
      <SectionHead icon={<Alert20Regular />} title="Notification channels" hint="The Azure Monitor action group this check's alerts fire. Every row is a real action-group receiver — Azure-native, no Fabric." />
      <MessageBar intent="info"><MessageBarBody>
        Saving upserts a real <b>Microsoft.Insights/actionGroups</b> and binds new check rules to it; <b>Send test</b> delivers a Common Alert Schema payload through every receiver. Requires <b>LOOM_SUBSCRIPTION_ID</b> + <b>LOOM_ALERT_RG</b> and the Console UAMI as <b>Monitoring Contributor</b>.
      </MessageBarBody></MessageBar>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {loading && <Spinner size="tiny" label="Loading channels…" labelPosition="after" />}

      <div className={s.addBar}>
        <Field label="Action group name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="orders-health-ag" /></Field>
        <Field label="Short name (≤12, shown in alerts)"><Input value={shortName} maxLength={12} onChange={(_, d) => setShortName(d.value)} placeholder="loom" /></Field>
        <span className={s.spacer} />
        <Badge appearance="tint" color={channelCount ? 'brand' : 'warning'}>{channelCount} receiver{channelCount === 1 ? '' : 's'}</Badge>
        {savedId && <Badge appearance="tint" color="success">saved</Badge>}
      </div>

      {/* Email */}
      <div>
        {chanHead(<People20Regular />, 'Email')}
        {emails.map((e, i) => (
          <div key={i} style={rowStyle}>
            <Field label={i === 0 ? 'Email address' : ''} style={{ flex: 1, minWidth: 240 }}>
              <Input type="email" value={e} onChange={(_, d) => setEmails((arr) => arr.map((x, j) => (j === i ? d.value : x)))} placeholder="oncall@contoso.com" />
            </Field>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setEmails((arr) => arr.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setEmails((arr) => [...arr, ''])} style={{ marginTop: tokens.spacingVerticalXS }}>Add email</Button>
      </div>

      {/* SMS */}
      <div>
        {chanHead(<Pulse20Regular />, 'SMS')}
        {sms.map((r, i) => (
          <div key={i} style={rowStyle}>
            <Field label={i === 0 ? 'Country code' : ''} style={{ width: 120 }}>
              <Input value={r.countryCode} onChange={(_, d) => setSms((arr) => arr.map((x, j) => (j === i ? { ...x, countryCode: d.value } : x)))} placeholder="1" />
            </Field>
            <Field label={i === 0 ? 'Phone number' : ''} style={{ flex: 1, minWidth: 200 }}>
              <Input value={r.phoneNumber} onChange={(_, d) => setSms((arr) => arr.map((x, j) => (j === i ? { ...x, phoneNumber: d.value } : x)))} placeholder="5555550123" />
            </Field>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setSms((arr) => arr.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setSms((arr) => [...arr, { countryCode: '1', phoneNumber: '' }])} style={{ marginTop: tokens.spacingVerticalXS }}>Add SMS</Button>
      </div>

      {/* Webhook */}
      <div>
        {chanHead(<Link20Regular />, 'Webhook')}
        {webhooks.map((r, i) => (
          <div key={i} style={rowStyle}>
            <Field label={i === 0 ? 'HTTPS endpoint' : ''} style={{ flex: 1, minWidth: 280 }}>
              <Input value={r.serviceUri} onChange={(_, d) => setWebhooks((arr) => arr.map((x, j) => (j === i ? { ...x, serviceUri: d.value } : x)))} placeholder="https://hooks.example.com/alert" />
            </Field>
            <Switch checked={r.useCommonAlertSchema !== false} label="Common Alert Schema" onChange={(_, d) => setWebhooks((arr) => arr.map((x, j) => (j === i ? { ...x, useCommonAlertSchema: d.checked } : x)))} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setWebhooks((arr) => arr.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setWebhooks((arr) => [...arr, { serviceUri: '', useCommonAlertSchema: true }])} style={{ marginTop: tokens.spacingVerticalXS }}>Add webhook</Button>
      </div>

      {/* Azure Function */}
      <div>
        {chanHead(<Code20Regular />, 'Azure Function')}
        <Caption1 className={s.hint}>Delivered as a webhook to the function's HTTPS trigger URL (include the function key).</Caption1>
        {functions.map((r, i) => (
          <div key={i} style={rowStyle}>
            <Field label={i === 0 ? 'Function HTTPS trigger URL' : ''} style={{ flex: 1, minWidth: 280 }}>
              <Input value={r.functionUrl} onChange={(_, d) => setFunctions((arr) => arr.map((x, j) => (j === i ? { ...x, functionUrl: d.value } : x)))} placeholder="https://myfunc.azurewebsites.net/api/alert?code=..." />
            </Field>
            <Switch checked={r.useCommonAlertSchema !== false} label="Common Alert Schema" onChange={(_, d) => setFunctions((arr) => arr.map((x, j) => (j === i ? { ...x, useCommonAlertSchema: d.checked } : x)))} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setFunctions((arr) => arr.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setFunctions((arr) => [...arr, { functionUrl: '', useCommonAlertSchema: true }])} style={{ marginTop: tokens.spacingVerticalXS }}>Add function</Button>
      </div>

      {/* Logic App */}
      <div>
        {chanHead(<Cloud20Regular />, 'Logic App')}
        <Caption1 className={s.hint}>The workflow's callback URL is resolved from its resource id via ARM listCallbackUrl on save.</Caption1>
        {logicApps.map((r, i) => (
          <div key={i} style={rowStyle}>
            <Field label={i === 0 ? 'Logic App resource id' : ''} style={{ flex: 1, minWidth: 320 }}>
              <Input value={r.resourceId} onChange={(_, d) => setLogicApps((arr) => arr.map((x, j) => (j === i ? { ...x, resourceId: d.value } : x)))} placeholder="/subscriptions/…/providers/Microsoft.Logic/workflows/notify" />
            </Field>
            <Switch checked={r.useCommonAlertSchema !== false} label="Common Alert Schema" onChange={(_, d) => setLogicApps((arr) => arr.map((x, j) => (j === i ? { ...x, useCommonAlertSchema: d.checked } : x)))} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setLogicApps((arr) => arr.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setLogicApps((arr) => [...arr, { resourceId: '', useCommonAlertSchema: true }])} style={{ marginTop: tokens.spacingVerticalXS }}>Add Logic App</Button>
      </div>

      <div style={rowStyle}>
        <Button appearance="primary" icon={<Alert20Regular />} disabled={saving || !name.trim()} onClick={save}>{saving ? 'Saving…' : 'Save channels'}</Button>
        <Button appearance="secondary" icon={<Play20Regular />} disabled={testing || !savedId} onClick={test} title={savedId ? undefined : 'Save the action group first.'}>{testing ? 'Sending…' : 'Send test'}</Button>
        <span className={s.spacer} />
        {groups.length > 0 && <Caption1 className={s.hint}>{groups.length} action group{groups.length === 1 ? '' : 's'} in {`LOOM_ALERT_RG`}</Caption1>}
      </div>
    </div>
  );
}
