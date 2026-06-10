'use client';

/**
 * MonitorAlertEditor — full create/edit lifecycle for an Azure Monitor
 * scheduled query alert rule (Microsoft.Insights/scheduledQueryRules), themed
 * to Fluent v9 + Loom tokens with one-for-one parity to the Azure portal
 * "Create alert rule" experience (Scope → Condition → Actions → Details).
 *
 * Tabs:
 *   - Query        KQL evaluated against the Loom Log Analytics workspace.
 *   - Condition    operator + threshold against the KQL result row count.
 *   - Schedule     evaluation frequency + look-back window + severity.
 *   - Destination  Action Group picker (real Microsoft.Insights/actionGroups)
 *                  — delivers email / SMS / webhook / Logic App when the rule fires.
 *
 * Every control hits the real BFF (/api/monitor/alerts). No mocks, no dead
 * controls. The post-save receipt surfaces the server-assigned ARM id. When the
 * `rule` prop is supplied the dialog opens in EDIT mode pre-populated from it;
 * the save is the same idempotent PUT (upsertScheduledQueryRule), so editing an
 * existing rule and creating a new one share one code path.
 *
 * Azure-native only — no Microsoft Fabric dependency (per no-fabric-dependency).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Field, Input, Dropdown, Option, Spinner, Badge,
  Tab, TabList, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Alert20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  MonitorConditionsBuilder, freqMinutes,
} from './monitor-conditions-builder';

/** Mirrors ScheduledQueryRule from monitor-client (the fields the editor uses). */
export interface ScheduledQueryRuleLite {
  id?: string;
  name: string;
  enabled?: boolean;
  severity?: number;
  description?: string;
  query?: string;
  operator?: string;
  threshold?: number;
  evaluationFrequency?: string;
  windowSize?: string;
  actionGroupIds?: string[];
}

interface ActionGroup { id: string; name: string; }

const DEFAULT_KQL =
  '// KQL evaluated against the Loom Log Analytics workspace.\n' +
  '// The rule fires when the result row count meets the condition below.\n' +
  'Heartbeat\n' +
  '| where TimeGenerated > ago(5m)\n' +
  '| summarize count()';

const useStyles = makeStyles({
  editorPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: '320px' },
  hint: { color: tokens.colorNeutralForeground3 },
  agRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, alignItems: 'flex-start' },
  titleRow: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  titleText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '480px',
  },
});

export interface MonitorAlertEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog opens in EDIT mode pre-populated with existing rule fields. */
  rule?: ScheduledQueryRuleLite;
  /** Fired after a successful create/edit; receives the server-assigned ARM id. */
  onSaved: (id: string) => void;
}

