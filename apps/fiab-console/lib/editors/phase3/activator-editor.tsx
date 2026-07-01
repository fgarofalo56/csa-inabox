'use client';

/**
 * ActivatorEditor — extracted from phase3-editors.tsx (byte-for-byte).
 *
 * Activator (Reflex) editor: watches a KQL query or an Event Hub and runs
 * actions (Email, Teams, SMS, webhook, Logic App, pipeline, notebook, Power
 * Automate) when a rule's condition fires. Azure-native by DEFAULT — each rule
 * becomes a real Microsoft.Insights scheduled-query alert rule via Azure
 * Monitor; no Microsoft Fabric capacity or workspace is required. Fabric is a
 * strictly opt-in alternative backend.
 *
 * The Loom WorkspacePicker trio (PbiWorkspaceLite / useWorkspaces /
 * WorkspacePicker) and the fmtCell helper are duplicated locally here —
 * matching the existing per-editor pattern across the editors folder — so this
 * module is self-contained and carries no import cycle back to the barrel.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tooltip,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Textarea, Checkbox,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular,
  List20Regular, Stop20Regular, Play20Regular, Flash20Regular, Edit20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { EventHubsNamespaceTree } from '@/lib/components/eventhubs/eventhubs-tree';
import { NewItemCreateGate } from '../new-item-gate';
import { openCopilotWithPersona } from '@/lib/components/copilot-pane';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useStyles } from './styles';

// ---- local helpers (duplicated from phase3-editors.tsx, byte-for-byte) ----
function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

interface PbiWorkspaceLite { id: string; name: string; description?: string; }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to list workspaces'); setHint(j.hint || null); setWorkspaces([]); }
      else { setWorkspaces(j.workspaces || []); }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

function WorkspacePicker({
  value, onChange, error, hint, loading, workspaces,
}: {
  value: string; onChange: (id: string) => void;
  error: string | null; hint: string | null; loading: boolean;
  workspaces: PbiWorkspaceLite[] | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 280 }}>
      <Caption1>Workspace</Caption1>
      <Select value={value} onChange={(_: unknown, d: any) => onChange(d.value)} disabled={loading || (workspaces?.length ?? 0) === 0}>
        {!value && <option value="">{loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
        {(workspaces || []).map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {!loading && !error && (workspaces?.length ?? 0) === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No Power BI workspaces</MessageBarTitle>
            The Console service principal can&apos;t see any Power BI workspaces. Create one (or get added to one) in Power BI, then Refresh.
            <br />
            <Button appearance="primary" size="small" style={{ marginTop: tokens.spacingVerticalS}}
              onClick={() => { try { window.open('https://app.powerbi.com/groups/me/list', '_blank', 'noreferrer'); } catch { /* popup blocked */ } }}>
              Open Power BI
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

interface ActivatorLite {
  id: string; displayName: string; description?: string;
}
interface RuleLite {
  id: string; name: string;
  objectName?: string; propertyName?: string;
  condition?: { operator?: string; value?: unknown };
  action?: { kind?: string; config?: Record<string, unknown> };
  state?: string; lastTriggered?: string;
  // Azure Monitor (default) fields — MonitorRuleRecord shape.
  query?: string;
  severity?: number;
  evaluationFrequency?: string;
  windowSize?: string;
  azureRuleName?: string;
  backend?: 'azure-monitor' | 'fabric';
  actionGroupId?: string;
  actionGroupReceivers?: { emails: number; sms: number; webhooks: number; logicApps: number };
  // RTI source backend — 'adx' (Eventhouse / KQL Database) or 'log-analytics'.
  sourceKind?: 'log-analytics' | 'adx';
  adxDatabase?: string;
  adxClusterUri?: string;
  /** Whether hands-off scheduled evaluation is wired (LA: always; ADX: only when
   *  an ADX-scoped alert host is provisioned). */
  scheduled?: boolean;
  note?: string;
}
/** Shape of one /api/items/activator/[id]/history event (AlertHistoryEvent). */
interface HistoryEventLite {
  id: string;
  alertRule: string;
  monitorCondition: string;       // Fired | Resolved
  alertState: string;             // New | Acknowledged | Closed
  severity?: string;
  startDateTime: string;
  lastModifiedDateTime?: string;
  monitorConditionResolvedDateTime?: string;
  targetResourceName?: string;
  targetResourceGroup?: string;
  payload?: {
    matchingRowsCount?: number;
    operator?: string;
    threshold?: string;
    timeAggregation?: string;
    searchQuery?: string;
    dimensions?: unknown[];
    windowStartTime?: string;
    windowEndTime?: string;
    linkToSearchResultsUI?: string;
    raw?: unknown;
  };
}

