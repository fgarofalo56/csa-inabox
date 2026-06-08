'use client';

/**
 * OneLakeSecurityTab (F7) — data-access roles for Lakehouse / Mirrored-Database
 * / Mirrored-Catalog items, with the Azure-native ADLS Gen2 ACL backend.
 *
 * Parity with Fabric's "Manage OneLake security": a role list, a 3-step role
 * wizard (name + permissions → folders/tables → members), a DefaultReader /
 * DefaultReadWriter "spans all folders" warning, an ACL read-back Verification
 * view, and an opt-in "Sync to Fabric" panel (hidden unless enabled + non-Gov).
 *
 * Every control calls the real BFF (no mocks). The grant is enforced as real
 * ADLS Gen2 POSIX ACLs server-side (no Fabric workspace required).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2, Tab, TabList, Field, Input,
  Checkbox, Radio, RadioGroup,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular, ShieldTask20Regular,
  Folder20Regular, People20Regular, CheckmarkCircle20Filled,
  CloudArrowUp20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  chips: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  pickList: {
    maxHeight: 220, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
  },
  resultRow: {
    padding: '6px 10px', cursor: 'pointer', borderRadius: 4,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  step: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 280 },
  stepNum: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: '50%',
    backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand,
    fontSize: 12, fontWeight: 700, marginRight: 8,
  },
});

export type OneLakeSecurityItemType = 'lakehouse' | 'mirrored-database' | 'mirrored-catalog';

interface SecurityRoleMember {
  objectId: string;
  objectType: 'User' | 'Group' | 'ServicePrincipal';
  tenantId?: string;
  upn?: string;
  displayName?: string;
}
interface OneLakeSecurityRole {
  id: string;
  itemId: string;
  itemType: OneLakeSecurityItemType;
  container: string;
  roleName: string;
  permissions: ('Read' | 'ReadWrite')[];
  paths: string[];
  members: SecurityRoleMember[];
  isDefault?: boolean;
  createdBy: string;
  createdAt: string;
}

interface PrincipalHit { id: string; type: 'user' | 'group'; displayName: string; upn?: string }
interface PathEntry { name: string; isDirectory: boolean }

interface Props {
  itemId: string;
  itemType: OneLakeSecurityItemType;
  /** Medallion container the item's Delta data lives in (default per type server-side). */
  container?: string;
  /** Needed only for the opt-in Fabric sync. */
  workspaceId?: string;
  fabricItemId?: string;
}

const DEFAULT_WARNING =
  'The DefaultReader role grants all users with ReadAll permission access to all folders. Customizing roles while DefaultReader is active with All Folders does not restrict access. Edit or delete DefaultReader to enforce per-folder isolation.';

