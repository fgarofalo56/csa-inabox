'use client';

/**
 * ManageAccessPane — F5 workspace RBAC "Manage access" side-pane.
 *
 * Azure-native parity for the Fabric workspace "Manage access" experience:
 * list members (users / groups / service principals) with their workspace role
 * (Admin / Member / Contributor / Viewer), add by searching Entra, and remove.
 *
 * Backend (all real, per no-vaporware.md):
 *   GET    /api/workspaces/{id}/role-assignments
 *   POST   /api/workspaces/{id}/role-assignments
 *   DELETE /api/workspaces/{id}/role-assignments/{principalId}
 *   GET    /api/admin/permissions/principals  (Entra search — users & groups)
 *
 * Each row is mirrored to a real Azure RBAC assignment on the DLZ resource
 * group; the "Azure RBAC" column shows that side-effect's status. When the
 * UAMI lacks RBAC-admin, an honest-gate warning MessageBar names the exact
 * remediation. Fabric mirroring is opt-in and surfaced via an info MessageBar.
 *
 * Two render modes:
 *   • embeddedMode → renders inline (used inside WorkspaceSettingsDrawer).
 *   • default      → renders its own "Manage access" trigger Button + Drawer.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Tooltip, Field, Input, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Persona, Badge, Tab, TabList,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PeopleTeam24Regular, Dismiss24Regular, Delete20Regular,
  PersonAdd20Regular, Search16Regular,
} from '@fluentui/react-icons';

type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';
type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';
type SideEffectStatus = 'active' | 'pending' | 'error';

interface RoleAssignment {
  id: string;
  workspaceId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
  azureRoleStatus?: SideEffectStatus;
  azureRoleDetail?: string;
  fabricSynced?: boolean;
  addedBy: string;
  addedAt: string;
}

interface ListResponse {
  ok: boolean;
  roleAssignments: RoleAssignment[];
  rbacAdminGate?: string;
  fabricMode: 'azure-native' | 'fabric+azure';
  callerRole: 'admin' | 'contributor' | 'viewer';
}

interface PrincipalHit {
  id: string;
  type: 'user' | 'group';
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

const ROLE_DESCRIPTIONS: Record<WorkspaceRoleName, string> = {
  Admin: 'Full workspace control, including membership and settings',
  Member: 'Create, publish, and share items',
  Contributor: 'Create and modify items',
  Viewer: 'Read-only access to items',
};

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  spacer: { flex: 1 },
  results: { maxHeight: '220px', overflowY: 'auto', borderRadius: '4px', border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px', marginTop: '8px' },
  resultRow: { display: 'flex', alignItems: 'center', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  resultRowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  empty: { padding: '24px', textAlign: 'center', color: tokens.colorNeutralForeground3, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: '8px' },
  detail: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
});

function roleBadgeColor(role: WorkspaceRoleName): 'brand' | 'success' | 'informative' | 'subtle' {
  switch (role) {
    case 'Admin': return 'brand';
    case 'Member': return 'success';
    case 'Contributor': return 'informative';
    default: return 'subtle';
  }
}

function rbacBadge(status?: SideEffectStatus): { color: 'success' | 'warning' | 'danger' | 'subtle'; label: string } {
  switch (status) {
    case 'active': return { color: 'success', label: 'Active' };
    case 'pending': return { color: 'warning', label: 'Pending' };
    case 'error': return { color: 'danger', label: 'Error' };
    default: return { color: 'subtle', label: '—' };
  }
}

// =========================================================================

interface Props { workspaceId: string; embeddedMode?: boolean; }

export function ManageAccessPane({ workspaceId, embeddedMode }: Props) {
  const [open, setOpen] = useState(false);

  if (embeddedMode) {
    return <ManageAccessBody workspaceId={workspaceId} />;
  }

  return (
    <>
      <Tooltip content="Manage access" relationship="label">
        <Button appearance="subtle" icon={<PeopleTeam24Regular />} onClick={() => setOpen(true)}
          aria-label="Manage access">
          Manage access
        </Button>
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => setOpen(d.open)} position="end" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={
            <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setOpen(false)} aria-label="Close" />
          }>
            Manage access
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <ManageAccessBody workspaceId={workspaceId} />
        </DrawerBody>
      </Drawer>
    </>
  );
}

function ManageAccessBody({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/role-assignments`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setLoadError(json?.error || `HTTP ${res.status}`); return; }
      setData(json as ListResponse);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const remove = useCallback(async (principalId: string) => {
    setRemoving(principalId);
    try {
      await fetch(`/api/workspaces/${workspaceId}/role-assignments/${encodeURIComponent(principalId)}`, { method: 'DELETE' });
      await load();
    } finally {
      setRemoving(null);
    }
  }, [workspaceId, load]);

  const canManage = data?.callerRole === 'admin';
  const rows = data?.roleAssignments ?? [];

  return (
    <div className={styles.body}>
      {data?.rbacAdminGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure RBAC not enforced</MessageBarTitle>
            {data.rbacAdminGate}
          </MessageBarBody>
        </MessageBar>
      )}
      {data?.fabricMode === 'azure-native' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Azure-native access control</MessageBarTitle>
            Membership is backed by Cosmos + Azure RBAC on the workspace resource group.
            Set <code>LOOM_WORKSPACE_ROLES_FABRIC=1</code> (and bind a Fabric workspace) to
            also mirror these roles to Microsoft Fabric.
          </MessageBarBody>
        </MessageBar>
      )}
      {data?.fabricMode === 'fabric+azure' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Fabric mirroring enabled</MessageBarTitle>
            Roles are mirrored to the bound Microsoft Fabric workspace in addition to Azure RBAC.
          </MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error"><MessageBarBody>{loadError}</MessageBarBody></MessageBar>
      )}

      <div className={styles.toolbar}>
        <Button appearance="primary" icon={<PersonAdd20Regular />} onClick={() => setAddOpen(true)} disabled={!canManage}>
          Add member
        </Button>
        <div className={styles.spacer} />
        {!data && !loadError && <Spinner size="tiny" label="Loading…" />}
      </div>

      {data && rows.length === 0 && (
        <div className={styles.empty}>No members yet. Click &quot;Add member&quot; to grant a user or group access.</div>
      )}

      {data && rows.length > 0 && (
        <Table aria-label="Workspace role assignments" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Principal</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Azure RBAC</TableHeaderCell>
              <TableHeaderCell>Added</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const rbac = rbacBadge(r.azureRoleStatus);
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Persona name={r.displayName} secondaryText={r.principalId} avatar={{ color: 'colorful' }} />
                  </TableCell>
                  <TableCell>
                    <Badge appearance="outline" color="informative">{r.principalType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Tooltip content={ROLE_DESCRIPTIONS[r.role]} relationship="description">
                      <Badge appearance="tint" color={roleBadgeColor(r.role)}>{r.role}</Badge>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip content={r.azureRoleDetail || ''} relationship="description">
                      <Badge appearance="tint" color={rbac.color}>{rbac.label}</Badge>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <span className={styles.detail}>{new Date(r.addedAt).toLocaleDateString()}</span>
                  </TableCell>
                  <TableCell>
                    <Button appearance="subtle" size="small" icon={<Delete20Regular />}
                      disabled={!canManage || removing === r.principalId}
                      onClick={() => remove(r.principalId)} aria-label={`Remove ${r.displayName}`} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <AddRoleDialog
        workspaceId={workspaceId}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); void load(); }}
      />
    </div>
  );
}

// ---------------------------------- Add dialog ----------------------------

function AddRoleDialog({
  workspaceId, open, onClose, onAdded,
}: { workspaceId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const styles = useStyles();
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PrincipalHit[]>([]);
  const [selected, setSelected] = useState<PrincipalHit | null>(null);
  const [role, setRole] = useState<WorkspaceRoleName>('Member');
  const [searching, setSearching] = useState(false);
  const [searchGate, setSearchGate] = useState<{ message: string; remediation?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) { setQ(''); setHits([]); setSelected(null); setRole('Member'); setError(null); setSearchGate(null); }
  }, [open]);

  // Debounced Entra search.
  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); setSearchGate(null); return; }
    const handle = setTimeout(async () => {
      setSearching(true); setSearchGate(null);
      try {
        const res = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${kind}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSearchGate({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation });
          setHits([]);
        } else {
          setHits(json.results || []);
        }
      } catch (e: any) {
        setSearchGate({ message: e?.message || String(e) });
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, kind, open]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/role-assignments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalId: selected.id,
          principalType: selected.type === 'group' ? 'Group' : 'User',
          displayName: selected.displayName,
          role,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      // Surface a non-active RBAC side-effect so the operator knows enforcement is pending.
      if (json?.rbac && json.rbac.status !== 'active') {
        setError(`Member added. Azure RBAC ${json.rbac.status}: ${json.rbac.detail || ''}`);
        // Still refresh the list; the row exists.
        onAdded();
        return;
      }
      onAdded();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, role, workspaceId, onAdded]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add member</DialogTitle>
          <DialogContent>
            <TabList selectedValue={kind} onTabSelect={(_e, d) => { setKind(d.value as 'user' | 'group'); setSelected(null); }}>
              <Tab value="user">User</Tab>
              <Tab value="group">Group</Tab>
            </TabList>
            <Field label="Search Entra" style={{ marginTop: 12 }}>
              <Input value={q} onChange={(_e, d) => setQ(d.value)} contentBefore={<Search16Regular />}
                placeholder={kind === 'user' ? 'Display name or UPN' : 'Group display name'} />
            </Field>

            {searchGate && (
              <MessageBar intent="warning" style={{ marginTop: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>{searchGate.message}</MessageBarTitle>
                  {searchGate.remediation && <div style={{ marginTop: 4 }}>{searchGate.remediation}</div>}
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.results}>
              {searching && <Spinner size="tiny" label="Searching Entra…" />}
              {!searching && hits.length === 0 && q.trim() && !searchGate && (
                <div style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No matches.</div>
              )}
              {hits.map((h) => (
                <div key={h.id}
                  className={`${styles.resultRow} ${selected?.id === h.id ? styles.resultRowSelected : ''}`}
                  onClick={() => setSelected(h)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(h); }}>
                  <Persona name={h.displayName} secondaryText={h.upn || h.mail || h.description || h.type} avatar={{ color: 'colorful' }} />
                </div>
              ))}
            </div>

            <Field label="Role" style={{ marginTop: 16 }}>
              <Dropdown value={role} selectedOptions={[role]}
                onOptionSelect={(_e, d) => setRole((d.optionValue || 'Member') as WorkspaceRoleName)}>
                <Option value="Admin">Admin — {ROLE_DESCRIPTIONS.Admin}</Option>
                <Option value="Member">Member — {ROLE_DESCRIPTIONS.Member}</Option>
                <Option value="Contributor">Contributor — {ROLE_DESCRIPTIONS.Contributor}</Option>
                <Option value="Viewer">Viewer — {ROLE_DESCRIPTIONS.Viewer}</Option>
              </Dropdown>
            </Field>

            {error && (
              <MessageBar intent={error.startsWith('Member added') ? 'warning' : 'error'} style={{ marginTop: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={!selected || saving}>
              {saving ? 'Adding…' : 'Add'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
