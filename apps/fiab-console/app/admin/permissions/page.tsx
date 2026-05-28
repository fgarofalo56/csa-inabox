'use client';

/**
 * /admin/permissions — Fabric-style RBAC admin surface.
 *
 * Left pane: capability tree (Domain → Workload → Capability).
 * Right pane: selected capability detail + list of current grants +
 *             Add button (opens GrantDialog) + per-row Remove.
 *
 * All operations call real BFF routes — no mock state.  When the caller
 * is not a tenant admin and lacks admin.permissions, the page renders an
 * informational MessageBar with the exact remediation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Caption1, Body1, Subtitle2, Title2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { AddRegular, ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { CapabilityTree } from '@/lib/components/feature-rbac/capability-tree';
import { GrantRow } from '@/lib/components/feature-rbac/grant-row';
import { GrantDialog } from '@/lib/components/feature-rbac/grant-dialog';
import type { Capability } from '@/lib/auth/feature-catalog';
import type { FeatureGrant } from '@/lib/auth/feature-gate';

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '320px 1fr', minHeight: '600px', gap: 0 },
  detail: { padding: '24px', overflowY: 'auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', paddingBottom: '12px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  empty: { padding: '32px', color: tokens.colorNeutralForeground3, fontSize: '13px' },
});

export default function FeaturePermissionsPage() {
  const styles = useStyles();
  const [groups, setGroups] = useState<Array<{ domain: string; workloads: Array<{ name: string; capabilities: Capability[] }> }>>([]);
  const [grants, setGrants] = useState<FeatureGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; remediation?: string } | null>(null);
  const [selected, setSelected] = useState<Capability | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capRes, grantRes] = await Promise.all([
        fetch('/api/admin/permissions/capabilities', { cache: 'no-store' }),
        fetch('/api/admin/permissions/grants', { cache: 'no-store' }),
      ]);
      if (capRes.status === 401 || capRes.status === 403) {
        const j = await capRes.json().catch(() => ({}));
        setError({ message: `Access denied (${capRes.status})`, remediation: j?.remediation });
        return;
      }
      const capJson = await capRes.json();
      const grantJson = await grantRes.json();
      setGroups(capJson.groups || []);
      setGrants(grantJson.grants || []);
      if (!selected && capJson.groups?.[0]?.workloads?.[0]?.capabilities?.[0]) {
        setSelected(capJson.groups[0].workloads[0].capabilities[0]);
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grantCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of grants) m[g.capabilityId] = (m[g.capabilityId] || 0) + 1;
    return m;
  }, [grants]);

  const grantsForSelected = useMemo(
    () => grants.filter((g) => g.capabilityId === selected?.id),
    [grants, selected],
  );

  if (loading) {
    return (
      <AdminShell>
        <div style={{ padding: 32 }}><Spinner label="Loading capability catalog…" /></div>
      </AdminShell>
    );
  }
  if (error) {
    return (
      <AdminShell>
        <div style={{ padding: 32 }}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{error.message}</MessageBarTitle>
              {error.remediation && <div style={{ marginTop: 4 }}>{error.remediation}</div>}
              {!error.remediation && (
                <div style={{ marginTop: 4 }}>
                  Only members of the tenant-admin group (env <code>LOOM_TENANT_ADMIN_GROUP_ID</code>) or the user with <code>LOOM_TENANT_ADMIN_OID</code> can manage feature permissions before any grants exist.
                </div>
              )}
            </MessageBarBody>
          </MessageBar>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <div className={styles.layout}>
        <CapabilityTree
          groups={groups}
          grantCounts={grantCounts}
          selected={selected?.id}
          onSelect={(c) => setSelected(c)}
        />
        <div className={styles.detail}>
          {selected ? (
            <>
              <div className={styles.header}>
                <div>
                  <Title2><ShieldKeyhole24Regular /> {selected.name}</Title2>
                  <Caption1 style={{ display: 'block', marginTop: 4 }}>{selected.description}</Caption1>
                  <Caption1 style={{ display: 'block', marginTop: 4, fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}>
                    {selected.id}
                  </Caption1>
                </div>
                <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialogOpen(true)}>
                  Add grant
                </Button>
              </div>
              <Subtitle2>Current grants ({grantsForSelected.length})</Subtitle2>
              <div style={{ marginTop: 12 }}>
                {grantsForSelected.length === 0 && (
                  <div className={styles.empty}>
                    <Body1>No grants yet for this capability.</Body1>
                    <div style={{ marginTop: 8 }}>
                      Tenant admins always have full access; add explicit grants to delegate.
                    </div>
                  </div>
                )}
                {grantsForSelected.map((g) => (
                  <GrantRow key={g.id} grant={g} onRemoved={load} />
                ))}
              </div>
            </>
          ) : (
            <div className={styles.empty}>Select a capability from the tree.</div>
          )}
        </div>
      </div>
      <GrantDialog
        open={dialogOpen}
        capabilityId={selected?.id || ''}
        capabilityName={selected?.name || ''}
        onClose={() => setDialogOpen(false)}
        onGranted={load}
      />
    </AdminShell>
  );
}
