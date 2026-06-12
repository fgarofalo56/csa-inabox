'use client';

/**
 * Domain access pane (D2) — the third tab on /admin/permissions.
 *
 * Surfaces the caller's RBAC tier on every business domain (Tenant admin /
 * Domain admin / Domain contributor / No access) and — for tenant admins — lets
 * them bind each domain's Entra ADMIN and CONTRIBUTOR security groups (the
 * groups whose membership the BFF checks, cached, on every request). Mirrors
 * Fabric's Domains tab "Domain admins / Domain contributors" people-pickers.
 *
 * All data is real: GET /api/admin/domains (callerTier + group ids), PATCH
 * /api/admin/domains?id= to set adminGroupId/contributorGroupId, group search via
 * the existing /api/admin/permissions/principals Graph route. Editing the group
 * bindings is tenant-admin-only (server-enforced); domain admins see a read-only
 * tier badge. When per-domain group provisioning is enabled
 * (LOOM_DOMAIN_GROUP_PROVISIONING), a "Provision groups" affordance creates the
 * pair via Microsoft Graph (POST /api/admin/domains { provisionGroups:true }).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Badge, Button, Body1, Caption1,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { PeopleSettings20Regular } from '@fluentui/react-icons';
import { IdentityPicker, type IdentityHit } from '@/lib/components/ui/identity-picker';

type DomainTier = 'tenant-admin' | 'domain-admin' | 'domain-contributor' | null;

interface DomainRow {
  id: string;
  name: string;
  parentId?: string;
  adminGroupId?: string;
  contributorGroupId?: string;
  callerTier: DomainTier;
  workspaceCount?: number;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  groupCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  gid: { fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  pickerWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '360px' },
  nameCell: { display: 'flex', flexDirection: 'column' },
  sub: { color: tokens.colorNeutralForeground3 },
  banners: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  footnote: { marginTop: tokens.spacingVerticalL },
});

const TIER_BADGE: Record<Exclude<DomainTier, null> | 'none', { label: string; color: 'brand' | 'success' | 'informative' | 'subtle' }> = {
  'tenant-admin': { label: 'Tenant admin', color: 'brand' },
  'domain-admin': { label: 'Domain admin', color: 'success' },
  'domain-contributor': { label: 'Domain contributor', color: 'informative' },
  none: { label: 'No access', color: 'subtle' },
};

function TierBadge({ tier }: { tier: DomainTier }) {
  const b = TIER_BADGE[tier ?? 'none'];
  return <Badge appearance="tint" color={b.color}>{b.label}</Badge>;
}

export function DomainAccessPane() {
  const styles = useStyles();
  const [rows, setRows] = useState<DomainRow[] | null>(null);
  const [isTenantAdmin, setIsTenantAdmin] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ domain: DomainRow; field: 'adminGroupId' | 'contributorGroupId' } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await clientFetch('/api/admin/domains', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); setRows([]); return; }
      setRows((json.domains || []) as DomainRow[]);
      setIsTenantAdmin(json.isTenantAdmin === true);
      setProvisioning(json.domainGroupProvisioning === true);
    } catch (e: any) {
      setError(e?.message || String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setGroup = useCallback(async (domainId: string, field: 'adminGroupId' | 'contributorGroupId', value: string) => {
    setBusyId(domainId);
    setError(null);
    try {
      const res = await clientFetch(`/api/admin/domains?id=${encodeURIComponent(domainId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
      setEditing(null);
    }
  }, [load]);

  const provisionEnabled = provisioning;

  const sorted = useMemo(() => {
    const list = rows || [];
    // roots first, then their subdomains grouped under them
    const roots = list.filter((d) => !d.parentId);
    const out: DomainRow[] = [];
    for (const r of roots) {
      out.push(r);
      for (const c of list.filter((d) => d.parentId === r.id)) out.push(c);
    }
    // any orphan subdomains
    for (const d of list) if (!out.includes(d)) out.push(d);
    return out;
  }, [rows]);

  if (rows === null) return <Spinner label="Loading domain access…" />;

  return (
    <>
      <Body1 className={styles.intro}>
        Your access tier on each business domain. Tenant admins are global; domain admins have full
        control of their domain&apos;s workspaces, DLZ panes, and members; domain contributors can
        create and assign workspaces within the domain. Tier comes from the domain&apos;s Entra
        admin / contributor security groups (checked on every request).
      </Body1>

      {(error || !isTenantAdmin) && (
        <div className={styles.banners}>
          {error && (
            <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Couldn&apos;t complete the request</MessageBarTitle>{error}</MessageBarBody></MessageBar>
          )}

          {!isTenantAdmin && (
            <MessageBar intent="info">
              <MessageBarBody>
                Editing a domain&apos;s admin / contributor groups requires a tenant admin. You can see your
                tier on each domain below.
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      <Table aria-label="Domain access" size="medium">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Domain</TableHeaderCell>
            <TableHeaderCell>Your tier</TableHeaderCell>
            <TableHeaderCell>Admin group</TableHeaderCell>
            <TableHeaderCell>Contributor group</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((d) => (
            <TableRow key={d.id}>
              <TableCell>
                <div className={styles.nameCell}>
                  <span>{d.parentId ? `↳ ${d.name}` : d.name}</span>
                  <Caption1 className={styles.sub}>
                    {d.id}{typeof d.workspaceCount === 'number' ? ` · ${d.workspaceCount} workspace${d.workspaceCount === 1 ? '' : 's'}` : ''}
                  </Caption1>
                </div>
              </TableCell>
              <TableCell><TierBadge tier={d.callerTier} /></TableCell>
              <TableCell>
                <div className={styles.groupCell}>
                  {d.adminGroupId
                    ? <span className={styles.gid}>{d.adminGroupId}</span>
                    : <Caption1 className={styles.sub}>Not set</Caption1>}
                  {isTenantAdmin && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<PeopleSettings20Regular />}
                      disabled={busyId === d.id}
                      onClick={() => setEditing({ domain: d, field: 'adminGroupId' })}
                    >
                      {d.adminGroupId ? 'Change' : 'Bind'}
                    </Button>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className={styles.groupCell}>
                  {d.contributorGroupId
                    ? <span className={styles.gid}>{d.contributorGroupId}</span>
                    : <Caption1 className={styles.sub}>Not set</Caption1>}
                  {isTenantAdmin && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<PeopleSettings20Regular />}
                      disabled={busyId === d.id}
                      onClick={() => setEditing({ domain: d, field: 'contributorGroupId' })}
                    >
                      {d.contributorGroupId ? 'Change' : 'Bind'}
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow><TableCell colSpan={4}><Caption1 className={styles.sub}>No domains yet. Create one under Admin → Domains.</Caption1></TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      {provisionEnabled && isTenantAdmin && (
        <MessageBar intent="success" className={styles.footnote}>
          <MessageBarBody>
            Per-domain Entra group provisioning is enabled. New domains can auto-create their
            admin + contributor security groups at create time (Admin → Domains → New, &quot;Provision
            groups&quot;).
          </MessageBarBody>
        </MessageBar>
      )}

      <Dialog open={!!editing} onOpenChange={(_e, data) => { if (!data.open) setEditing(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {editing?.field === 'adminGroupId' ? 'Bind domain admin group' : 'Bind domain contributor group'}
            </DialogTitle>
            <DialogContent>
              <div className={styles.pickerWrap}>
                <Caption1 className={styles.sub}>
                  Pick the Entra security group whose members get the{' '}
                  {editing?.field === 'adminGroupId' ? 'domain admin' : 'domain contributor'} tier on{' '}
                  <b>{editing?.domain.name}</b>. Membership is checked (cached) on every request.
                </Caption1>
                <IdentityPicker
                  kind="group"
                  apiBase="/api/admin/permissions/principals"
                  label="Search Entra groups"
                  onSelect={(hit: IdentityHit | undefined) => {
                    if (!editing) return;
                    if (!hit) return;
                    void setGroup(editing.domain.id, editing.field, hit.id);
                  }}
                />
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              {editing && (editing.field === 'adminGroupId' ? editing.domain.adminGroupId : editing.domain.contributorGroupId) && (
                <Button
                  appearance="subtle"
                  disabled={busyId === editing.domain.id}
                  onClick={() => editing && setGroup(editing.domain.id, editing.field, '')}
                >
                  Clear binding
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export default DomainAccessPane;
