'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Dropdown, Option, Switch, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}

const KINDS = ['DLP', 'Masking', 'RLS', 'Retention', 'Access'] as const;

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  spacer: { flex: 1 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
  rule: { fontFamily: 'Consolas, monospace', fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

function kindColor(k: string): any {
  return k === 'DLP' || k === 'Retention' ? 'danger' :
         k === 'Masking' || k === 'RLS' ? 'warning' : 'informative';
}

export default function PoliciesPage() {
  const s = useStyles();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftKind, setDraftKind] = useState<typeof KINDS[number]>('DLP');
  const [draftScope, setDraftScope] = useState('tenant');
  const [draftRule, setDraftRule] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/governance/policies');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setPolicies(j.policies || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!draftName.trim()) { setActionErr('name required'); return; }
    setBusy(true); setActionErr(null);
    try {
      const r = await fetch('/api/governance/policies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: draftName.trim(), kind: draftKind, scope: draftScope, rule: draftRule, enabled: true }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setPolicies(j.policies);
      setOpen(false);
      setDraftName(''); setDraftScope('tenant'); setDraftRule('');
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function toggle(p: Policy) {
    try {
      const r = await fetch('/api/governance/policies', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: p.id, enabled: !p.enabled }),
      });
      const j = await r.json();
      if (j.ok) setPolicies(j.policies);
      else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this policy?')) return;
    try {
      const r = await fetch(`/api/governance/policies?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) setPolicies(j.policies);
      else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  return (
    <GovernanceShell sectionTitle="Policies">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        DLP, dynamic data masking, row-level security, retention, and access policies. Stored per tenant
        in Cosmos and visible to downstream enforcement code (Synapse SQL, Lakehouse query gate, etc.).
      </Body1>

      <div className={s.toolbar}>
        <div className={s.spacer} />
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => setOpen(true)}>New policy</Button>
      </div>

      {(error || actionErr) && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error || actionErr}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading policies…" />}

      {!loading && !error && (policies?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No policies defined yet. Click <strong>New policy</strong> to add your first DLP, masking, RLS, retention, or access rule.
        </div>
      )}

      {!loading && !error && (policies?.length ?? 0) > 0 && (
        <Table aria-label="Policies">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell>
              <TableHeaderCell>Rule</TableHeaderCell>
              <TableHeaderCell>Enabled</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(policies || []).map((p) => (
              <TableRow key={p.id}>
                <TableCell><strong>{p.name}</strong></TableCell>
                <TableCell><Badge appearance="filled" color={kindColor(p.kind)} size="small">{p.kind}</Badge></TableCell>
                <TableCell>{p.scope}</TableCell>
                <TableCell><code className={s.rule}>{p.rule || '—'}</code></TableCell>
                <TableCell>
                  <Switch checked={p.enabled} onChange={() => toggle(p)} />
                </TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(p.id)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New policy</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Name"><Input value={draftName} onChange={(_, d) => setDraftName(d.value)} /></Field>
                <Field label="Kind">
                  <Dropdown value={draftKind} selectedOptions={[draftKind]}
                            onOptionSelect={(_, d) => setDraftKind(d.optionValue as any)}>
                    {KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Scope"><Input value={draftScope} onChange={(_, d) => setDraftScope(d.value)} placeholder="tenant / domain:finance / workspace:abc" /></Field>
                <Field label="Rule">
                  <Input value={draftRule} onChange={(_, d) => setDraftRule(d.value)} placeholder="e.g. column:email mask:hash" />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={create} disabled={busy || !draftName.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </GovernanceShell>
  );
}
