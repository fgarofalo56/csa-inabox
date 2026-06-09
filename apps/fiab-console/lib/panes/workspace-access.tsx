'use client';

/**
 * WorkspaceAccessPane — F9 admin-plane "Workspace access" role grid.
 *
 * Per-workspace RBAC management for tenant admins (admin-plane → Permissions →
 * Workspace access). Azure-native parity for the Fabric workspace "Manage
 * access" experience, but admin-scoped: pick ANY workspace, see its roster,
 * add / edit / remove members.
 *
 * Each role row is the system-of-record Cosmos `workspace-roles` doc, MIRRORED
 * to a real Azure RBAC role assignment on the workspace's backing DLZ resource
 * group (Admin/Member → Contributor; Contributor/Viewer → Reader). The
 * "Azure RBAC" column shows that enforcement side-effect (active / pending /
 * error). When the Console UAMI lacks RBAC-admin on the DLZ RG, an honest-gate
 * warning MessageBar names the exact remediation — the membership row is still
 * recorded (per no-vaporware.md). Fabric mirroring is strictly opt-in and
 * surfaced via an info MessageBar (per no-fabric-dependency.md).
 *
 * Backend (all real):
 *   GET    /api/workspaces/{id}/role-assignments
 *   POST   /api/workspaces/{id}/role-assignments      (add or edit/upsert)
 *   DELETE /api/workspaces/{id}/role-assignments/{principalId}
 *   GET    /api/governance/identities/search          (IdentityPicker — Graph)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Tooltip, Field, Dropdown, Option, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Persona, Badge, Caption1, Subtitle2,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PersonAdd20Regular, Delete20Regular, Edit20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { IdentityPicker, type IdentityHit, type IdentityKind } from '@/lib/components/ui/identity-picker';
import {
  listRoleAssignments, addRoleAssignment, deleteRoleAssignment,
  roleBadgeColor, rbacBadge, WORKSPACE_ROLE_NAMES, ROLE_DESCRIPTIONS,
  type ListRolesResponse, type WorkspaceRoleAssignment, type WorkspaceRoleName, type PrincipalType,
} from '@/lib/clients/workspace-roles-client';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  empty: {
    padding: tokens.spacingVerticalXXL, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
  detail: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  dialogField: { marginTop: tokens.spacingVerticalM },
});

function identityKindToPrincipalType(k: IdentityKind): PrincipalType {
  if (k === 'group') return 'Group';
  if (k === 'spn') return 'ServicePrincipal';
  return 'User';
}

export interface WorkspaceAccessPaneProps {
  workspaceId: string;
  /** Display name for the header context (optional). */
  workspaceName?: string;
}

export function WorkspaceAccessPane({ workspaceId, workspaceName }: WorkspaceAccessPaneProps) {
  const styles = useStyles();
  const [data, setData] = useState<ListRolesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WorkspaceRoleAssignment | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceRoleAssignment | null>(null);
  const [busyPrincipal, setBusyPrincipal] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listRoleAssignments(workspaceId);
      setData(res);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const remove = useCallback(async (principalId: string) => {
    setBusyPrincipal(principalId);
    try {
      await deleteRoleAssignment(workspaceId, principalId);
      setRemoveTarget(null);
      await load();
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setBusyPrincipal(null);
    }
  }, [workspaceId, load]);

  const rows = data?.roleAssignments ?? [];
  const canManage = data?.callerRole === 'admin';

  return (
    <div className={styles.body}>
      {workspaceName && (
        <Caption1>
          Managing access for workspace <strong>{workspaceName}</strong> (<code>{workspaceId}</code>).
        </Caption1>
      )}

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
            Membership is the Cosmos system-of-record, mirrored to real Azure RBAC on the
            workspace&apos;s backing resource group (Admin/Member → Contributor; Contributor/Viewer → Reader).
            Set <code>LOOM_WORKSPACE_ROLES_FABRIC=1</code> (and bind a Fabric workspace) to also mirror
            these roles to Microsoft Fabric.
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
        <Subtitle2>Members{data ? ` (${rows.length})` : ''}</Subtitle2>
        <div className={styles.spacer} />
        <Tooltip content="Refresh" relationship="label">
          <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()} aria-label="Refresh" />
        </Tooltip>
        <Button appearance="primary" icon={<PersonAdd20Regular />} onClick={() => setAddOpen(true)} disabled={!canManage}>
          Add member
        </Button>
      </div>

      {loading && !data && <Spinner size="small" label="Loading workspace roles…" />}

      {data && rows.length === 0 && (
        <div className={styles.empty}>
          No members yet. Click &quot;Add member&quot; to grant a user, group, or service principal access.
        </div>
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
              const busy = busyPrincipal === r.principalId;
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
                    <Tooltip content="Edit role" relationship="label">
                      <Button appearance="subtle" size="small" icon={<Edit20Regular />}
                        disabled={!canManage || busy}
                        onClick={() => setEditTarget(r)} aria-label={`Edit role for ${r.displayName}`} />
                    </Tooltip>
                    <Tooltip content="Remove member" relationship="label">
                      <Button appearance="subtle" size="small" icon={<Delete20Regular />}
                        disabled={!canManage || busy}
                        onClick={() => setRemoveTarget(r)} aria-label={`Remove ${r.displayName}`} />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <AddMemberDialog
        workspaceId={workspaceId}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); void load(); }}
      />

      <EditRoleDialog
        workspaceId={workspaceId}
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); void load(); }}
      />

      <RemoveConfirmDialog
        target={removeTarget}
        busy={busyPrincipal === removeTarget?.principalId}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && remove(removeTarget.principalId)}
      />
    </div>
  );
}

