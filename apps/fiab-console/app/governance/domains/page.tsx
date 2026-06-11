'use client';

/**
 * /governance/domains — read-only governance catalog view of the tenant's
 * domains. Mirrors Fabric's pattern where the catalog/governance surface shows
 * domain metadata read-only and the Admin portal is the management surface.
 *
 * Tiles show each domain's image/color, workspace count, contributor scope,
 * default sensitivity label, and certification status. Data comes from the same
 * /api/admin/domains BFF (Cosmos-backed). Management links route to
 * /admin/domains.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Settings20Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { DomainImageChip } from '@/lib/components/domain-image-presets';

interface Domain {
  id: string; name: string; description?: string; color?: string; imageKey?: string;
  parentId?: string; workspaceCount?: number;
  contributors?: { scope: 'AllTenant' | 'AdminsOnly' | 'SpecificUsersAndGroups' };
  delegatedSettings?: { defaultSensitivityLabelName?: string; certificationEnabled?: boolean };
  admins?: string[];
}

const SCOPE_LABEL: Record<string, string> = {
  AllTenant: 'Everyone can assign', AdminsOnly: 'Admins only', SpecificUsersAndGroups: 'Specific users',
};

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginTop: 16 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 16,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 12 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 4,
  },
  statCard: {
    padding: 16, borderRadius: 8, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
});

export default function GovernanceDomainsPage() {
  const s = useStyles();
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true); setError(null);
    clientFetch('/api/admin/domains')
      .then((r) => r.json())
      .then((j) => { if (j.ok) setDomains(j.domains || []); else setError(j.error || 'failed'); })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const stats = useMemo(() => {
    const all = domains || [];
    return {
      total: all.length,
      roots: all.filter((d) => !d.parentId).length,
      subdomains: all.filter((d) => d.parentId).length,
      workspaces: all.reduce((n, d) => n + (d.workspaceCount || 0), 0),
    };
  }, [domains]);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of domains || []) m[d.id] = d.name;
    return m;
  }, [domains]);

  return (
    <GovernanceShell sectionTitle="Domains">
      <MessageBar intent="info" style={{ marginBottom: 16 }}>
        <MessageBarBody>
          <MessageBarTitle>Read-only catalog view</MessageBarTitle>
          Manage domains, assign workspaces, and configure delegated settings from the{' '}
          <Link href="/admin/domains" style={{ fontWeight: 600 }}>Admin portal → Domains</Link>.
        </MessageBarBody>
      </MessageBar>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Could not load domains</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.statsRow}>
        <div className={s.statCard}><div className={s.statVal}>{stats.total}</div><div className={s.statLabel}>Domains</div></div>
        <div className={s.statCard}><div className={s.statVal}>{stats.roots}</div><div className={s.statLabel}>Root domains</div></div>
        <div className={s.statCard}><div className={s.statVal}>{stats.subdomains}</div><div className={s.statLabel}>Subdomains</div></div>
        <div className={s.statCard}><div className={s.statVal}>{stats.workspaces}</div><div className={s.statLabel}>Assigned workspaces</div></div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {loading && !domains ? (
        <Spinner label="Loading domains…" />
      ) : (domains && domains.length === 0) ? (
        <MessageBar intent="info">
          <MessageBarBody>
            No domains defined yet. Create your first domain in the{' '}
            <Link href="/admin/domains" style={{ fontWeight: 600 }}>Admin portal → Domains</Link>.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.grid}>
          {(domains || []).map((d) => (
            <div key={d.id} className={s.card}>
              <div className={s.cardHead}>
                <DomainImageChip imageKey={d.imageKey} fallbackColor={d.color} size={44} />
                <div style={{ minWidth: 0 }}>
                  <Subtitle2 style={{ display: 'block' }}>{d.name}</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {d.parentId ? `Subdomain of ${nameById[d.parentId] || d.parentId}` : 'Root domain'}
                  </Caption1>
                </div>
              </div>
              {d.description && <Body1 style={{ color: tokens.colorNeutralForeground2 }}>{d.description}</Body1>}
              <div className={s.badgeRow}>
                <Badge appearance="tint" color={d.workspaceCount ? 'brand' : 'subtle'} size="small">
                  {d.workspaceCount || 0} workspace{(d.workspaceCount || 0) === 1 ? '' : 's'}
                </Badge>
                <Badge appearance="outline" size="small">{SCOPE_LABEL[d.contributors?.scope || 'AllTenant']}</Badge>
                {d.delegatedSettings?.defaultSensitivityLabelName && (
                  <Badge appearance="tint" color="important" size="small">
                    Label: {d.delegatedSettings.defaultSensitivityLabelName}
                  </Badge>
                )}
                {d.delegatedSettings?.certificationEnabled && (
                  <Badge appearance="tint" color="success" size="small">Certification on</Badge>
                )}
              </div>
              <Link href="/admin/domains" style={{ marginTop: 'auto' }}>
                <Button size="small" appearance="subtle" icon={<Settings20Regular />}>Manage in Admin portal</Button>
              </Link>
            </div>
          ))}
        </div>
      )}
    </GovernanceShell>
  );
}