export function OneLakeSecurityTab({ itemId, itemType, container, workspaceId, fabricItemId }: Props) {
  const s = useStyles();
  const base = `/api/items/${itemType}/${encodeURIComponent(itemId)}/security-roles`;
  const effContainer = container || (itemType === 'lakehouse' ? 'gold' : 'bronze');

  const [view, setView] = useState<'roles' | 'verify' | 'fabric'>('roles');
  const [roles, setRoles] = useState<OneLakeSecurityRole[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string; hint: string } | null>(null);
  const [allowedPerms, setAllowedPerms] = useState<('Read' | 'ReadWrite')[]>(
    itemType === 'lakehouse' ? ['Read', 'ReadWrite'] : ['Read'],
  );
  const [fabricSyncEnabled, setFabricSyncEnabled] = useState(false);
  const [aclEnabled, setAclEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadRoles = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await fetch(`${base}?list=roles`);
      const j = await r.json();
      if (j.gate) { setGate({ missing: j.missing, hint: j.hint }); setRoles([]); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRoles(j.roles || []);
      if (Array.isArray(j.allowedPermissions)) setAllowedPerms(j.allowedPermissions);
      setFabricSyncEnabled(!!j.fabricSyncEnabled);
      setAclEnabled(j.aclEnabled !== false);
    } catch (e: any) { setError(e?.message || String(e)); setRoles([]); }
    finally { setLoading(false); }
  }, [base]);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  const defaultSpansAll = useMemo(
    () => (roles || []).some((r) => (r.roleName === 'DefaultReader' || r.roleName === 'DefaultReadWriter') && r.paths.includes('*')),
    [roles],
  );
  const hasNarrowRole = useMemo(
    () => (roles || []).some((r) => !r.isDefault && !r.paths.includes('*')),
    [roles],
  );

  // ---- Wizard state ---------------------------------------------------
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [roleName, setRoleName] = useState('');
  const [perms, setPerms] = useState<('Read' | 'ReadWrite')[]>(['Read']);
  const [pathMode, setPathMode] = useState<'all' | 'selected'>('all');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [members, setMembers] = useState<SecurityRoleMember[]>([]);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const nameValid = /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(roleName.trim());

  const resetWizard = useCallback(() => {
    setStep(1); setRoleName(''); setPerms(['Read']); setPathMode('all');
    setSelectedPaths([]); setMembers([]); setSubmitErr(null);
  }, []);

  const openWizard = useCallback(() => { resetWizard(); setWizardOpen(true); }, [resetWizard]);

  // ---- Step 2: folder/table picker ------------------------------------
  const [treeEntries, setTreeEntries] = useState<PathEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeErr, setTreeErr] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    setTreeLoading(true); setTreeErr(null);
    try {
      const out: PathEntry[] = [];
      for (const prefix of ['Tables', 'Files']) {
        const r = await fetch(`/api/lakehouse/paths?container=${encodeURIComponent(effContainer)}&prefix=${prefix}`);
        const j = await r.json();
        if (j.ok && Array.isArray(j.paths)) {
          for (const p of j.paths) if (p.isDirectory) out.push({ name: `/${p.name}`, isDirectory: true });
        }
      }
      setTreeEntries(out);
    } catch (e: any) { setTreeErr(e?.message || String(e)); }
    finally { setTreeLoading(false); }
  }, [effContainer]);

  useEffect(() => {
    if (wizardOpen && step === 2 && pathMode === 'selected' && treeEntries.length === 0) loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardOpen, step, pathMode]);

  const togglePath = useCallback((p: string, checked: boolean) => {
    setSelectedPaths((prev) => (checked ? Array.from(new Set([...prev, p])) : prev.filter((x) => x !== p)));
  }, []);

  // ---- Step 3: identity picker ----------------------------------------
  const [pq, setPq] = useState('');
  const [pkind, setPkind] = useState<'user' | 'group'>('user');
  const [pres, setPres] = useState<PrincipalHit[]>([]);
  const [pbusy, setPbusy] = useState(false);
  const [pGate, setPGate] = useState<string | null>(null);
  const [rawOid, setRawOid] = useState('');

  useEffect(() => {
    if (!wizardOpen || step !== 3) return;
    const q = pq.trim();
    if (q.length < 2) { setPres([]); return; }
    const h = setTimeout(async () => {
      setPbusy(true); setPGate(null);
      try {
        const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${pkind}`);
        const j = await r.json();
        if (!j.ok && j.remediation) { setPGate(j.remediation); setPres([]); return; }
        setPres((j.results || []).map((p: any) => ({ id: p.id, type: p.type, displayName: p.displayName, upn: p.upn })));
      } catch { setPres([]); }
      finally { setPbusy(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [pq, pkind, wizardOpen, step]);

  const addMember = useCallback((m: SecurityRoleMember) => {
    setMembers((prev) => (prev.some((x) => x.objectId === m.objectId) ? prev : [...prev, m]));
    setPq(''); setPres([]);
  }, []);
  const removeMember = useCallback((oid: string) => {
    setMembers((prev) => prev.filter((m) => m.objectId !== oid));
  }, []);
  const addRawOid = useCallback(() => {
    const oid = rawOid.trim();
    if (/^[0-9a-fA-F-]{36}$/.test(oid)) { addMember({ objectId: oid, objectType: pkind === 'group' ? 'Group' : 'User' }); setRawOid(''); }
  }, [rawOid, pkind, addMember]);

  const submitRole = useCallback(async () => {
    setBusy(true); setSubmitErr(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          role: {
            roleName: roleName.trim(),
            container: effContainer,
            permissions: perms,
            paths: pathMode === 'all' ? ['*'] : selectedPaths,
            members: members.map((m) => ({ objectId: m.objectId, objectType: m.objectType, upn: m.upn, displayName: m.displayName })),
          },
        }),
      });
      const j = await r.json();
      if (j.gate) { setSubmitErr(`${j.missing}: ${j.hint}`); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setWizardOpen(false);
      await loadRoles();
    } catch (e: any) { setSubmitErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, roleName, effContainer, perms, pathMode, selectedPaths, members, loadRoles]);

  const deleteRole = useCallback(async (role: OneLakeSecurityRole) => {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm(`Delete role "${role.roleName}"? This revokes its ADLS ACL grants for all members.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${base}?roleId=${encodeURIComponent(role.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.gate) { setGate({ missing: j.missing, hint: j.hint }); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadRoles();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, loadRoles]);

  // ---- Verification view ----------------------------------------------
  const [verifyRoleId, setVerifyRoleId] = useState('');
  const [verifyPath, setVerifyPath] = useState('');
  const [verifyResult, setVerifyResult] = useState<{ path: string; membersPresent: string[]; membersMissing: string[] } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  const runVerify = useCallback(async () => {
    if (!verifyRoleId) return;
    setVerifyBusy(true); setVerifyErr(null); setVerifyResult(null);
    try {
      const qs = new URLSearchParams({ verify: '1', roleId: verifyRoleId });
      if (verifyPath) qs.set('path', verifyPath);
      const r = await fetch(`${base}?${qs.toString()}`);
      const j = await r.json();
      if (j.gate) { setVerifyErr(`${j.missing}: ${j.hint}`); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setVerifyResult(j.verification);
    } catch (e: any) { setVerifyErr(e?.message || String(e)); }
    finally { setVerifyBusy(false); }
  }, [base, verifyRoleId, verifyPath]);

  // ---- Fabric sync (opt-in) -------------------------------------------
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const runFabricSync = useCallback(async () => {
    setSyncBusy(true); setSyncMsg(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'sync-to-fabric', workspaceId, fabricItemId }),
      });
      const j = await r.json();
      if (j.gate) { setSyncMsg({ ok: false, text: `${j.missing}: ${j.hint}` }); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSyncMsg({ ok: true, text: `Synced ${j.synced} role(s) to Fabric${j.etag ? ` (etag ${j.etag})` : ''}.` });
    } catch (e: any) { setSyncMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSyncBusy(false); }
  }, [base, workspaceId, fabricItemId]);

  const permDisabled = (p: 'Read' | 'ReadWrite') => !allowedPerms.includes(p);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<ShieldTask20Regular />}>OneLake security</Badge>
        <Caption1>container: <strong>{effContainer}</strong></Caption1>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadRoles} disabled={loading}>Refresh</Button>
      </div>

      <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as any)}>
        <Tab value="roles" icon={<ShieldTask20Regular />}>Roles</Tab>
        <Tab value="verify" icon={<CheckmarkCircle20Filled />}>Verification</Tab>
        {fabricSyncEnabled && <Tab value="fabric" icon={<CloudArrowUp20Regular />}>Fabric sync</Tab>}
      </TabList>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Storage not configured</MessageBarTitle>
            {gate.hint}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      {view === 'roles' && (
        <>
          {!aclEnabled && !gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>OneLake security backend not enabled</MessageBarTitle>
                Set <code>LOOM_ONELAKE_SECURITY_ACL=true</code> on loom-console and grant the Console UAMI <strong>Storage Blob Data Owner</strong> on the DLZ storage account (deploy admin-plane + synapse.bicep with <code>loomOnelakeSecurityEnabled=true</code>). Until then, roles cannot be created — ADLS ACLs require the Owner role to set permissions on behalf of members.
              </MessageBarBody>
            </MessageBar>
          )}
          {defaultSpansAll && hasNarrowRole && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>DefaultReader spans all folders</MessageBarTitle>
                {DEFAULT_WARNING}
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={openWizard} disabled={busy || !!gate || !aclEnabled}>New role</Button>
          </div>
          {loading && <Spinner size="tiny" label="Loading roles…" />}
          {roles && roles.length === 0 && !loading && !gate && (
            <Caption1>No data-access roles yet. Click “New role” to grant folder/table access to users or groups.</Caption1>
          )}
          {roles && roles.length > 0 && (
            <Table aria-label="OneLake security roles" size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Permissions</TableHeaderCell>
                  <TableHeaderCell>Folders / tables</TableHeaderCell>
                  <TableHeaderCell>Members</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <strong>{r.roleName}</strong>{' '}
                      {r.isDefault && <Badge appearance="tint" color="informative" size="small">Default</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className={s.chips}>
                        {r.permissions.map((p) => <Badge key={p} appearance="outline" size="small">{p}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.paths.includes('*')
                        ? <Badge appearance="tint" color="warning" size="small">All folders</Badge>
                        : <div className={s.chips}>{r.paths.map((p) => <Badge key={p} appearance="outline" size="small" icon={<Folder20Regular />}>{p}</Badge>)}</div>}
                    </TableCell>
                    <TableCell>{r.members.length}</TableCell>
                    <TableCell>
                      <Button appearance="subtle" size="small" icon={<Delete20Regular />} onClick={() => deleteRole(r)} disabled={busy}>Delete</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      {view === 'verify' && (
        <>
          <Body1>Read the live ADLS Gen2 ACL back and confirm each member of a role is present on a path.</Body1>
          <Field label="Role">
            <select
              value={verifyRoleId}
              onChange={(e) => { setVerifyRoleId(e.target.value); const role = (roles || []).find((x) => x.id === e.target.value); setVerifyPath(role?.paths.find((p) => p !== '*') || ''); }}
              style={{ padding: 6 }}
            >
              <option value="">Select a role…</option>
              {(roles || []).map((r) => <option key={r.id} value={r.id}>{r.roleName}</option>)}
            </select>
          </Field>
          <Field label="Path (blank = first folder of the role; '*' roles check the container root)">
            <Input value={verifyPath} onChange={(_, d) => setVerifyPath(d.value)} placeholder="/Tables/sales" />
          </Field>
          <div><Button appearance="primary" icon={<CheckmarkCircle20Filled />} onClick={runVerify} disabled={!verifyRoleId || verifyBusy}>{verifyBusy ? 'Reading ACL…' : 'Verify ACL'}</Button></div>
          {verifyErr && <MessageBar intent="error"><MessageBarBody>{verifyErr}</MessageBarBody></MessageBar>}
          {verifyResult && (
            <MessageBar intent={verifyResult.membersMissing.length === 0 ? 'success' : 'warning'}>
              <MessageBarBody>
                <MessageBarTitle>ACL on {verifyResult.path}</MessageBarTitle>
                Present ({verifyResult.membersPresent.length}): {verifyResult.membersPresent.join(', ') || '—'}.{' '}
                Missing ({verifyResult.membersMissing.length}): {verifyResult.membersMissing.join(', ') || '—'}.
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      )}

      {view === 'fabric' && fabricSyncEnabled && (
        <>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Opt-in Fabric mirror</MessageBarTitle>
              Pushes these Loom roles to the bound Fabric item’s OneLake dataAccessRoles (replace-all). The Azure-native ADLS path remains the source of truth and works without this.
            </MessageBarBody>
          </MessageBar>
          <Caption1>workspace: <strong>{workspaceId || '—'}</strong> · item: <strong>{fabricItemId || '—'}</strong></Caption1>
          <div><Button appearance="primary" icon={<CloudArrowUp20Regular />} onClick={runFabricSync} disabled={syncBusy || !workspaceId || !fabricItemId}>{syncBusy ? 'Syncing…' : 'Sync to Fabric'}</Button></div>
          {syncMsg && <MessageBar intent={syncMsg.ok ? 'success' : 'error'}><MessageBarBody>{syncMsg.text}</MessageBarBody></MessageBar>}
        </>
      )}

      {/* ---- Role wizard ---- */}
      <Dialog open={wizardOpen} onOpenChange={(_, d) => setWizardOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle><ShieldTask20Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />New data-access role · step {step} of 3</DialogTitle>
            <DialogContent>
              {step === 1 && (
                <div className={s.step}>
                  <div><span className={s.stepNum}>1</span><Subtitle2 style={{ display: 'inline' }}>Name &amp; permissions</Subtitle2></div>
                  <Field label="Role name" required validationState={roleName && !nameValid ? 'error' : 'none'} validationMessage={roleName && !nameValid ? 'Start with a letter; alphanumeric; max 128 chars.' : undefined}>
                    <Input value={roleName} onChange={(_, d) => setRoleName(d.value)} placeholder="SalesReaders" />
                  </Field>
                  <Field label="Permissions">
                    <Checkbox checked={perms.includes('Read')} label="Read" onChange={(_, d) => setPerms((p) => (d.checked ? Array.from(new Set([...p, 'Read'])) : p.filter((x) => x !== 'Read')))} />
                    <Checkbox
                      checked={perms.includes('ReadWrite')}
                      disabled={permDisabled('ReadWrite')}
                      label={permDisabled('ReadWrite') ? 'ReadWrite (not supported for this item type)' : 'ReadWrite'}
                      onChange={(_, d) => setPerms((p) => (d.checked ? Array.from(new Set([...p, 'ReadWrite'])) : p.filter((x) => x !== 'ReadWrite')))}
                    />
                  </Field>
                </div>
              )}
              {step === 2 && (
                <div className={s.step}>
                  <div><span className={s.stepNum}>2</span><Subtitle2 style={{ display: 'inline' }}>Folders &amp; tables</Subtitle2></div>
                  <RadioGroup value={pathMode} onChange={(_, d) => setPathMode(d.value as any)}>
                    <Radio value="all" label="All folders (DefaultReader-equivalent)" />
                    <Radio value="selected" label="Selected folders / tables" />
                  </RadioGroup>
                  {pathMode === 'all' && defaultSpansAll && (
                    <MessageBar intent="warning"><MessageBarBody>{DEFAULT_WARNING}</MessageBarBody></MessageBar>
                  )}
                  {pathMode === 'selected' && (
                    <>
                      {treeLoading && <Spinner size="tiny" label="Listing folders…" />}
                      {treeErr && <MessageBar intent="error"><MessageBarBody>{treeErr}</MessageBarBody></MessageBar>}
                      {!treeLoading && treeEntries.length === 0 && !treeErr && <Caption1>No Tables/ or Files/ folders found in {effContainer}.</Caption1>}
                      <div className={s.pickList}>
                        {treeEntries.map((e) => (
                          <Checkbox key={e.name} checked={selectedPaths.includes(e.name)} label={e.name} onChange={(_, d) => togglePath(e.name, !!d.checked)} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {step === 3 && (
                <div className={s.step}>
                  <div><span className={s.stepNum}>3</span><Subtitle2 style={{ display: 'inline' }}>Members</Subtitle2></div>
                  <RadioGroup value={pkind} layout="horizontal" onChange={(_, d) => { setPkind(d.value as any); setPres([]); }}>
                    <Radio value="user" label="Users" />
                    <Radio value="group" label="Groups" />
                  </RadioGroup>
                  <Field label="Search by name or UPN">
                    <Input value={pq} onChange={(_, d) => setPq(d.value)} placeholder="Search Entra…" contentAfter={pbusy ? <Spinner size="extra-tiny" /> : undefined} />
                  </Field>
                  {pGate && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Identity search unavailable</MessageBarTitle>
                        {pGate} You can still paste an Entra object id below.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {pres.length > 0 && (
                    <div className={s.pickList}>
                      {pres.map((p) => (
                        <div key={p.id} role="button" tabIndex={0} className={s.resultRow}
                          onClick={() => addMember({ objectId: p.id, objectType: p.type === 'group' ? 'Group' : 'User', upn: p.upn, displayName: p.displayName })}
                          onKeyDown={(e) => { if (e.key === 'Enter') addMember({ objectId: p.id, objectType: p.type === 'group' ? 'Group' : 'User', upn: p.upn, displayName: p.displayName }); }}>
                          <Body1>{p.displayName}</Body1>
                          <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{p.upn || p.id}</Caption1>
                        </div>
                      ))}
                    </div>
                  )}
                  <Field label="…or add a raw Entra object id">
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Input value={rawOid} onChange={(_, d) => setRawOid(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                      <Button onClick={addRawOid} icon={<Add20Regular />}>Add</Button>
                    </div>
                  </Field>
                  <Field label={`Selected members (${members.length})`}>
                    <div className={s.chips}>
                      {members.length === 0 && <Caption1>None yet.</Caption1>}
                      {members.map((m) => (
                        <Badge key={m.objectId} appearance="tint" color="brand" icon={<People20Regular />} style={{ cursor: 'pointer' }} onClick={() => removeMember(m.objectId)}>
                          {m.displayName || m.upn || m.objectId.slice(0, 8)} ✕
                        </Badge>
                      ))}
                    </div>
                  </Field>
                </div>
              )}
              {submitErr && <MessageBar intent="error"><MessageBarBody>{submitErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setWizardOpen(false)}>Cancel</Button>
              {step > 1 && <Button appearance="secondary" onClick={() => setStep((st) => (st - 1) as 1 | 2 | 3)}>Back</Button>}
              {step < 3 && (
                <Button appearance="primary"
                  disabled={(step === 1 && !nameValid) || (step === 2 && pathMode === 'selected' && selectedPaths.length === 0)}
                  onClick={() => setStep((st) => (st + 1) as 1 | 2 | 3)}>Next</Button>
              )}
              {step === 3 && (
                <Button appearance="primary" icon={busy ? <Spinner size="extra-tiny" /> : <CheckmarkCircle20Filled />}
                  disabled={busy || !nameValid || members.length === 0}
                  onClick={submitRole}>Create role</Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
