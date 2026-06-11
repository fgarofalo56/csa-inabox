'use client';

/**
 * Catalog → Data quality.
 *
 * Loom-native data-quality rule management. Rules are stored in Cosmos and can
 * be created/edited/deleted without any Purview dependency. Each rule specifies:
 *   - name: descriptive rule name
 *   - scope: table (e.g., "table:my_table") or column (e.g., "column:my_table.my_col")
 *   - check type: not-null, unique, range, regex, or freshness
 *   - threshold: numeric value (% for not-null/unique, days for freshness, etc.)
 *   - optional: pattern (for regex), min/max (for range)
 *
 * All dropdowns follow Loom tokens + Fluent v9 style. No JSON, no freeform config.
 * An honest note states that execution defers to the next scan.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Badge, MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Input, Field, Dropdown, Option, Textarea, Switch,
  Caption1, Body1, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface DataQualityRule {
  id: string;
  name: string;
  scope: string;
  check: 'not-null' | 'unique' | 'range' | 'regex' | 'freshness';
  threshold: number;
  pattern?: string;
  min?: number;
  max?: number;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface ApiResponse {
  ok: boolean;
  rules?: DataQualityRule[];
  error?: string;
  errors?: string[];
}

const useStyles = makeStyles({
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: '16px', maxWidth: '760px' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px',
    paddingBottom: '12px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  infoBar: { marginBottom: '16px' },
  actionCell: { display: 'flex', gap: '8px' },
  dialogFields: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '400px' },
  row: { display: 'flex', gap: '8px' },
  conditionalsSection: {
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusMedium,
  },
});

const CHECK_TYPES: Array<{ value: DataQualityRule['check']; label: string }> = [
  { value: 'not-null', label: 'Not null' },
  { value: 'unique', label: 'Unique' },
  { value: 'range', label: 'Range' },
  { value: 'regex', label: 'Regex pattern' },
  { value: 'freshness', label: 'Freshness' },
];

const SCOPE_PREFIXES = [
  { value: 'table', label: 'Table' },
  { value: 'column', label: 'Column' },
];

export default function DataQualityPage() {
  const s = useStyles();
  const [rules, setRules] = useState<DataQualityRule[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<DataQualityRule | null>(null);
  const [dialogError, setDialogError] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const [draftName, setDraftName] = useState('');
  const [draftScopeType, setDraftScopeType] = useState<'table' | 'column'>('table');
  const [draftScopeName, setDraftScopeName] = useState('');
  const [draftCheck, setDraftCheck] = useState<DataQualityRule['check']>('not-null');
  const [draftThreshold, setDraftThreshold] = useState('80');
  const [draftPattern, setDraftPattern] = useState('');
  const [draftMin, setDraftMin] = useState('');
  const [draftMax, setDraftMax] = useState('');
  const [draftEnabled, setDraftEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/admin/data-quality-rules');
      const j: ApiResponse = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to load'); return; }
      setRules(j.rules || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setDraftName(''); setDraftScopeType('table'); setDraftScopeName('');
    setDraftCheck('not-null'); setDraftThreshold('80'); setDraftPattern('');
    setDraftMin(''); setDraftMax(''); setDraftEnabled(true);
    setDialogError(null); setEditingRule(null);
  }

  function editRule(rule: DataQualityRule) {
    setEditingRule(rule);
    setDraftName(rule.name);
    const parts = rule.scope.split(':');
    setDraftScopeType((parts[0] as any) || 'table');
    setDraftScopeName(parts[1] || '');
    setDraftCheck(rule.check);
    setDraftThreshold(String(rule.threshold));
    setDraftPattern(rule.pattern || '');
    setDraftMin(rule.min !== undefined ? String(rule.min) : '');
    setDraftMax(rule.max !== undefined ? String(rule.max) : '');
    setDraftEnabled(rule.enabled);
    setDialogError(null);
    setDialogOpen(true);
  }

  async function saveRule() {
    setBusy(true);
    setDialogError(null);
    const scope = `${draftScopeType}:${draftScopeName}`;
    const payload: any = {
      name: draftName.trim(), scope, check: draftCheck,
      threshold: parseInt(draftThreshold, 10), enabled: draftEnabled,
    };
    if (draftCheck === 'regex' && draftPattern) payload.pattern = draftPattern;
    if (draftCheck === 'range') { payload.min = parseInt(draftMin, 10); payload.max = parseInt(draftMax, 10); }
    if (editingRule) payload.id = editingRule.id;
    try {
      const method = editingRule ? 'PUT' : 'POST';
      const r = await clientFetch('/api/admin/data-quality-rules', {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j: ApiResponse = await r.json();
      if (!j.ok) { setDialogError(Array.isArray(j.errors) ? j.errors : [j.error || 'Unknown error']); return; }
      setRules(j.rules || []);
      setDialogOpen(false);
      resetForm();
    } catch (e: any) { setDialogError([e?.message || String(e)]); }
    finally { setBusy(false); }
  }

  async function deleteRule(id: string) {
    try {
      const r = await clientFetch(`/api/admin/data-quality-rules?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j: ApiResponse = await r.json();
      if (j.ok) setRules(j.rules || []);
      else setError(j.error || 'Delete failed');
    } catch (e: any) { setError(e?.message || String(e)); }
  }

  const ruleColumns: LoomColumn<DataQualityRule>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (r) => r.name, render: (r) => <Body1><strong>{r.name}</strong></Body1> },
    { key: 'scope', label: 'Scope', sortable: true, filterable: true, getValue: (r) => r.scope, render: (r) => <Caption1>{r.scope}</Caption1> },
    { key: 'check', label: 'Check', sortable: true, filterable: true, width: 140, getValue: (r) => r.check, render: (r) => <Badge appearance="tint" size="small">{r.check}</Badge> },
    { key: 'threshold', label: 'Threshold', sortable: true, filterable: false, width: 110, getValue: (r) => r.threshold, render: (r) => <Caption1>{r.threshold}{r.check === 'freshness' ? 'd' : '%'}</Caption1> },
    { key: 'enabled', label: 'Status', sortable: true, filterable: false, width: 110, getValue: (r) => (r.enabled ? 1 : 0), render: (r) => <Badge appearance="tint" color={r.enabled ? 'success' : 'warning'} size="small">{r.enabled ? 'Enabled' : 'Disabled'}</Badge> },
    {
      key: 'actions', label: 'Actions', sortable: false, filterable: false, width: 100,
      render: (r) => (
        <span className={s.actionCell} onClick={(e) => e.stopPropagation()}>
          <Button size="small" appearance="transparent" icon={<Edit20Regular />} onClick={() => editRule(r)} aria-label="Edit" />
          <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => deleteRule(r.id)} aria-label="Delete" />
        </span>
      ),
    },
  ];

  return (
    <CatalogShell sectionTitle="Data quality" sectionBadge="Loom native">
      <Caption1 className={s.intro}>
        Define and manage data-quality rules for your tables and columns. Rules are stored in Loom&rsquo;s Cosmos store and run on the next scan. No Purview dependency — this is Loom-native.
      </Caption1>

      <MessageBar intent="info" className={s.infoBar}>
        <MessageBarBody>
          <MessageBarTitle>Execution deferred</MessageBarTitle>
          Rules you define here are evaluated on the next scan run. Real-time enforcement can be enabled via the scan configuration in Scans &amp; sources.
        </MessageBarBody>
      </MessageBar>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Error loading rules</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Quality rules</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => { resetForm(); setDialogOpen(true); }}>New rule</Button>
      </div>

      {loading && !rules && <Spinner label="Loading data-quality rules…" />}

      {!loading && rules && (
        <LoomDataTable<DataQualityRule>
          columns={ruleColumns}
          rows={rules}
          getRowId={(r) => r.id}
          empty="No rules yet. Create one to start monitoring data quality."
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={(_, d) => { if (!d.open) { setDialogOpen(false); resetForm(); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editingRule ? 'Edit rule' : 'New data-quality rule'}</DialogTitle>
            <DialogContent>
              {dialogError && dialogError.length > 0 && (
                <MessageBar intent="error" style={{ marginBottom: 12 }}>
                  <MessageBarBody>{dialogError.map((e, i) => <div key={i}>{e}</div>)}</MessageBarBody>
                </MessageBar>
              )}
              <div className={s.dialogFields}>
                <Field label="Rule name" required>
                  <Input value={draftName} onChange={(_, d) => setDraftName(d.value)} placeholder="e.g., 'Customer ID not null'" />
                </Field>

                <div className={s.row}>
                  <Field label="Scope type" style={{ flex: 1 }}>
                    <Dropdown
                      selectedOptions={[draftScopeType]} value={SCOPE_PREFIXES.find((sp) => sp.value === draftScopeType)?.label || ''}
                      onOptionSelect={(_, d) => setDraftScopeType((d.optionValue as any) || 'table')}
                    >
                      {SCOPE_PREFIXES.map((sp) => <Option key={sp.value} value={sp.value}>{sp.label}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label={draftScopeType === 'table' ? 'Table name' : 'Column (table.column)'} style={{ flex: 2 }}>
                    <Input value={draftScopeName} onChange={(_, d) => setDraftScopeName(d.value)}
                      placeholder={draftScopeType === 'table' ? 'my_table' : 'my_table.customer_id'} />
                  </Field>
                </div>

                <Field label="Check type" required>
                  <Dropdown
                    selectedOptions={[draftCheck]} value={CHECK_TYPES.find((ct) => ct.value === draftCheck)?.label || ''}
                    onOptionSelect={(_, d) => setDraftCheck((d.optionValue as any) || 'not-null')}
                  >
                    {CHECK_TYPES.map((ct) => <Option key={ct.value} value={ct.value}>{ct.label}</Option>)}
                  </Dropdown>
                </Field>

                <Field label={`Threshold (${draftCheck === 'freshness' ? 'days' : '%'})`} required>
                  <Input type="number" value={draftThreshold} onChange={(_, d) => setDraftThreshold(d.value)}
                    min={draftCheck === 'freshness' ? '1' : '0'} max={draftCheck === 'freshness' ? '365' : '100'} />
                </Field>

                {draftCheck === 'regex' && (
                  <Field label="Regex pattern" required>
                    <Textarea value={draftPattern} onChange={(_, d) => setDraftPattern(d.value)} placeholder="e.g., ^[A-Z]{2}\d{4}$" />
                  </Field>
                )}

                {draftCheck === 'range' && (
                  <div className={s.conditionalsSection}>
                    <div className={s.row}>
                      <Field label="Min" style={{ flex: 1 }}>
                        <Input type="number" value={draftMin} onChange={(_, d) => setDraftMin(d.value)} />
                      </Field>
                      <Field label="Max" style={{ flex: 1 }}>
                        <Input type="number" value={draftMax} onChange={(_, d) => setDraftMax(d.value)} />
                      </Field>
                    </div>
                  </div>
                )}

                <Switch label="Enable this rule" checked={draftEnabled} onChange={(_, d) => setDraftEnabled(d.checked)} />
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setDialogOpen(false); resetForm(); }} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={saveRule} disabled={busy || !draftName.trim() || !draftScopeName.trim()}>
                {editingRule ? 'Update' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </CatalogShell>
  );
}