export function MonitorAlertEditor({ open, onOpenChange, rule, onSaved }: MonitorAlertEditorProps) {
  const s = useStyles();
  const isEdit = !!rule?.name;

  const [tab, setTab] = useState<'query' | 'condition' | 'schedule' | 'destination'>('query');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState(DEFAULT_KQL);
  const [operator, setOperator] = useState('GreaterThan');
  const [threshold, setThreshold] = useState(0);
  const [frequency, setFrequency] = useState('PT5M');
  const [windowSize, setWindowSize] = useState('PT5M');
  const [severity, setSeverity] = useState(3);
  const [actionGroupId, setActionGroupId] = useState('');
  const [actionGroups, setActionGroups] = useState<ActionGroup[]>([]);
  const [agNote, setAgNote] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string } | null>(null);

  const loadActionGroups = useCallback(async () => {
    setAgNote(null);
    try {
      const r = await fetch('/api/monitor/action-groups');
      const j = await r.json();
      if (j.ok && Array.isArray(j.actionGroups)) {
        setActionGroups(j.actionGroups.map((a: { id: string; name: string }) => ({ id: a.id, name: a.name })));
        if (j.actionGroups.length === 0) {
          setAgNote('No action groups exist yet. Create one in Monitor → Action groups (or via the Activator action editor), then reload. The rule still fires; without a destination it only records to Azure Monitor.');
        }
      } else {
        setAgNote(j.gate?.remediation || j.error || 'Action groups unavailable.');
      }
    } catch (e) {
      setAgNote((e as Error)?.message || String(e));
    }
  }, []);

  // (Re)initialize the form whenever the dialog opens or the target rule changes.
  useEffect(() => {
    if (!open) return;
    setTab('query');
    setSaveErr(null);
    setReceipt(null);
    setName(rule?.name || '');
    setDescription(rule?.description || '');
    setQuery(rule?.query || DEFAULT_KQL);
    setOperator(rule?.operator || 'GreaterThan');
    setThreshold(typeof rule?.threshold === 'number' ? rule.threshold : 0);
    setFrequency(rule?.evaluationFrequency || 'PT5M');
    setWindowSize(rule?.windowSize || 'PT5M');
    setSeverity(typeof rule?.severity === 'number' ? rule.severity : 3);
    setActionGroupId((rule?.actionGroupIds && rule.actionGroupIds[0]) || '');
    void loadActionGroups();
  }, [open, rule, loadActionGroups]);

  const windowTooSmall = useMemo(
    () => freqMinutes(windowSize) < freqMinutes(frequency),
    [windowSize, frequency],
  );

  const canSave = !!name.trim() && !!query.trim() && Number.isFinite(threshold) && !windowTooSmall;

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    setReceipt(null);
    try {
      const r = await fetch('/api/monitor/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _action: 'upsert',
          rule: {
            name: name.trim(),
            description: description.trim() || undefined,
            query: query.trim(),
            operator,
            threshold,
            severity,
            evaluationFrequency: frequency,
            windowSize,
            actionGroupIds: actionGroupId ? [actionGroupId] : [],
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.gate?.remediation || j.error || `HTTP ${r.status}`);
      setReceipt({ id: j.id });
      onSaved(j.id);
    } catch (e) {
      setSaveErr((e as Error)?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [name, description, query, operator, threshold, severity, frequency, windowSize, actionGroupId, onSaved]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '820px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}>
              <Alert20Regular />
              <span className={s.titleText} title={isEdit ? rule?.name : undefined}>
                {isEdit ? `Edit alert rule — ${rule?.name}` : 'New alert rule'}
              </span>
              <Badge appearance="outline" color="brand">Azure Monitor (scheduled query rule)</Badge>
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.editorPane}>
              <Field label="Rule name" required hint={isEdit ? 'Name is the rule identity; editing keeps the same rule.' : 'Lowercase letters, numbers and hyphens recommended.'}>
                <Input
                  value={name}
                  disabled={isEdit}
                  onChange={(_, d) => setName(d.value)}
                  placeholder="heartbeat-missing-alert"
                />
              </Field>
              <Field label="Description">
                <Input
                  value={description}
                  onChange={(_, d) => setDescription(d.value)}
                  placeholder="Fires when no heartbeat is seen in the look-back window."
                />
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
                    KQL evaluated against the Loom Log Analytics workspace. The rule fires when the
                    result row count meets the condition on the Condition tab.
                  </Caption1>
                  <MonacoTextarea
                    value={query}
                    onChange={setQuery}
                    language="kusto"
                    height={220}
                    minHeight={160}
                    ariaLabel="Alert KQL query"
                  />
                </>
              )}

              {tab === 'condition' && (
                <MonitorConditionsBuilder
                  mode="edit"
                  section="condition"
                  operator={operator}
                  threshold={threshold}
                  evaluationFrequency={frequency}
                  windowSize={windowSize}
                  severity={severity}
                  onOperatorChange={setOperator}
                  onThresholdChange={setThreshold}
                />
              )}

              {tab === 'schedule' && (
                <MonitorConditionsBuilder
                  mode="edit"
                  section="schedule"
                  operator={operator}
                  threshold={threshold}
                  evaluationFrequency={frequency}
                  windowSize={windowSize}
                  severity={severity}
                  onFrequencyChange={setFrequency}
                  onWindowChange={setWindowSize}
                  onSeverityChange={setSeverity}
                />
              )}

              {tab === 'destination' && (
                <div className={s.agRow}>
                  <Field label="Action group" hint="Real Microsoft.Insights/actionGroups — delivers email / SMS / webhook / Logic App when the rule fires">
                    <Dropdown
                      value={
                        actionGroups.find((a) => a.id === actionGroupId)?.name
                        || (actionGroupId
                          ? (actionGroupId.split('/').pop() || actionGroupId)
                          : 'None — record to Azure Monitor only')
                      }
                      selectedOptions={actionGroupId ? [actionGroupId] : ['']}
                      onOptionSelect={(_, d) => setActionGroupId(d.optionValue || '')}
                    >
                      <Option value="">None — record to Azure Monitor only</Option>
                      {actionGroups.map((a) => <Option key={a.id} value={a.id}>{a.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void loadActionGroups()}>
                    Reload action groups
                  </Button>
                  {agNote && <MessageBar intent="info"><MessageBarBody>{agNote}</MessageBarBody></MessageBar>}
                </div>
              )}

              <Divider />
              {windowTooSmall && (
                <MessageBar intent="warning"><MessageBarBody>The look-back window must be at least the evaluation frequency. Adjust them on the Schedule tab.</MessageBarBody></MessageBar>
              )}
              {saveErr && (
                <MessageBar intent="error"><MessageBarBody><MessageBarTitle>{isEdit ? 'Update failed' : 'Create failed'}</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>
              )}
              {receipt && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>{isEdit ? 'Alert rule updated' : 'Alert rule created'}</MessageBarTitle>
                    ID: <code>{receipt.id}</code>
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              appearance="primary"
              icon={saving ? <Spinner size="tiny" /> : <Alert20Regular />}
              disabled={!canSave || saving}
              onClick={() => void save()}
            >
              {saving ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create alert rule')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
