'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Dropdown, Option, Switch, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  enforcement?: { status: 'active' | 'pending' | 'error'; roleName?: string; roleAssignmentId?: string; detail?: string };
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
  // Scope = selectable dropdowns (type + target) instead of a freeform string.
  const [scopeType, setScopeType] = useState<'tenant' | 'domain' | 'workspace'>('tenant');
  const [scopeTarget, setScopeTarget] = useState('');
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);
  // Per-kind rule wizard fields.
  const [w, setW] = useState<Record<string, string>>({
    dlpDetect: 'Email', dlpAction: 'Audit',
    maskColumn: '', maskFn: 'Hash',
    rlsColumn: '', rlsOp: '=', rlsValue: '',
    retPeriod: '90', retUnit: 'Days', retAction: 'Delete',
    accPrincipal: '', accPermission: 'Read',
  });
  const setWf = (k: string, v: string) => setW((p) => ({ ...p, [k]: v }));
  // Access policy: Entra principal search + ADLS container scope (real RBAC).
  const [accQuery, setAccQuery] = useState('');
  const [accKind, setAccKind] = useState<'user' | 'group'>('user');
  const [accResults, setAccResults] = useState<Array<{ id: string; type: string; displayName: string; upn?: string }>>([]);
  const [accSearching, setAccSearching] = useState(false);
  const [accPicked, setAccPicked] = useState<{ id: string; name: string; type: 'User' | 'Group'; upn?: string } | null>(null);
  const [accContainer, setAccContainer] = useState('');
  // Which data-plane the grant binds to: ADLS container · warehouse (Synapse SQL)
  // · KQL database (ADX). Each is a real Azure-native grant (no Fabric dep).
  const [accScope, setAccScope] = useState<'adls-container' | 'warehouse' | 'kql-database'>('adls-container');
  const [accKqlDb, setAccKqlDb] = useState('');
  const [kqlItems, setKqlItems] = useState<Array<{ id: string; name: string }>>([]);

  const searchPrincipals = useCallback(async () => {
    const q = accQuery.trim();
    if (q.length < 2) { setAccResults([]); return; }
    setAccSearching(true);
    try {
      const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&type=${accKind}`);
      const j = await r.json();
      setAccResults(j.ok ? (j.results || []) : []);
    } catch { setAccResults([]); }
    finally { setAccSearching(false); }
  }, [accQuery, accKind]);

  useEffect(() => {
    fetch('/api/workspaces').then((r) => r.json()).then((d) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list.map((x: any) => ({ id: x.id, name: x.name || x.displayName || x.id })));
    }).catch(() => {});
    fetch('/api/admin/domains').then((r) => r.json()).then((d) => {
      setDomains((d?.domains || []).map((x: any) => ({ id: x.id, name: x.name || x.id })));
    }).catch(() => {});
    fetch('/api/items/by-type?types=kql-database').then((r) => r.json()).then((d) => {
      setKqlItems((d?.items || []).map((x: any) => ({ id: x.id, name: x.displayName || x.id })));
    }).catch(() => {});
  }, []);

  const buildScope = (): string => scopeType === 'tenant' ? 'tenant' : `${scopeType}:${scopeTarget}`;
  const buildRule = (): string => {
    switch (draftKind) {
      case 'DLP': return `detect:${w.dlpDetect} action:${w.dlpAction}`;
      case 'Masking': return `mask column:${w.maskColumn || '<column>'} using:${w.maskFn}`;
      case 'RLS': return `filter ${w.rlsColumn || '<column>'} ${w.rlsOp} ${w.rlsValue || '<value>'}`;
      case 'Retention': return `retain ${w.retPeriod} ${w.retUnit} then:${w.retAction}`;
      case 'Access': {
        const tgt = accScope === 'adls-container' ? (accContainer || '<container>')
          : accScope === 'kql-database' ? (accKqlDb || '<kql db>')
          : 'warehouse (Synapse SQL)';
        return `grant ${accPicked?.name || '<principal>'} ${w.accPermission} on ${tgt}`;
      }
      default: return '';
    }
  };

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
    const body: Record<string, unknown> = { name: draftName.trim(), kind: draftKind, scope: buildScope(), rule: buildRule(), enabled: true };
    if (draftKind === 'Access') {
      if (!accPicked) { setActionErr('Search and pick a principal for the access policy.'); return; }
      body.principalId = accPicked.id;
      body.principalName = accPicked.upn || accPicked.name;
      body.principalType = accPicked.type;
      body.scopeType = accScope;
      if (accScope === 'adls-container') {
        if (!accContainer.trim()) { setActionErr('Enter the ADLS container the grant applies to.'); return; }
        body.scopeRef = accContainer.trim();
      } else if (accScope === 'kql-database') {
        if (!accKqlDb) { setActionErr('Pick the KQL database the grant applies to.'); return; }
        body.scopeRef = accKqlDb;
      } else {
        // warehouse → the configured Synapse dedicated pool (resolved server-side).
        body.scopeRef = 'warehouse';
      }
      body.permission = (w.accPermission || 'Read').toLowerCase();
    }
    setBusy(true); setActionErr(null);
    try {
      const r = await fetch('/api/governance/policies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); if (j.policies) setPolicies(j.policies); return; }
      setPolicies(j.policies);
      setOpen(false);
      setDraftName(''); setScopeType('tenant'); setScopeTarget('');
      setAccPicked(null); setAccContainer(''); setAccQuery(''); setAccResults([]);
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

  const policyColumns: LoomColumn<Policy>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (p) => p.name, render: (p) => <strong>{p.name}</strong> },
    { key: 'kind', label: 'Kind', sortable: true, filterable: true, width: 120, getValue: (p) => p.kind, render: (p) => <Badge appearance="filled" color={kindColor(p.kind)} size="small">{p.kind}</Badge> },
    { key: 'scope', label: 'Scope', sortable: true, filterable: true, getValue: (p) => p.scope },
    {
      key: 'rule', label: 'Rule', sortable: false, filterable: true, getValue: (p) => p.rule || '',
      render: (p) => (
        <span>
          <code className={s.rule}>{p.rule || '—'}</code>
          {p.enforcement && (
            <Badge appearance="tint" size="small" style={{ marginLeft: 6 }}
              color={p.enforcement.status === 'active' ? 'success' : p.enforcement.status === 'error' ? 'danger' : 'warning'}
              title={p.enforcement.detail || p.enforcement.roleName}>
              {p.enforcement.status === 'active' ? `enforced${p.enforcement.roleName ? ` · ${p.enforcement.roleName.replace('Storage Blob Data ', '')}` : ''}` : p.enforcement.status}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'enabled', label: 'Enabled', sortable: true, filterable: false, width: 100, getValue: (p) => (p.enabled ? 1 : 0),
      render: (p) => <span onClick={(e) => e.stopPropagation()}><Switch checked={p.enabled} onChange={() => toggle(p)} /></span>,
    },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 110,
      render: (p) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(p.id)}>Delete</Button>
        </span>
      ),
    },
  ];

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

      {!error && (
        <LoomDataTable<Policy>
          columns={policyColumns}
          rows={policies || []}
          getRowId={(p) => p.id}
          loading={loading}
          empty="No policies yet. Create one with “New policy”."
        />
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
                {/* Scope — selectable dropdowns (type + target) */}
                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Applies to" style={{ flex: 1 }}>
                    <Dropdown value={scopeType} selectedOptions={[scopeType]}
                      onOptionSelect={(_, d) => { setScopeType(d.optionValue as any); setScopeTarget(''); }}>
                      <Option value="tenant">Whole tenant</Option>
                      <Option value="domain">A domain</Option>
                      <Option value="workspace">A workspace</Option>
                    </Dropdown>
                  </Field>
                  {scopeType !== 'tenant' && (
                    <Field label={scopeType === 'domain' ? 'Domain' : 'Workspace'} style={{ flex: 1 }}>
                      <Dropdown value={scopeTarget} selectedOptions={[scopeTarget]} placeholder="Select…"
                        onOptionSelect={(_, d) => setScopeTarget(d.optionValue || '')}>
                        {(scopeType === 'domain' ? domains : workspaces).map((t) => <Option key={t.id} value={t.id}>{t.name}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>

                {/* Rule wizard — fields depend on the policy kind */}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Configure the {draftKind} rule</Caption1>
                {draftKind === 'DLP' && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Field label="Detect" style={{ flex: 1 }}>
                      <Dropdown value={w.dlpDetect} selectedOptions={[w.dlpDetect]} onOptionSelect={(_, d) => setWf('dlpDetect', d.optionValue || '')}>
                        {['Email', 'SSN', 'Credit card', 'Phone', 'IP address', 'Custom classification'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Action" style={{ flex: 1 }}>
                      <Dropdown value={w.dlpAction} selectedOptions={[w.dlpAction]} onOptionSelect={(_, d) => setWf('dlpAction', d.optionValue || '')}>
                        {['Audit', 'Block', 'Notify', 'Quarantine'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'Masking' && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Field label="Column" style={{ flex: 1 }}><Input value={w.maskColumn} placeholder="e.g. email" onChange={(_, d) => setWf('maskColumn', d.value)} /></Field>
                    <Field label="Masking function" style={{ flex: 1 }}>
                      <Dropdown value={w.maskFn} selectedOptions={[w.maskFn]} onOptionSelect={(_, d) => setWf('maskFn', d.optionValue || '')}>
                        {['Full', 'Partial', 'Email', 'Hash', 'Random'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'RLS' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Field label="Column" style={{ flex: 1 }}><Input value={w.rlsColumn} placeholder="e.g. region" onChange={(_, d) => setWf('rlsColumn', d.value)} /></Field>
                    <Field label="Operator" style={{ width: 100 }}>
                      <Dropdown value={w.rlsOp} selectedOptions={[w.rlsOp]} onOptionSelect={(_, d) => setWf('rlsOp', d.optionValue || '=')}>
                        {['=', '!=', 'IN', 'LIKE'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Value" style={{ flex: 1 }}><Input value={w.rlsValue} placeholder="@currentUser.region" onChange={(_, d) => setWf('rlsValue', d.value)} /></Field>
                  </div>
                )}
                {draftKind === 'Retention' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Field label="Keep for" style={{ width: 120 }}><Input type="number" value={w.retPeriod} onChange={(_, d) => setWf('retPeriod', d.value)} /></Field>
                    <Field label="Unit" style={{ width: 120 }}>
                      <Dropdown value={w.retUnit} selectedOptions={[w.retUnit]} onOptionSelect={(_, d) => setWf('retUnit', d.optionValue || 'Days')}>
                        {['Days', 'Months', 'Years'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Then" style={{ flex: 1 }}>
                      <Dropdown value={w.retAction} selectedOptions={[w.retAction]} onOptionSelect={(_, d) => setWf('retAction', d.optionValue || 'Delete')}>
                        {['Delete', 'Archive', 'Review'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'Access' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Field label="Principal — search Entra users / groups">
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Dropdown value={accKind === 'user' ? 'User' : 'Group'} selectedOptions={[accKind]} style={{ minWidth: 100 }}
                          onOptionSelect={(_, d) => { setAccKind((d.optionValue as 'user' | 'group') || 'user'); setAccResults([]); }}>
                          <Option value="user">User</Option>
                          <Option value="group">Group</Option>
                        </Dropdown>
                        <Input value={accQuery} placeholder="name or UPN…" style={{ flex: 1 }}
                          onChange={(_, d) => setAccQuery(d.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') searchPrincipals(); }} />
                        <Button onClick={searchPrincipals} disabled={accSearching || accQuery.trim().length < 2}>
                          {accSearching ? 'Searching…' : 'Search'}
                        </Button>
                      </div>
                    </Field>
                    {accResults.length > 0 && !accPicked && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                        {accResults.map((r) => (
                          <Button key={r.id} appearance="subtle" style={{ justifyContent: 'flex-start' }}
                            onClick={() => { setAccPicked({ id: r.id, name: r.displayName, type: r.type === 'group' ? 'Group' : 'User', upn: r.upn }); setAccResults([]); }}>
                            {r.displayName}{r.upn ? ` · ${r.upn}` : ''}
                          </Button>
                        ))}
                      </div>
                    )}
                    {accPicked && (
                      <Caption1>
                        Principal: <strong>{accPicked.name}</strong> ({accPicked.type}){' '}
                        <Button size="small" appearance="subtle" onClick={() => setAccPicked(null)}>change</Button>
                      </Caption1>
                    )}
                    <div style={{ display: 'flex', gap: 12 }}>
                      <Field label="Scope (data plane)" style={{ flex: 1 }}
                        hint="Where the grant is enforced — each is a real Azure-native grant.">
                        <Dropdown
                          value={accScope === 'adls-container' ? 'ADLS container' : accScope === 'warehouse' ? 'Warehouse (Synapse SQL)' : 'KQL database (ADX)'}
                          selectedOptions={[accScope]}
                          onOptionSelect={(_, d) => setAccScope((d.optionValue as typeof accScope) || 'adls-container')}>
                          <Option value="adls-container">ADLS container</Option>
                          <Option value="warehouse">Warehouse (Synapse SQL)</Option>
                          <Option value="kql-database">KQL database (ADX)</Option>
                        </Dropdown>
                      </Field>
                      <Field label="Permission" style={{ flex: 1 }}>
                        <Dropdown value={w.accPermission} selectedOptions={[w.accPermission]} onOptionSelect={(_, d) => setWf('accPermission', d.optionValue || 'Read')}>
                          {['Read', 'Write', 'Admin'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    {accScope === 'adls-container' && (
                      <Field label="ADLS container"
                        hint="The data-lake container the grant applies to — Loom enforces it as real Storage RBAC.">
                        <Input value={accContainer} placeholder="bronze" onChange={(_, d) => setAccContainer(d.value)} />
                      </Field>
                    )}
                    {accScope === 'kql-database' && (
                      <Field label="KQL database"
                        hint="The ADX database — Loom enforces the grant as a real ADX database role.">
                        <Dropdown placeholder={kqlItems.length ? 'Select…' : 'No KQL databases found'} disabled={!kqlItems.length}
                          value={accKqlDb} selectedOptions={accKqlDb ? [accKqlDb] : []}
                          onOptionSelect={(_, d) => setAccKqlDb(d.optionValue || '')}>
                          {kqlItems.map((k) => <Option key={k.id} value={k.name}>{k.name}</Option>)}
                        </Dropdown>
                      </Field>
                    )}
                    {accScope === 'warehouse' && (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        The grant applies to the configured Synapse dedicated SQL pool. Loom creates the Entra
                        database user (if needed) and adds it to db_datareader / db_datawriter / db_owner.
                      </Caption1>
                    )}
                  </div>
                )}
                <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1 }}>{buildScope()} · {buildRule()}</Caption1>
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
