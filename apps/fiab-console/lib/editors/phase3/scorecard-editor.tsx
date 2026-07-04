'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ScorecardEditor — goals + rollups + check-ins + connected metrics.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md, rel-T03/B11): scorecards are
 * a Loom-native goal store — goals live in Cosmos (bundle `state.content` +
 * the scorecard-goals / scorecard-checkins containers) and the rollup/status
 * engine runs in the BFF. No Power BI workspace is required and the default
 * render makes ZERO Power BI network calls.
 *
 * Power BI scorecard sync is the OPT-IN Fabric-family leg, enabled via
 * NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi: the workspace picker appears, live
 * Power BI scorecards list alongside the Loom ones, check-ins also push to
 * the live Fabric goal, and "Open in Power BI" links out.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RollupMethod, StatusColor, StatusOperator, StatusMetricKind, StatusRule } from '@/lib/apps/content-bundles/types';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, SpinButton,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular, DatabaseLink20Regular,
  List20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { usePowerBiWorkspaces, WorkspacePicker } from './workspace-picker';
import { useStyles } from './styles';

interface ScorecardLite { id: string; displayName: string; description?: string; }
type ScorecardGoalStatusUi = 'notStarted' | 'onTrack' | 'atRisk' | 'behindGoal' | 'aheadOfGoal' | 'completed';
interface ConnectedMetricUi { workspaceId: string; datasetId: string; daxExpression: string; lastValue?: number; lastRefreshed?: string; }
interface GoalLite {
  id?: string;
  name?: string;
  description?: string;
  currentValue?: number;
  /** Rollup-computed value (parent goals) — overrides currentValue for display + status. */
  computedValue?: number;
  targetValue?: number;
  /** Resolved status color from the BFF rollup engine. */
  status?: StatusColor;
  /** Editor-only UI status band (notStarted/onTrack/atRisk/…), kept distinct from the rollup-engine StatusColor. */
  statusUi?: ScorecardGoalStatusUi;
  owner?: string;
  dueDate?: string;
  subGoalIds?: string[];
  connectedMetric?: ConnectedMetricUi;
  parentId?: string;
  rollupMethod?: RollupMethod;
  statusRules?: StatusRule[];
  otherwiseStatus?: StatusColor;
}
interface CheckInRow { id: string; value: number; status?: string; note?: string; checkInDate?: string; recordedAt: string; source?: string; }
interface DatasetLite { id: string; name?: string; displayName?: string; }

const SC_STATUS_OPTIONS: { value: ScorecardGoalStatusUi; label: string }[] = [
  { value: 'notStarted', label: 'Not started' },
  { value: 'onTrack', label: 'On track' },
  { value: 'atRisk', label: 'At risk' },
  { value: 'behindGoal', label: 'Behind' },
  { value: 'aheadOfGoal', label: 'Ahead' },
  { value: 'completed', label: 'Completed' },
];
function scStatusColor(st?: string): 'success' | 'warning' | 'danger' | 'informative' | 'brand' {
  switch (st) {
    case 'onTrack': case 'completed': return 'success';
    case 'aheadOfGoal': return 'brand';
    case 'atRisk': return 'warning';
    case 'behindGoal': return 'danger';
    default: return 'informative';
  }
}
function scStatusLabel(st?: string): string {
  return SC_STATUS_OPTIONS.find((o) => o.value === st)?.label || (st ? String(st) : '—');
}

const SC_STATUS_LABEL: Record<StatusColor, string> = {
  'on-track': 'On Track',
  'at-risk': 'At Risk',
  'behind': 'Behind',
  'completed': 'Completed',
  'not-started': 'Not Started',
};
const SC_STATUS_BADGE_COLOR: Record<StatusColor, 'success' | 'warning' | 'danger' | 'informative' | 'subtle'> = {
  'on-track': 'success',
  'at-risk': 'warning',
  'behind': 'danger',
  'completed': 'informative',
  'not-started': 'subtle',
};
const SC_STATUS_COLORS: StatusColor[] = ['on-track', 'at-risk', 'behind', 'completed', 'not-started'];
const SC_ROLLUP_METHODS: { value: RollupMethod; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min (Worst child)' },
  { value: 'max', label: 'Max' },
];
const SC_OPERATORS: StatusOperator[] = ['>=', '<=', '>', '<', '='];
const SC_METRIC_KINDS: { value: StatusMetricKind; label: string }[] = [
  { value: 'value', label: 'Value' },
  { value: 'percent-of-target', label: '% of target' },
];