// ----------------------------------- Add ----------------------------------

function AddMemberDialog({
  workspaceId, open, onClose, onAdded,
}: { workspaceId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const styles = useStyles();
  const [picked, setPicked] = useState<IdentityHit | null>(null);
  const [role, setRole] = useState<WorkspaceRoleName>('Member');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setPicked(null); setRole('Member'); setError(null); setPendingNote(null); }
  }, [open]);

  const submit = useCallback(async () => {
    if (!picked) return;
    setSaving(true); setError(null); setPendingNote(null);
    try {
      const res = await addRoleAssignment(workspaceId, {
        principalId: picked.id,
        principalType: identityKindToPrincipalType(picked.type),
        displayName: picked.displayName,
        role,
      });
      // Surface a non-active RBAC side-effect honestly; the membership row exists.
      if (res.rbac && res.rbac.status !== 'active') {
        setPendingNote(`Member added. Azure RBAC ${res.rbac.status}: ${res.rbac.detail || ''}`);
        onAdded();
        return;
      }
      onAdded();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [picked, role, workspaceId, onAdded]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add member</DialogTitle>
          <DialogContent>
            <IdentityPicker
              kind="all"
              selected={picked}
              onSelect={(h) => setPicked(h || null)}
              label="Search Entra (users, groups, service principals)"
            />
            <Field label="Role" className={styles.dialogField}>
              <Dropdown value={role} selectedOptions={[role]}
                onOptionSelect={(_e, d) => setRole((d.optionValue || 'Member') as WorkspaceRoleName)}>
                {WORKSPACE_ROLE_NAMES.map((rn) => (
                  <Option key={rn} value={rn} text={rn}>{rn} — {ROLE_DESCRIPTIONS[rn]}</Option>
                ))}
              </Dropdown>
            </Field>
            {pendingNote && (
              <MessageBar intent="warning" className={styles.dialogField}>
                <MessageBarBody>{pendingNote}</MessageBarBody>
              </MessageBar>
            )}
            {error && (
              <MessageBar intent="error" className={styles.dialogField}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={!picked || saving}>
              {saving ? 'Adding…' : 'Add'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ----------------------------------- Edit ---------------------------------

function EditRoleDialog({
  workspaceId, target, onClose, onSaved,
}: {
  workspaceId: string;
  target: WorkspaceRoleAssignment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useStyles();
  const [role, setRole] = useState<WorkspaceRoleName>('Member');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);

  useEffect(() => {
    if (target) { setRole(target.role); setError(null); setPendingNote(null); }
  }, [target]);

  const submit = useCallback(async () => {
    if (!target) return;
    setSaving(true); setError(null); setPendingNote(null);
    try {
      // POST upserts: same principalId, new role → updates Cosmos row + re-PUTs RBAC.
      const res = await addRoleAssignment(workspaceId, {
        principalId: target.principalId,
        principalType: target.principalType,
        displayName: target.displayName,
        role,
      });
      if (res.rbac && res.rbac.status !== 'active') {
        setPendingNote(`Role updated. Azure RBAC ${res.rbac.status}: ${res.rbac.detail || ''}`);
        onSaved();
        return;
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [target, role, workspaceId, onSaved]);

  return (
    <Dialog open={!!target} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Edit role</DialogTitle>
          <DialogContent>
            {target && (
              <Persona name={target.displayName} secondaryText={`${target.principalType} · ${target.principalId}`}
                avatar={{ color: 'colorful' }} />
            )}
            <Field label="Role" className={styles.dialogField}>
              <Dropdown value={role} selectedOptions={[role]}
                onOptionSelect={(_e, d) => setRole((d.optionValue || 'Member') as WorkspaceRoleName)}>
                {WORKSPACE_ROLE_NAMES.map((rn) => (
                  <Option key={rn} value={rn} text={rn}>{rn} — {ROLE_DESCRIPTIONS[rn]}</Option>
                ))}
              </Dropdown>
            </Field>
            {pendingNote && (
              <MessageBar intent="warning" className={styles.dialogField}>
                <MessageBarBody>{pendingNote}</MessageBarBody>
              </MessageBar>
            )}
            {error && (
              <MessageBar intent="error" className={styles.dialogField}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={saving || role === target?.role}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------- Remove --------------------------------

function RemoveConfirmDialog({
  target, busy, onCancel, onConfirm,
}: {
  target: WorkspaceRoleAssignment | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Remove member</DialogTitle>
          <DialogContent>
            Remove <strong>{target?.displayName}</strong> from this workspace? This deletes the
            membership record AND revokes the mirrored Azure RBAC assignment on the backing
            resource group.
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default WorkspaceAccessPane;
