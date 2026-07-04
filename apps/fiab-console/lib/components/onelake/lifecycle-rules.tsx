'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LifecycleRulesPanel — OneLake Lifecycle Management rules editor.
 *
 * Parity with Fabric "OneLake — Manage lifecycle" / the Azure portal storage
 * "Lifecycle management" blade: a rules grid with Add / Edit / Delete / Pause /
 * Reactivate / Create-from-template, capped at 10 rules per workspace. The rule
 * editor is a guided wizard — dropdowns, checkboxes and a number SpinButton, NO
 * JSON textarea (per loom_no_freeform_config).
 *
 * Backend: GET/PUT /api/onelake/lifecycle, which read/write the storage
 * account's live ADLS Gen2 managementPolicies/default via ARM (Azure-native, no
 * Fabric dependency). When the Console UAMI lacks Storage Account Contributor,
 * the BFF returns an honest gate and this panel renders a MessageBar naming the
 * role + bicep module.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Input, Dropdown, Option, SpinButton, Checkbox,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Edit20Regular, Delete20Regular, Pause20Regular, Play20Regular,
  DocumentBulletList20Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

// ---- Domain types (mirror lib/azure/adls-client.ts, kept local for the client) ----

export type ConditionField =
  | 'daysAfterModificationGreaterThan'
  | 'daysAfterLastAccessTimeGreaterThan'
  | 'daysAfterCreationGreaterThan';

export type LifecycleAction =
  | 'tierToCool'
  | 'tierToCold'
  | 'tierToArchive'
  | 'enableAutoTierToHotFromCool'
  | 'delete';

export interface LifecycleRule {
  name: string;
  enabled: boolean;
  prefixMatch?: string[];
  conditionField: ConditionField;
  conditionDays: number;
  actions: LifecycleAction[];
}

const MAX_RULES = 10;

const CONDITION_LABELS: Record<ConditionField, string> = {
  daysAfterModificationGreaterThan: 'Days since last modification',
  daysAfterLastAccessTimeGreaterThan: 'Days since last access',
  daysAfterCreationGreaterThan: 'Days since creation',
};

const ACTION_LABELS: Record<LifecycleAction, string> = {
  tierToCool: 'Tier to Cool',
  tierToCold: 'Tier to Cold',
  tierToArchive: 'Tier to Archive',
  enableAutoTierToHotFromCool: 'Auto-tier Hot from Cool',
  delete: 'Delete blob',
};

interface Template { key: string; label: string; build: () => LifecycleRule; }

const TEMPLATES: Template[] = [
  {
    key: 'tier-cool-30',
    label: 'Tier to Cool — 30 days since modified',
    build: () => ({ name: 'tier-cool-30d', enabled: true, conditionField: 'daysAfterModificationGreaterThan', conditionDays: 30, actions: ['tierToCool'] }),
  },
  {
    key: 'archive-90',
    label: 'Archive cold data — 90 days since modified',
    build: () => ({ name: 'archive-90d', enabled: true, conditionField: 'daysAfterModificationGreaterThan', conditionDays: 90, actions: ['tierToArchive'] }),
  },
  {
    key: 'delete-180',
    label: 'Data retention — delete after 180 days',
    build: () => ({ name: 'delete-180d', enabled: true, conditionField: 'daysAfterModificationGreaterThan', conditionDays: 180, actions: ['delete'] }),
  },
  {
    key: 'auto-tier',
    label: 'Auto-tier to Hot on access — 30 days last access',
    build: () => ({ name: 'auto-tier-hot', enabled: true, conditionField: 'daysAfterLastAccessTimeGreaterThan', conditionDays: 30, actions: ['tierToCool', 'enableAutoTierToHotFromCool'] }),
  },
  {
    key: 'lz-cleanup',
    label: 'Landing-zone cleanup — delete after 7 days (landing/ prefix)',
    build: () => ({ name: 'landing-cleanup-7d', enabled: true, prefixMatch: ['landing/'], conditionField: 'daysAfterModificationGreaterThan', conditionDays: 7, actions: ['delete'] }),
  },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '420px' },
  checks: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS },
  hint: { color: tokens.colorNeutralForeground3 },
  count: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

interface GateInfo { missing?: string; hint?: string; bicepModule?: string; }