function ScStatusBadge({ status }: { status?: StatusColor }) {
  if (!status) return null;
  return (
    <Badge appearance="filled" color={SC_STATUS_BADGE_COLOR[status] ?? 'subtle'}>
      {SC_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * No-freeform rollup + status-rule config editor for one goal. All inputs are
 * fixed-enum dropdowns / numeric fields (mirrors ConditionalFormattingEditor).
 * Stateless — all values come from props + onChange.
 */
function ScRollupEditor({ goal, childCount, onChange }: {
  goal: GoalLite;
  childCount: number;
  onChange: (patch: Partial<GoalLite>) => void;
}) {
  const rules = goal.statusRules || [];
  const updateRule = (idx: number, patch: Partial<StatusRule>) =>
    onChange({ statusRules: rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) });
  const addRule = () =>
    onChange({ statusRules: [...rules, { operator: '>=', threshold: 0, metricKind: 'value', status: 'on-track' }] });
  const removeRule = (idx: number) =>
    onChange({ statusRules: rules.filter((_, i) => i !== idx) });
  const fieldRow: React.CSSProperties = { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>{goal.name || goal.id}</Caption1>
        {childCount > 0 && <Badge appearance="outline" color="brand">Parent · {childCount} {childCount === 1 ? 'child' : 'children'}</Badge>}
        <ScStatusBadge status={goal.status} />
      </div>
      {childCount > 0 && (
        <div style={fieldRow}>
          <Label size="small">Rollup method</Label>
          <Select size="small" value={goal.rollupMethod || ''} aria-label={`${goal.name || goal.id} rollup method`}
            onChange={(_: unknown, d: any) => onChange({ rollupMethod: (d.value || undefined) as RollupMethod | undefined })}>
            <option value="">None (use own value)</option>
            {SC_ROLLUP_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
          {goal.computedValue !== undefined && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>rolled-up value: <strong>{goal.computedValue}</strong></Caption1>
          )}
        </div>
      )}
      <div>
        <Caption1 style={{ fontWeight: 600 }}>Status rules</Caption1>
        {rules.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block' }}>No rules — goal uses the Otherwise status. Add a rule to color by threshold.</Caption1>
        )}
      </div>
      {rules.map((r, ri) => (
        <div key={ri} style={fieldRow}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 36 }}>{ri === 0 ? 'If' : 'else if'}</Caption1>
          <Select size="small" value={r.metricKind} aria-label={`Rule ${ri + 1} metric`}
            onChange={(_: unknown, d: any) => updateRule(ri, { metricKind: d.value as StatusMetricKind })}>
            {SC_METRIC_KINDS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
          <Select size="small" value={r.operator} aria-label={`Rule ${ri + 1} operator`}
            onChange={(_: unknown, d: any) => updateRule(ri, { operator: d.value as StatusOperator })}>
            {SC_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
          </Select>
          <Input size="small" type="number" style={{ width: 90 }} value={String(r.threshold)} aria-label={`Rule ${ri + 1} threshold`}
            onChange={(_: unknown, d: any) => updateRule(ri, { threshold: Number(d.value) || 0 })} />
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>→</Caption1>
          <Select size="small" value={r.status} aria-label={`Rule ${ri + 1} status`}
            onChange={(_: unknown, d: any) => updateRule(ri, { status: d.value as StatusColor })}>
            {SC_STATUS_COLORS.map((c) => <option key={c} value={c}>{SC_STATUS_LABEL[c]}</option>)}
          </Select>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete rule ${ri + 1}`} onClick={() => removeRule(ri)} />
        </div>
      ))}
      <div style={fieldRow}>
        <Tooltip relationship="label" content="Add a threshold-based status rule, e.g. if value >= 100 then on-track">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={addRule}>Add rule</Button>
        </Tooltip>
        <Label size="small" style={{ marginLeft: tokens.spacingHorizontalM}}>Otherwise</Label>
        <Tooltip relationship="label" content="Status when no other rule matches">
          <Select size="small" value={goal.otherwiseStatus || ''} aria-label={`${goal.name || goal.id} otherwise status`}
            onChange={(_: unknown, d: any) => onChange({ otherwiseStatus: (d.value || undefined) as StatusColor | undefined })}>
            <option value="">Not Started (default)</option>
            {SC_STATUS_COLORS.map((c) => <option key={c} value={c}>{SC_STATUS_LABEL[c]}</option>)}
          </Select>
        </Tooltip>
      </div>
    </div>
  );
}


export function ScorecardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // Azure-native DEFAULT (rel-T03/B11): the Loom Cosmos goal store needs no
  // Power BI workspace. The picker + live Power BI scorecard sync are the
  // opt-in Fabric-family leg (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi). When the
  // opt-in is off the hook is disabled — zero Power BI network calls.
  const pbiOptIn = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '').toLowerCase() === 'powerbi';
  const ws = usePowerBiWorkspaces(pbiOptIn);
  const [workspaceId, setWorkspaceId] = useState('');
  const [scorecards, setScorecards] = useState<ScorecardLite[] | null>(null);
  const [scorecardId, setScorecardId] = useState('');
  const [goals, setGoals] = useState<GoalLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);

  // Check-in flyout (value + status + note + date).
  const [entryOpen, setEntryOpen] = useState<{ goalId: string } | null>(null);
  const [entryValue, setEntryValue] = useState('');
  const [entryTarget, setEntryTarget] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [entryStatus, setEntryStatus] = useState<ScorecardGoalStatusUi | ''>('');
  const [entryDate, setEntryDate] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);
  // Rollup + status-rule config (Configure rollups panel).
  const [configOpen, setConfigOpen] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [configNote, setConfigNote] = useState<string | null>(null);
  // Editable draft of the goals' config, synced from the loaded goals.
  const [draft, setDraft] = useState<GoalLite[]>([]);

  // "Open in Power BI" portal host — cloud-correct for Gov when
  // NEXT_PUBLIC_LOOM_POWERBI_PORTAL is set; empty string hides the link
  // (GCC-High / IL5 where Power BI isn't reachable).
  const pbiPortal = process.env.NEXT_PUBLIC_LOOM_POWERBI_PORTAL ?? 'https://app.powerbi.com';

  // Connected-metric binder flyout.
  const [bindOpen, setBindOpen] = useState<{ goalId: string } | null>(null);
  const [bindDatasets, setBindDatasets] = useState<DatasetLite[]>([]);
  const [bindDatasetId, setBindDatasetId] = useState('');
  const [bindDax, setBindDax] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindTestValue, setBindTestValue] = useState<number | null | undefined>(undefined);
  const [bindErr, setBindErr] = useState<string | null>(null);

  // Live metric pull (per-goal, from the grid).
  const [metricBusy, setMetricBusy] = useState<string | null>(null);
  const [metricValues, setMetricValues] = useState<Record<string, number | null>>({});

  // Check-in history flyout.
  const [historyOpen, setHistoryOpen] = useState<{ goalId: string } | null>(null);
  const [historyRows, setHistoryRows] = useState<CheckInRow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  // Optional workspace query-string — empty on the Azure-native default path
  // (the BFF serves Cosmos-backed scorecards with no workspaceId).
  const wsQs = useCallback((wsId: string) => (wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : ''), []);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await clientFetch(`/api/items/scorecard${wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : ''}`);
      const j = await r.json();
      if (!j.ok) { setScorecards([]); setErr(j.error); return; }
      setScorecards(j.scorecards || []);
      setScorecardId((prev) => prev || (j.scorecards?.[0]?.id ?? ''));
    } catch (e: any) { setScorecards([]); setErr(e?.message || String(e)); }
  }, []);

  const loadGoals = useCallback(async (wsId: string, scId: string) => {
    try {
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scId)}${wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : ''}`);
      const j = await r.json();
      if (j.ok) { setGoals(j.goals || []); setDraft(j.goals || []); } else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  // Power BI opt-in: auto-pick the first Power BI workspace so the live list
  // loads. On the Azure-native default the Loom (Cosmos) scorecards list
  // immediately — no workspace needed.
  useEffect(() => {
    if (pbiOptIn && !workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [pbiOptIn, workspaceId, ws.workspaces]);
  useEffect(() => {
    if (!pbiOptIn) { loadList(''); return; }
    if (workspaceId) loadList(workspaceId);
  }, [pbiOptIn, workspaceId, loadList]);
  useEffect(() => { if (scorecardId) loadGoals(workspaceId, scorecardId); }, [workspaceId, scorecardId, loadGoals]);

  const submitValue = useCallback(async () => {
    if (!entryOpen || !scorecardId) return;
    const value = Number(entryValue);
    if (!Number.isFinite(value)) { setEntryErr('numeric value required'); return; }
    setEntryBusy(true); setEntryErr(null);
    try {
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}${wsQs(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goalId: entryOpen.goalId,
          value,
          targetValue: entryTarget ? Number(entryTarget) : undefined,
          noteText: entryNote || undefined,
          status: entryStatus || undefined,
          goalValueDate: entryDate || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setEntryErr(j.error || 'submit failed'); return; }
      setEntryOpen(null); setEntryValue(''); setEntryTarget(''); setEntryNote(''); setEntryStatus(''); setEntryDate('');
      loadGoals(workspaceId, scorecardId);
    } catch (e: any) { setEntryErr(e?.message || String(e)); } finally { setEntryBusy(false); }
  }, [entryOpen, entryValue, entryTarget, entryNote, entryStatus, entryDate, workspaceId, scorecardId, loadGoals, wsQs]);

  // Open the connected-metric binder for a goal and load candidate datasets.
  const openBinder = useCallback(async (goalId: string) => {
    const goal = goals.find((g) => g.id === goalId);
    setBindOpen({ goalId });
    setBindDatasetId(goal?.connectedMetric?.datasetId || '');
    setBindDax(goal?.connectedMetric?.daxExpression || '');
    setBindTestValue(undefined); setBindErr(null); setBindDatasets([]);
    if (!workspaceId) return;
    try {
      const r = await clientFetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (j.ok) setBindDatasets(j.datasets || []);
    } catch { /* dataset list is best-effort; the binder still works by saving */ }
  }, [goals, workspaceId]);

  // Test a candidate DAX expression — pulls a live scalar via the metric route
  // after a transient save (binds, then evaluates). We bind first so the
  // metric-value route can read the binding from Cosmos.
  const testMetric = useCallback(async () => {
    if (!bindOpen || !workspaceId || !scorecardId) return;
    if (!bindDatasetId || !bindDax.trim()) { setBindErr('pick a dataset and enter a DAX expression'); return; }
    setBindBusy(true); setBindErr(null); setBindTestValue(undefined);
    try {
      const put = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: bindOpen.goalId, connectedMetric: { workspaceId, datasetId: bindDatasetId, daxExpression: bindDax.trim() } }),
      });
      const pj = await put.json();
      if (!pj.ok) { setBindErr(pj.error || 'bind failed'); return; }
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}/metric-value?goalId=${encodeURIComponent(bindOpen.goalId)}&workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setBindErr(`${j.error}${j.remediation ? ' — ' + j.remediation : ''}`); return; }
      setBindTestValue(j.value);
    } catch (e: any) { setBindErr(e?.message || String(e)); } finally { setBindBusy(false); }
  }, [bindOpen, bindDatasetId, bindDax, workspaceId, scorecardId]);

  // Persist the binding and close.
  const saveMetric = useCallback(async () => {
    if (!bindOpen || !workspaceId || !scorecardId) return;
    if (!bindDatasetId || !bindDax.trim()) { setBindErr('pick a dataset and enter a DAX expression'); return; }
    setBindBusy(true); setBindErr(null);
    try {
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: bindOpen.goalId, connectedMetric: { workspaceId, datasetId: bindDatasetId, daxExpression: bindDax.trim() } }),
      });
      const j = await r.json();
      if (!j.ok) { setBindErr(j.error || 'save failed'); return; }
      setBindOpen(null);
      loadGoals(workspaceId, scorecardId);
    } catch (e: any) { setBindErr(e?.message || String(e)); } finally { setBindBusy(false); }
  }, [bindOpen, bindDatasetId, bindDax, workspaceId, scorecardId, loadGoals]);

  // Pull the live value for a bound goal directly from the grid.
  const pullMetric = useCallback(async (goalId: string) => {
    if (!workspaceId || !scorecardId) return;
    setMetricBusy(goalId);
    try {
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}/metric-value?goalId=${encodeURIComponent(goalId)}&workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (j.ok) setMetricValues((m) => ({ ...m, [goalId]: j.value }));
      else setErr(`${j.error}${j.remediation ? ' — ' + j.remediation : ''}`);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setMetricBusy(null); }
  }, [workspaceId, scorecardId]);

  // Open + load the check-in history flyout for a goal (Cosmos-backed — no
  // Power BI workspace needed).
  const openHistory = useCallback(async (goalId: string) => {
    if (!scorecardId) return;
    setHistoryOpen({ goalId }); setHistoryRows([]); setHistoryBusy(true);
    try {
      const qs = new URLSearchParams();
      if (workspaceId) qs.set('workspaceId', workspaceId);
      qs.set('history', goalId);
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}?${qs.toString()}`);
      const j = await r.json();
      if (j.ok) setHistoryRows(j.checkIns || []); else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setHistoryBusy(false); }
  }, [workspaceId, scorecardId]);

  const refreshScorecard = useCallback(() => {
    loadList(workspaceId);
    if (scorecardId) loadGoals(workspaceId, scorecardId);
  }, [workspaceId, scorecardId, loadList, loadGoals]);
  const openScorecardInPbi = useCallback(() => {
    if (workspaceId && scorecardId && pbiPortal) {
      const url = `${pbiPortal}/groups/${encodeURIComponent(workspaceId)}/scorecards/${encodeURIComponent(scorecardId)}`;
      window.open(url, '_blank', 'noreferrer');
    }
  }, [workspaceId, scorecardId, pbiPortal]);
  const openCheckIn = useCallback((goalId: string) => {
    const g = goals.find((x) => x.id === goalId);
    setEntryOpen({ goalId });
    setEntryValue(''); setEntryNote('');
    setEntryTarget(g?.targetValue?.toString() || '');
    setEntryStatus(g?.statusUi || '');
    setEntryDate(new Date().toISOString().slice(0, 10));
  }, [goals]);

  // Patch one goal's config draft in place.
  const patchDraft = useCallback((goalId: string, patch: Partial<GoalLite>) => {
    setDraft((prev) => prev.map((g) => (g.id === goalId ? { ...g, ...patch } : g)));
  }, []);

  // Count children (draft goals whose parentId === this goal id).
  const childCountOf = useCallback((goalId?: string) => {
    if (!goalId) return 0;
    return draft.filter((g) => g.parentId === goalId).length;
  }, [draft]);

  // Persist the rollup + status-rule config, then reload to show computed
  // status (Cosmos-backed — works on the Azure-native default path).
  const saveConfig = useCallback(async () => {
    if (!scorecardId) return;
    setConfigBusy(true); setConfigErr(null); setConfigNote(null);
    try {
      const payload = draft.map((g) => ({
        goalId: g.id,
        parentId: g.parentId,
        rollupMethod: g.rollupMethod,
        statusRules: g.statusRules,
        otherwiseStatus: g.otherwiseStatus,
      }));
      const r = await clientFetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}/config${wsQs(workspaceId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goals: payload }),
      });
      const j = await r.json();
      if (!j.ok) { setConfigErr(j.error || 'save failed'); return; }
      if (j.note) setConfigNote(j.note);
      loadGoals(workspaceId, scorecardId);
    } catch (e: any) {
      setConfigErr(e?.message || String(e));
    } finally { setConfigBusy(false); }
  }, [draft, workspaceId, scorecardId, loadGoals, wsQs]);

  const scRibbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      // "Open in Power BI" belongs to the OPT-IN Fabric-family leg only —
      // the Azure-native default never leads with a Power BI affordance.
      ...(pbiOptIn ? [{ label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: scorecardId && pbiPortal ? openScorecardInPbi : undefined, disabled: !scorecardId || !pbiPortal, title: !pbiPortal ? 'Power BI is not reachable in this cloud' : (!scorecardId ? 'select a scorecard first' : 'opens Power BI Web — Fabric scorecard authoring lives there') },
      ]}] : []),
      { label: 'Goal', actions: [
        { label: 'Check in', icon: <Add20Regular />, onClick: selectedGoalId ? () => openCheckIn(selectedGoalId) : undefined, disabled: !selectedGoalId, title: !selectedGoalId ? 'select a goal first' : 'record a goal value + status + note' },
        { label: 'Bind metric', icon: <DatabaseLink20Regular />, onClick: selectedGoalId && workspaceId ? () => openBinder(selectedGoalId) : undefined, disabled: !selectedGoalId || !workspaceId, title: !workspaceId ? 'connected metrics pull live DAX values from a Power BI / AAS semantic model — enable the Power BI backend (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi) and select a workspace' : (!selectedGoalId ? 'select a goal first' : 'connect a DAX measure as this goal’s live value source') },
        { label: 'History', icon: <List20Regular />, onClick: selectedGoalId ? () => openHistory(selectedGoalId) : undefined, disabled: !selectedGoalId, title: !selectedGoalId ? 'select a goal first' : 'view this goal’s check-in history' },
      ]},
      { label: 'Metadata', actions: [
        { label: 'Refresh', onClick: refreshScorecard, title: 'reload list + selected scorecard goals' },
      ]},
      { label: 'Rollup', actions: [
        { label: configOpen ? 'Hide config' : 'Configure rollups', onClick: scorecardId ? () => setConfigOpen((v) => !v) : undefined, disabled: !scorecardId, title: !scorecardId ? 'select a scorecard first' : 'edit rollup aggregation + status rules' },
      ]},
    ]},
  ], [pbiOptIn, scorecardId, workspaceId, selectedGoalId, pbiPortal, openScorecardInPbi, refreshScorecard, openCheckIn, openBinder, openHistory, configOpen]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={scRibbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Scorecards</Subtitle2>
          {pbiOptIn && !workspaceId && <Caption1>Select a Power BI workspace to include live scorecards.</Caption1>}
          {scorecards && scorecards.length === 0 && <Caption1>No scorecards yet — create one from New item or install a scorecard app.</Caption1>}
          <Tree aria-label="Scorecards">
            {(scorecards || []).map((sc) => (
              <TreeItem key={sc.id} itemType="leaf" value={sc.id} onClick={() => setScorecardId(sc.id)}>
                <TreeItemLayout>{scorecardId === sc.id ? <strong>{sc.displayName}</strong> : sc.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Scorecard</Badge>
            {pbiOptIn && <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />}
            <Tooltip relationship="label" content="Reload the scorecard list">
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => loadList(workspaceId)}>Refresh</Button>
            </Tooltip>
            {pbiOptIn && scorecardId && pbiPortal && <Button appearance="primary" onClick={openScorecardInPbi} style={{ marginLeft: 'auto' }}>Open in Power BI</Button>}
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Scorecard goals + rollups + check-ins — Loom-native</MessageBarTitle>
              Goals live in Loom&apos;s own goal store: track <strong>current / target / status / owner / due</strong>,
              record <strong>check-ins</strong> (value + status + note) with full history, and let parent goals
              roll up from their children and color by status — all Azure-native, no Fabric or Power BI required.
              Use <strong>Configure rollups</strong> to set each goal&apos;s rollup aggregation (Sum / Average /
              Min&nbsp;= worst-child / Max) and ordered status rules (threshold → color).
              {pbiOptIn ? (
                <> The Power BI backend is enabled: live Power BI scorecards list alongside Loom ones, a goal can
                bind to a live <strong>DAX measure</strong> (pulled via <em>executeQueries</em>), and
                <strong> Open in Power BI</strong> opens the Fabric scorecard canvas.</>
              ) : (
                <> Optional: set <code>NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi</code> to also sync with live Power BI
                scorecards and bind goals to DAX measures.</>
              )}
            </MessageBarBody>
          </MessageBar>
          {scorecardId && (
            <>
              <Subtitle2>Goals ({goals.length})</Subtitle2>
              {goals.length === 0 ? (
                <Caption1>No goals on this scorecard yet. Install a scorecard app bundle to seed goals{pbiOptIn ? ', or author them in Power BI,' : ''} then refresh.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Goals" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Goal</TableHeaderCell>
                      <TableHeaderCell>Current</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Owner</TableHeaderCell>
                      <TableHeaderCell>Due</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {goals.map((g, i) => {
                        const isSub = !!g.id && goals.some((o) => (o.subGoalIds || []).includes(g.id!));
                        const live = g.id && g.id in metricValues ? metricValues[g.id] : undefined;
                        const current = live !== undefined ? live : (g.currentValue ?? g.connectedMetric?.lastValue);
                        const selected = selectedGoalId === g.id;
                        return (
                          <TableRow
                            key={g.id || i}
                            appearance={selected ? 'brand' : undefined}
                            onClick={() => g.id && setSelectedGoalId(g.id)}
                            style={{ cursor: g.id ? 'pointer' : 'default' }}
                          >
                            <TableCell>
                              <span style={{ paddingLeft: isSub ? 20 : 0 }}>
                                {isSub && <span style={{ color: tokens.colorNeutralForeground3, marginRight: tokens.spacingHorizontalXS}}>↳</span>}
                                {g.name || g.id || '—'}
                                {g.connectedMetric && <DatabaseLink20Regular style={{ marginLeft: tokens.spacingHorizontalS, verticalAlign: 'middle' }} title="connected metric" />}
                              </span>
                            </TableCell>
                            <TableCell>
                              {g.computedValue !== undefined ? (
                                <span title={`rolled up from children (${g.rollupMethod ?? 'rollup'}): ${g.computedValue}`}>
                                  {g.computedValue} <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(rollup)</Caption1>
                                </span>
                              ) : (current ?? '—')}
                              {g.id && g.connectedMetric && (
                                <Tooltip content="pull the live value from the connected DAX metric" relationship="label">
                                  <Button
                                    size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                                    disabled={metricBusy === g.id}
                                    onClick={(e) => { e.stopPropagation(); pullMetric(g.id!); }}
                                  />
                                </Tooltip>
                              )}
                            </TableCell>
                            <TableCell>{g.targetValue ?? '—'}</TableCell>
                            <TableCell>
                              {g.status ? (
                                <ScStatusBadge status={g.status} />
                              ) : (
                                <Badge appearance="filled" color={scStatusColor(g.statusUi)}>{scStatusLabel(g.statusUi)}</Badge>
                              )}
                            </TableCell>
                            <TableCell>{g.owner || '—'}</TableCell>
                            <TableCell>{g.dueDate || '—'}</TableCell>
                            <TableCell>
                              {g.id && (
                                <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
                                  <Tooltip relationship="label" content="Record a goal value, target, status, and note — updates history">
                                    <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={(e) => { e.stopPropagation(); openCheckIn(g.id!); }}>Check in</Button>
                                  </Tooltip>
                                  <Tooltip relationship="label" content={workspaceId ? "Connect this goal's value to a live DAX measure from a Power BI/AAS semantic model" : 'connected metrics need the Power BI backend opt-in (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi) + a workspace'}>
                                    <Button size="small" appearance="subtle" icon={<DatabaseLink20Regular />} disabled={!workspaceId} onClick={(e) => { e.stopPropagation(); openBinder(g.id!); }}>Bind</Button>
                                  </Tooltip>
                                  <Tooltip relationship="label" content="View all past check-ins for this goal">
                                    <Button size="small" appearance="subtle" icon={<List20Regular />} onClick={(e) => { e.stopPropagation(); openHistory(g.id!); }}>History</Button>
                                  </Tooltip>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {configOpen && (
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                    <Subtitle2>Rollup &amp; status rules</Subtitle2>
                    <Button size="small" appearance="primary" disabled={configBusy || draft.length === 0} onClick={saveConfig}>
                      {configBusy ? 'Saving…' : 'Save config'}
                    </Button>
                    <Button size="small" appearance="subtle" onClick={() => setConfigOpen(false)}>Close</Button>
                  </div>
                  {configErr && <MessageBar intent="error"><MessageBarBody>{configErr}</MessageBarBody></MessageBar>}
                  {configNote && <MessageBar intent="warning"><MessageBarBody>{configNote}</MessageBarBody></MessageBar>}
                  {draft.length === 0 ? (
                    <Caption1>No goals to configure.</Caption1>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                      {draft.map((g, i) => (
                        <ScRollupEditor
                          key={g.id || i}
                          goal={g}
                          childCount={childCountOf(g.id)}
                          onChange={(patch) => g.id && patchDraft(g.id, patch)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Check-in flyout — value + status + note + date */}
          <Dialog open={!!entryOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setEntryOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Check in</DialogTitle>
                <DialogContent>
                  <Field label="Value" required>
                    <SpinButton value={Number(entryValue) || 0} onChange={(_: unknown, d: any) => setEntryValue(String(d.value ?? (d.displayValue ?? '')))} style={{ width: '100%' }} />
                  </Field>
                  <Field label="Target (optional)" style={{ marginTop: tokens.spacingVerticalS}}>
                    <Input value={entryTarget} onChange={(_: unknown, d: any) => setEntryTarget(d.value)} type="number" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Status" style={{ marginTop: tokens.spacingVerticalS}}>
                    <Select value={entryStatus} onChange={(_: unknown, d: any) => setEntryStatus(d.value as ScorecardGoalStatusUi | '')}>
                      <option value="">(unchanged)</option>
                      {SC_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Check-in date" style={{ marginTop: tokens.spacingVerticalS}}>
                    <Input value={entryDate} onChange={(_: unknown, d: any) => setEntryDate(d.value)} type="date" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Note (optional)" style={{ marginTop: tokens.spacingVerticalS}}>
                    <Textarea value={entryNote} onChange={(_: unknown, d: any) => setEntryNote(d.value)} style={{ width: '100%' }} />
                  </Field>
                  {entryErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{entryErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setEntryOpen(null)}>Cancel</Button>
                  <Button appearance="primary" disabled={entryBusy || entryValue === ''} onClick={submitValue}>{entryBusy ? 'Saving…' : 'Record check-in'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Connected-metric binder flyout */}
          <Dialog open={!!bindOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setBindOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Bind connected metric</DialogTitle>
                <DialogContent>
                  <Caption1>
                    The goal&apos;s current value is pulled live from a DAX measure in a Power BI / Azure Analysis
                    Services semantic model. No Fabric capacity required — evaluation runs via Power BI executeQueries.
                  </Caption1>
                  <Field label="Semantic model (dataset)" required style={{ marginTop: tokens.spacingVerticalS}}>
                    {bindDatasets.length > 0 ? (
                      <Dropdown
                        selectedOptions={bindDatasetId ? [bindDatasetId] : []}
                        value={bindDatasets.find((d) => d.id === bindDatasetId)?.name || bindDatasets.find((d) => d.id === bindDatasetId)?.displayName || ''}
                        onOptionSelect={(_: unknown, d: any) => setBindDatasetId(d.optionValue)}
                        placeholder="Select a dataset"
                      >
                        {bindDatasets.map((d) => <Option key={d.id} value={d.id}>{d.name || d.displayName || d.id}</Option>)}
                      </Dropdown>
                    ) : (
                      <Input value={bindDatasetId} onChange={(_: unknown, d: any) => setBindDatasetId(d.value)} placeholder="Power BI dataset id (GUID)" style={{ width: '100%' }} />
                    )}
                  </Field>
                  <Field label="DAX expression" required style={{ marginTop: tokens.spacingVerticalS}} hint="a measure reference like [Total Revenue] or an inline scalar like SUM(Sales[Amount])">
                    <MonacoTextarea value={bindDax} onChange={setBindDax} language="plaintext" minHeight={80} />
                  </Field>
                  {bindTestValue !== undefined && (
                    <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalS}}>
                      <MessageBarBody>Live value: <strong>{bindTestValue === null ? '(null)' : bindTestValue}</strong></MessageBarBody>
                    </MessageBar>
                  )}
                  {bindErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{bindErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setBindOpen(null)}>Cancel</Button>
                  <Button appearance="outline" disabled={bindBusy || !bindDatasetId || !bindDax.trim()} onClick={testMetric}>{bindBusy ? 'Testing…' : 'Test'}</Button>
                  <Button appearance="primary" disabled={bindBusy || !bindDatasetId || !bindDax.trim()} onClick={saveMetric}>Save binding</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Check-in history flyout */}
          <Dialog open={!!historyOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setHistoryOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Check-in history</DialogTitle>
                <DialogContent>
                  {historyBusy ? <Spinner size="tiny" label="Loading…" /> : historyRows.length === 0 ? (
                    <Caption1>No check-ins recorded for this goal yet.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Check-in history" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Date</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Note</TableHeaderCell>
                          <TableHeaderCell>Source</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {historyRows.map((h) => (
                            <TableRow key={h.id}>
                              <TableCell>{h.checkInDate || h.recordedAt?.slice(0, 10) || '—'}</TableCell>
                              <TableCell>{h.value}</TableCell>
                              <TableCell><Badge appearance="filled" color={scStatusColor(h.status)}>{scStatusLabel(h.status)}</Badge></TableCell>
                              <TableCell>{h.note || '—'}</TableCell>
                              <TableCell>{h.source || 'manual'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setHistoryOpen(null)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
