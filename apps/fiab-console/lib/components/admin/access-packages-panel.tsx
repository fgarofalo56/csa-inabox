'use client';

/**
 * AccessPackagesPanel — tenant-admin authoring for access packages + approval
 * policies (access-governance W2). Wizard/picker authoring only — no freeform
 * JSON (no-freeform-config). All real backends:
 *   packages  → /api/access-packages[/id]
 *   policies  → /api/approval-policies[/id]
 * Fluent v9 + Loom tokens; badge rows wrap (ux-baseline §9.5).
 */
import { useState, useEffect, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  makeStyles, tokens, TabList, Tab, Table, TableHeader, TableRow, TableHeaderCell,
  TableBody, TableCell, TableCellLayout, Badge, Button, Input, Textarea, Field,
  Dropdown, Option, Checkbox, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Caption1, Divider,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Edit20Regular, BoxMultiple24Regular,
  ShieldTask24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { isUnauthorized } from '@/lib/components/sign-in-required';
import type { AccessPackage, PackageGrant } from '@/lib/types/access-package';
import type { ApprovalPolicy, ApprovalStageKey } from '@/lib/types/approval-policy';

const SCOPE_TYPES = ['workspace', 'item', 'data-product', 'adls-container', 'warehouse', 'kql-database'];
const STAGES: { key: ApprovalStageKey; label: string }[] = [
  { key: 'manager', label: 'Manager' },
  { key: 'privacy', label: 'Privacy reviewer' },
  { key: 'approver', label: 'Approver' },
  { key: 'access-provider', label: 'Access provider' },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  bar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  scroll: { overflowX: 'auto', minWidth: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  grantRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
  },
  stageRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, paddingTop: tokens.spacingVerticalS },
});

type Tabk = 'packages' | 'policies';

