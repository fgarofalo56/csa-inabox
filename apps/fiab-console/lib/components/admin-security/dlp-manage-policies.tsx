'use client';

/**
 * DlpManagePolicies — real DLP compliance-policy CRUD for the /admin/security
 * DLP → Policies tab. Backed by /api/admin/security/dlp/manage, which proxies
 * Get/New/Set/Remove-DlpCompliancePolicy through the Security & Compliance
 * PowerShell sidecar (the ONLY Microsoft-supported DLP authoring surface —
 * Microsoft Graph has no DLP write API).
 *
 * Guided form only (no raw JSON rule authoring, per loom-no-freeform-config):
 *   - Policy: name, mode, comment, workload scope (Exchange/SharePoint/OneDrive/Teams).
 *   - Rule:   name, sensitive info types (multi-select), action (block / audit),
 *             generate alert. A DLP policy is inert without a rule, so create
 *             always authors one.
 *
 * When the sidecar is unwired the GET returns 503 dlp_admin_not_configured and
 * this surface renders the honest NotConfiguredBar with the exact env var /
 * role / bootstrap step — the read-only Graph policy list below still works.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Badge, Spinner, Caption1, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Textarea, Dropdown, Option, Checkbox, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  AddRegular, EditRegular, DeleteRegular, ArrowSync24Regular,
} from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';

const useStyles = makeStyles({
  wrap: { marginBottom: 16 },
  toolbar: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' },
  fieldStack: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 460 },
  row: { display: 'flex', gap: 16, flexWrap: 'wrap' },
  checks: { display: 'flex', flexDirection: 'column', gap: 4 },
});

// Policy enforcement modes (New/Set-DlpCompliancePolicy -Mode).
const MODES: { key: string; label: string }[] = [
  { key: 'Enable', label: 'Enable (enforce)' },
  { key: 'TestWithNotifications', label: 'Test with notifications' },
  { key: 'TestWithoutNotifications', label: 'Test without notifications' },
  { key: 'Disable', label: 'Disabled' },
];

// Microsoft built-in sensitive information types (display names map 1:1 to
// New-DlpComplianceRule -ContentContainsSensitiveInformation @{Name='…'}).
const SITS: string[] = [
  'Credit Card Number',
  'U.S. Social Security Number (SSN)',
  'U.S. / U.K. Passport Number',
  'U.S. Bank Account Number',
  'U.S. Individual Taxpayer Identification Number (ITIN)',
  'ABA Routing Number',
  'International Banking Account Number (IBAN)',
  "U.S. Driver's License Number",
  'IP Address',
  'Azure Storage Account Key',
  'Azure SQL Connection String',
  'Amazon S3 Client Secret Access Key',
  'General Symmetric Key',
];

interface RuleView {
  id?: string; name?: string; priority?: number; blockAccess?: boolean;
  generateAlert?: boolean; disabled?: boolean; sensitiveTypes?: string[];
}
interface PolicyView {
  id: string; name?: string; displayName?: string; comment?: string; mode?: string;
  enabled?: boolean; workload?: string; locations?: string[]; ruleCount?: number; rules?: RuleView[];
}

interface ManageState {
  loading: boolean;
  policies: PolicyView[] | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  errorStatus?: number;
}

interface FormState {
  open: boolean;
  editingId: string | null;
  name: string;
  comment: string;
  mode: string;
  exchange: boolean; sharePoint: boolean; oneDrive: boolean; teams: boolean;
  ruleName: string;
  sensitiveTypes: string[];
  blockAccess: boolean;
  generateAlert: boolean;
  submitting: boolean;
  error: string | null;
}

function blankForm(): FormState {
  return {
    open: false, editingId: null, name: '', comment: '', mode: 'TestWithNotifications',
    exchange: true, sharePoint: true, oneDrive: true, teams: false,
    ruleName: '', sensitiveTypes: [], blockAccess: true, generateAlert: true,
    submitting: false, error: null,
  };
}

export function DlpManagePolicies() {
  const s = useStyles();
  const [state, setState] = useState<ManageState>({ loading: true, policies: null });
  const [form, setForm] = useState<FormState>(blankForm());

  const load = useCallback(async () => {
    setState({ loading: true, policies: null });
    try {
      const r = await fetch('/api/admin/security/dlp/manage');
      const j = await r.json();
      if (r.status === 503 && j?.code === 'dlp_admin_not_configured') {
        setState({ loading: false, policies: null, notConfigured: j.hint, error: j.error, errorStatus: 503 });
        return;
      }
      if (!r.ok) { setState({ loading: false, policies: null, error: j?.error || `HTTP ${r.status}`, errorStatus: r.status }); return; }
      setState({ loading: false, policies: j.policies || [] });
    } catch (e: any) {
      setState({ loading: false, policies: null, error: e?.message || String(e) });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = () => setForm({ ...blankForm(), open: true });
  const openEdit = (p: PolicyView) => {
    const rule = (p.rules || [])[0];
    setForm({
      ...blankForm(),
      open: true,
      editingId: p.id || p.name || null,
      name: p.name || '',
      comment: p.comment || '',
      mode: p.mode || 'TestWithNotifications',
      exchange: (p.locations || []).includes('Exchange'),
      sharePoint: (p.locations || []).includes('SharePoint'),
      oneDrive: (p.locations || []).includes('OneDrive'),
      teams: (p.locations || []).includes('Teams'),
      ruleName: rule?.name || '',
      sensitiveTypes: rule?.sensitiveTypes || [],
      blockAccess: rule?.blockAccess ?? true,
      generateAlert: rule?.generateAlert ?? true,
    });
  };

  const submit = async () => {
    setForm((f) => ({ ...f, submitting: true, error: null }));
    const isEdit = !!form.editingId;
    const rule = form.ruleName.trim() || form.sensitiveTypes.length
      ? {
          name: form.ruleName.trim() || `${form.name.trim()} rule`,
          sensitiveTypes: form.sensitiveTypes,
          blockAccess: form.blockAccess,
          generateAlert: form.generateAlert,
        }
      : undefined;
    const policy = {
      name: form.name.trim(),
      comment: form.comment.trim() || undefined,
      mode: form.mode,
      exchange: form.exchange, sharePoint: form.sharePoint, oneDrive: form.oneDrive, teams: form.teams,
      rule,
    };
    try {
      const r = await fetch('/api/admin/security/dlp/manage', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isEdit ? { id: form.editingId, policy } : { policy }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        setForm((f) => ({ ...f, submitting: false, error: j?.error || `HTTP ${r.status}` }));
        return;
      }
      setForm(blankForm());
      load();
    } catch (e: any) {
      setForm((f) => ({ ...f, submitting: false, error: e?.message || String(e) }));
    }
  };

  const remove = async (p: PolicyView) => {
    const id = p.id || p.name;
    if (!id) return;
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm(`Delete DLP policy "${p.name}"? This removes the policy and its rules.`)) return;
    setState((st) => ({ ...st, loading: true }));
    try {
      await fetch(`/api/admin/security/dlp/manage?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* surfaced on reload */ }
    load();
  };

  const canSubmit = !!form.name.trim() &&
    (form.exchange || form.sharePoint || form.oneDrive || form.teams) &&
    // a rule (when present) needs at least one SIT
    (!(form.ruleName.trim() || form.sensitiveTypes.length) || form.sensitiveTypes.length > 0) &&
    !form.submitting;

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>
          Manage DLP policies <Badge appearance="tint" color="brand">Security &amp; Compliance</Badge>
        </Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
        <Button appearance="primary" icon={<AddRegular />} onClick={openCreate}
          disabled={!!state.notConfigured || state.loading}>New policy</Button>
      </div>

      {state.loading && <Spinner label="Loading DLP compliance policies…" />}

      {state.notConfigured && (
        <NotConfiguredBar surface="DLP policy management" hint={state.notConfigured}
          portalLink="https://purview.microsoft.com" portalLabel="Author in Microsoft Purview" />
      )}

      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load policies (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}

      {state.policies && state.policies.length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No DLP compliance policies yet. Use <strong>New policy</strong> to create one.
        </Caption1>
      )}

      {state.policies && state.policies.length > 0 && (
        <Table size="small" aria-label="DLP compliance policies">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Mode</TableHeaderCell>
              <TableHeaderCell>Workloads</TableHeaderCell>
              <TableHeaderCell>Rules</TableHeaderCell>
              <TableHeaderCell>Sensitive types</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.policies.map((p) => {
              const sits = (p.rules || []).flatMap((r) => r.sensitiveTypes || []);
              return (
                <TableRow key={p.id || p.name}>
                  <TableCell><strong>{p.name}</strong>{p.comment ? <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>{p.comment}</Caption1> : null}</TableCell>
                  <TableCell><Badge appearance="outline">{p.mode || '—'}</Badge></TableCell>
                  <TableCell>{(p.locations || []).map((l) => <Badge key={l} appearance="outline" style={{ marginRight: 4 }}>{l}</Badge>) || '—'}</TableCell>
                  <TableCell>{p.ruleCount ?? (p.rules || []).length}</TableCell>
                  <TableCell><Caption1>{sits.slice(0, 3).join(', ')}{sits.length > 3 ? ` +${sits.length - 3}` : ''}</Caption1></TableCell>
                  <TableCell>
                    <Button size="small" icon={<EditRegular />} onClick={() => openEdit(p)} aria-label={`Edit ${p.name}`} />
                    <Button size="small" icon={<DeleteRegular />} onClick={() => remove(p)} aria-label={`Delete ${p.name}`} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={form.open} onOpenChange={(_, d) => { if (!d.open) setForm(blankForm()); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{form.editingId ? 'Edit DLP policy' : 'New DLP policy'}</DialogTitle>
            <DialogContent>
              <div className={s.fieldStack}>
                <Field label="Policy name" required>
                  <Input value={form.name} disabled={!!form.editingId}
                    onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))}
                    placeholder="e.g. Block U.S. PII in email + files" />
                </Field>
                <Field label="Description">
                  <Input value={form.comment} onChange={(_, d) => setForm((f) => ({ ...f, comment: d.value }))} placeholder="Optional admin note" />
                </Field>
                <Field label="Mode">
                  <Dropdown
                    value={MODES.find((m) => m.key === form.mode)?.label}
                    selectedOptions={[form.mode]}
                    onOptionSelect={(_, d) => setForm((f) => ({ ...f, mode: d.optionValue || 'TestWithNotifications' }))}
                  >
                    {MODES.map((m) => <Option key={m.key} value={m.key}>{m.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Workload scope (locations)" hint="Each selected workload is scoped to 'All'.">
                  <div className={s.row}>
                    <Checkbox label="Exchange" checked={form.exchange} onChange={(_, d) => setForm((f) => ({ ...f, exchange: !!d.checked }))} />
                    <Checkbox label="SharePoint" checked={form.sharePoint} onChange={(_, d) => setForm((f) => ({ ...f, sharePoint: !!d.checked }))} />
                    <Checkbox label="OneDrive" checked={form.oneDrive} onChange={(_, d) => setForm((f) => ({ ...f, oneDrive: !!d.checked }))} />
                    <Checkbox label="Teams" checked={form.teams} onChange={(_, d) => setForm((f) => ({ ...f, teams: !!d.checked }))} />
                  </div>
                </Field>

                <Subtitle2>Rule</Subtitle2>
                <Field label="Rule name" hint="A policy is inert without a rule. Leave blank to auto-name.">
                  <Input value={form.ruleName} onChange={(_, d) => setForm((f) => ({ ...f, ruleName: d.value }))} placeholder="e.g. Detect U.S. PII" />
                </Field>
                <Field label="Sensitive information types" required>
                  <Dropdown
                    multiselect
                    placeholder="Select one or more sensitive info types"
                    selectedOptions={form.sensitiveTypes}
                    value={form.sensitiveTypes.join(', ')}
                    onOptionSelect={(_, d) => setForm((f) => ({ ...f, sensitiveTypes: d.selectedOptions }))}
                  >
                    {SITS.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Action">
                  <div className={s.checks}>
                    <Switch label="Block access when matched" checked={form.blockAccess} onChange={(_, d) => setForm((f) => ({ ...f, blockAccess: !!d.checked }))} />
                    <Switch label="Generate alert" checked={form.generateAlert} onChange={(_, d) => setForm((f) => ({ ...f, generateAlert: !!d.checked }))} />
                  </div>
                </Field>

                {form.error && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{form.error}</MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setForm(blankForm())} disabled={form.submitting}>Cancel</Button>
              <Button appearance="primary" onClick={submit} disabled={!canSubmit}>
                {form.submitting ? (form.editingId ? 'Saving…' : 'Creating…') : (form.editingId ? 'Save policy' : 'Create policy')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
