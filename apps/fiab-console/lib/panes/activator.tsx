'use client';

/**
 * ActivatorPane — workspace-level Activator overview.
 *
 * Azure-native by DEFAULT (per .claude/rules/no-fabric-dependency.md): every
 * rule shown here is a real Azure Monitor scheduledQueryRule persisted on its
 * Cosmos activator item (state.rules: MonitorRuleRecord[]). Enable/disable
 * round-trips to ARM via PATCH .../rules?ruleId=&enabled=, delete via
 * DELETE .../rules?ruleId=. The full per-rule create/edit wizard lives in the
 * ActivatorEditor (the /activator item page); this pane links there rather than
 * re-implementing a freeform editor (which would violate loom-no-freeform-config).
 *
 * Three tabs, all backed by real data:
 *  • Rules         — every rule across the workspace's activators (LoomDataTable),
 *                    with live enable/disable + delete.
 *  • Objects       — the distinct source tables ("object classes") the rules
 *                    target, derived from state.rules[*].query/sourceTable.
 *  • Action history — fired/resolved Azure Monitor alert instances from
 *                    GET .../history (Microsoft.AlertsManagement/alerts).
 *
 * A Fabric Reflex backend remains opt-in (LOOM_ACTIVATOR_BACKEND=fabric); the
 * same BFF routes dispatch to it transparently. No Fabric workspace is required
 * for the default path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Title2,
  Body1,
  Caption1,
  makeStyles,
  tokens,
  Button,
  Badge,
  CounterBadge,
  Select,
  Tab,
  TabList,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import {
  Add24Regular,
  Flash24Regular,
  PauseCircle24Regular,
  Delete24Regular,
  ArrowClockwise24Regular,
  Open16Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

// ── shapes (mirror MonitorRuleRecord + AlertHistoryEvent from the BFF) ──────
interface MonitorRuleRecord {
  id: string;
  name: string;
  query: string;
  azureRuleName: string;
  severity: number;
  evaluationFrequency: string;
  windowSize: string;
  state: 'Active' | 'Disabled';
  backend?: 'azure-monitor' | 'fabric';
  createdAt?: string;
  updatedAt?: string;
  note?: string;
}

interface HistoryEvent {
  id: string;
  alertRule: string;
  monitorCondition: string;
  alertState: string;
  severity?: string;
  startDateTime: string;
  monitorConditionResolvedDateTime?: string;
  targetResourceName?: string;
}

interface WorkspaceLite { id: string; name: string }

interface ActivatorSummary {
  id: string;
  displayName: string;
  rules: MonitorRuleRecord[];
}

/** A rule joined to its parent activator (the Rules-tab row). */
interface RuleRow extends MonitorRuleRecord {
  activatorId: string;
  activatorName: string;
  /** Derived KQL source table (the "object class"). */
  sourceTable: string;
}

/** A distinct source table across all rules (the Objects-tab row). */
interface ObjectRow {
  sourceTable: string;
  activatorName: string;
  ruleCount: number;
  activeCount: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  titleGroup: { display: 'flex', flexDirection: 'column', gap: '2px' },
  subtitle: { color: tokens.colorNeutralForeground3 },
  tabLabel: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  historyCaption: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
  bar: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  actions: { display: 'flex', gap: '6px', alignItems: 'center' },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'block',
  },
  picker: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '260px' },
  loadingWrap: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '32px',
  },
  footer: {
    color: tokens.colorNeutralForeground3,
    paddingTop: '4px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: '4px',
  },
});

/** Extract the leading KQL table name from a rule's query — that is the
 *  Activator "object class" the rule watches. Falls back to '(unknown)'. */
function sourceTableOf(rule: MonitorRuleRecord): string {
  const q = (rule.query || '').trim();
  if (!q) return '(unknown)';
  // First non-empty token up to a pipe/newline/whitespace.
  const first = q.split(/[\n|]/)[0].trim();
  const m = first.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : '(unknown)';
}

const SEV_LABEL: Record<number, string> = { 0: 'Sev0 critical', 1: 'Sev1 error', 2: 'Sev2 warning', 3: 'Sev3 informational', 4: 'Sev4 verbose' };

