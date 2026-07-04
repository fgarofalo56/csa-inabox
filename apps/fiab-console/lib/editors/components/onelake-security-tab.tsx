'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular, ShieldTask20Regular,
  Folder20Regular, People20Regular, CheckmarkCircle20Filled,
  CloudArrowUp20Regular, MoreHorizontal20Regular, FilterRegular, ColumnTripleRegular,
  Eye20Regular, Person20Regular, Play20Regular,
} from '@fluentui/react-icons';

import { RowSecurityDialog } from '@/lib/panes/onelake-security/row-security-dialog';
import { ColumnSecurityDialog } from '@/lib/panes/onelake-security/column-security-dialog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  pickList: {
    maxHeight: '220px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  resultRow: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`, cursor: 'pointer', borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  step: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: '280px' },
  stepNum: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '22px', height: '22px', borderRadius: '50%',
    backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeBase200, fontWeight: 700, marginRight: tokens.spacingHorizontalS,
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
  /** Row-level rules (ADDITIVE) — one predicate per table. Drives Preview-as. */
  rls?: { table: string; predicate: string }[];
  /** Column-level rules (ADDITIVE) — allowed columns per table. Drives Preview-as masking. */
  cls?: { table: string; allowedColumns: string[] }[];
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

  const [view, setView] = useState<'roles' | 'verify' | 'preview' | 'fabric'>('roles');
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

  // Row/Column-security dialogs (§2.2) — opened per role from its overflow menu.
  const [secDialog, setSecDialog] = useState<{ kind: 'rls' | 'cls'; roleName: string } | null>(null);

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
        const r = await clientFetch(`/api/lakehouse/paths?container=${encodeURIComponent(effContainer)}&prefix=${prefix}`);
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
        const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${pkind}`);
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

  // ---- Preview as <principal> (test-as-user) --------------------------
  // Evaluate a role's RLS predicate + CLS allow-list against LIVE rows for the
  // selected principal — real Synapse/ADX SELECT via .../security-roles/preview-as.
  const [prevRoleId, setPrevRoleId] = useState('');
  const [prevTable, setPrevTable] = useState('');
  const [prevQ, setPrevQ] = useState('');
  const [prevKind, setPrevKind] = useState<'user' | 'group'>('user');
  const [prevHits, setPrevHits] = useState<PrincipalHit[]>([]);
  const [prevSearchBusy, setPrevSearchBusy] = useState(false);
  const [prevPrincipal, setPrevPrincipal] = useState<{ upn: string; displayName: string } | null>(null);
  const [prevBusy, setPrevBusy] = useState(false);
  const [prevErr, setPrevErr] = useState<string | null>(null);
  const [prevGate, setPrevGate] = useState<{ missing: string; hint: string } | null>(null);
  const [prevResult, setPrevResult] = useState<{
    engine: string; table: string; principal: string; predicate?: string;
    projectedColumns: string[] | string; columns: string[]; rows: unknown[][];
    rowCount: number; executionMs: number; truncated: boolean; note?: string;
  } | null>(null);

  const prevRole = useMemo(() => (roles || []).find((r) => r.id === prevRoleId) || null, [roles, prevRoleId]);
  const prevTables = useMemo(() => {
    if (!prevRole) return [] as string[];
    const set = new Set<string>();
    for (const r of prevRole.rls || []) if (r?.table) set.add(r.table);
    for (const c of prevRole.cls || []) if (c?.table) set.add(c.table);
    return Array.from(set);
  }, [prevRole]);

  // Debounced Entra search for the "Preview as" principal picker.
  useEffect(() => {
    if (view !== 'preview') return;
    const q = prevQ.trim();
    if (q.length < 2) { setPrevHits([]); return; }
    const h = setTimeout(async () => {
      setPrevSearchBusy(true);
      try {
        const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${prevKind}`);
        const j = await r.json();
        setPrevHits((j.results || []).map((p: any) => ({ id: p.id, type: p.type, displayName: p.displayName, upn: p.upn })));
      } catch { setPrevHits([]); }
      finally { setPrevSearchBusy(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [prevQ, prevKind, view]);

  const runPreview = useCallback(async () => {
    if (!prevRole || !prevPrincipal) return;
    setPrevBusy(true); setPrevErr(null); setPrevGate(null); setPrevResult(null);
    try {
      const r = await fetch(`${base}/preview-as`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roleName: prevRole.roleName,
          table: prevTable || undefined,
          principal: prevPrincipal.upn,
          sampleRows: 100,
        }),
      });
      const j = await r.json();
      if (j.gate) { setPrevGate({ missing: j.missing, hint: j.hint }); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPrevResult(j);
    } catch (e: any) { setPrevErr(e?.message || String(e)); }
    finally { setPrevBusy(false); }
  }, [base, prevRole, prevTable, prevPrincipal]);

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
        <Tab value="preview" icon={<Eye20Regular />}>Preview as</Tab>
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
                      <Menu>
                        <MenuTrigger disableButtonEnhancement>
                          <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for role ${r.roleName}`} disabled={busy} />
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            <MenuItem icon={<FilterRegular />} onClick={() => setSecDialog({ kind: 'rls', roleName: r.roleName })}>Row security…</MenuItem>
                            <MenuItem icon={<ColumnTripleRegular />} onClick={() => setSecDialog({ kind: 'cls', roleName: r.roleName })}>Column security…</MenuItem>
                            <MenuItem icon={<Delete20Regular />} onClick={() => deleteRole(r)}>Delete role</MenuItem>
                          </MenuList>
                        </MenuPopover>
                      </Menu>
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
              style={{ padding: tokens.spacingVerticalS }}
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

      {view === 'preview' && (
        <>
          <Body1>
            Preview the rows a member of a role would see — the role&apos;s row-level filter and
            column-level masking applied for the selected principal, run against the live source
            engine (no policy is created).
          </Body1>
          <Field label="Role">
            <select
              value={prevRoleId}
              onChange={(e) => {
                setPrevRoleId(e.target.value);
                setPrevTable('');
                setPrevResult(null);
                setPrevErr(null);
                setPrevGate(null);
              }}
              style={{ padding: tokens.spacingVerticalS }}
            >
              <option value="">Select a role…</option>
              {(roles || []).map((r) => <option key={r.id} value={r.id}>{r.roleName}</option>)}
            </select>
          </Field>

          {prevRole && prevTables.length === 0 && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>No row/column rules on this role</MessageBarTitle>
                Add a Row security or Column security rule (role ⋯ menu on the Roles tab) to preview
                filtered/masked rows.
              </MessageBarBody>
            </MessageBar>
          )}

          {prevRole && prevTables.length > 0 && (
            <Field label="Table">
              <select
                value={prevTable}
                onChange={(e) => { setPrevTable(e.target.value); setPrevResult(null); }}
                style={{ padding: tokens.spacingVerticalS }}
              >
                <option value="">First ruled table ({prevTables[0]})</option>
                {prevTables.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          )}

          <RadioGroup value={prevKind} layout="horizontal" onChange={(_, d) => { setPrevKind(d.value as any); setPrevHits([]); }}>
            <Radio value="user" label="Users" />
            <Radio value="group" label="Groups" />
          </RadioGroup>
          <Field label="Preview as (search Entra)">
            <Input
              value={prevPrincipal ? (prevPrincipal.displayName) : prevQ}
              disabled={!!prevPrincipal}
              onChange={(_, d) => setPrevQ(d.value)}
              placeholder="Search a user or group…"
              contentBefore={<Person20Regular />}
              contentAfter={
                prevPrincipal
                  ? <Button size="small" appearance="subtle" onClick={() => { setPrevPrincipal(null); setPrevQ(''); }}>Change</Button>
                  : (prevSearchBusy ? <Spinner size="extra-tiny" /> : undefined)
              }
            />
          </Field>
          {!prevPrincipal && prevHits.length > 0 && (
            <div className={s.pickList}>
              {prevHits.map((p) => (
                <div key={p.id} role="button" tabIndex={0} className={s.resultRow}
                  onClick={() => { setPrevPrincipal({ upn: p.upn || p.id, displayName: p.displayName }); setPrevHits([]); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setPrevPrincipal({ upn: p.upn || p.id, displayName: p.displayName }); setPrevHits([]); } }}>
                  <Body1>{p.displayName}</Body1>
                  <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{p.upn || p.id}</Caption1>
                </div>
              ))}
            </div>
          )}

          <div>
            <Button
              appearance="primary"
              icon={prevBusy ? <Spinner size="extra-tiny" /> : <Play20Regular />}
              onClick={runPreview}
              disabled={!prevRole || prevTables.length === 0 || !prevPrincipal || prevBusy}
            >
              {prevBusy ? 'Running preview…' : 'Preview rows'}
            </Button>
          </div>

          {prevGate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Backing store not configured</MessageBarTitle>
                {prevGate.hint}
              </MessageBarBody>
            </MessageBar>
          )}
          {prevErr && <MessageBar intent="error"><MessageBarBody>{prevErr}</MessageBarBody></MessageBar>}

          {prevResult && (
            <>
              <MessageBar intent={prevResult.rowCount === 0 ? 'warning' : 'success'}>
                <MessageBarBody>
                  <MessageBarTitle>
                    {prevResult.rowCount.toLocaleString()} row{prevResult.rowCount === 1 ? '' : 's'} visible to{' '}
                    {prevResult.principal} on {prevResult.table}
                  </MessageBarTitle>
                  {prevResult.note} {prevResult.predicate ? `· predicate: ${prevResult.predicate}` : ''}
                  {' '}· {prevResult.executionMs} ms{prevResult.truncated ? ' · truncated' : ''}
                  {Array.isArray(prevResult.projectedColumns)
                    ? ` · columns: ${prevResult.projectedColumns.join(', ')}`
                    : ''}
                </MessageBarBody>
              </MessageBar>
              {prevResult.columns.length > 0 && (
                <div style={{ overflow: 'auto', maxHeight: '340px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table aria-label="Preview-as result rows" size="small">
                    <TableHeader>
                      <TableRow>
                        {prevResult.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {prevResult.rows.map((row, i) => (
                        <TableRow key={i}>
                          {row.map((v, j) => (
                            <TableCell key={j}>{v == null ? 'NULL' : String(v)}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
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
            <DialogTitle><ShieldTask20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />New data-access role · step {step} of 3</DialogTitle>
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
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
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

      {/* ---- Row / Column-security dialogs (§2.2) ---- */}
      {secDialog?.kind === 'rls' && (
        <RowSecurityDialog
          open
          onOpenChange={(o) => { if (!o) setSecDialog(null); }}
          itemId={itemId}
          itemType={itemType}
          roleName={secDialog.roleName}
        />
      )}
      {secDialog?.kind === 'cls' && (
        <ColumnSecurityDialog
          open
          onOpenChange={(o) => { if (!o) setSecDialog(null); }}
          itemId={itemId}
          itemType={itemType}
          roleName={secDialog.roleName}
        />
      )}
    </div>
  );
}
