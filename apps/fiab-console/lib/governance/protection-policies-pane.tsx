'use client';

/**
 * ProtectionPoliciesPane — EH Phase-1 §2.3 management UI over
 * /api/admin/protection-policies (GET list, POST upsert+reconcile, [id] DELETE).
 *
 * A protection policy is a LABEL-driven, restrict-ONLY rule: every resource
 * carrying `label` allows ONLY `allowPrincipals` (+ the issuer). This pane is the
 * one-for-one manager: a card/table of policies (label, mode, allow count, last
 * reconcile status) with an EmptyState; a New/Edit dialog (label, allow-list via
 * the shared IdentityPicker people-picker, mode, retainFullControl + exportBlock
 * switches); Save → POST renders the reconcile receipt (applied/gated +
 * warnings) in a MessageBar; per-row Reconcile-now re-POSTs.
 *
 * Backend is REAL (no-vaporware): every call uses clientFetch (same-session
 * cookie). 403 → honest tenant-admin gate. mode='sovereign-rbac' default keeps
 * the no-fabric-dependency rule (Azure RBAC, no Purview/Fabric). No freeform —
 * label is a Dropdown of tenant labels, mode is a Dropdown, principals are
 * people-picked. Web3: Loom tokens, cards/icons, EmptyState/Spinner.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, Body1, Badge, Button, Switch, Field,
  Dropdown, Option, Input, Title3, Subtitle2, Persona,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ShieldKeyhole20Regular, Add20Regular, ArrowSync16Regular, Edit16Regular,
  Delete16Regular, ShieldCheckmark20Regular, LockClosed16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { IdentityPicker, type IdentityHit } from '@/lib/components/ui/identity-picker';
import { clientFetch } from '@/lib/client-fetch';

type ProtectionMode = 'sovereign-rbac' | 'purview';

interface ProtectionPolicy {
  id: string;
  resourceId: string;
  domainId: string;
  label: string;
  allowPrincipals: string[];
  issuer?: string;
  retainFullControl?: boolean;
  scope?: string;
  exportBlock?: boolean;
  mode: ProtectionMode;
  reason?: string;
  tenantId: string;
  updatedAt: string;
}

interface ReconcileReceipt {
  status: 'converged' | 'partial' | 'gated';
  policyId: string;
  label: string;
  mode: ProtectionMode;
  itemsMatched: number;
  grantsAdded: number;
  grantsRevoked: number;
  errors: number;
  gate?: string;
  detail: string[];
  at: string;
}

interface TenantLabel { id: string; name: string }

const API = '/api/admin/protection-policies';

const useStyles = makeStyles({
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow4,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: 0,
    transition: 'box-shadow 120ms ease, transform 120ms ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chip: {
    width: '36px', height: '36px', borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, flexShrink: 0,
  },
  grow: { flex: 1, minWidth: 0 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' },
  dialogStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  pickedList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalXS },
  switchRow: { display: 'flex', gap: tokens.spacingHorizontalXXL, flexWrap: 'wrap' },
});

function statusBadge(s?: ReconcileReceipt['status']) {
  if (s === 'converged') return <Badge appearance="filled" color="success">Converged</Badge>;
  if (s === 'partial') return <Badge appearance="filled" color="warning">Partial</Badge>;
  if (s === 'gated') return <Badge appearance="outline" color="danger">Gated</Badge>;
  return <Badge appearance="outline">Not reconciled</Badge>;
}

export function ProtectionPoliciesPane() {
  const styles = useStyles();
  const [policies, setPolicies] = useState<ProtectionPolicy[]>([]);
  const [labels, setLabels] = useState<TenantLabel[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [forbiddenRemediation, setForbiddenRemediation] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ReconcileReceipt>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [edit, setEdit] = useState<ProtectionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ReconcileReceipt | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setForbidden(false); setForbiddenRemediation(null);
    try {
      const r = await clientFetch(API);
      if (r.status === 403) {
        const j = await r.json().catch(() => ({}));
        setForbidden(true);
        setForbiddenRemediation(j?.remediation || j?.reason || null);
        setPolicies([]);
        return;
      }
      const j = await r.json();
      if (!r.ok || !j?.ok) { setError(j?.error || `Failed (${r.status})`); return; }
      setPolicies(j.policies || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Tenant labels feed the Dropdown (no freeform). Best-effort; if MIP/labels
  // unset, dialog falls back to a free label name.
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/admin/sensitivity-labels');
        const j = await r.json().catch(() => ({}));
        if (r.ok && j?.ok) setLabels((j.labels || []).map((l: any) => ({ id: l.id, name: l.name })));
      } catch { /* leave labels empty → free name */ }
    })();
  }, []);

  const reconcile = useCallback(async (p: ProtectionPolicy) => {
    setBusyId(p.id); setError(null);
    try {
      const r = await clientFetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setError(j?.error || `Reconcile failed (${r.status})`); return; }
      setReceipts((m) => ({ ...m, [p.id]: j.receipt }));
      setLastReceipt(j.receipt);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }, []);

  const remove = useCallback(async (p: ProtectionPolicy) => {
    setBusyId(p.id);
    try {
      await clientFetch(`${API}/${encodeURIComponent(p.id)}?resourceId=${encodeURIComponent(p.resourceId)}`, { method: 'DELETE' });
      await load();
    } finally { setBusyId(null); }
  }, [load]);

  if (forbidden) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Tenant administrator required</MessageBarTitle>
          Protection policies are a tenant-wide control.{' '}
          {forbiddenRemediation ||
            'Set LOOM_TENANT_ADMIN_OID (your Entra user object id) or LOOM_TENANT_ADMIN_GROUP_ID ' +
              'to bind a tenant admin, then sign in with that account. A tenant admin can also grant ' +
              'access at /admin/permissions.'}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <Section
      title="Protection policies"
      actions={<Button appearance="primary" icon={<Add20Regular />} onClick={() => { setEdit(null); setDialogOpen(true); }}>New policy</Button>}
    >
      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {lastReceipt && (
        <MessageBar
          intent={lastReceipt.status === 'converged' ? 'success' : lastReceipt.status === 'gated' ? 'warning' : 'info'}
          style={{ marginBottom: tokens.spacingVerticalM }}
        >
          <MessageBarBody>
            <MessageBarTitle>Reconcile {lastReceipt.status}</MessageBarTitle>
            {lastReceipt.itemsMatched} item(s) matched · {lastReceipt.grantsAdded} granted · {lastReceipt.grantsRevoked} revoked · {lastReceipt.errors} error(s)
            {lastReceipt.gate ? ` · ${lastReceipt.gate}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading policies…" />}

      {!loading && policies.length === 0 && (
        <EmptyState
          icon={<ShieldKeyhole20Regular />}
          title="No protection policies"
          body="Restrict labeled data to an exact allow-list. Sovereign-RBAC enforces Azure RBAC + DENY-by-omission — no Fabric or Purview required."
          primaryAction={{ label: 'New policy', onClick: () => { setEdit(null); setDialogOpen(true); } }}
        />
      )}

      {!loading && policies.length > 0 && (
        <TileGrid>
          {policies.map((p) => {
            const rec = receipts[p.id];
            return (
              <div key={p.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <div className={styles.chip}><ShieldCheckmark20Regular /></div>
                  <div className={styles.grow}>
                    <Subtitle2 truncate>{p.label}</Subtitle2>
                    <Caption1>{p.domainId}</Caption1>
                  </div>
                </div>
                <div className={styles.meta}>
                  <Badge appearance="outline" color={p.mode === 'purview' ? 'warning' : 'brand'}>{p.mode}</Badge>
                  <Badge appearance="tint">{p.allowPrincipals.length} principal(s)</Badge>
                  {p.exportBlock && <Badge appearance="tint" color="danger" icon={<LockClosed16Regular />}>export blocked</Badge>}
                  {statusBadge(rec?.status)}
                </div>
                <div className={styles.rowActions}>
                  <Button size="small" icon={<ArrowSync16Regular />} disabled={busyId === p.id} onClick={() => void reconcile(p)}>
                    {busyId === p.id ? 'Reconciling…' : 'Reconcile now'}
                  </Button>
                  <Button size="small" icon={<Edit16Regular />} onClick={() => { setEdit(p); setDialogOpen(true); }}>Edit</Button>
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busyId === p.id} onClick={() => void remove(p)}>Delete</Button>
                </div>
              </div>
            );
          })}
        </TileGrid>
      )}

      {dialogOpen && (
        <PolicyDialog
          labels={labels}
          initial={edit}
          saving={saving}
          onClose={() => setDialogOpen(false)}
          onSaved={(rec) => { setLastReceipt(rec); setDialogOpen(false); void load(); }}
          setSaving={setSaving}
        />
      )}
    </Section>
  );
}

function PolicyDialog({
  labels, initial, saving, setSaving, onClose, onSaved,
}: {
  labels: TenantLabel[];
  initial: ProtectionPolicy | null;
  saving: boolean;
  setSaving: (b: boolean) => void;
  onClose: () => void;
  onSaved: (r: ReconcileReceipt) => void;
}) {
  const styles = useStyles();
  const [domainId, setDomainId] = useState(initial?.domainId || 'default');
  const [label, setLabel] = useState(initial?.label || '');
  const [mode, setMode] = useState<ProtectionMode>(initial?.mode || 'sovereign-rbac');
  const [retain, setRetain] = useState(initial?.retainFullControl !== false);
  const [exportBlock, setExportBlock] = useState(initial?.exportBlock === true);
  const [principals, setPrincipals] = useState<IdentityHit[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const labelNames = useMemo(() => labels.map((l) => l.name), [labels]);

  const save = async () => {
    if (!label.trim()) { setErr('Choose a label'); return; }
    setSaving(true); setErr(null);
    try {
      const body = {
        id: initial?.id, domainId, label, mode,
        retainFullControl: retain, exportBlock,
        allowPrincipals: principals.map((p) => p.id),
      };
      const r = await clientFetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.error || `Save failed (${r.status})`); return; }
      onSaved(j.receipt);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{initial ? 'Edit protection policy' : 'New protection policy'}</DialogTitle>
          <DialogContent className={styles.dialogStack}>
            {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field label="Domain">
              <Dropdown value={domainId} selectedOptions={[domainId]} onOptionSelect={(_e, d) => setDomainId(d.optionValue || 'default')}>
                <Option value="default">default</Option>
              </Dropdown>
            </Field>
            <Field label="Sensitivity label">
              {labelNames.length > 0 ? (
                <Dropdown placeholder="Select label" value={label} selectedOptions={[label]} onOptionSelect={(_e, d) => setLabel(d.optionValue || '')}>
                  {labelNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                </Dropdown>
              ) : (
                <Input placeholder="Type a label name" value={label} onChange={(_e, d) => setLabel(d.value)} />
              )}
            </Field>
            <Field label="Allowed principals">
              <IdentityPicker kind="all" onSelect={(h) => h && setPrincipals((ps) => ps.find((x) => x.id === h.id) ? ps : [...ps, h])} />
              <div className={styles.pickedList}>
                {principals.map((p) => (
                  <Persona key={p.id} name={p.displayName} secondaryText={p.upn || p.mail || p.type} size="extra-small" />
                ))}
              </div>
            </Field>
            <Field label="Mode">
              <Dropdown value={mode} selectedOptions={[mode]} onOptionSelect={(_e, d) => setMode((d.optionValue as ProtectionMode) || 'sovereign-rbac')}>
                <Option value="sovereign-rbac">sovereign-rbac (Azure RBAC, no Fabric)</Option>
                <Option value="purview">purview (opt-in)</Option>
              </Dropdown>
            </Field>
            <div className={styles.switchRow}>
              <Switch checked={retain} onChange={(_e, d) => setRetain(d.checked)} label="Retain issuer full control" />
              <Switch checked={exportBlock} onChange={(_e, d) => setExportBlock(d.checked)} label="Block export" />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save & reconcile'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ProtectionPoliciesPane;