export function ActivatorPane() {
  const styles = useStyles();

  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [wsError, setWsError] = useState<string | null>(null);

  const [activators, setActivators] = useState<ActivatorSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'rules' | 'objects' | 'history'>('rules');
  const [busyRuleId, setBusyRuleId] = useState<string>('');

  const [history, setHistory] = useState<HistoryEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // ── load Loom workspaces ──
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (!j.ok) { setWsError(j.error || 'failed to list workspaces'); return; }
        const ws: WorkspaceLite[] = (j.workspaces || []).map((w: any) => ({ id: w.id, name: w.name || w.id }));
        setWorkspaces(ws);
        if (ws.length > 0) setWorkspaceId((prev) => prev || ws[0].id);
      } catch (e: any) {
        setWsError(e?.message || String(e));
      }
    })();
  }, []);

  // ── load activators + their rules for the selected workspace ──
  const loadAll = useCallback(async (wsId: string) => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to list activators'); setActivators([]); return; }
      const list: { id: string; displayName: string }[] = (j.activators || j.items || []).map((a: any) => ({
        id: a.id, displayName: a.displayName || a.name || a.id,
      }));
      const withRules = await Promise.all(list.map(async (a) => {
        try {
          const rr = await fetch(`/api/items/activator/${encodeURIComponent(a.id)}/rules?workspaceId=${encodeURIComponent(wsId)}`);
          const rj = await rr.json();
          const rules: MonitorRuleRecord[] = rj.ok && Array.isArray(rj.rules)
            ? rj.rules.map((x: any) => ({ ...x, state: x.state === 'Disabled' ? 'Disabled' : 'Active' }))
            : [];
          return { id: a.id, displayName: a.displayName, rules };
        } catch {
          return { id: a.id, displayName: a.displayName, rules: [] };
        }
      }));
      setActivators(withRules);
    } catch (e: any) {
      setError(e?.message || String(e)); setActivators([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (workspaceId) loadAll(workspaceId); }, [workspaceId, loadAll]);

  // ── load action history (lazy, on tab activation) ──
  const loadHistory = useCallback(async (wsId: string, acts: ActivatorSummary[]) => {
    const withRules = acts.filter((a) => a.rules.length > 0);
    if (!wsId || withRules.length === 0) { setHistory([]); return; }
    setHistoryLoading(true); setHistoryError(null);
    try {
      const merged: HistoryEvent[] = [];
      for (const a of withRules) {
        const r = await fetch(`/api/items/activator/${encodeURIComponent(a.id)}/history?workspaceId=${encodeURIComponent(wsId)}`);
        const j = await r.json();
        if (!j.ok) {
          setHistoryError(j.gate?.remediation || j.error || 'history failed');
          continue;
        }
        for (const e of (j.events || [])) merged.push(e as HistoryEvent);
      }
      merged.sort((a, b) => new Date(b.startDateTime).getTime() - new Date(a.startDateTime).getTime());
      setHistory(merged);
    } catch (e: any) {
      setHistoryError(e?.message || String(e)); setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'history' && workspaceId && history === null) loadHistory(workspaceId, activators);
  }, [activeTab, workspaceId, history, activators, loadHistory]);

  // Reset history cache whenever the workspace or rule set changes.
  useEffect(() => { setHistory(null); }, [workspaceId, activators]);

  // ── derived rows ──
  const ruleRows: RuleRow[] = useMemo(
    () => activators.flatMap((a) =>
      a.rules.map((r) => ({ ...r, activatorId: a.id, activatorName: a.displayName, sourceTable: sourceTableOf(r) }))),
    [activators],
  );

  const objectRows: ObjectRow[] = useMemo(() => {
    const byTable = new Map<string, ObjectRow>();
    for (const r of ruleRows) {
      const key = `${r.sourceTable} ${r.activatorName}`;
      const existing = byTable.get(key);
      if (existing) {
        existing.ruleCount += 1;
        if (r.state === 'Active') existing.activeCount += 1;
      } else {
        byTable.set(key, {
          sourceTable: r.sourceTable, activatorName: r.activatorName,
          ruleCount: 1, activeCount: r.state === 'Active' ? 1 : 0,
        });
      }
    }
    return Array.from(byTable.values());
  }, [ruleRows]);

  // ── enable/disable + delete (round-trip to Azure Monitor) ──
  const toggleRule = useCallback(async (row: RuleRow) => {
    setBusyRuleId(row.id); setError(null);
    const next = row.state !== 'Active';
    try {
      const r = await fetch(
        `/api/items/activator/${encodeURIComponent(row.activatorId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&ruleId=${encodeURIComponent(row.id)}&enabled=${next}`,
        { method: 'PATCH' },
      );
      const j = await r.json();
      if (!j.ok) { setError(j.gate?.remediation || j.error || 'toggle failed'); return; }
      await loadAll(workspaceId);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyRuleId('');
    }
  }, [workspaceId, loadAll]);

  const deleteRule = useCallback(async (row: RuleRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete rule "${row.name}"? This removes its Azure Monitor scheduled-query rule.`)) return;
    setBusyRuleId(row.id); setError(null);
    try {
      const r = await fetch(
        `/api/items/activator/${encodeURIComponent(row.activatorId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&ruleId=${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!j.ok) { setError(j.gate?.remediation || j.error || 'delete failed'); return; }
      await loadAll(workspaceId);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyRuleId('');
    }
  }, [workspaceId, loadAll]);

  const openEditor = useCallback(() => {
    if (typeof window !== 'undefined') window.location.href = '/activator';
  }, []);

  // ── columns ──
  const ruleColumns: LoomColumn<RuleRow>[] = useMemo(() => [
    { key: 'name', label: 'Rule', filterType: 'text', width: 180, render: (r) => <strong>{r.name}</strong> },
    { key: 'activatorName', label: 'Activator', filterType: 'select', width: 160 },
    { key: 'sourceTable', label: 'Object (source table)', filterType: 'select', width: 170, render: (r) => <code className={styles.mono}>{r.sourceTable}</code> },
    { key: 'query', label: 'KQL', filterType: 'text', width: 240, render: (r) => <code className={styles.mono} title={r.query}>{r.query}</code> },
    { key: 'evaluationFrequency', label: 'Frequency', filterType: 'select', width: 110 },
    {
      key: 'severity', label: 'Severity', filterType: 'select', width: 150,
      getValue: (r) => `Sev${r.severity}`,
      render: (r) => SEV_LABEL[r.severity] ?? `Sev${r.severity}`,
    },
    {
      key: 'state', label: 'State', filterType: 'select', width: 110,
      render: (r) => (
        <Badge appearance="filled" color={r.state === 'Active' ? 'success' : 'subtle'}>
          {r.state === 'Active' ? 'Active' : 'Disabled'}
        </Badge>
      ),
    },
    {
      key: 'actions', label: 'Actions', filterable: false, sortable: false, width: 170,
      getValue: () => '',
      render: (r) => (
        <div className={styles.actions}>
          <Button
            size="small"
            appearance={r.state === 'Active' ? 'primary' : 'subtle'}
            icon={r.state === 'Active' ? <PauseCircle24Regular /> : <Flash24Regular />}
            disabled={busyRuleId === r.id}
            onClick={(e) => { e.stopPropagation(); toggleRule(r); }}
            title={r.state === 'Active' ? 'Disable (pause evaluation)' : 'Enable (resume evaluation)'}
          >
            {r.state === 'Active' ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete24Regular />}
            disabled={busyRuleId === r.id}
            onClick={(e) => { e.stopPropagation(); deleteRule(r); }}
            title="Delete rule"
            aria-label={`Delete ${r.name}`}
          />
        </div>
      ),
    },
  ], [styles.mono, styles.actions, busyRuleId, toggleRule, deleteRule]);

  const objectColumns: LoomColumn<ObjectRow>[] = useMemo(() => [
    { key: 'sourceTable', label: 'Object (source table)', filterType: 'text', width: 220, render: (o) => <code className={styles.mono}>{o.sourceTable}</code> },
    { key: 'activatorName', label: 'Activator', filterType: 'select', width: 200 },
    { key: 'ruleCount', label: 'Rules', filterable: false, width: 100, getValue: (o) => o.ruleCount },
    { key: 'activeCount', label: 'Active rules', filterable: false, width: 120, getValue: (o) => o.activeCount },
  ], [styles.mono]);

  const historyColumns: LoomColumn<HistoryEvent>[] = useMemo(() => [
    { key: 'alertRule', label: 'Alert rule', filterType: 'text', width: 220 },
    {
      key: 'monitorCondition', label: 'Condition', filterType: 'select', width: 120,
      render: (e) => (
        <Badge appearance="filled" color={e.monitorCondition === 'Fired' ? 'danger' : e.monitorCondition === 'Resolved' ? 'success' : 'subtle'}>
          {e.monitorCondition || '—'}
        </Badge>
      ),
    },
    { key: 'alertState', label: 'State', filterType: 'select', width: 120 },
    { key: 'severity', label: 'Severity', filterType: 'select', width: 110, render: (e) => e.severity || '—' },
    { key: 'startDateTime', label: 'Fired', filterType: 'date', width: 180, render: (e) => e.startDateTime ? new Date(e.startDateTime).toLocaleString() : '—' },
    { key: 'monitorConditionResolvedDateTime', label: 'Resolved', filterType: 'date', width: 180, render: (e) => e.monitorConditionResolvedDateTime ? new Date(e.monitorConditionResolvedDateTime).toLocaleString() : '—' },
    { key: 'targetResourceName', label: 'Target', filterType: 'text', width: 160, render: (e) => e.targetResourceName || '—' },
  ], []);

  const activeRules = ruleRows.filter((r) => r.state === 'Active').length;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <Title2>Activator</Title2>
          <Caption1 className={styles.subtitle}>
            Detect-and-act rules across this workspace, backed by Azure Monitor scheduled-query alerts.
          </Caption1>
        </div>
        <Badge color="brand">Azure Monitor scheduled-query rules</Badge>
        {ruleRows.length > 0 && (
          <Badge appearance="tint" color="success">{activeRules} active / {ruleRows.length} rules</Badge>
        )}
        <div className={styles.spacer} />
        <Button appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={() => loadAll(workspaceId)} disabled={!workspaceId || loading}>
          Refresh
        </Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={openEditor}>
          New rule
        </Button>
      </div>

      <div className={styles.bar}>
        <div className={styles.picker}>
          <Caption1>Workspace</Caption1>
          <Select
            value={workspaceId}
            onChange={(_, d) => setWorkspaceId(d.value)}
            disabled={workspaces.length === 0}
          >
            {!workspaceId && <option value="">{wsError ? 'Workspaces unavailable' : 'Select a workspace'}</option>}
            {workspaces.map((w) => (<option key={w.id} value={w.id}>{w.name}</option>))}
          </Select>
        </div>
      </div>

      {wsError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
            {wsError}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Monitor</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as typeof activeTab)}>
        <Tab value="rules">
          <span className={styles.tabLabel}>
            Rules
            {ruleRows.length > 0 && <CounterBadge count={ruleRows.length} appearance="ghost" size="small" />}
          </span>
        </Tab>
        <Tab value="objects">
          <span className={styles.tabLabel}>
            Objects
            {objectRows.length > 0 && <CounterBadge count={objectRows.length} appearance="ghost" size="small" />}
          </span>
        </Tab>
        <Tab value="history">
          <span className={styles.tabLabel}>
            Action history
            {history && history.length > 0 && <CounterBadge count={history.length} appearance="ghost" size="small" />}
          </span>
        </Tab>
      </TabList>

      {activeTab === 'rules' && (
        <LoomDataTable<RuleRow>
          columns={ruleColumns}
          rows={ruleRows}
          getRowId={(r) => `${r.activatorId}:${r.id}`}
          loading={loading}
          ariaLabel="Activator rules"
          empty={
            workspaceId
              ? 'No rules yet in this workspace. Open an Activator and add a rule — it becomes a real Azure Monitor scheduled-query rule.'
              : 'Select a workspace to view its Activator rules.'
          }
          onRowClick={() => openEditor()}
        />
      )}

      {activeTab === 'objects' && (
        <LoomDataTable<ObjectRow>
          columns={objectColumns}
          rows={objectRows}
          getRowId={(o) => `${o.activatorName}:${o.sourceTable}`}
          loading={loading}
          ariaLabel="Activator objects"
          empty="No objects yet. Each rule's KQL source table appears here as a watched object once a rule is added."
        />
      )}

      {activeTab === 'history' && (
        <>
          <div className={styles.bar}>
            <Caption1 className={styles.historyCaption}>
              Fired and resolved Azure Monitor alert instances across this workspace&apos;s activators.
            </Caption1>
            <div className={styles.spacer} />
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowClockwise24Regular />}
              onClick={() => loadHistory(workspaceId, activators)}
              disabled={!workspaceId || historyLoading}
            >
              Refresh history
            </Button>
          </div>
          {historyError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Run history</MessageBarTitle>
                {historyError}
              </MessageBarBody>
            </MessageBar>
          )}
          {historyLoading ? (
            <div className={styles.loadingWrap}>
              <Spinner size="medium" label="Loading alert history…" />
            </div>
          ) : (
            <LoomDataTable<HistoryEvent>
              columns={historyColumns}
              rows={history || []}
              getRowId={(e) => e.id}
              ariaLabel="Activator action history"
              empty="No fired/resolved alert instances yet. When a rule's condition is met, Azure Monitor records the instance here."
            />
          )}
        </>
      )}

      <Body1 as="p" className={styles.footer}>
        Rules persist as Azure Monitor scheduled-query alert rules — enable/disable and delete here round-trip to ARM. Use{' '}
        <Button appearance="transparent" size="small" icon={<Open16Regular />} iconPosition="after" onClick={openEditor}>
          the Activator editor
        </Button>{' '}
        to author a new rule (condition, KQL, action group) with the full guided wizard.
      </Body1>
    </div>
  );
}