export function ActivatorEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [activators, setActivators] = useState<ActivatorLite[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [rules, setRules] = useState<RuleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);

  // create
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // new rule
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleName, setRuleName] = useState('');
  // Rule wizard (no JSON): condition (property/operator/value) + action (kind + target/message).
  const [condProperty, setCondProperty] = useState('');
  const [condOperator, setCondOperator] = useState('GreaterThan');
  const [condValue, setCondValue] = useState('20');
  const [actKind, setActKind] = useState<'TeamsMessage' | 'Email' | 'Webhook' | 'SMS' | 'LogicApp' | 'AdfPipelineRun' | 'NotebookRun' | 'PowerAutomateFlow'>('TeamsMessage');
  const [actTarget, setActTarget] = useState('');
  const [actMessage, setActMessage] = useState('Loom alert: {{eventValue}}');
  // SMS + Logic App receiver fields (Azure Monitor action-group receivers).
  const [actCountryCode, setActCountryCode] = useState('1');
  const [actPhone, setActPhone] = useState('');
  const [actLogicAppResourceId, setActLogicAppResourceId] = useState('');
  const [actLogicAppCallbackUrl, setActLogicAppCallbackUrl] = useState('');
  const [actLogicAppTrigger, setActLogicAppTrigger] = useState('manual');
  const [fetchingCallback, setFetchingCallback] = useState(false);
  const [callbackErr, setCallbackErr] = useState<string | null>(null);
  // Pick-existing action group flow.
  const [agList, setAgList] = useState<{ id: string; name: string; shortName: string; emailCount: number; smsCount: number; webhookCount: number; logicAppCount: number }[]>([]);
  const [useExistingAg, setUseExistingAg] = useState(false);
  const [existingAgId, setExistingAgId] = useState('');
  const [agBusy, setAgBusy] = useState<string | null>(null);
  const [agMsg, setAgMsg] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleErr, setRuleErr] = useState<string | null>(null);
  // Per-row rule controls (enable/disable/delete) + edit-mode for the wizard.
  // busyRuleId disables a row's actions while its ARM round-trip is in flight;
  // editingRuleId (when set) flips the New-rule wizard into Edit mode so addRule
  // PUTs to the existing rule instead of POSTing a new one.
  const [busyRuleId, setBusyRuleId] = useState<string>('');
  const [editingRuleId, setEditingRuleId] = useState<string>('');
  // ── Azure Monitor scheduled-query wizard (DEFAULT backend) ──
  // Data source: an Eventhouse / KQL Database (ADX — the RTI DEFAULT, where
  // real-time streams land), a raw KQL query (Log Analytics), OR an Event Hub
  // whose data is ingested into LA (the alert query then targets the hub table).
  const [sourceType, setSourceType] = useState<'adx' | 'kql' | 'eventhub'>('adx');
  const [kqlQuery, setKqlQuery] = useState('');
  const [sourceTable, setSourceTable] = useState('');
  const [selectedHub, setSelectedHub] = useState('');
  // Eventhouse / ADX source picker (cluster + database + table, resolved from
  // LOOM_KUSTO_* via /adx-source; the trigger/preview runs the KQL against it).
  const [adxCluster, setAdxCluster] = useState('');
  const [adxDatabase, setAdxDatabase] = useState('');
  const [adxDatabases, setAdxDatabases] = useState<{ name: string }[]>([]);
  const [adxTables, setAdxTables] = useState<{ name: string }[]>([]);
  const [adxDefaultCluster, setAdxDefaultCluster] = useState('');
  const [adxGate, setAdxGate] = useState<string | null>(null);
  const [adxLoading, setAdxLoading] = useState(false);
  // Evaluation cadence (ISO-8601).
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [winSize, setWinSize] = useState('PT5M');
  // Severity 0 (critical) – 4 (verbose); Warning is the portal default.
  const [severity, setSeverity] = useState(2);
  // Trigger-now result for inline feedback (rows + fired + which backend ran).
  const [triggerResult, setTriggerResult] = useState<{ ruleId: string; fired: boolean; count: number; backend?: string } | null>(null);

  // Run history / trigger log (Azure Monitor alert instances for this reflex).
  const [activeView, setActiveView] = useState<'rules' | 'history'>('rules');
  const [historyEvents, setHistoryEvents] = useState<HistoryEventLite[] | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [payloadEvent, setPayloadEvent] = useState<HistoryEventLite | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setLoading(true); setListErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActivators([]); setListErr(j.error); return; }
      setActivators(j.activators || []);
      // Use functional setSelectedId so we don't have to depend on
      // selectedId in this callback — keeps the workspace-change effect
      // from re-firing every time the user clicks a row.
      setSelectedId((prev) => prev || (j.activators?.[0]?.id ?? ''));
    } catch (e: any) {
      setActivators([]); setListErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  const loadRules = useCallback(async (wsId: string, actId: string) => {
    setRulesErr(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(actId)}/rules?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setRules([]); setRulesErr(j.error); return; }
      setRules(j.rules || []);
    } catch (e: any) {
      setRules([]); setRulesErr(e?.message || String(e));
    }
  }, []);

  // Eventhouse / ADX source picker — resolve the real cluster + databases (and,
  // when a database is chosen, its tables) from /adx-source (backed by
  // kusto-client + LOOM_KUSTO_*). On an honest gate (LOOM_KUSTO_* unset / no
  // cluster rights) surface the remediation instead of a phantom list.
  const loadAdxSource = useCallback(async (db?: string) => {
    if (!selectedId) return;
    setAdxLoading(true); setAdxGate(null);
    try {
      const qs = db ? `&database=${encodeURIComponent(db)}` : '';
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/adx-source?_=1${qs}`);
      const j = await r.json();
      if (!j.ok) { setAdxGate(j.gate?.remediation || j.error || 'Eventhouse not reachable'); if (!db) { setAdxDatabases([]); } else { setAdxTables([]); } return; }
      if (db) {
        setAdxTables(Array.isArray(j.tables) ? j.tables : []);
      } else {
        setAdxDatabases(Array.isArray(j.databases) ? j.databases : []);
        setAdxDefaultCluster(j.cluster || '');
        // Default the database selection to the cluster's default (or first).
        setAdxDatabase((prev) => prev || j.defaultDatabase || (j.databases?.[0]?.name ?? ''));
      }
    } catch (e: any) {
      setAdxGate(e?.message || String(e));
    } finally {
      setAdxLoading(false);
    }
  }, [selectedId]);

  // Auto-pick the first workspace once loaded so the editor isn't blocked on a
  // manual click for the common single-workspace deployments (matches the
  // Eventstream editor). After NewItemCreateGate routes here post-create, this
  // makes the Start/Stop/New rule/action-template ribbon reachable immediately.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [workspaceId, ws.workspaces]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && selectedId) loadRules(workspaceId, selectedId); }, [workspaceId, selectedId, loadRules]);

  // Load Eventhouse databases when the ADX source is active in the open rule
  // wizard; load that database's tables when the chosen database changes.
  useEffect(() => {
    if (ruleOpen && sourceType === 'adx' && selectedId) loadAdxSource();
  }, [ruleOpen, sourceType, selectedId, loadAdxSource]);
  useEffect(() => {
    if (ruleOpen && sourceType === 'adx' && adxDatabase) loadAdxSource(adxDatabase);
  }, [ruleOpen, sourceType, adxDatabase, loadAdxSource]);

  const createReflex = useCallback(async () => {
    if (!createName.trim() || !workspaceId) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), description: createDesc.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else {
        setCreateOpen(false); setCreateName(''); setCreateDesc('');
        loadList(workspaceId);
      }
    } finally { setCreateBusy(false); }
  }, [createName, createDesc, workspaceId, loadList]);

  const addRule = useCallback(async () => {
    if (!ruleName.trim() || !workspaceId || !selectedId) return;
    setRuleBusy(true); setRuleErr(null);
    // Build the structured condition + action from the wizard fields (no JSON).
    const condition = {
      ...(condProperty.trim() ? { property: condProperty.trim() } : {}),
      operator: condOperator,
      value: condValue.trim() === '' ? null : (Number.isNaN(Number(condValue)) ? condValue.trim() : Number(condValue)),
    };
    const cfgByKind: Record<string, Record<string, string>> = {
      TeamsMessage: { webhookUrl: actTarget, message: actMessage },
      Email: { to: actTarget, subject: actMessage },
      Webhook: { url: actTarget },
      SMS: { countryCode: actCountryCode, phoneNumber: actPhone },
      LogicApp: { logicAppResourceId: actLogicAppResourceId, callbackUrl: actLogicAppCallbackUrl },
      AdfPipelineRun: { pipeline: actTarget },
      NotebookRun: { notebookId: actTarget },
      PowerAutomateFlow: { triggerUrl: actTarget },
    };
    const action = { kind: actKind, config: cfgByKind[actKind] || {} };
    // The data-source picker decides what the rule evaluates. Eventhouse / ADX
    // (the RTI default) runs the KQL against a Kusto database; a raw KQL query
    // wins verbatim, else the condition builder composes it against the chosen
    // table. Log Analytics / Event Hub keep the Azure Monitor scheduledQueryRule.
    const body: Record<string, unknown> = {
      name: ruleName.trim(),
      condition,
      action,
      severity,
      evaluationFrequency: evalFreq,
      windowSize: winSize,
      ...(useExistingAg && existingAgId ? { existingActionGroupId: existingAgId } : {}),
    };
    if (sourceType === 'adx') {
      body.sourceKind = 'adx';
      if (adxDatabase.trim()) body.adxDatabase = adxDatabase.trim();
      if (adxCluster.trim()) body.adxClusterUri = adxCluster.trim();
      if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
      if (kqlQuery.trim()) body.query = kqlQuery.trim();
    } else if (sourceType === 'kql' && kqlQuery.trim()) {
      body.sourceKind = 'log-analytics';
      body.query = kqlQuery.trim();
      if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    } else if (sourceType === 'eventhub' && selectedHub) {
      body.sourceKind = 'log-analytics';
      body.sourceTable = sourceTable.trim() || `${selectedHub}_CL`;
    } else {
      body.sourceKind = 'log-analytics';
      if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    }
    try {
      // Edit mode (editingRuleId set) PUTs the full structured body to the
      // existing rule (the route upserts the backing scheduledQueryRule by name
      // and preserves a paused rule's Disabled state); otherwise POST a new one.
      const editing = !!editingRuleId;
      const url = editing
        ? `/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&ruleId=${encodeURIComponent(editingRuleId)}`
        : `/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`;
      const r = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setRuleErr(j.error || j.gate?.remediation || (editing ? 'update rule failed' : 'add rule failed')); }
      else { setRuleOpen(false); setRuleName(''); setKqlQuery(''); setEditingRuleId(''); loadRules(workspaceId, selectedId); }
    } finally { setRuleBusy(false); }
  }, [ruleName, condProperty, condOperator, condValue, actKind, actTarget, actMessage, actCountryCode, actPhone, actLogicAppResourceId, actLogicAppCallbackUrl, sourceType, kqlQuery, sourceTable, selectedHub, adxDatabase, adxCluster, severity, evalFreq, winSize, useExistingAg, existingAgId, editingRuleId, workspaceId, selectedId, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    if (!workspaceId || !selectedId) return;
    setTriggerResult(null);
    const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) { setRulesErr(j.error || j.gate?.remediation || 'trigger failed'); return; }
    // Azure-native trigger = run the rule's KQL now against its source (ADX for
    // Eventhouse/RTI rules, Log Analytics otherwise); report rows + would-fire.
    setTriggerResult({ ruleId, fired: !!j.fired, count: typeof j.count === 'number' ? j.count : (Array.isArray(j.rows) ? j.rows.length : 0), backend: j.backend });
    loadRules(workspaceId, selectedId);
  }, [workspaceId, selectedId, loadRules]);

  // ── per-rule enable/disable + delete (round-trip to Azure Monitor; mirrors the
  //    workspace ActivatorPane). Each keys off the persisted state.rules record,
  //    so on a deployed reflex (provisioner now persists MonitorRuleRecord[]) the
  //    backing scheduledQueryRule is the real ARM target. On success re-load the
  //    rule list so every other action sees the new state. ──
  const toggleRule = useCallback(async (r: RuleLite) => {
    if (!workspaceId || !selectedId) return;
    setBusyRuleId(r.id); setRulesErr(null);
    const next = r.state !== 'Active'; // Active → disable; anything else → enable
    try {
      const res = await fetch(
        `/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&ruleId=${encodeURIComponent(r.id)}&enabled=${next}`,
        { method: 'PATCH' },
      );
      const j = await res.json();
      if (!j.ok) { setRulesErr(j.error || j.gate?.remediation || 'toggle failed'); return; }
      await loadRules(workspaceId, selectedId);
    } catch (e: any) {
      setRulesErr(e?.message || String(e));
    } finally { setBusyRuleId(''); }
  }, [workspaceId, selectedId, loadRules]);

  const deleteRule = useCallback(async (r: RuleLite) => {
    if (!workspaceId || !selectedId) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete rule "${r.name}"? This removes its Azure Monitor scheduled-query rule.`)) return;
    setBusyRuleId(r.id); setRulesErr(null);
    try {
      const res = await fetch(
        `/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&ruleId=${encodeURIComponent(r.id)}`,
        { method: 'DELETE' },
      );
      const j = await res.json();
      if (!j.ok) { setRulesErr(j.error || j.gate?.remediation || 'delete failed'); return; }
      await loadRules(workspaceId, selectedId);
    } catch (e: any) {
      setRulesErr(e?.message || String(e));
    } finally { setBusyRuleId(''); }
  }, [workspaceId, selectedId, loadRules]);

  // Edit re-opens the SAME structured rule wizard pre-filled from the record (no
  // JSON box — loom_no_freeform_config); with editingRuleId set, addRule PUTs.
  const openEditRule = useCallback((r: RuleLite) => {
    setEditingRuleId(r.id);
    setRuleName(r.name || '');
    const cond: any = r.condition || {};
    const hasStructured = !!(cond.property || cond.field || r.propertyName);
    setCondProperty(String(cond.property ?? cond.field ?? r.propertyName ?? ''));
    setCondOperator(String(cond.operator ?? 'GreaterThan'));
    setCondValue(cond.value === undefined || cond.value === null ? '' : String(cond.value));
    const act: any = r.action || {};
    const kind = String(act.kind || 'TeamsMessage');
    setActKind((['TeamsMessage', 'Email', 'Webhook', 'SMS', 'LogicApp', 'AdfPipelineRun', 'NotebookRun', 'PowerAutomateFlow'].includes(kind) ? kind : 'TeamsMessage') as any);
    const cfg: any = act.config || {};
    setActTarget(String(cfg.webhookUrl || cfg.to || cfg.url || cfg.pipeline || cfg.notebookId || cfg.triggerUrl || ''));
    setActMessage(String(cfg.message || cfg.subject || ''));
    setActCountryCode(String(cfg.countryCode || '1'));
    setActPhone(String(cfg.phoneNumber || cfg.phone || ''));
    setActLogicAppResourceId(String(cfg.logicAppResourceId || ''));
    setActLogicAppCallbackUrl(String(cfg.callbackUrl || ''));
    // Prefer the structured condition builder when the record carries one;
    // otherwise fall back to editing the verbatim KQL the rule runs. Restore the
    // rule's source backend (Eventhouse/ADX vs Log Analytics) so the edit PUTs
    // against the same source instead of flipping it.
    const isAdx = r.sourceKind === 'adx';
    setSourceType(isAdx ? 'adx' : 'kql');
    setAdxDatabase(isAdx ? String(r.adxDatabase || '') : '');
    setAdxCluster(isAdx ? String(r.adxClusterUri || '') : '');
    setSourceTable(r.objectName ? String(r.objectName) : '');
    setSelectedHub('');
    if (!hasStructured && typeof r.query === 'string' && r.query.trim()) setKqlQuery(r.query);
    else setKqlQuery('');
    setSeverity(typeof r.severity === 'number' ? r.severity : 2);
    setEvalFreq(r.evaluationFrequency || 'PT5M');
    setWinSize(r.windowSize || 'PT5M');
    setUseExistingAg(false); setExistingAgId('');
    setRuleErr(null);
    setRuleOpen(true);
  }, []);

  // Run history — fired/resolved Azure Monitor alert instances for this reflex.
  const loadHistory = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    setHistoryLoading(true); setHistoryErr(null); setHistoryNote(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/history?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setHistoryEvents([]); setHistoryErr(j.error || j.gate?.remediation || 'history failed'); return; }
      setHistoryEvents(j.events || []);
      if (j.note) setHistoryNote(j.note);
    } catch (e: any) {
      setHistoryEvents([]); setHistoryErr(e?.message || String(e));
    } finally { setHistoryLoading(false); }
  }, [workspaceId, selectedId]);

  // Reset (and re-fetch when viewing) history whenever the selected reflex changes.
  useEffect(() => {
    setHistoryEvents(null); setHistoryErr(null); setHistoryNote(null);
  }, [selectedId, workspaceId]);
  useEffect(() => {
    if (activeView === 'history' && historyEvents === null && workspaceId && selectedId) loadHistory();
  }, [activeView, historyEvents, workspaceId, selectedId, loadHistory]);

  const canNewRule = !!selectedId && !!workspaceId;

  // Load existing action groups for the pick-existing flow (non-fatal on error
  // — the create-new path still works without the list).
  const loadActionGroups = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/action-groups');
      const j = await r.json();
      if (j.ok) setAgList(j.actionGroups || []);
    } catch { /* non-fatal: pick-existing simply has no options */ }
  }, []);
  useEffect(() => { if (workspaceId) loadActionGroups(); }, [workspaceId, loadActionGroups]);

  // Resolve a Logic App trigger's callback URL from ARM (so the receiver can be
  // invoked when the alert fires) and populate the field.
  const fetchCallbackUrl = useCallback(async () => {
    if (!actLogicAppResourceId.trim()) { setCallbackErr('Enter the Logic App resource id first.'); return; }
    setFetchingCallback(true); setCallbackErr(null);
    try {
      const r = await fetch('/api/monitor/logic-app-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowResourceId: actLogicAppResourceId.trim(), triggerName: actLogicAppTrigger.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) setCallbackErr(j.gate?.remediation || j.error || 'failed to resolve callback URL');
      else setActLogicAppCallbackUrl(j.callbackUrl || '');
    } catch (e: any) {
      setCallbackErr(e?.message || String(e));
    } finally { setFetchingCallback(false); }
  }, [actLogicAppResourceId, actLogicAppTrigger]);

  // Fire a REAL test notification through an action group's receivers (the
  // webhook receiver logs the Common Alert Schema payload — the acceptance test).
  const testNotification = useCallback(async (actionGroupId: string) => {
    setAgBusy(actionGroupId); setAgMsg(null); setRulesErr(null);
    try {
      const r = await fetch('/api/monitor/action-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _action: 'test', actionGroupId }),
      });
      const j = await r.json();
      if (!j.ok) setAgMsg(`Test failed: ${j.gate?.remediation || j.error || 'unknown'}`);
      else {
        const rc = j.result?.receivers || {};
        setAgMsg(`Test notification sent — ${rc.emails || 0} email · ${rc.sms || 0} SMS · ${rc.webhooks || 0} webhook · ${rc.logicApps || 0} Logic App receiver(s).`);
      }
    } catch (e: any) {
      setAgMsg(`Test failed: ${e?.message || String(e)}`);
    } finally { setAgBusy(null); }
  }, []);

  // Start/Stop reflex — calls the new /start /stop routes which PATCH every
  // trigger on the reflex to Active/Stopped via Fabric REST.
  const [reflexBusy, setReflexBusy] = useState<'start' | 'stop' | null>(null);
  const [reflexMsg, setReflexMsg] = useState<string | null>(null);
  const startStop = useCallback(async (kind: 'start' | 'stop') => {
    if (!workspaceId || !selectedId) return;
    setReflexBusy(kind); setReflexMsg(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/${kind}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setReflexMsg(`${kind} failed: ${j.error || 'unknown'}`);
      else setReflexMsg(`${kind === 'start' ? 'Started' : 'Stopped'} — ${j.updated} trigger(s) updated.`);
      await loadRules(workspaceId, selectedId);
    } catch (e: any) {
      setReflexMsg(`${kind} failed: ${e?.message || String(e)}`);
    } finally {
      setReflexBusy(null);
    }
  }, [workspaceId, selectedId, loadRules]);

  // Action template — pre-select the action kind + a sensible target/message in
  // the wizard (no JSON). The user refines via the dropdowns/inputs.
  const openTemplate = useCallback((kind: 'Email' | 'SMS' | 'Teams' | 'Webhook' | 'LogicApp' | 'Pipeline' | 'Notebook' | 'PowerAutomate') => {
    const map = {
      Email: { k: 'Email' as const, t: 'alerts@example.com', m: 'Loom alert' },
      SMS: { k: 'SMS' as const, t: '', m: '' },
      Teams: { k: 'TeamsMessage' as const, t: 'https://outlook.office.com/webhook/...', m: 'Loom alert: {{eventValue}}' },
      Webhook: { k: 'Webhook' as const, t: 'https://your-endpoint.example.com/hook', m: '' },
      LogicApp: { k: 'LogicApp' as const, t: '', m: '' },
      Pipeline: { k: 'AdfPipelineRun' as const, t: 'pl_alert_handler', m: '' },
      Notebook: { k: 'NotebookRun' as const, t: '', m: '' },
      PowerAutomate: { k: 'PowerAutomateFlow' as const, t: 'https://prod-xx.logic.azure.com/workflows/.../triggers/...', m: '' },
    };
    const sel = map[kind];
    setEditingRuleId(''); // action templates always start a NEW rule
    setRuleName(`alert-${kind.toLowerCase()}-${Date.now().toString(36)}`);
    setActKind(sel.k); setActTarget(sel.t); setActMessage(sel.m);
    setRuleOpen(true);
  }, []);

  // Reset every wizard field to defaults so a NEW rule never inherits a prior
  // edit's values; openNewRule clears edit-mode then opens the wizard fresh.
  const resetRuleForm = useCallback(() => {
    setRuleName(''); setCondProperty(''); setCondOperator('GreaterThan'); setCondValue('20');
    setActKind('TeamsMessage'); setActTarget(''); setActMessage('Loom alert: {{eventValue}}');
    setActCountryCode('1'); setActPhone(''); setActLogicAppResourceId(''); setActLogicAppCallbackUrl('');
    setSourceType('adx'); setKqlQuery(''); setSourceTable(''); setSelectedHub('');
    setAdxCluster(''); setAdxDatabase(''); setAdxTables([]); setAdxGate(null);
    setEvalFreq('PT5M'); setWinSize('PT5M'); setSeverity(2);
    setUseExistingAg(false); setExistingAgId(''); setRuleErr(null);
  }, []);
  const openNewRule = useCallback(() => { setEditingRuleId(''); resetRuleForm(); setRuleOpen(true); }, [resetRuleForm]);
  // pre-loaded with this reflex's context (id, workspace, existing rule names)
  // so the model can author a real Azure Monitor scheduled-query alert rule from
  // plain English, suggest a threshold from real history, and create it.
  const openActivatorCopilot = useCallback(() => {
    const reflex = (activators || []).find((a) => a.id === selectedId);
    openCopilotWithPersona({
      persona: 'activator',
      personaContext: {
        activatorId: selectedId,
        activatorName: reflex?.displayName,
        workspaceId,
        existingRuleNames: rules.map((r) => r.azureRuleName || r.name).filter(Boolean),
      },
      prefillPrompt: 'Alert me when failed logins exceed normal.',
    });
  }, [activators, selectedId, workspaceId, rules]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Rules', actions: [
        { label: 'New rule', onClick: canNewRule ? openNewRule : undefined, disabled: !canNewRule, title: !canNewRule ? 'select a workspace and reflex first' : undefined },
        { label: reflexBusy === 'start' ? 'Starting…' : 'Start', onClick: canNewRule && !reflexBusy ? () => startStop('start') : undefined, disabled: !canNewRule || !!reflexBusy },
        { label: reflexBusy === 'stop' ? 'Stopping…' : 'Stop', onClick: canNewRule && !reflexBusy ? () => startStop('stop') : undefined, disabled: !canNewRule || !!reflexBusy },
      ]},
      { label: 'Copilot', actions: [
        { label: 'Author rule with Copilot', onClick: canNewRule ? openActivatorCopilot : undefined, disabled: !canNewRule, title: !canNewRule ? 'select a workspace and reflex first' : 'Describe an alert in plain English — Copilot drafts the KQL, suggests a threshold from real history, and creates the Azure Monitor rule after you approve.' },
      ]},
      { label: 'Actions', actions: [
        { label: 'Email', onClick: canNewRule ? () => openTemplate('Email') : undefined, disabled: !canNewRule },
        { label: 'SMS', onClick: canNewRule ? () => openTemplate('SMS') : undefined, disabled: !canNewRule },
        { label: 'Teams', onClick: canNewRule ? () => openTemplate('Teams') : undefined, disabled: !canNewRule },
        { label: 'Webhook', onClick: canNewRule ? () => openTemplate('Webhook') : undefined, disabled: !canNewRule },
        { label: 'Logic App', onClick: canNewRule ? () => openTemplate('LogicApp') : undefined, disabled: !canNewRule },
        { label: 'Run pipeline', onClick: canNewRule ? () => openTemplate('Pipeline') : undefined, disabled: !canNewRule },
        { label: 'Run notebook', onClick: canNewRule ? () => openTemplate('Notebook') : undefined, disabled: !canNewRule },
        { label: 'Power Automate', onClick: canNewRule ? () => openTemplate('PowerAutomate') : undefined, disabled: !canNewRule },
      ]},
    ]},
  ], [canNewRule, reflexBusy, startStop, openTemplate, openActivatorCopilot, openNewRule]);

  // On /new there is no reflex selected yet, so every rule/action button is
  // gated. Mirror the PR #438 NewItemGate pattern: show an ENABLED create
  // surface that mints a Cosmos activator item and routes to the live editor
  // below, where the real Fabric-backed Start/Stop/rule/action handlers work.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New reflex"
        intro="An Activator (Reflex) watches an Eventhouse / KQL Database (Real-Time Intelligence) stream, a KQL query, or an Event Hub and runs actions — Email, Teams, a pipeline, a notebook, or a Power Automate flow — when a rule's condition fires. Create it, then add rules. The default source is Eventhouse / ADX: the rule's KQL runs against Azure Data Explorer, and Trigger/Preview evaluates it against real stream data — no Microsoft Fabric required." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Reflexes</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && loading && <Spinner size="tiny" label="Loading…" />}
          {activators && activators.length === 0 && !loading && <Caption1>No reflexes in this workspace.</Caption1>}
          <Tree aria-label="Reflex list">
            {(activators || []).map((a) => (
              <TreeItem key={a.id} itemType="leaf" value={a.id} onClick={() => setSelectedId(a.id)}>
                <TreeItemLayout>{selectedId === a.id ? <strong>{a.displayName}</strong> : a.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Activator (Reflex)</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            <Dialog open={createOpen} onOpenChange={(_: unknown, d: any) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId} style={{ marginLeft: 'auto' }}>New reflex</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create Activator (reflex)</DialogTitle>
                  <DialogContent>
                    <Input placeholder="displayName" value={createName} onChange={(_: unknown, d: any) => setCreateName(d.value)} style={{ width: '100%' }} />
                    <Input placeholder="description (optional)" value={createDesc} onChange={(_: unknown, d: any) => setCreateDesc(d.value)} style={{ width: '100%', marginTop: tokens.spacingVerticalS}} />
                    {createErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={createReflex}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
          {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
          {reflexMsg && <MessageBar intent={reflexMsg.includes('failed') ? 'error' : 'success'}><MessageBarBody>{reflexMsg}</MessageBarBody></MessageBar>}

          {selectedId && (
            <>
              <TabList selectedValue={activeView} onTabSelect={(_: unknown, d: any) => setActiveView(d.value as 'rules' | 'history')}>
                <Tab value="rules" icon={<List20Regular />}>Rules{rules.length ? ` (${rules.length})` : ''}</Tab>
                <Tab value="history" icon={<ArrowSync20Regular />}>Run history</Tab>
              </TabList>

              {activeView === 'rules' && (
              <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                <Subtitle2>Rules</Subtitle2>
                <Dialog open={ruleOpen} onOpenChange={(_: unknown, d: any) => { setRuleOpen(d.open); if (!d.open) setEditingRuleId(''); }}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={openNewRule}>New rule</Button>
                  </DialogTrigger>
                  <DialogSurface style={{ maxWidth: 760 }}>
                    <DialogBody>
                      <DialogTitle>{editingRuleId ? 'Edit rule' : 'Add rule'}</DialogTitle>
                      <DialogContent>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                          <Field label="Rule name" required>
                            <Input placeholder="e.g. Latency SLA breach" value={ruleName} onChange={(_: unknown, d: any) => setRuleName(d.value)} />
                          </Field>

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>DATA SOURCE</Caption1>
                          <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                            <Field label="Source type" style={{ width: 280 }}>
                              <Select value={sourceType} onChange={(_: unknown, d: any) => setSourceType(d.value as 'adx' | 'kql' | 'eventhub')}>
                                <option value="adx">Eventhouse / KQL Database (ADX)</option>
                                <option value="kql">KQL query (Log Analytics)</option>
                                <option value="eventhub">Event Hub</option>
                              </Select>
                            </Field>
                            {sourceType !== 'adx' && (
                              <Field label="Source table (KQL table the condition targets)" style={{ flex: 1 }}>
                                <Input placeholder="e.g. AppEvents_CL" value={sourceTable} onChange={(_: unknown, d: any) => setSourceTable(d.value)} />
                              </Field>
                            )}
                          </div>

                          {sourceType === 'adx' && (
                            <>
                              <MessageBar intent="info">
                                <MessageBarBody>
                                  Real-Time Intelligence streams land in Azure Data Explorer / Eventhouse. This rule&apos;s KQL runs against the ADX cluster — <strong>Trigger / Preview evaluates it against real Eventhouse data</strong>. No Microsoft Fabric required.
                                </MessageBarBody>
                              </MessageBar>
                              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                                <Field label="Database" style={{ width: 240 }} hint={adxLoading ? 'Loading databases…' : undefined}>
                                  <Select value={adxDatabase} onChange={(_: unknown, d: any) => { setAdxDatabase(d.value); setSourceTable(''); }} disabled={adxLoading || adxDatabases.length === 0}>
                                    {adxDatabases.length === 0 && <option value="">{adxLoading ? 'Loading…' : 'No databases'}</option>}
                                    {adxDatabases.map((db) => <option key={db.name} value={db.name}>{db.name}</option>)}
                                  </Select>
                                </Field>
                                <Field label="Table" style={{ width: 240 }} hint="The Eventhouse table the condition targets.">
                                  <Select value={sourceTable} onChange={(_: unknown, d: any) => setSourceTable(d.value)} disabled={adxLoading || adxTables.length === 0}>
                                    <option value="">{adxTables.length === 0 ? (adxLoading ? 'Loading…' : 'Select a database') : '— select a table —'}</option>
                                    {adxTables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                                  </Select>
                                </Field>
                                <Field label="Cluster (optional override)" style={{ flex: 1, minWidth: 240 }} hint={adxDefaultCluster ? `Default: ${adxDefaultCluster}` : 'Resolved from LOOM_KUSTO_CLUSTER_URI'}>
                                  <Input placeholder="https://<cluster>.<region>.kusto.windows.net" value={adxCluster} onChange={(_: unknown, d: any) => setAdxCluster(d.value)} />
                                </Field>
                              </div>
                              {adxGate && (
                                <MessageBar intent="warning">
                                  <MessageBarBody>
                                    <MessageBarTitle>Eventhouse not reachable</MessageBarTitle>
                                    {adxGate}
                                  </MessageBarBody>
                                </MessageBar>
                              )}
                              <Field label="KQL query (optional)" hint="Verbatim query — alert fires when it returns ≥ 1 row. Leave empty to use the condition builder below against the selected table.">
                                <MonacoTextarea value={kqlQuery} onChange={setKqlQuery} language="kql" className={s.monaco} ariaLabel="Eventhouse alert KQL query" />
                              </Field>
                              <MessageBar intent="warning">
                                <MessageBarBody>
                                  <MessageBarTitle>Scheduled evaluation</MessageBarTitle>
                                  Continuous, hands-off evaluation for Eventhouse / ADX sources is on-demand today — use <strong>Trigger</strong> to evaluate now against real ADX data. For a scheduled host, set <code>LOOM_ADX_ALERT_SCOPE</code> to the ADX cluster resource id (and grant the alert identity Database Viewer). Log Analytics sources evaluate continuously via Azure Monitor.
                                </MessageBarBody>
                              </MessageBar>
                            </>
                          )}
                          {sourceType === 'kql' && (
                            <Field label="KQL query" hint="Verbatim query — alert fires when it returns ≥ 1 row. Leave empty to use the condition builder below.">
                              <MonacoTextarea value={kqlQuery} onChange={setKqlQuery} language="kql" className={s.monaco} ariaLabel="Alert KQL query" />
                            </Field>
                          )}
                          {sourceType === 'eventhub' && (
                            <>
                              <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, maxHeight: 220, overflow: 'auto' }}>
                                <EventHubsNamespaceTree onSelectEventHub={(hub) => { setSelectedHub(hub); setSourceTable(`${hub}_CL`); }} />
                              </div>
                              {selectedHub && (
                                <>
                                  <Caption1>Event hub selected: <strong>{selectedHub}</strong> → source table <code>{sourceTable || `${selectedHub}_CL`}</code></Caption1>
                                  <MessageBar intent="warning">
                                    <MessageBarBody>
                                      Data from this Event Hub must flow into Log Analytics (via a data collection rule or an ADX data connection) before this alert can fire. The scheduled-query rule targets table <code>{sourceTable || `${selectedHub}_CL`}</code>.
                                    </MessageBarBody>
                                  </MessageBar>
                                </>
                              )}
                            </>
                          )}

                          {!((sourceType === 'adx' || sourceType === 'kql') && kqlQuery.trim()) && (
                            <>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>WHEN — condition</Caption1>
                              <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                                <Field label="Property" style={{ flex: 1 }}>
                                  <Input placeholder="e.g. latency_ms" value={condProperty} onChange={(_: unknown, d: any) => setCondProperty(d.value)} />
                                </Field>
                                <Field label="Operator" style={{ width: 180 }}>
                                  <Select value={condOperator} onChange={(_: unknown, d: any) => setCondOperator(d.value)}>
                                    {['GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Equals', 'NotEquals', 'BecomesTrue', 'ChangesTo'].map((o) => <option key={o} value={o}>{o}</option>)}
                                  </Select>
                                </Field>
                                <Field label="Value" style={{ width: 120 }}>
                                  <Input placeholder="20" value={condValue} onChange={(_: unknown, d: any) => setCondValue(d.value)} />
                                </Field>
                              </div>
                            </>
                          )}

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>THEN — action</Caption1>
                          <Checkbox
                            label="Attach an existing action group (skip building a new one)"
                            checked={useExistingAg}
                            disabled={agList.length === 0}
                            onChange={(_: unknown, d: any) => setUseExistingAg(!!d.checked)}
                          />
                          {useExistingAg ? (
                            <Field label="Action group" hint="Pick a Microsoft.Insights/actionGroups resource in the Loom alert resource group.">
                              <Select value={existingAgId} onChange={(_: unknown, d: any) => setExistingAgId(d.value)}>
                                <option value="">— select an action group —</option>
                                {agList.map((ag) => (
                                  <option key={ag.id} value={ag.id}>
                                    {ag.name} ({ag.emailCount}✉ {ag.smsCount}☎ {ag.webhookCount}🔗 {ag.logicAppCount}⚙)
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          ) : (
                          <>
                          <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                            <Field label="Do" style={{ width: 200 }}>
                              <Select value={actKind} onChange={(_: unknown, d: any) => setActKind(d.value)}>
                                <option value="TeamsMessage">Post to Teams</option>
                                <option value="Email">Send email</option>
                                <option value="SMS">Send SMS</option>
                                <option value="Webhook">Call webhook</option>
                                <option value="LogicApp">Trigger Logic App</option>
                                <option value="AdfPipelineRun">Run a pipeline</option>
                                <option value="NotebookRun">Run a notebook</option>
                                <option value="PowerAutomateFlow">Trigger Power Automate</option>
                              </Select>
                            </Field>
                            {(actKind !== 'SMS' && actKind !== 'LogicApp') && (
                              <Field label={
                                actKind === 'TeamsMessage' ? 'Teams webhook URL' :
                                actKind === 'Email' ? 'To address' :
                                actKind === 'Webhook' ? 'Webhook URL' :
                                actKind === 'AdfPipelineRun' ? 'Pipeline name' :
                                actKind === 'NotebookRun' ? 'Notebook id' : 'Flow trigger URL'
                              } style={{ flex: 1 }}>
                                <Input value={actTarget} onChange={(_: unknown, d: any) => setActTarget(d.value)} />
                              </Field>
                            )}
                          </div>
                          {(actKind === 'TeamsMessage' || actKind === 'Email') && (
                            <Field label={actKind === 'Email' ? 'Subject' : 'Message'}>
                              <Input value={actMessage} onChange={(_: unknown, d: any) => setActMessage(d.value)} />
                            </Field>
                          )}
                          {actKind === 'SMS' && (
                            <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                              <Field label="Country code" style={{ width: 140 }} hint="e.g. 1 for US">
                                <Input value={actCountryCode} onChange={(_: unknown, d: any) => setActCountryCode(d.value)} />
                              </Field>
                              <Field label="Phone number" style={{ flex: 1 }}>
                                <Input placeholder="5551234567" value={actPhone} onChange={(_: unknown, d: any) => setActPhone(d.value)} />
                              </Field>
                            </div>
                          )}
                          {actKind === 'LogicApp' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                              <Field label="Logic App resource id" hint="Microsoft.Logic/workflows resource id (Consumption workflow with an HTTP trigger).">
                                <Input placeholder="/subscriptions/.../providers/Microsoft.Logic/workflows/wf-alert" value={actLogicAppResourceId} onChange={(_: unknown, d: any) => setActLogicAppResourceId(d.value)} />
                              </Field>
                              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                                <Field label="Trigger name" style={{ width: 160 }}>
                                  <Input value={actLogicAppTrigger} onChange={(_: unknown, d: any) => setActLogicAppTrigger(d.value)} />
                                </Field>
                                <Button appearance="secondary" disabled={fetchingCallback || !actLogicAppResourceId.trim()} onClick={fetchCallbackUrl}>
                                  {fetchingCallback ? 'Resolving…' : 'Fetch callback URL from ARM'}
                                </Button>
                              </div>
                              <Field label="Trigger callback URL" hint="Auto-filled by 'Fetch callback URL', or paste a listCallbackUrl SAS URL.">
                                <Input value={actLogicAppCallbackUrl} onChange={(_: unknown, d: any) => setActLogicAppCallbackUrl(d.value)} />
                              </Field>
                              {callbackErr && <MessageBar intent="warning"><MessageBarBody>{callbackErr}</MessageBarBody></MessageBar>}
                            </div>
                          )}
                          </>
                          )}

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>EVALUATION</Caption1>
                          <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                            <Field label="Evaluation frequency" style={{ width: 200 }}>
                              <Select value={evalFreq} onChange={(_: unknown, d: any) => setEvalFreq(d.value)}>
                                {['PT1M', 'PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H'].map((f) => <option key={f} value={f}>{f}</option>)}
                              </Select>
                            </Field>
                            <Field label="Window size (≥ frequency)" style={{ width: 200 }}>
                              <Select value={winSize} onChange={(_: unknown, d: any) => setWinSize(d.value)}>
                                {['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'P1D'].map((w) => <option key={w} value={w}>{w}</option>)}
                              </Select>
                            </Field>
                            <Field label="Severity" style={{ width: 200 }}>
                              <Select value={String(severity)} onChange={(_: unknown, d: any) => setSeverity(Number(d.value))}>
                                <option value="0">0 — Critical</option>
                                <option value="1">1 — Error</option>
                                <option value="2">2 — Warning (default)</option>
                                <option value="3">3 — Informational</option>
                                <option value="4">4 — Verbose</option>
                              </Select>
                            </Field>
                          </div>

                          <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1 }}>
                            {(sourceType === 'adx' || sourceType === 'kql') && kqlQuery.trim()
                              ? `${sourceType === 'adx' ? 'ADX' : 'LA'} KQL: ${kqlQuery.trim().slice(0, 72)}${kqlQuery.trim().length > 72 ? '…' : ''} → ${useExistingAg ? 'existing action group' : actKind} · sev${severity} · eval ${evalFreq} / win ${winSize}`
                              : `${sourceType === 'adx' ? `${adxDatabase || '<db>'}/` : ''}${condProperty || (sourceTable || '<table>')} ${condOperator} ${condValue || '<value>'} → ${useExistingAg ? 'existing action group' : actKind} · sev${severity} · eval ${evalFreq} / win ${winSize}`}
                          </Caption1>
                          {ruleErr && <MessageBar intent="error"><MessageBarBody>{ruleErr}</MessageBarBody></MessageBar>}
                        </div>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => { setRuleOpen(false); setEditingRuleId(''); }}>Cancel</Button>
                        <Button appearance="primary" disabled={ruleBusy || !ruleName.trim()} onClick={addRule}>{ruleBusy ? (editingRuleId ? 'Saving…' : 'Adding…') : (editingRuleId ? 'Save' : 'Add')}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {rulesErr && <MessageBar intent="error"><MessageBarBody>{rulesErr}</MessageBarBody></MessageBar>}
              {triggerResult && (
                <MessageBar intent={triggerResult.fired ? 'success' : 'info'}>
                  <MessageBarBody>
                    Trigger '{triggerResult.ruleId}'{triggerResult.backend ? ` (${triggerResult.backend === 'adx' ? 'Eventhouse / ADX' : 'Log Analytics'})` : ''}: {triggerResult.count} row(s) — {triggerResult.fired ? 'FIRED (the alert condition was met)' : 'no rows, would not fire'}.
                  </MessageBarBody>
                </MessageBar>
              )}
              {rules.length === 0 ? (
                <Caption1>No rules on this reflex yet. Click “New rule” to create an Azure Monitor scheduled-query alert.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Rules" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Backend</TableHeaderCell>
                      <TableHeaderCell>Query / Condition</TableHeaderCell>
                      <TableHeaderCell>Sev</TableHeaderCell>
                      <TableHeaderCell>Freq / Window</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                      <TableHeaderCell>Action group</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {rules.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.name}</TableCell>
                          <TableCell><Badge size="small" appearance="tint" color={r.backend === 'fabric' ? 'warning' : 'brand'}>{r.backend === 'fabric' ? 'Fabric' : (r.sourceKind === 'adx' ? 'Azure Monitor · Eventhouse' : 'Azure Monitor · LA')}</Badge></TableCell>
                          <TableCell className={s.cell}>
                            {r.query
                              ? r.query.replace(/\s+/g, ' ').slice(0, 60) + (r.query.length > 60 ? '…' : '')
                              : (r.condition ? `${r.condition.operator || ''} ${fmtCell(r.condition.value)}`.trim() : '—')}
                          </TableCell>
                          <TableCell>{typeof r.severity === 'number' ? r.severity : '—'}</TableCell>
                          <TableCell className={s.cell}>{(r.evaluationFrequency || '—')} / {(r.windowSize || '—')}</TableCell>
                          <TableCell className={s.cell}>{r.action?.kind || '—'}</TableCell>
                          <TableCell className={s.cell} title={r.actionGroupId || ''}>
                            {r.actionGroupId ? (r.actionGroupId.split('/').pop() || r.actionGroupId) : '—'}
                          </TableCell>
                          <TableCell>{r.state || '—'}</TableCell>
                          <TableCell>
                            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' }}>
                              <Button
                                size="small"
                                appearance={r.state === 'Active' ? 'subtle' : 'primary'}
                                icon={r.state === 'Active' ? <Stop20Regular /> : <Flash20Regular />}
                                disabled={busyRuleId === r.id}
                                onClick={() => toggleRule(r)}
                                title={r.state === 'Active' ? 'Disable — pause Azure Monitor evaluation' : 'Enable — resume Azure Monitor evaluation'}
                                aria-label={r.state === 'Active' ? `Disable rule ${r.name}` : `Enable rule ${r.name}`}
                              >
                                {r.state === 'Active' ? 'Disable' : 'Enable'}
                              </Button>
                              <Button
                                size="small"
                                appearance="subtle"
                                icon={<Play20Regular />}
                                disabled={busyRuleId === r.id}
                                onClick={() => triggerNow(r.id)}
                                title={r.sourceKind === 'adx' ? "Trigger now — run this rule's KQL against the Eventhouse / ADX cluster" : "Trigger now — run this rule's KQL against Log Analytics"}
                                aria-label={`Trigger rule ${r.name}`}
                              >
                                Trigger
                              </Button>
                              <Tooltip content="Edit rule" relationship="label">
                                <Button
                                  size="small"
                                  appearance="subtle"
                                  icon={<Edit20Regular />}
                                  disabled={busyRuleId === r.id}
                                  onClick={() => openEditRule(r)}
                                  aria-label={`Edit rule ${r.name}`}
                                />
                              </Tooltip>
                              <Tooltip content="Delete rule" relationship="label">
                                <Button
                                  size="small"
                                  appearance="subtle"
                                  icon={<Delete20Regular />}
                                  disabled={busyRuleId === r.id}
                                  onClick={() => deleteRule(r)}
                                  aria-label={`Delete rule ${r.name}`}
                                />
                              </Tooltip>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Action groups — resolved Microsoft.Insights/actionGroups per rule,
                  with a real "Test notification" button that fires the group's
                  receivers (webhook receiver logs the Common Alert Schema payload). */}
              {rules.some((r) => r.actionGroupId) && (
                <div style={{ marginTop: tokens.spacingVerticalL}}>
                  <Subtitle2>Action groups</Subtitle2>
                  {agMsg && <MessageBar intent={agMsg.startsWith('Test failed') ? 'error' : 'success'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{agMsg}</MessageBarBody></MessageBar>}
                  <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                    <Table aria-label="Action groups" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Rule</TableHeaderCell>
                        <TableHeaderCell>Action group ARM id</TableHeaderCell>
                        <TableHeaderCell>Receivers</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {rules.filter((r) => r.actionGroupId).map((r) => {
                          const rc = r.actionGroupReceivers;
                          return (
                            <TableRow key={`ag-${r.id}`}>
                              <TableCell>{r.name}</TableCell>
                              <TableCell className={s.cell}>{r.actionGroupId}</TableCell>
                              <TableCell className={s.cell}>
                                {rc ? `${rc.emails}✉ ${rc.sms}☎ ${rc.webhooks}🔗 ${rc.logicApps}⚙` : '—'}
                              </TableCell>
                              <TableCell>
                                <Button size="small" appearance="subtle" disabled={agBusy === r.actionGroupId} onClick={() => testNotification(r.actionGroupId!)}>
                                  {agBusy === r.actionGroupId ? 'Sending…' : 'Test notification'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
              </>
              )}

              {activeView === 'history' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                  <Subtitle2>Run history</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>fired &amp; resolved events · last 30 days · Azure Monitor</Caption1>
                  <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={loadHistory} disabled={historyLoading} style={{ marginLeft: 'auto' }}>
                    {historyLoading ? 'Loading…' : 'Refresh'}
                  </Button>
                </div>
                {historyErr && <MessageBar intent="warning"><MessageBarBody>{historyErr}</MessageBarBody></MessageBar>}
                {historyNote && !historyErr && <MessageBar intent="info"><MessageBarBody>{historyNote}</MessageBarBody></MessageBar>}
                {historyLoading && <Spinner size="tiny" label="Loading run history…" />}
                {!historyLoading && historyEvents && historyEvents.length === 0 && !historyNote && !historyErr && (
                  <Caption1>No fired or resolved alerts in the last 30 days for this reflex&apos;s rules. Trigger a rule, or wait for a scheduled evaluation, then refresh.</Caption1>
                )}
                {!historyLoading && historyEvents && historyEvents.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Run history" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Timestamp</TableHeaderCell>
                        <TableHeaderCell>Rule</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Severity</TableHeaderCell>
                        <TableHeaderCell>Target</TableHeaderCell>
                        <TableHeaderCell>Rows matched</TableHeaderCell>
                        <TableHeaderCell>Payload</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {historyEvents.map((ev) => (
                          <TableRow key={ev.id}>
                            <TableCell className={s.cell}>{ev.startDateTime ? new Date(ev.startDateTime).toLocaleString() : '—'}</TableCell>
                            <TableCell className={s.cell}>{ev.alertRule || '—'}</TableCell>
                            <TableCell>
                              <Badge appearance="filled" color={ev.monitorCondition === 'Fired' ? 'danger' : ev.monitorCondition === 'Resolved' ? 'success' : 'informative'}>
                                {ev.monitorCondition || ev.alertState || '—'}
                              </Badge>
                            </TableCell>
                            <TableCell>{ev.severity || '—'}</TableCell>
                            <TableCell className={s.cell}>{ev.targetResourceName || '—'}</TableCell>
                            <TableCell>{ev.payload?.matchingRowsCount ?? '—'}</TableCell>
                            <TableCell>
                              <Button size="small" appearance="subtle" onClick={() => setPayloadEvent(ev)} disabled={!ev.payload}>View</Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
              )}

              <Dialog open={!!payloadEvent} onOpenChange={(_: unknown, d: any) => { if (!d.open) setPayloadEvent(null); }}>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Alert payload — {payloadEvent?.alertRule}</DialogTitle>
                    <DialogContent>
                      {payloadEvent && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                          <Caption1><strong>Condition</strong>: {payloadEvent.monitorCondition} · {payloadEvent.alertState}{payloadEvent.severity ? ` · ${payloadEvent.severity}` : ''}</Caption1>
                          <Caption1><strong>Fired</strong>: {payloadEvent.startDateTime ? new Date(payloadEvent.startDateTime).toLocaleString() : '—'}{payloadEvent.monitorConditionResolvedDateTime ? ` · resolved ${new Date(payloadEvent.monitorConditionResolvedDateTime).toLocaleString()}` : ''}</Caption1>
                          <Caption1><strong>Rows matched</strong>: {payloadEvent.payload?.matchingRowsCount ?? '—'} ({payloadEvent.payload?.operator || '—'} {payloadEvent.payload?.threshold ?? '—'})</Caption1>
                          {payloadEvent.payload?.windowStartTime && (
                            <Caption1><strong>Window</strong>: {new Date(payloadEvent.payload.windowStartTime).toLocaleString()} → {payloadEvent.payload.windowEndTime ? new Date(payloadEvent.payload.windowEndTime).toLocaleString() : '—'}</Caption1>
                          )}
                          {payloadEvent.payload?.searchQuery && (
                            <Textarea readOnly value={payloadEvent.payload.searchQuery} rows={4} style={{ fontFamily: 'Consolas, monospace', width: '100%' }} />
                          )}
                          {payloadEvent.payload?.linkToSearchResultsUI && (
                            <a href={payloadEvent.payload.linkToSearchResultsUI} target="_blank" rel="noreferrer">Open matching rows in Azure Monitor →</a>
                          )}
                        </div>
                      )}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="primary" onClick={() => setPayloadEvent(null)}>Close</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
            </>
          )}
        </div>
      }
    />
  );
}