function describeScope(r: LifecycleRule): string {
  return r.prefixMatch && r.prefixMatch.length ? r.prefixMatch.join(', ') : 'Entire account';
}
function describeCondition(r: LifecycleRule): string {
  return `${CONDITION_LABELS[r.conditionField]} > ${r.conditionDays}d`;
}
function describeActions(r: LifecycleRule): string {
  return r.actions.map((a) => ACTION_LABELS[a]).join(', ');
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

export function LifecycleRulesPanel({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<LifecycleRule[]>([]);
  const [gate, setGate] = useState<GateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | undefined>();
  const [editing, setEditing] = useState<{ rule: LifecycleRule | null; original?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientFetch(`/api/onelake/lifecycle?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await res.json();
      if (j?.gate) { setGate({ missing: j.missing, hint: j.hint, bicepModule: j.bicepModule }); setRules([]); }
      else if (j?.ok) { setGate(null); setRules(j.rules || []); setAccount(j.account); }
      else { setError(j?.error || `HTTP ${res.status}`); }
    } catch (e: any) {
      setError(e?.message || 'Failed to load lifecycle rules');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  // PUT the full ruleset (ARM replaces in full); re-GET to confirm persistence.
  const persist = useCallback(async (next: LifecycleRule[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await clientFetch('/api/onelake/lifecycle', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, rules: next }),
      });
      const j = await res.json();
      if (j?.gate) { setGate({ missing: j.missing, hint: j.hint, bicepModule: j.bicepModule }); return false; }
      if (!res.ok || !j?.ok) { setError(j?.error || `HTTP ${res.status}`); return false; }
      await load(); // re-GET → confirm the live policy matches
      return true;
    } catch (e: any) {
      setError(e?.message || 'Failed to save lifecycle rules');
      return false;
    } finally {
      setSaving(false);
    }
  }, [workspaceId, load]);

  const atLimit = rules.length >= MAX_RULES;

  const saveRule = useCallback(async (rule: LifecycleRule, originalName?: string) => {
    // Upsert by name. New rule when no original; rename allowed when editing.
    const others = rules.filter((r) => r.name !== originalName);
    if (others.some((r) => r.name === rule.name)) {
      setError(`A rule named "${rule.name}" already exists.`);
      return;
    }
    if (!originalName && others.length >= MAX_RULES) {
      setError(`Maximum ${MAX_RULES} lifecycle rules reached. Delete or replace an existing rule.`);
      return;
    }
    const next = originalName
      ? rules.map((r) => (r.name === originalName ? rule : r))
      : [...rules, rule];
    const ok = await persist(next);
    if (ok) setEditing(null);
  }, [rules, persist]);

  const toggleRule = useCallback(async (rule: LifecycleRule, enabled: boolean) => {
    await persist(rules.map((r) => (r.name === rule.name ? { ...r, enabled } : r)));
  }, [rules, persist]);

  const deleteRule = useCallback(async (rule: LifecycleRule) => {
    await persist(rules.filter((r) => r.name !== rule.name));
  }, [rules, persist]);

  const columns: LoomColumn<LifecycleRule>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 180, filterable: true,
      render: (r) => <Text weight="semibold">{r.name}</Text>,
    },
    {
      key: 'status', label: 'Status', width: 110, filterType: 'select',
      getValue: (r) => (r.enabled ? 'Active' : 'Inactive'),
      render: (r) => (
        <Badge appearance="filled" color={r.enabled ? 'success' : 'informative'}>
          {r.enabled ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    { key: 'scope', label: 'Scope', width: 180, getValue: describeScope, render: (r) => describeScope(r) },
    { key: 'condition', label: 'Condition', width: 200, getValue: describeCondition, render: (r) => describeCondition(r) },
    { key: 'actions', label: 'Actions', width: 220, getValue: describeActions, render: (r) => describeActions(r) },
    {
      key: 'rowActions', label: '', width: 170, sortable: false, filterable: false,
      render: (r) => (
        <div className={styles.rowActions}>
          <Tooltip content="Edit" relationship="label">
            <Button size="small" appearance="subtle" icon={<Edit20Regular />}
              aria-label={`Edit ${r.name}`} disabled={saving}
              onClick={() => setEditing({ rule: r, original: r.name })} />
          </Tooltip>
          {r.enabled ? (
            <Tooltip content="Pause (set Inactive)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Pause20Regular />}
                aria-label={`Pause ${r.name}`} disabled={saving}
                onClick={() => toggleRule(r, false)} />
            </Tooltip>
          ) : (
            <Tooltip content="Reactivate (set Active)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Play20Regular />}
                aria-label={`Reactivate ${r.name}`} disabled={saving}
                onClick={() => toggleRule(r, true)} />
            </Tooltip>
          )}
          <Tooltip content="Delete" relationship="label">
            <Button size="small" appearance="subtle" icon={<Delete20Regular />}
              aria-label={`Delete ${r.name}`} disabled={saving}
              onClick={() => deleteRule(r)} />
          </Tooltip>
        </div>
      ),
    },
  ], [styles, saving, toggleRule, deleteRule]);

  if (loading) return <Spinner size="tiny" label="Loading lifecycle rules…" />;

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Lifecycle management not wired in this deployment</MessageBarTitle>
          <Caption1 block>
            Missing role: <code>{gate.missing}</code>
          </Caption1>
          {gate.bicepModule && (
            <Caption1 block>Bicep module: <code>{gate.bicepModule}</code></Caption1>
          )}
          {gate.hint && <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>{gate.hint}</Caption1>}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Tooltip content={atLimit ? `Maximum ${MAX_RULES} rules reached` : 'Add a lifecycle rule'} relationship="label">
          <Button appearance="primary" icon={<Add20Regular />} disabled={atLimit || saving}
            onClick={() => setEditing({ rule: null })}>
            Add rule
          </Button>
        </Tooltip>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button icon={<DocumentBulletList20Regular />} disabled={atLimit || saving}>
              Create from template
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {TEMPLATES.map((t) => (
                <MenuItem key={t.key} onClick={() => setEditing({ rule: t.build() })}>{t.label}</MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rules.length} / {MAX_RULES} rules{account ? ` · ${account}` : ''}
        </span>
      </div>

      {atLimit && (
        <MessageBar intent="error">
          <MessageBarBody>
            Maximum {MAX_RULES} lifecycle rules reached. Delete or replace an existing rule to add a new one.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      <LoomDataTable<LifecycleRule>
        columns={columns}
        rows={rules}
        getRowId={(r) => r.name}
        loading={false}
        empty="No lifecycle rules yet. Add one or start from a template."
        ariaLabel="Lifecycle management rules"
      />

      {editing && (
        <RuleEditorDialog
          rule={editing.rule}
          existingNames={rules.filter((r) => r.name !== editing.original).map((r) => r.name)}
          saving={saving}
          onSave={(r) => saveRule(r, editing.original)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ----------------------------- Rule editor wizard -----------------------------

function RuleEditorDialog({
  rule, existingNames, saving, onSave, onClose,
}: {
  rule: LifecycleRule | null;
  existingNames: string[];
  saving: boolean;
  onSave: (r: LifecycleRule) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [name, setName] = useState(rule?.name ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [scopeMode, setScopeMode] = useState<'all' | 'prefix'>(rule?.prefixMatch?.length ? 'prefix' : 'all');
  const [prefix, setPrefix] = useState(rule?.prefixMatch?.join(', ') ?? '');
  const [conditionField, setConditionField] = useState<ConditionField>(rule?.conditionField ?? 'daysAfterModificationGreaterThan');
  const [conditionDays, setConditionDays] = useState<number>(rule?.conditionDays ?? 30);
  const [actions, setActions] = useState<Set<LifecycleAction>>(new Set(rule?.actions ?? ['tierToCool']));

  const toggleAction = (a: LifecycleAction, on: boolean) => {
    setActions((prev) => {
      const next = new Set(prev);
      if (on) next.add(a); else next.delete(a);
      // Auto-tier requires tierToCool; drop it if tierToCool is removed.
      if (a === 'tierToCool' && !on) next.delete('enableAutoTierToHotFromCool');
      return next;
    });
  };

  const autoTierOn = actions.has('enableAutoTierToHotFromCool');
  const tierCoolOn = actions.has('tierToCool');

  // Client-side validation mirrors the BFF.
  const nameValid = NAME_RE.test(name);
  const nameDup = existingNames.includes(name);
  const daysValid = Number.isFinite(conditionDays) && conditionDays >= 1;
  const hasAction = actions.size >= 1;
  const autoTierValid = !autoTierOn || (tierCoolOn && conditionField === 'daysAfterLastAccessTimeGreaterThan');
  const prefixValid = scopeMode === 'all' || prefix.split(',').map((p) => p.trim()).filter(Boolean).length > 0;
  const valid = nameValid && !nameDup && daysValid && hasAction && autoTierValid && prefixValid;

  const submit = () => {
    if (!valid) return;
    const prefixMatch = scopeMode === 'prefix'
      ? prefix.split(',').map((p) => p.trim()).filter(Boolean)
      : undefined;
    onSave({
      name: name.trim(),
      enabled,
      prefixMatch,
      conditionField,
      conditionDays: Math.floor(conditionDays),
      actions: Array.from(actions),
    });
  };

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{rule?.name ? `Edit rule` : 'Add lifecycle rule'}</DialogTitle>
          <DialogContent>
            <div className={styles.dialogBody}>
              <Field label="Rule name" required
                validationState={name && (!nameValid || nameDup) ? 'error' : 'none'}
                validationMessage={
                  name && !nameValid ? '1–63 chars: letters, digits, dashes; must start alphanumeric.'
                    : nameDup ? 'A rule with this name already exists.' : undefined
                }>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. tier-cool-30d" />
              </Field>

              <Field label="Status">
                <Dropdown
                  value={enabled ? 'Active' : 'Inactive'}
                  selectedOptions={[enabled ? 'active' : 'inactive']}
                  onOptionSelect={(_, d) => setEnabled(d.optionValue === 'active')}>
                  <Option value="active">Active</Option>
                  <Option value="inactive">Inactive</Option>
                </Dropdown>
              </Field>

              <Field label="Scope">
                <Dropdown
                  value={scopeMode === 'all' ? 'Entire account' : 'Path prefix'}
                  selectedOptions={[scopeMode]}
                  onOptionSelect={(_, d) => setScopeMode((d.optionValue as 'all' | 'prefix') || 'all')}>
                  <Option value="all">Entire account</Option>
                  <Option value="prefix">Path prefix</Option>
                </Dropdown>
              </Field>
              {scopeMode === 'prefix' && (
                <Field label="Path prefix(es)" required
                  validationState={!prefixValid ? 'error' : 'none'}
                  validationMessage={!prefixValid ? 'Enter at least one prefix.' : undefined}
                  hint="Comma-separated, e.g. bronze/raw/, landing/">
                  <Input value={prefix} onChange={(_, d) => setPrefix(d.value)} placeholder="container/folder/" />
                </Field>
              )}

              <Field label="Condition">
                <Dropdown
                  value={CONDITION_LABELS[conditionField]}
                  selectedOptions={[conditionField]}
                  onOptionSelect={(_, d) => setConditionField((d.optionValue as ConditionField) || 'daysAfterModificationGreaterThan')}>
                  {(Object.keys(CONDITION_LABELS) as ConditionField[]).map((cf) => (
                    <Option key={cf} value={cf}>{CONDITION_LABELS[cf]}</Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Days threshold (more than)" required
                validationState={!daysValid ? 'error' : 'none'}
                validationMessage={!daysValid ? 'Enter a whole number ≥ 1.' : undefined}>
                <SpinButton
                  min={1}
                  value={conditionDays}
                  onChange={(_, d) => {
                    const v = d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : NaN);
                    if (Number.isFinite(v as number)) setConditionDays(v as number);
                  }} />
              </Field>

              <Field label="Actions" required>
                <div className={styles.checks}>
                  {(['tierToCool', 'tierToCold', 'tierToArchive', 'delete'] as LifecycleAction[]).map((a) => (
                    <Checkbox key={a} label={ACTION_LABELS[a]} checked={actions.has(a)}
                      onChange={(_, d) => toggleAction(a, !!d.checked)} />
                  ))}
                  {tierCoolOn && (
                    <Checkbox label={ACTION_LABELS.enableAutoTierToHotFromCool} checked={autoTierOn}
                      onChange={(_, d) => toggleAction('enableAutoTierToHotFromCool', !!d.checked)} />
                  )}
                </div>
              </Field>
              {!hasAction && (
                <Caption1 className={styles.hint}>Select at least one action.</Caption1>
              )}
              {autoTierOn && !autoTierValid && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    "Auto-tier Hot from Cool" requires "Tier to Cool" and the "Days since last access" condition.
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={!valid || saving}>
              {saving ? 'Saving…' : 'Save rule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default LifecycleRulesPanel;