export function AccessPackagesPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<Tabk>('packages');
  const [packages, setPackages] = useState<AccessPackage[] | null>(null);
  const [policies, setPolicies] = useState<ApprovalPolicy[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pkgDlg, setPkgDlg] = useState<AccessPackage | 'new' | null>(null);
  const [polDlg, setPolDlg] = useState<ApprovalPolicy | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [pr, plr] = await Promise.all([
        clientFetch('/api/access-packages?scope=admin'),
        clientFetch('/api/approval-policies'),
      ]);
      const pj = await pr.json(); const plj = await plr.json();
      if (!pj.ok) { setErr(isUnauthorized(pr) ? 'Tenant-admin access required.' : (pj.error || 'load failed')); setPackages([]); setPolicies([]); return; }
      setPackages(pj.packages || []);
      setPolicies(plj.ok ? (plj.policies || []) : []);
    } catch (e: any) { setErr(e?.message || String(e)); setPackages([]); setPolicies([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const del = useCallback(async (kind: 'access-packages' | 'approval-policies', id: string) => {
    setErr(null); setNote(null);
    try {
      const r = await clientFetch(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'delete failed'); return; }
      setNote('Deleted.'); await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [load]);

  return (
    <div className={s.root}>
      <div className={s.bar}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as Tabk)}>
          <Tab value="packages">Packages{packages ? ` (${packages.length})` : ''}</Tab>
          <Tab value="policies">Approval policies{policies ? ` (${policies.length})` : ''}</Tab>
        </TabList>
        <div className={s.spacer} />
        {tab === 'packages'
          ? <Button appearance="primary" icon={<Add20Regular />} onClick={() => setPkgDlg('new')}>New package</Button>
          : <Button appearance="primary" icon={<Add20Regular />} onClick={() => setPolDlg('new')}>New policy</Button>}
      </div>

      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      {tab === 'packages' && (
        (packages === null) ? <Spinner size="tiny" label="Loading packages…" labelPosition="after" /> :
        packages.length === 0 ? (
          <EmptyState icon={<BoxMultiple24Regular />} title="No access packages yet"
            body="Bundle related grants into a requestable package so users can request access in one click."
            primaryAction={{ label: 'New package', onClick: () => setPkgDlg('new') }} />
        ) : (
          <div className={s.scroll}>
            <Table size="small" aria-label="Access packages">
              <TableHeader><TableRow>
                <TableHeaderCell>Package</TableHeaderCell>
                <TableHeaderCell>Grants</TableHeaderCell>
                <TableHeaderCell>Policy</TableHeaderCell>
                <TableHeaderCell>Flags</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {packages.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><TableCellLayout media={<BoxMultiple24Regular />} description={p.description}>{p.name}</TableCellLayout></TableCell>
                    <TableCell>{p.grants.length}</TableCell>
                    <TableCell>{policies?.find((x) => x.id === p.approvalPolicyId)?.name || 'Default'}</TableCell>
                    <TableCell>
                      <div className={s.badges}>
                        <Badge appearance="tint" color={p.enabled ? 'success' : 'subtle'} size="small">{p.enabled ? 'enabled' : 'disabled'}</Badge>
                        {p.requestable && <Badge appearance="tint" color="brand" size="small">requestable</Badge>}
                        {p.sodConflictsWith && p.sodConflictsWith.length > 0 && <Badge appearance="tint" color="warning" size="small">SoD {p.sodConflictsWith.length}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={s.badges}>
                        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setPkgDlg(p)} aria-label="Edit" />
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => void del('access-packages', p.id)} aria-label="Delete" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      {tab === 'policies' && (
        (policies === null) ? <Spinner size="tiny" label="Loading policies…" labelPosition="after" /> :
        policies.length === 0 ? (
          <EmptyState icon={<ShieldTask24Regular />} title="No custom approval policies"
            body="Requests use the built-in four-stage chain. Create a policy to skip stages or name approvers for a package or resource type."
            primaryAction={{ label: 'New policy', onClick: () => setPolDlg('new') }} />
        ) : (
          <div className={s.scroll}>
            <Table size="small" aria-label="Approval policies">
              <TableHeader><TableRow>
                <TableHeaderCell>Policy</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Stages</TableHeaderCell>
                <TableHeaderCell>Flags</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {policies.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><TableCellLayout media={<ShieldTask24Regular />} description={p.description}>{p.name}</TableCellLayout></TableCell>
                    <TableCell>{p.scope.kind}{p.scope.ref ? `: ${p.scope.ref}` : ''}</TableCell>
                    <TableCell><div className={s.badges}>{p.stages.filter((st) => st.enabled).map((st) => <Badge key={st.key} appearance="outline" size="small">{STAGES.find((x) => x.key === st.key)?.label || st.key}</Badge>)}</div></TableCell>
                    <TableCell><div className={s.badges}>
                      <Badge appearance="tint" color={p.enabled ? 'success' : 'subtle'} size="small">{p.enabled ? 'enabled' : 'disabled'}</Badge>
                      {p.enforceApprovers && <Badge appearance="tint" color="brand" size="small">enforced</Badge>}
                    </div></TableCell>
                    <TableCell><div className={s.badges}>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setPolDlg(p)} aria-label="Edit" />
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => void del('approval-policies', p.id)} aria-label="Delete" />
                    </div></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      {pkgDlg && (
        <PackageDialog
          value={pkgDlg === 'new' ? null : pkgDlg}
          policies={policies || []}
          packages={(packages || []).filter((p) => pkgDlg === 'new' || p.id !== pkgDlg.id)}
          onClose={() => setPkgDlg(null)}
          onSaved={() => { setPkgDlg(null); setNote('Saved.'); void load(); }}
        />
      )}
      {polDlg && (
        <PolicyDialog
          value={polDlg === 'new' ? null : polDlg}
          onClose={() => setPolDlg(null)}
          onSaved={() => { setPolDlg(null); setNote('Saved.'); void load(); }}
        />
      )}
    </div>
  );
}

/* ── Package create/edit wizard ─────────────────────────────────────────────── */
function PackageDialog({ value, policies, packages, onClose, onSaved }: {
  value: AccessPackage | null; policies: ApprovalPolicy[]; packages: AccessPackage[];
  onClose: () => void; onSaved: () => void;
}) {
  const s = useStyles();
  const [name, setName] = useState(value?.name || '');
  const [description, setDescription] = useState(value?.description || '');
  const [requestable, setRequestable] = useState(value?.requestable ?? true);
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const [sodMode, setSodMode] = useState<'block' | 'warn'>(value?.sodMode || 'block');
  const [approvalPolicyId, setApprovalPolicyId] = useState(value?.approvalPolicyId || '');
  const [grants, setGrants] = useState<PackageGrant[]>(value?.grants?.length ? value.grants : [{ resourceType: 'workspace', resourceRef: '', role: 'Viewer' }]);
  const [sodConflictsWith, setSod] = useState<string[]>(value?.sodConflictsWith || []);
  const [defaultLifetimeDays, setLifetime] = useState<string>(value?.defaultLifetimeDays != null ? String(value.defaultLifetimeDays) : '');
  const [activationRequired, setActivationReq] = useState(value?.activationRequired ?? false);
  const [activationWindowHours, setWindow] = useState<string>(value?.activationWindowHours != null ? String(value.activationWindowHours) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setGrant = (i: number, patch: Partial<PackageGrant>) => setGrants((g) => g.map((x, j) => j === i ? { ...x, ...patch } : x));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        name, description, requestable, enabled, sodMode,
        approvalPolicyId: approvalPolicyId || undefined, sodConflictsWith,
        defaultLifetimeDays: defaultLifetimeDays.trim() ? Number(defaultLifetimeDays) : null,
        activationRequired,
        activationWindowHours: activationWindowHours.trim() ? Number(activationWindowHours) : null,
        grants: grants.filter((g) => g.resourceRef.trim()),
      };
      const r = await clientFetch(value ? `/api/access-packages/${value.id}` : '/api/access-packages', {
        method: value ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'save failed'); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>{value ? 'Edit access package' : 'New access package'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Sales Analyst" /></Field>
              <Field label="Description"><Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2} /></Field>
              <Field label="Grants (resource + role)">
                <div className={s.form}>
                  {grants.map((g, i) => (
                    <div key={i} className={s.grantRow}>
                      <Field label="Type"><Dropdown value={g.resourceType} selectedOptions={[g.resourceType]} onOptionSelect={(_, d) => setGrant(i, { resourceType: d.optionValue })} style={{ minWidth: 150 }}>{SCOPE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}</Dropdown></Field>
                      <Field label="Resource ref" style={{ flex: 1, minWidth: 160 }}><Input value={g.resourceRef} onChange={(_, d) => setGrant(i, { resourceRef: d.value })} placeholder="workspace / container / db / item id" /></Field>
                      <Field label="Role"><Input value={g.role} onChange={(_, d) => setGrant(i, { role: d.value })} style={{ maxWidth: 120 }} /></Field>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setGrants((gg) => gg.filter((_, j) => j !== i))} aria-label="Remove grant" disabled={grants.length === 1} />
                    </div>
                  ))}
                  <Button appearance="secondary" icon={<Add20Regular />} onClick={() => setGrants((g) => [...g, { resourceType: 'workspace', resourceRef: '', role: 'Viewer' }])}>Add grant</Button>
                </div>
              </Field>
              <Divider />
              <div className={s.grantRow}>
                <Checkbox label="Requestable" checked={requestable} onChange={(_, d) => setRequestable(!!d.checked)} />
                <Checkbox label="Enabled" checked={enabled} onChange={(_, d) => setEnabled(!!d.checked)} />
              </div>
              <div className={s.grantRow}>
                <Field label="Grant lifetime (days; blank = permanent)"><Input type="number" min={0} value={defaultLifetimeDays} onChange={(_, d) => setLifetime(d.value)} placeholder="e.g. 30" style={{ maxWidth: 200 }} /></Field>
                <Checkbox label="Require activation (PIM: assign eligible, user activates)" checked={activationRequired} onChange={(_, d) => setActivationReq(!!d.checked)} />
                {activationRequired && <Field label="Activation window (hours)"><Input type="number" min={1} value={activationWindowHours} onChange={(_, d) => setWindow(d.value)} placeholder="8" style={{ maxWidth: 140 }} /></Field>}
              </div>
              <Field label="Approval policy">
                <Dropdown value={policies.find((p) => p.id === approvalPolicyId)?.name || 'Default (four-stage chain)'} selectedOptions={[approvalPolicyId]} onOptionSelect={(_, d) => setApprovalPolicyId(d.optionValue || '')}>
                  <Option value="">Default (four-stage chain)</Option>
                  {policies.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
                </Dropdown>
              </Field>
              {packages.length > 0 && (
                <Field label="Separation-of-duties — incompatible packages">
                  <div className={s.form}>
                    <Dropdown multiselect selectedOptions={sodConflictsWith}
                      value={sodConflictsWith.map((id) => packages.find((p) => p.id === id)?.name).filter(Boolean).join(', ') || 'None'}
                      onOptionSelect={(_, d) => setSod(d.selectedOptions)}>
                      {packages.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
                    </Dropdown>
                    <div className={s.grantRow}>
                      <Caption1>On conflict:</Caption1>
                      <Dropdown value={sodMode} selectedOptions={[sodMode]} onOptionSelect={(_, d) => setSodMode((d.optionValue as any) || 'block')} style={{ minWidth: 120 }}>
                        <Option value="block">Block</Option><Option value="warn">Warn</Option>
                      </Dropdown>
                    </div>
                  </div>
                </Field>
              )}
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim() || busy || grants.every((g) => !g.resourceRef.trim())} onClick={() => void save()} icon={busy ? <Spinner size="tiny" /> : undefined}>{value ? 'Save' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ── Approval-policy create/edit wizard ─────────────────────────────────────── */
function PolicyDialog({ value, onClose, onSaved }: { value: ApprovalPolicy | null; onClose: () => void; onSaved: () => void; }) {
  const s = useStyles();
  const [name, setName] = useState(value?.name || '');
  const [description, setDescription] = useState(value?.description || '');
  const [scopeKind, setScopeKind] = useState<'default' | 'resource-type' | 'package'>(value?.scope.kind || 'default');
  const [scopeRef, setScopeRef] = useState(value?.scope.ref || '');
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const [enforceApprovers, setEnforce] = useState(value?.enforceApprovers ?? false);
  const initialEnabled = new Set((value?.stages || STAGES.map((x) => ({ key: x.key, enabled: true }))).filter((x) => x.enabled).map((x) => x.key));
  const [stageOn, setStageOn] = useState<Record<string, boolean>>(Object.fromEntries(STAGES.map((x) => [x.key, initialEnabled.has(x.key)])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const stages = STAGES.map((x) => ({ key: x.key, enabled: x.key === 'access-provider' ? true : !!stageOn[x.key] }));
      const body = { name, description, scope: { kind: scopeKind, ref: scopeKind === 'default' ? undefined : scopeRef }, stages, enforceApprovers, enabled };
      const r = await clientFetch(value ? `/api/approval-policies/${value.id}` : '/api/approval-policies', {
        method: value ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'save failed'); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 600 }}>
        <DialogBody>
          <DialogTitle>{value ? 'Edit approval policy' : 'New approval policy'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Low-sensitivity fast-track" /></Field>
              <Field label="Description"><Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2} /></Field>
              <div className={s.grantRow}>
                <Field label="Applies to"><Dropdown value={scopeKind} selectedOptions={[scopeKind]} onOptionSelect={(_, d) => setScopeKind((d.optionValue as any) || 'default')} style={{ minWidth: 160 }}>
                  <Option value="default">Default (fallback)</Option><Option value="resource-type">Resource type</Option><Option value="package">Package</Option>
                </Dropdown></Field>
                {scopeKind !== 'default' && (
                  <Field label={scopeKind === 'package' ? 'Package id' : 'Item type'} style={{ flex: 1, minWidth: 160 }}><Input value={scopeRef} onChange={(_, d) => setScopeRef(d.value)} placeholder={scopeKind === 'package' ? 'package id' : 'e.g. data-product'} /></Field>
                )}
              </div>
              <Field label="Approval stages (in order; Access provider is always on)">
                <div className={s.stageRow}>
                  {STAGES.map((st) => (
                    <Checkbox key={st.key} label={st.label} checked={st.key === 'access-provider' ? true : !!stageOn[st.key]} disabled={st.key === 'access-provider'}
                      onChange={(_, d) => setStageOn((p) => ({ ...p, [st.key]: !!d.checked }))} />
                  ))}
                </div>
              </Field>
              <div className={s.grantRow}>
                <Checkbox label="Enabled" checked={enabled} onChange={(_, d) => setEnabled(!!d.checked)} />
                <Checkbox label="Enforce named approvers" checked={enforceApprovers} onChange={(_, d) => setEnforce(!!d.checked)} />
              </div>
              <Caption1>Named per-stage approvers can be added via the API; group-approver enforcement lands in W4.</Caption1>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim() || busy || (scopeKind !== 'default' && !scopeRef.trim())} onClick={() => void save()} icon={busy ? <Spinner size="tiny" /> : undefined}>{value ? 'Save' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
