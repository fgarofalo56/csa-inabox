'use client';

/**
 * /items/[type]/[id]/permissions — Fabric-style "Manage permissions" page.
 *
 * Lists the live item-permission grants (Cosmos-backed, no mock list), shows a
 * DLP-restriction badge when a Purview DLP policy targets the item (T19), and
 * opens the multi-step ShareItemDialog to grant access. Each row can be revoked
 * (Cosmos row + ADLS POSIX ACL + ARM Storage RBAC removed).
 */
import { use, useCallback, useEffect, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge, Persona, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { AddRegular, ShieldKeyholeRegular, DeleteRegular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ShareItemDialog, type ItemPermissionType } from '@/lib/dialogs/share-item-dialog';

interface ItemPermissionRow {
  id: string;
  principalId: string;
  principalType: 'user' | 'group';
  principalDisplayName?: string;
  principalUpn?: string;
  permissionTypes: ItemPermissionType[];
  grantedBy: string;
  grantedAt: string;
  aclGranted?: boolean;
  rbacRoleName?: string;
  mirrorNotes?: string[];
  fabricHint?: string;
}

const useStyles = makeStyles({
  badges: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  caption: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM, display: 'block' },
});

interface Props { params: Promise<{ type: string; id: string }> }

export default function ItemPermissionsPage(props: Props) {
  const { type, id } = use(props.params);
  const styles = useStyles();
  const [rows, setRows] = useState<ItemPermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dlpRestricted, setDlpRestricted] = useState(false);
  const [dlpPolicyName, setDlpPolicyName] = useState<string | undefined>(undefined);
  const [hasStoragePath, setHasStoragePath] = useState<boolean | undefined>(undefined);
  const [itemName, setItemName] = useState<string>('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/permissions`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) { setError(json?.error || `Failed (${res.status})`); return; }
      setRows(json.permissions || []);
      setDlpRestricted(!!json.dlpRestricted);
      setDlpPolicyName(json.dlpPolicyName);
      setHasStoragePath(json.hasStoragePath);
      setItemName(json.item?.displayName || id);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [type, id]);

  useEffect(() => { load(); }, [load]);

  const revoke = useCallback(async (permissionId: string) => {
    const res = await fetch(`/api/items/${type}/${id}/permissions?permissionId=${encodeURIComponent(permissionId)}`, { method: 'DELETE' });
    if (res.ok) load();
    else {
      const j = await res.json().catch(() => ({}));
      setError(j?.error || `Revoke failed (${res.status})`);
    }
  }, [type, id, load]);

  const columns: LoomColumn<ItemPermissionRow>[] = [
    {
      key: 'principal', label: 'Principal', sortable: true,
      getValue: (r) => r.principalDisplayName || r.principalUpn || r.principalId,
      render: (r) => (
        <Persona
          name={r.principalDisplayName || r.principalUpn || r.principalId}
          secondaryText={r.principalUpn || (r.principalType === 'group' ? 'Group' : 'User')}
        />
      ),
    },
    {
      key: 'permissions', label: 'Permissions', filterType: 'text',
      getValue: (r) => r.permissionTypes.join(', '),
      render: (r) => (
        <div className={styles.badges}>
          {r.permissionTypes.map((p) => (
            <Badge key={p} appearance="tint" color="brand">{p}</Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'mirror', label: 'Backing', filterType: 'text', sortable: false,
      getValue: (r) => `${r.aclGranted ? 'ACL ' : ''}${r.rbacRoleName || ''}`.trim(),
      render: (r) => (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {r.aclGranted ? 'ADLS ACL' : '—'}{r.rbacRoleName ? ` · ${r.rbacRoleName}` : ''}
          {r.fabricHint ? ' · Fabric: skipped' : ''}
        </Caption1>
      ),
    },
    { key: 'grantedBy', label: 'Granted by', sortable: true, getValue: (r) => r.grantedBy },
    { key: 'grantedAt', label: 'Granted', sortable: true, width: 170, getValue: (r) => r.grantedAt },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 110,
      render: (r) => (
        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => revoke(r.id)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <PageShell
      title="Manage permissions"
      subtitle={itemName}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Workspaces', href: '/workspaces' },
        { label: itemName || id, href: `/items/${type}/${id}` },
        { label: 'Manage permissions' },
      ]}
      actions={
        <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialogOpen(true)}>
          Share
        </Button>
      }
    >
      {dlpRestricted && (
        <MessageBar intent="warning" icon={<ShieldKeyholeRegular />} style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>DLP-restricted item</MessageBarTitle>
            Sharing is limited by the active Data Loss Prevention policy
            {dlpPolicyName ? ` "${dlpPolicyName}"` : ''}. Edit and Reshare cannot be granted.
          </MessageBarBody>
        </MessageBar>
      )}

      <Caption1 className={styles.caption}>
        People and groups with access to this item. Granting Read mirrors a POSIX ACL entry and
        Storage Blob Data Reader on the item&apos;s data. Revocation takes effect on the
        recipient&apos;s next sign-in / token refresh (existing tokens persist up to ~1 hour).
      </Caption1>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="Loading permissions…" />
      ) : (
        <LoomDataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          ariaLabel="Item permissions"
          empty="No one has been granted access yet. Use Share to grant access."
        />
      )}

      <ShareItemDialog
        open={dialogOpen}
        itemId={id}
        itemType={type}
        dlpRestricted={dlpRestricted}
        dlpPolicyName={dlpPolicyName}
        hasStoragePath={hasStoragePath}
        onClose={() => setDialogOpen(false)}
        onGranted={load}
      />
    </PageShell>
  );
}
