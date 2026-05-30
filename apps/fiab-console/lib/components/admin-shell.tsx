'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { makeStyles, tokens, Subtitle2, Title3 } from '@fluentui/react-components';

const SECTIONS: { href: string; label: string; description: string }[] = [
  { href: '/admin/tenant-settings', label: 'Tenant settings', description: 'Per-area switches (Power BI, Fabric, OneLake, Real-Time, AI, Mirroring, Git).' },
  { href: '/admin/capacity', label: 'Capacity & compute', description: 'Underlying Azure services Loom orchestrates: ACA, Databricks, Synapse, ADF, ADLA, AML, Cosmos, ACR.' },
  { href: '/admin/scaling', label: 'Scale by SKU', description: 'Scale Fabric, Synapse, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, Foundry — real ARM PATCH from inside Loom.' },
  { href: '/admin/domains', label: 'Domains', description: 'Organize workspaces into business domains and subdomains.' },
  { href: '/admin/deploy-planner', label: 'Deployment planner', description: 'Visually plan what deploys to which subscription and domain; generate the bicepparam for az deployment.' },
  { href: '/admin/security', label: 'Security & governance', description: 'Sensitivity labels, DLP policies, Purview hub link, workspace identity.' },
  { href: '/admin/permissions', label: 'Feature permissions', description: 'Fabric-style RBAC — grant Reader/Contributor/Admin on every editor type, admin page, and workload to Entra users and groups.' },
  { href: '/admin/audit-logs', label: 'Audit logs', description: 'Microsoft 365 audit log activity for every Fabric operation.' },
  { href: '/admin/usage', label: 'Usage metrics', description: 'Feature usage & adoption report, item inventory, item details.' },
  { href: '/admin/users', label: 'Users & licenses', description: 'Power BI / Fabric license assignments and user inventory.' },
  { href: '/admin/workspaces', label: 'Workspaces', description: 'Tenant-wide inventory: every workspace, owner, capacity, state.' },
  { href: '/admin/updates', label: 'Updates & version sync', description: 'See your running version vs latest upstream; pull bug fixes and new features.' },
];

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '260px 1fr', gap: '24px', minHeight: '480px' },
  sidebar: { display: 'flex', flexDirection: 'column', gap: '4px', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: '16px' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px',
    borderRadius: '4px',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
  },
  itemDesc: { fontSize: '12px', color: tokens.colorNeutralForeground3, fontWeight: 'normal' },
  body: { minHeight: 0 },
});

export function AdminShell({ sectionTitle, children }: { sectionTitle?: string; children: ReactNode }) {
  const styles = useStyles();
  const pathname = usePathname();
  return (
    <PageShell
      title="Admin portal"
      subtitle="Tenant-wide settings, capacity, governance, audit, and usage for everyone in your organization."
    >
      <div className={styles.layout}>
        <nav className={styles.sidebar} aria-label="Admin sections">
          {SECTIONS.map((s) => {
            const active = pathname === s.href;
            return (
              <Link key={s.href} href={s.href} className={`${styles.item} ${active ? styles.itemActive : ''}`}>
                <Subtitle2>{s.label}</Subtitle2>
                <span className={styles.itemDesc}>{s.description}</span>
              </Link>
            );
          })}
        </nav>
        <div className={styles.body}>
          {sectionTitle && <Title3 as="h2" style={{ marginBottom: 16 }}>{sectionTitle}</Title3>}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
